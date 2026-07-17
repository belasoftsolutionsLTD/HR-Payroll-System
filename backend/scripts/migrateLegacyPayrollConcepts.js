/**
 * One-time migration: mirrors the three legacy payroll systems (staff_loans,
 * fixed_allowances, deduction_types) into the unified Concepts model
 * (payroll_concepts + employee_compensations, using the new scope/appliesTo
 * targeting from the Concepts unification work) — so both systems describe the
 * same underlying facts while lockCycleInternal is migrated over in a later,
 * separate step (behind the useUnifiedConceptsEngine flag).
 *
 * Idempotent — safe to re-run. Every doc this script creates carries a
 * `migratedFromLegacy` marker (keyed by loanType for staff_loans' shared concept,
 * or by the legacy doc's own _id for fixed_allowances/deduction_types and every
 * staff_loans-derived assignment), checked before insert so re-running never
 * creates duplicates.
 *
 * Does NOT delete or modify the legacy collections — staff_loans, fixed_allowances,
 * and deduction_types remain the system of record for lockCycleInternal until the
 * engine cutover (Phase 5/6). Re-run this script after any edit made through the
 * legacy admin UI to keep the mirrored concepts in sync, or make those legacy panels
 * read-only once this script's first run succeeds (recommended).
 *
 * Run: node scripts/migrateLegacyPayrollConcepts.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'school-erp';

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log('Connected to', DB_NAME);

  const now = new Date();
  const stats = { loanConceptsCreated: 0, loanAssignmentsCreated: 0, loanAssignmentsSkipped: 0,
    allowancesCreated: 0, allowancesSkipped: 0, deductionsCreated: 0, deductionsSkipped: 0 };

  // ── staff_loans ──────────────────────────────────────────────────────────────
  const loans = await db.collection('staff_loans').find({}).toArray();
  console.log(`Found ${loans.length} staff_loans record(s).`);

  const loanConceptCache = {}; // loanType -> concept doc
  for (const loan of loans) {
    const loanType = loan.loanType || 'Staff Loan';

    let concept = loanConceptCache[loanType];
    if (!concept) {
      concept = await db.collection('payroll_concepts').findOne({ subCategory: 'loans', loanType, migratedFromLegacy: true });
      if (!concept) {
        const code = `LOAN_${loanType.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
        const existingCode = await db.collection('payroll_concepts').findOne({ code });
        const doc = {
          name: loanType, code: existingCode ? `${code}_${Date.now()}` : code,
          category: 'deductions', subCategory: 'loans', type: 'fixed',
          defaultAmount: null, currency: 'KES',
          percentageOf: null, percentageValue: null, formula: null, brackets: null,
          loanType,
          isActive: true, isTaxable: false, isRecurring: true,
          appearsOnPayslip: true, alertIfUndefined: false,
          migratedFromLegacy: true,
          createdBy: null, createdAt: now, updatedAt: now,
        };
        const result = await db.collection('payroll_concepts').insertOne(doc);
        concept = { ...doc, _id: result.insertedId };
        stats.loanConceptsCreated++;
        console.log(`  Created concept "${loanType}" (${concept._id})`);
      }
      loanConceptCache[loanType] = concept;
    }

    const existingAssignment = await db.collection('employee_compensations').findOne({ migratedFromStaffLoanId: loan._id });
    if (existingAssignment) {
      stats.loanAssignmentsSkipped++;
      continue;
    }

    const assignmentDoc = {
      scope: 'individual',
      employeeId: loan.employeeId,
      conceptId: concept._id, conceptName: concept.name, conceptCode: concept.code,
      category: concept.category, subCategory: concept.subCategory,
      amount: loan.monthlyInstallment || 0, currency: 'KES',
      effectiveFrom: loan.startDate || now, effectiveTo: null, cycleId: null,
      isActive: loan.status === 'active',
      principal: loan.principal, openingBalance: loan.principal,
      balanceRemaining: loan.balanceRemaining, totalRepaid: loan.totalRepaid || 0,
      loanStatus: loan.status,
      notes: loan.notes || null,
      addedBy: null,
      migratedFromLegacy: true, migratedFromStaffLoanId: loan._id,
      createdAt: loan.createdAt || now, updatedAt: now,
    };
    await db.collection('employee_compensations').insertOne(assignmentDoc);
    stats.loanAssignmentsCreated++;
  }

  // ── fixed_allowances ─────────────────────────────────────────────────────────
  const allowances = await db.collection('fixed_allowances').find({}).toArray();
  console.log(`Found ${allowances.length} fixed_allowances record(s).`);

  for (const allowance of allowances) {
    const existingConcept = await db.collection('payroll_concepts').findOne({ migratedFromFixedAllowanceId: allowance._id });
    if (existingConcept) {
      stats.allowancesSkipped++;
      continue;
    }

    const code = `ALW_${(allowance.name || 'ALLOWANCE').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    const existingCode = await db.collection('payroll_concepts').findOne({ code });
    const conceptDoc = {
      name: allowance.name, code: existingCode ? `${code}_${Date.now()}` : code,
      category: 'earnings', subCategory: 'allowance', type: 'fixed',
      defaultAmount: allowance.amount || 0, currency: 'KES',
      percentageOf: null, percentageValue: null, formula: null, brackets: null, loanType: null,
      isActive: allowance.isEnabled !== false, isTaxable: allowance.isTaxable !== false, isRecurring: true,
      appearsOnPayslip: allowance.appearsOnPayslip !== false, alertIfUndefined: false,
      migratedFromLegacy: true, migratedFromFixedAllowanceId: allowance._id,
      createdBy: null, createdAt: now, updatedAt: now,
    };
    const conceptResult = await db.collection('payroll_concepts').insertOne(conceptDoc);

    const jobGroupIds = Array.isArray(allowance.jobGroupIds) ? allowance.jobGroupIds : [];
    const appliesTo = jobGroupIds.length
      ? { type: 'jobGroup', jobGroupIds: jobGroupIds.map((id) => new ObjectId(id)) }
      : { type: 'all' };

    await db.collection('employee_compensations').insertOne({
      scope: 'group', employeeId: null, appliesTo,
      conceptId: conceptResult.insertedId, conceptName: conceptDoc.name, conceptCode: conceptDoc.code,
      category: conceptDoc.category, subCategory: conceptDoc.subCategory,
      amount: allowance.amount || 0, currency: 'KES',
      effectiveFrom: now, effectiveTo: null, cycleId: null,
      isActive: allowance.isEnabled !== false,
      notes: allowance.description || null, addedBy: null,
      migratedFromLegacy: true, migratedFromFixedAllowanceId: allowance._id,
      createdAt: now, updatedAt: now,
    });
    stats.allowancesCreated++;
    console.log(`  Created concept "${allowance.name}" (allowance, ${conceptResult.insertedId})`);
  }

  // ── deduction_types ──────────────────────────────────────────────────────────
  const deductions = await db.collection('deduction_types').find({}).toArray();
  console.log(`Found ${deductions.length} deduction_types record(s).`);

  for (const deduction of deductions) {
    const existingConcept = await db.collection('payroll_concepts').findOne({ migratedFromDeductionTypeId: deduction._id });
    if (existingConcept) {
      stats.deductionsSkipped++;
      continue;
    }

    const isPercentage = deduction.type === 'percentage';
    const code = `DED_${(deduction.name || 'DEDUCTION').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    const existingCode = await db.collection('payroll_concepts').findOne({ code });
    const conceptDoc = {
      name: deduction.name, code: existingCode ? `${code}_${Date.now()}` : code,
      category: 'deductions', subCategory: 'other_withholding', type: isPercentage ? 'percentage' : 'fixed',
      defaultAmount: isPercentage ? null : (deduction.amount || 0), currency: 'KES',
      percentageOf: isPercentage ? 'gross_salary' : null,
      percentageValue: isPercentage ? (deduction.percentage || 0) : null,
      formula: null, brackets: null, loanType: null,
      isActive: deduction.isEnabled !== false, isTaxable: false, isRecurring: true,
      appearsOnPayslip: true, alertIfUndefined: false,
      migratedFromLegacy: true, migratedFromDeductionTypeId: deduction._id,
      createdBy: null, createdAt: now, updatedAt: now,
    };
    const conceptResult = await db.collection('payroll_concepts').insertOne(conceptDoc);

    const jobGroupIds = Array.isArray(deduction.jobGroupIds) ? deduction.jobGroupIds : [];
    const appliesTo = jobGroupIds.length
      ? { type: 'jobGroup', jobGroupIds: jobGroupIds.map((id) => new ObjectId(id)) }
      : { type: 'all' };

    await db.collection('employee_compensations').insertOne({
      scope: 'group', employeeId: null, appliesTo,
      conceptId: conceptResult.insertedId, conceptName: conceptDoc.name, conceptCode: conceptDoc.code,
      category: conceptDoc.category, subCategory: conceptDoc.subCategory,
      amount: isPercentage ? 0 : (deduction.amount || 0), currency: 'KES',
      effectiveFrom: now, effectiveTo: null, cycleId: null,
      isActive: deduction.isEnabled !== false,
      notes: deduction.description || null, addedBy: null,
      migratedFromLegacy: true, migratedFromDeductionTypeId: deduction._id,
      createdAt: now, updatedAt: now,
    });
    stats.deductionsCreated++;
    console.log(`  Created concept "${deduction.name}" (deduction, ${conceptResult.insertedId})`);
  }

  console.log('\nMigration complete:');
  console.log(`  Loans:      ${stats.loanConceptsCreated} concept(s) created, ${stats.loanAssignmentsCreated} assignment(s) created, ${stats.loanAssignmentsSkipped} skipped (already migrated)`);
  console.log(`  Allowances: ${stats.allowancesCreated} created, ${stats.allowancesSkipped} skipped (already migrated)`);
  console.log(`  Deductions: ${stats.deductionsCreated} created, ${stats.deductionsSkipped} skipped (already migrated)`);
  console.log('\nLegacy collections (staff_loans, fixed_allowances, deduction_types) were left untouched — lockCycleInternal still reads them exclusively.');

  await client.close();
}

migrate().catch((err) => { console.error(err); process.exit(1); });
