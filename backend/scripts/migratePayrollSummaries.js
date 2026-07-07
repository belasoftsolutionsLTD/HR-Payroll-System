/**
 * One-time migration: folds every payroll_summaries doc (the legacy, per-employee
 * flat payroll record) into the Cycles engine's data model (payroll_cycles +
 * payroll_results + payslips), so historical payslip data survives the legacy
 * system's retirement.
 *
 * Idempotent — safe to re-run. A payroll_results doc is only created for an
 * (employeeId, cycleId) pair that doesn't already have one (whether from a prior
 * run of this script, or from a genuine Cycles-engine run for that same period).
 *
 * Run: node scripts/migratePayrollSummaries.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'school-erp';

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  global.dbo = db; // generatePayslipFromResult doesn't need it, but payslipService's callers historically expect it set
  console.log('Connected to', DB_NAME);

  const { generatePayslipFromResult } = require('../src/services/payslipService');

  const summaries = await db.collection('payroll_summaries').find({}).sort({ year: 1, month: 1 }).toArray();
  console.log(`Found ${summaries.length} payroll_summaries record(s) to migrate.`);
  if (!summaries.length) {
    console.log('Nothing to migrate.');
    await client.close();
    return;
  }

  const now = new Date();
  const cycleCache = {}; // "month-year" -> cycle doc
  let migrated = 0, skipped = 0;

  for (const summary of summaries) {
    const { month, year } = summary;
    const cacheKey = `${month}-${year}`;

    let cycle = cycleCache[cacheKey];
    if (!cycle) {
      cycle = await db.collection('payroll_cycles').findOne({ 'period.month': month, 'period.year': year });
      if (!cycle) {
        const startDate = new Date(year, month - 1, 1);
        const endDate   = new Date(year, month, 0);
        const doc = {
          name: `Migrated ${month}/${year} Payroll`,
          period: { month, year, startDate, endDate },
          payDate: null,
          status: 'closed',
          payGroup: 'all',
          currency: summary.currency || 'KES',
          totalGross: 0, totalDeductions: 0, totalNet: 0, totalEmployerCost: 0, employeeCount: 0,
          hasExceptions: false, exceptionCount: 0,
          lockedAt: now, lockedBy: null, closedAt: now, closedBy: null,
          migratedFromLegacy: true,
          createdBy: null,
          createdAt: now, updatedAt: now,
        };
        const result = await db.collection('payroll_cycles').insertOne(doc);
        cycle = { ...doc, _id: result.insertedId };
        console.log(`  Created cycle for ${month}/${year} (${cycle._id})`);
      }
      cycleCache[cacheKey] = cycle;
    }

    const existingResult = await db.collection('payroll_results').findOne({ employeeId: summary.employeeId, cycleId: cycle._id });
    if (existingResult) {
      skipped++;
      continue;
    }

    const d = summary.deductions || {};
    const earnings = [
      { conceptId: null, conceptName: 'Basic Pay', conceptCode: 'LEGACY_BASIC', subCategory: 'fixed_pay', amount: summary.grossPay || 0, isTaxable: true },
      ...(summary.allowances || []).map((a) => ({ conceptId: null, conceptName: a.name, conceptCode: null, subCategory: 'fixed_pay', amount: a.amount || 0, isTaxable: true })),
      ...(summary.otherAllowances || []).map((a) => ({ conceptId: null, conceptName: a.label || a.name || 'Allowance', conceptCode: null, subCategory: 'variable_pay', amount: parseFloat(a.amount) || 0, isTaxable: true })),
    ];
    const deductions = (d.otherDeductions || []).map((od) => ({ conceptId: null, conceptName: od.label || od.name || 'Deduction', conceptCode: null, subCategory: 'other_withholding', amount: parseFloat(od.amount) || 0 }));
    const otherDeductionsTotal = deductions.reduce((s, x) => s + x.amount, 0);
    const statutoryTotal = (d.paye || 0) + (d.nssf || 0) + (d.sha || 0) + (d.ahl || 0);
    const grossPay = summary.totalEarnings ?? summary.grossPay ?? 0;

    const resultDoc = {
      cycleId: cycle._id,
      employeeId: summary.employeeId,
      earnings, deductions, benefits: [], employerContributions: [],
      statutoryDeductions: {
        paye: d.paye || 0, nssf: d.nssf || 0, sha: d.sha || 0, ahl: d.ahl || 0,
        total: Math.round(statutoryTotal * 100) / 100,
        labels: {
          paye: summary.taxLabels?.incomeTax || 'PAYE',
          nssf: summary.taxLabels?.pension || 'NSSF',
          sha: summary.taxLabels?.health || 'SHA',
          ahl: summary.taxLabels?.housingLevy || 'Affordable Housing Levy',
        },
      },
      grossPay,
      totalDeductions: Math.round((statutoryTotal + otherDeductionsTotal) * 100) / 100,
      netPay: summary.netPay || 0,
      totalEmployerCost: grossPay,
      isProRata: false, proRataReason: null, proRataDays: null, workingDaysInCycle: null,
      overtimeHours: 0, overtimeAmount: 0, expenseReimbursements: 0,
      leave: [], leaveDeductionTotal: 0,
      hasException: false, exceptions: [],
      status: summary.paymentStatus === 'paid' ? 'paid' : 'approved',
      approvedBy: null, approvedAt: null,
      payslipUrl: null, payslipSentAt: null,
      migratedFromLegacy: true, legacySummaryId: summary._id,
      createdAt: summary.generatedAt || now, updatedAt: now,
    };
    const resultInsert = await db.collection('payroll_results').insertOne(resultDoc);

    const employee = await db.collection('employees').findOne({ _id: summary.employeeId });
    let pdfBuffer = null;
    try {
      pdfBuffer = await generatePayslipFromResult(employee || {}, resultDoc, cycle);
    } catch (e) {
      console.warn(`  (payslip PDF generation failed for employee ${summary.employeeId}, ${month}/${year}: ${e.message})`);
    }

    const payslipDoc = {
      employeeId: summary.employeeId,
      cycleId: cycle._id,
      resultId: resultInsert.insertedId,
      period: { month, year },
      grossPay,
      netPay: summary.netPay || 0,
      status: 'paid',
      pdfData: pdfBuffer ? pdfBuffer.toString('base64') : null,
      generatedAt: summary.generatedAt || now,
      migratedFromLegacy: true,
      createdAt: now,
    };
    const slip = await db.collection('payslips').insertOne(payslipDoc);
    await db.collection('payroll_results').updateOne(
      { _id: resultInsert.insertedId },
      { $set: { payslipUrl: `/api/payroll/payslips/${slip.insertedId}/pdf`, payslipSentAt: summary.generatedAt || now } }
    );

    migrated++;
  }

  // Recompute aggregate totals for every cycle touched by this migration
  for (const cacheKey of Object.keys(cycleCache)) {
    const cycle = cycleCache[cacheKey];
    const results = await db.collection('payroll_results').find({ cycleId: cycle._id }).toArray();
    const totals = results.reduce((acc, r) => ({
      totalGross: acc.totalGross + (r.grossPay || 0),
      totalDeductions: acc.totalDeductions + (r.totalDeductions || 0),
      totalNet: acc.totalNet + (r.netPay || 0),
      totalEmployerCost: acc.totalEmployerCost + (r.totalEmployerCost || 0),
    }), { totalGross: 0, totalDeductions: 0, totalNet: 0, totalEmployerCost: 0 });
    await db.collection('payroll_cycles').updateOne({ _id: cycle._id }, {
      $set: { ...totals, employeeCount: results.length, updatedAt: now },
    });
  }

  console.log(`\nMigration complete: ${migrated} record(s) migrated, ${skipped} skipped (already had a Cycles-engine result for that period).`);
  await client.close();
}

migrate().catch((err) => { console.error(err); process.exit(1); });
