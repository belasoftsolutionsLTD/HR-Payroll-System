#!/usr/bin/env node
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md), Phase 1
// slice of the eventual full ETL script (Phase 11 assembles the rest module-by-module).
//
// STRICTLY READ-ONLY against Mongo, write-only against Postgres. This never calls
// insertOne/updateOne/deleteOne/etc. on the Mongo side — only .find(). Safe to run
// against the real (shared local-dev/production) Atlas cluster referenced by
// MONGO_DB_URI, per the project's own known trap: bare `node -e` scripts silently
// hitting the wrong database. This script always loads .env via dotenv and always
// logs which Mongo/Postgres targets it connected to before touching anything.
//
// Idempotent: every write is an upsert (`insert ... on conflict (id) do update`), so
// re-running is always safe and just refreshes rows to match Mongo's current state.
//
// Usage:
//   node scripts/migrateMongoToPostgres.js            # copies data
//   node scripts/migrateMongoToPostgres.js --dry-run   # counts only, writes nothing

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const knex = require('../src/functions/Database/pgClient');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 200;

const idStr = (v) => (v === undefined || v === null ? null : String(v));
const toDate = (v) => (v === undefined || v === null ? null : new Date(v));

const log = (...args) => console.log('[migrate]', ...args);

// Upserts in fixed-size batches so a single collection's worth of rows never becomes
// one giant INSERT statement. `rows` must already have every value coerced to a
// Postgres-safe type (string/number/boolean/Date/plain-object-for-jsonb).
async function upsertBatched(table, rows, conflictKeys = ['id']) {
  if (!rows.length) return 0;
  if (DRY_RUN) return rows.length;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    // conflictKeys === null means "plain insert, no upsert" — used for tables with no
    // natural conflict key to upsert against (e.g. employee_skills' auto-increment id,
    // which is cleared-and-reinserted per employee instead — see call site).
    await (conflictKeys ? knex(table).insert(batch).onConflict(conflictKeys).merge() : knex(table).insert(batch));
  }
  return rows.length;
}

async function main() {
  log(DRY_RUN ? 'DRY RUN — counting only, no writes' : 'LIVE RUN — will write to Postgres');
  log('Mongo source:', (process.env.MONGO_DB_URI || '').replace(/:[^:@]+@/, ':***@'));
  log('Postgres target:', (process.env.DATABASE_URL || '').replace(/:[^:@]+@/, ':***@'));

  const mongoClient = new MongoClient(process.env.MONGO_DB_URI);
  await mongoClient.connect();
  const dbo = mongoClient.db('school-erp');

  const counts = {};

  try {
    // ── departments ────────────────────────────────────────────────────────
    const departments = await dbo.collection('departments').find({}).toArray();
    counts.departments = await upsertBatched('departments', departments.map((d) => ({
      id: idStr(d._id), name: d.name, description: d.description ?? null,
      createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt),
    })));

    // ── branches ───────────────────────────────────────────────────────────
    const branches = await dbo.collection('branches').find({}).toArray();
    counts.branches = await upsertBatched('branches', branches.map((b) => ({
      id: idStr(b._id), name: b.name, address: b.address ?? null, phone: b.phone ?? null,
      email: b.email ?? null, contactPerson: b.contactPerson ?? null,
      createdAt: toDate(b.createdAt), updatedAt: toDate(b.updatedAt),
    })));

    // ── job_groups ─────────────────────────────────────────────────────────
    const jobGroups = await dbo.collection('job_groups').find({}).toArray();
    counts.job_groups = await upsertBatched('job_groups', jobGroups.map((g) => ({
      id: idStr(g._id), name: g.name, salaryMin: g.salaryMin ?? null, salaryMax: g.salaryMax ?? null,
      description: g.description ?? null, createdAt: toDate(g.createdAt), updatedAt: toDate(g.updatedAt),
    })));

    // ── designations (+ designation_departments join table) ─────────────────
    const designations = await dbo.collection('designations').find({}).toArray();
    counts.designations = await upsertBatched('designations', designations.map((d) => ({
      id: idStr(d._id), name: d.name, createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt),
    })));
    const designationDepartments = designations.flatMap((d) =>
      (Array.isArray(d.departmentIds) ? d.departmentIds : []).map((depId) => ({
        designationId: idStr(d._id), departmentId: idStr(depId),
      }))
    );
    counts.designation_departments = await upsertBatched(
      'designation_departments', designationDepartments, ['designationId', 'departmentId']
    );

    // ── employees (parent row first, managerId set in a second pass) ────────
    const employees = await dbo.collection('employees').find({}).toArray();
    counts.employees = await upsertBatched('employees', employees.map((e) => ({
      id: idStr(e._id),
      fullName: e.fullName, firstName: e.firstName ?? null, lastName: e.lastName ?? null,
      nationalId: e.nationalId, staffNumber: e.staffNumber ?? null,
      designation: e.designation, employmentType: e.employmentType, department: e.department,
      jobGroupId: idStr(e.jobGroupId),
      dateOfHire: toDate(e.dateOfHire), dateOfBirth: toDate(e.dateOfBirth),
      contractEndDate: toDate(e.contractEndDate), probationEndDate: toDate(e.probationEndDate),
      confirmationDate: toDate(e.confirmationDate), terminationDate: toDate(e.terminationDate),
      terminationReason: e.terminationReason ?? null,
      preferredName: e.preferredName ?? null, gender: e.gender ?? null, maritalStatus: e.maritalStatus ?? null,
      nationality: e.nationality ?? null, passportNumber: e.passportNumber ?? null,
      passportExpiryDate: toDate(e.passportExpiryDate), address: e.address ?? null,
      nextOfKin: e.nextOfKin ? JSON.stringify(e.nextOfKin) : null,
      grossPay: e.grossPay ?? null, kraPin: e.kraPin ?? null, paymentMethod: e.paymentMethod ?? 'bank_transfer',
      bankName: e.bankName ?? null, bankAccountNumber: e.bankAccountNumber ?? null, mpesaNumber: e.mpesaNumber ?? null,
      paypalEmail: e.paypalEmail ?? null, cryptoWalletAddress: e.cryptoWalletAddress ?? null, cryptoNetwork: e.cryptoNetwork ?? null,
      email: e.email, phone: e.phone ?? null, profilePhoto: e.profilePhoto ?? null,
      location: e.location ?? null, branchId: idStr(e.branchId), costCenter: e.costCenter ?? null,
      managerId: null, // second pass below
      payGroup: e.payGroup ?? 'all', payFrequency: e.payFrequency ?? 'monthly',
      status: e.status ?? 'active', createdAt: toDate(e.createdAt), updatedAt: toDate(e.updatedAt),
    })));

    if (!DRY_RUN) {
      const withManager = employees.filter((e) => e.managerId);
      for (let i = 0; i < withManager.length; i += BATCH_SIZE) {
        await Promise.all(withManager.slice(i, i + BATCH_SIZE).map((e) =>
          knex('employees').where({ id: idStr(e._id) }).update({ managerId: idStr(e.managerId) })
        ));
      }
      log('employees.managerId second pass:', withManager.length, 'rows');
    }

    // ── employees' embedded-array child tables ───────────────────────────────
    const documents = employees.flatMap((e) => (e.documents || []).map((d) => ({
      id: idStr(d.docId), employeeId: idStr(e._id), docType: d.docType,
      fileName: d.fileName, filePath: d.filePath, uploadedAt: toDate(d.uploadedAt),
    })));
    counts.employee_documents = await upsertBatched('employee_documents', documents);

    const emergencyContacts = employees.flatMap((e) => (e.emergencyContacts || []).map((c) => ({
      id: idStr(c.id) || new ObjectId().toString(), employeeId: idStr(e._id),
      name: c.name ?? null, relationship: c.relationship ?? null, phone: c.phone ?? null, email: c.email ?? null,
    })));
    counts.employee_emergency_contacts = await upsertBatched('employee_emergency_contacts', emergencyContacts);

    const skills = employees.flatMap((e) => (e.skills || []).map((s, i) => ({
      employeeId: idStr(e._id), skill: String(s), position: i,
    })));
    // employee_skills uses an auto-increment id — re-running would duplicate rows, so
    // this one collection is delete-then-insert per employee instead of upsert-on-id.
    if (!DRY_RUN) {
      for (const e of employees) {
        await knex('employee_skills').where({ employeeId: idStr(e._id) }).del();
      }
    }
    counts.employee_skills = await upsertBatched('employee_skills', skills.map(({ id, ...rest }) => rest), null);

    const certifications = employees.flatMap((e) => (e.certifications || []).map((c) => ({
      id: idStr(c.id), employeeId: idStr(e._id), name: c.name, issuingOrganization: c.issuingOrganization,
      issueDate: toDate(c.issueDate), expiryDate: toDate(c.expiryDate), fileUrl: c.fileUrl ?? null,
    })));
    counts.employee_certifications = await upsertBatched('employee_certifications', certifications);

    const educationHistory = employees.flatMap((e) => (e.educationHistory || []).map((ed) => ({
      id: idStr(ed.id), employeeId: idStr(e._id), institution: ed.institution, degree: ed.degree,
      fieldOfStudy: ed.fieldOfStudy, startYear: ed.startYear ?? null, endYear: ed.endYear ?? null,
    })));
    counts.employee_education_history = await upsertBatched('employee_education_history', educationHistory);

    // ── users (parent row first, createdBy set in a second pass) ────────────
    const users = await dbo.collection('users').find({}).toArray();
    counts.users = await upsertBatched('users', users.map((u) => ({
      id: idStr(u._id), name: u.name, email: u.email, password: u.password, role: u.role,
      employeeId: idStr(u.employeeId), department: u.department ?? null,
      mustResetPassword: u.mustResetPassword ?? false, isActive: u.isActive ?? true,
      tokenVersion: u.tokenVersion ?? 0, refreshTokenHash: u.refreshTokenHash ?? null,
      refreshTokenExpiresAt: toDate(u.refreshTokenExpiresAt),
      passwordResetToken: u.passwordResetToken ?? null, passwordResetExpires: toDate(u.passwordResetExpires),
      mfaEnabled: u.mfaEnabled ?? false, mfaSecret: u.mfaSecret ?? null,
      createdBy: null, // second pass below
      createdAt: toDate(u.createdAt), updatedAt: toDate(u.updatedAt),
    })));

    if (!DRY_RUN) {
      const withCreatedBy = users.filter((u) => u.createdBy);
      for (let i = 0; i < withCreatedBy.length; i += BATCH_SIZE) {
        await Promise.all(withCreatedBy.slice(i, i + BATCH_SIZE).map((u) =>
          knex('users').where({ id: idStr(u._id) }).update({ createdBy: idStr(u.createdBy) })
        ));
      }
      log('users.createdBy second pass:', withCreatedBy.length, 'rows');
    }

    // ── job_history ────────────────────────────────────────────────────────
    const jobHistory = await dbo.collection('job_history').find({}).toArray();
    counts.job_history = await upsertBatched('job_history', jobHistory.map((j) => ({
      id: idStr(j._id), employeeId: idStr(j.employeeId), changeType: j.changeType,
      effectiveDate: toDate(j.effectiveDate),
      previousValues: j.previousValues ? JSON.stringify(j.previousValues) : null,
      newValues: j.newValues ? JSON.stringify(j.newValues) : null,
      reason: j.reason ?? null, changedBy: idStr(j.changedBy), changedByName: j.changedByName ?? null,
      createdAt: toDate(j.createdAt),
    })));

    // ── company_accounts ───────────────────────────────────────────────────
    const companyAccounts = await dbo.collection('company_accounts').find({}).toArray();
    counts.company_accounts = await upsertBatched('company_accounts', companyAccounts.map((a) => ({
      id: idStr(a._id), name: a.name, accountType: a.accountType,
      bankName: a.bankName ?? null, accountNumber: a.accountNumber ?? null, swiftCode: a.swiftCode ?? null,
      ibanNumber: a.ibanNumber ?? null, mpesaNumber: a.mpesaNumber ?? null, paypalEmail: a.paypalEmail ?? null,
      wiseEmail: a.wiseEmail ?? null, stripeAccountId: a.stripeAccountId ?? null,
      flutterwaveAccountId: a.flutterwaveAccountId ?? null, currency: a.currency ?? null,
      isActive: a.isActive ?? null, createdAt: toDate(a.createdAt), updatedAt: toDate(a.updatedAt),
    })));

    // ── compensation_audit_logs ────────────────────────────────────────────
    const compAuditLogs = await dbo.collection('compensation_audit_logs').find({}).toArray();
    counts.compensation_audit_logs = await upsertBatched('compensation_audit_logs', compAuditLogs.map((c) => ({
      id: idStr(c._id), employeeId: idStr(c.employeeId), compensationId: idStr(c.compensationId),
      conceptName: c.conceptName ?? null, action: c.action,
      changes: c.changes ? JSON.stringify(c.changes) : null,
      performedBy: idStr(c.performedBy), performedAt: toDate(c.performedAt),
    })));

    // ── staff_notes ────────────────────────────────────────────────────────
    const staffNotes = await dbo.collection('staff_notes').find({}).toArray();
    counts.staff_notes = await upsertBatched('staff_notes', staffNotes.map((n) => ({
      id: idStr(n._id), employeeId: idStr(n.employeeId), category: n.category, note: n.note,
      createdBy: idStr(n.createdBy), createdAt: toDate(n.createdAt),
    })));

    // ── counters (only the staff_number_* keys Phase 1 actually consumes — see
    // generateStaffNumber. Every other counter key stays Mongo-only until whichever
    // later phase migrates the module that owns it, so it isn't left stale in two
    // places at once.) ────────────────────────────────────────────────────────
    const staffNumberCounters = await dbo.collection('counters')
      .find({ _id: { $regex: /^staff_number_/ } }).toArray();
    counts.counters = await upsertBatched('counters', staffNumberCounters.map((c) => ({
      id: idStr(c._id), seq: c.seq ?? 0,
    })));

    // ══════════════════════════════════════════════════════════════════════
    // Phase 2 — payroll: concepts, compensations, cycles, results (+ its five
    // line-item child tables + exceptions), payslips, welfare schemes.
    // ══════════════════════════════════════════════════════════════════════

    // ── payroll_concepts ──────────────────────────────────────────────────
    const concepts = await dbo.collection('payroll_concepts').find({}).toArray();
    counts.payroll_concepts = await upsertBatched('payroll_concepts', concepts.map((c) => ({
      id: idStr(c._id), name: c.name, code: c.code ?? null, category: c.category, subCategory: c.subCategory,
      type: c.type, defaultAmount: c.defaultAmount ?? null, currency: c.currency ?? 'KES',
      percentageOf: c.percentageOf ?? null, percentageValue: c.percentageValue ?? null, formula: c.formula ?? null,
      brackets: c.brackets ? JSON.stringify(c.brackets) : null, loanType: c.loanType ?? null,
      cap: c.cap ?? null, flatCredit: c.flatCredit ?? null,
      deductConceptCodesFromBase: c.deductConceptCodesFromBase || [],
      // isTaxable: `!== false`, not `?? false` — matches resolveConceptPayItems.js's own
      // read semantics, where an absent field (real data: the BASIC concept has none)
      // means taxable. See the migration file's matching comment on the column default.
      statutoryKey: c.statutoryKey ?? null, isActive: c.isActive ?? true, isTaxable: c.isTaxable !== false,
      isRecurring: c.isRecurring ?? false, appearsOnPayslip: c.appearsOnPayslip ?? true, alertIfUndefined: c.alertIfUndefined ?? false,
      createdBy: idStr(c.createdBy), createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    // ── payroll_cycles ─────────────────────────────────────────────────────
    const cycles = await dbo.collection('payroll_cycles').find({}).toArray();
    counts.payroll_cycles = await upsertBatched('payroll_cycles', cycles.map((c) => ({
      id: idStr(c._id), name: c.name,
      periodMonth: c.period?.month ?? null, periodYear: c.period?.year ?? null,
      periodStartDate: toDate(c.period?.startDate), periodEndDate: toDate(c.period?.endDate),
      payDate: toDate(c.payDate), status: c.status, payGroup: c.payGroup ?? 'all', payFrequency: c.payFrequency ?? null,
      runType: c.runType ?? 'regular', offCycleReason: c.offCycleReason ?? null,
      targetEmployeeIds: c.targetEmployeeIds?.length ? c.targetEmployeeIds.map((id) => idStr(id)) : null,
      departmentId: idStr(c.departmentId), jobGroupId: idStr(c.jobGroupId), employmentType: c.employmentType ?? null,
      currency: c.currency ?? 'KES', totalGross: c.totalGross ?? 0, totalDeductions: c.totalDeductions ?? 0,
      totalNet: c.totalNet ?? 0, totalEmployerCost: c.totalEmployerCost ?? 0, employeeCount: c.employeeCount ?? 0,
      hasExceptions: c.hasExceptions ?? false, exceptionCount: c.exceptionCount ?? 0,
      excludedEmployees: c.excludedEmployees ? JSON.stringify(c.excludedEmployees) : null,
      isLocking: false, isClosing: false, // in-flight claim flags never survive into a copy
      lockedAt: toDate(c.lockedAt), lockedBy: idStr(c.lockedBy), closedAt: toDate(c.closedAt), closedBy: idStr(c.closedBy),
      createdBy: idStr(c.createdBy), createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    // ── employee_compensations ────────────────────────────────────────────
    const compensations = await dbo.collection('employee_compensations').find({}).toArray();
    counts.employee_compensations = await upsertBatched('employee_compensations', compensations.map((c) => ({
      id: idStr(c._id), employeeId: idStr(c.employeeId), conceptId: idStr(c.conceptId),
      conceptName: c.conceptName ?? null, conceptCode: c.conceptCode ?? null, category: c.category ?? null, subCategory: c.subCategory ?? null,
      amount: c.amount ?? 0, currency: c.currency ?? 'KES', effectiveFrom: toDate(c.effectiveFrom), effectiveTo: toDate(c.effectiveTo),
      cycleId: idStr(c.cycleId), scope: c.scope ?? 'individual', appliesTo: c.appliesTo ? JSON.stringify(c.appliesTo) : null,
      isActive: c.isActive ?? true, addedBy: idStr(c.addedBy), notes: c.notes ?? null,
      principal: c.principal ?? null, openingBalance: c.openingBalance ?? null, balanceRemaining: c.balanceRemaining ?? null,
      totalRepaid: c.totalRepaid ?? null, loanStatus: c.loanStatus ?? null,
      createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    // ── payroll_results (+ its five line-item child tables + exceptions) ──
    const results = await dbo.collection('payroll_results').find({}).toArray();
    counts.payroll_results = await upsertBatched('payroll_results', results.map((r) => ({
      id: idStr(r._id), cycleId: idStr(r.cycleId), employeeId: idStr(r.employeeId),
      grossPay: r.grossPay ?? null, totalDeductions: r.totalDeductions ?? null, netPay: r.netPay ?? null,
      totalEmployerCost: r.totalEmployerCost ?? null, isProRata: r.isProRata ?? null, proRataReason: r.proRataReason ?? null,
      proRataDays: r.proRataDays ?? null, workingDaysInCycle: r.workingDaysInCycle ?? null,
      overtimeHours: r.overtimeHours ?? null, overtimeAmount: r.overtimeAmount ?? null,
      expenseReimbursements: r.expenseReimbursements ?? null, leaveDeductionTotal: r.leaveDeductionTotal ?? null,
      statutoryPaye: r.statutoryDeductions?.paye ?? null, statutoryNssf: r.statutoryDeductions?.nssf ?? null,
      statutorySha: r.statutoryDeductions?.sha ?? null, statutoryAhl: r.statutoryDeductions?.ahl ?? null,
      statutoryTotal: r.statutoryDeductions?.total ?? null,
      statutoryLabels: r.statutoryDeductions?.labels ? JSON.stringify(r.statutoryDeductions.labels) : null,
      hasException: r.hasException ?? false, engine: r.engine ?? 'concepts', status: r.status ?? 'pending',
      approvedBy: idStr(r.approvedBy), approvedAt: toDate(r.approvedAt),
      payslipUrl: r.payslipUrl ?? null, payslipSentAt: toDate(r.payslipSentAt),
      createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
    })));

    // Child line-item tables use an auto-increment id (plain array elements in Mongo) —
    // delete-then-insert per result, same convention as Phase 1's employee_skills.
    const lineItemRows = (field) => results.flatMap((r) => (r[field] || []).map((item, position) => ({ resultId: idStr(r._id), position, ...item })));

    if (!DRY_RUN) {
      for (const r of results) {
        await knex('payroll_result_earnings').where({ resultId: idStr(r._id) }).del();
        await knex('payroll_result_deductions').where({ resultId: idStr(r._id) }).del();
        await knex('payroll_result_benefits').where({ resultId: idStr(r._id) }).del();
        await knex('payroll_result_employer_contributions').where({ resultId: idStr(r._id) }).del();
        await knex('payroll_result_leave').where({ resultId: idStr(r._id) }).del();
        await knex('payroll_result_exceptions').where({ resultId: idStr(r._id) }).del();
      }
    }

    counts.payroll_result_earnings = await upsertBatched('payroll_result_earnings', lineItemRows('earnings').map((e) => ({
      resultId: e.resultId, position: e.position, conceptId: idStr(e.conceptId), conceptName: e.conceptName ?? null,
      conceptCode: e.conceptCode ?? null, subCategory: e.subCategory ?? null, amount: e.amount ?? 0,
      source: e.source ?? null, isTaxable: e.isTaxable ?? null,
    })), null);

    counts.payroll_result_deductions = await upsertBatched('payroll_result_deductions', lineItemRows('deductions').map((d) => ({
      resultId: d.resultId, position: d.position, conceptId: idStr(d.conceptId), conceptName: d.conceptName ?? null,
      conceptCode: d.conceptCode ?? null, subCategory: d.subCategory ?? null, amount: d.amount ?? 0, source: d.source ?? null,
      loanAssignmentId: idStr(d.loanAssignmentId), balanceAfter: d.balanceAfter ?? null,
    })), null);

    counts.payroll_result_benefits = await upsertBatched('payroll_result_benefits', lineItemRows('benefits').map((b) => ({
      resultId: b.resultId, position: b.position, conceptId: idStr(b.conceptId), conceptName: b.conceptName ?? null, amount: b.amount ?? 0,
    })), null);

    counts.payroll_result_employer_contributions = await upsertBatched('payroll_result_employer_contributions', lineItemRows('employerContributions').map((e) => ({
      resultId: e.resultId, position: e.position, conceptId: idStr(e.conceptId), conceptName: e.conceptName ?? null, amount: e.amount ?? 0,
    })), null);

    counts.payroll_result_leave = await upsertBatched('payroll_result_leave', lineItemRows('leave').map((l) => ({
      resultId: l.resultId, position: l.position, leaveType: l.leaveType ?? null,
      startDate: l.startDate ?? null, endDate: l.endDate ?? null, days: l.days ?? null, amount: l.amount ?? 0,
    })), null);

    counts.payroll_result_exceptions = await upsertBatched('payroll_result_exceptions', lineItemRows('exceptions').map((e) => ({
      resultId: e.resultId, position: e.position, type: e.type ?? null, message: e.message ?? null, severity: e.severity ?? null,
    })), null);

    // ── payslips (base64 pdfData → a real file on disk + pdfPath, per the plan) ──
    const payslips = await dbo.collection('payslips').find({}).toArray();
    const uploadDir = process.env.UPLOAD_DIR || 'uploads';
    if (!DRY_RUN && payslips.some((p) => p.pdfData) && !fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    counts.payslips = await upsertBatched('payslips', payslips.map((p) => {
      let pdfPath = null;
      if (p.pdfData) {
        pdfPath = path.join(uploadDir, `payslip-${idStr(p._id)}.pdf`);
        if (!DRY_RUN && !fs.existsSync(pdfPath)) fs.writeFileSync(pdfPath, Buffer.from(p.pdfData, 'base64'));
      }
      return {
        id: idStr(p._id), employeeId: idStr(p.employeeId), cycleId: idStr(p.cycleId), resultId: idStr(p.resultId),
        periodMonth: p.period?.month ?? null, periodYear: p.period?.year ?? null,
        grossPay: p.grossPay ?? null, netPay: p.netPay ?? null, status: p.status ?? 'paid', pdfPath,
        generatedAt: toDate(p.generatedAt), createdAt: toDate(p.createdAt),
      };
    }));

    // ── welfare_schemes ────────────────────────────────────────────────────
    const welfareSchemes = await dbo.collection('welfare_schemes').find({}).toArray();
    counts.welfare_schemes = await upsertBatched('welfare_schemes', welfareSchemes.map((s) => ({
      id: idStr(s._id), name: s.name, description: s.description ?? null, conceptId: idStr(s.conceptId),
      contributionAmount: s.contributionAmount ?? null, contributionType: s.contributionType ?? null,
      percentageOf: s.percentageOf ?? null, isActive: s.isActive ?? true,
      createdBy: idStr(s.createdBy), createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    // ══════════════════════════════════════════════════════════════════════
    // Phase 3a — leave: types, public holidays, accrual policies, balances,
    // requests, audit log, blackouts.
    // ══════════════════════════════════════════════════════════════════════

    const leaveTypes = await dbo.collection('leave_types').find({}).toArray();
    counts.leave_types = await upsertBatched('leave_types', leaveTypes.map((lt) => ({
      id: idStr(lt._id), name: lt.name, code: lt.code ?? null, description: lt.description ?? null,
      isPaid: lt.isPaid ?? true, isCarryOverAllowed: lt.isCarryOverAllowed ?? false,
      maxCarryOverDays: lt.maxCarryOverDays ?? null, carryOverExpiryMonths: lt.carryOverExpiryMonths ?? null,
      requiresApproval: lt.requiresApproval ?? true, requiresAttachment: lt.requiresAttachment ?? false,
      minNoticeDays: lt.minNoticeDays ?? null, maxConsecutiveDays: lt.maxConsecutiveDays ?? null,
      eligibilityMonths: lt.eligibilityMonths ?? null, countPublicHolidays: lt.countPublicHolidays ?? false,
      color: lt.color ?? '#3b82f6', isActive: lt.isActive ?? true,
      appliesTo: lt.appliesTo ? JSON.stringify(lt.appliesTo) : null,
      createdBy: idStr(lt.createdBy), createdAt: toDate(lt.createdAt), updatedAt: toDate(lt.updatedAt),
    })));

    const holidays = await dbo.collection('public_holidays').find({}).toArray();
    counts.public_holidays = await upsertBatched('public_holidays', holidays.map((h) => ({
      id: idStr(h._id), name: h.name, date: h.date, isRecurringAnnually: h.isRecurringAnnually ?? false,
      appliesTo: h.appliesTo ? JSON.stringify(h.appliesTo) : null,
      createdBy: idStr(h.createdBy), createdAt: toDate(h.createdAt),
    })));

    const accrualPolicies = await dbo.collection('leave_accrual_policies').find({}).toArray();
    counts.leave_accrual_policies = await upsertBatched('leave_accrual_policies', accrualPolicies.map((p) => ({
      id: idStr(p._id), name: p.name, leaveTypeId: idStr(p.leaveTypeId), accrualFrequency: p.accrualFrequency,
      accrualAmount: p.accrualAmount, maxAnnualEntitlement: p.maxAnnualEntitlement,
      appliesTo: p.appliesTo ? JSON.stringify(p.appliesTo) : null, isActive: p.isActive ?? true,
      createdBy: idStr(p.createdBy), createdAt: toDate(p.createdAt),
    })));

    const balances = await dbo.collection('leave_balances').find({}).toArray();
    counts.leave_balances = await upsertBatched('leave_balances', balances.map((b) => ({
      id: idStr(b._id), employeeId: idStr(b.employeeId), leaveTypeId: idStr(b.leaveTypeId), year: b.year,
      openingBalance: b.openingBalance ?? 0, accrued: b.accrued ?? 0, used: b.used ?? 0, pending: b.pending ?? 0,
      carriedOver: b.carriedOver ?? 0, carryOverExpiry: toDate(b.carryOverExpiry), closingBalance: b.closingBalance ?? 0,
      lastAccrualDate: toDate(b.lastAccrualDate), updatedAt: toDate(b.updatedAt),
    })));

    const leaveRequests = await dbo.collection('leave_requests').find({}).toArray();
    counts.leave_requests = await upsertBatched('leave_requests', leaveRequests.map((r) => ({
      id: idStr(r._id), employeeId: idStr(r.employeeId), leaveTypeId: idStr(r.leaveTypeId),
      startDate: toDate(r.startDate), endDate: toDate(r.endDate), totalDays: r.totalDays,
      halfDay: r.halfDay ?? null, reason: r.reason ?? null, attachmentUrl: r.attachmentUrl ?? null,
      status: r.status, approvalChain: r.approvalChain ? JSON.stringify(r.approvalChain) : null,
      currentApprovalLevel: r.currentApprovalLevel ?? 0, rejectionReason: r.rejectionReason ?? null,
      cancelledAt: toDate(r.cancelledAt), cancelledBy: idStr(r.cancelledBy),
      revokedAt: toDate(r.revokedAt), revokedBy: idStr(r.revokedBy),
      disputeReason: r.disputeReason ?? null, disputeSource: r.disputeSource ?? null,
      disputeResolvedAt: toDate(r.disputeResolvedAt), disputeResolvedBy: idStr(r.disputeResolvedBy),
      proposedDays: r.proposedDays ?? null, counterOfferReason: r.counterOfferReason ?? null,
      payrollRunId: idStr(r.payrollRunId),
      leaveStartReminderSent: r.leaveStartReminderSent ?? false, leaveEndReminderSent: r.leaveEndReminderSent ?? false,
      createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
    })));

    const leaveAuditLog = await dbo.collection('leave_audit_log').find({}).toArray();
    counts.leave_audit_log = await upsertBatched('leave_audit_log', leaveAuditLog.map((a) => ({
      id: idStr(a._id), leaveRequestId: idStr(a.leaveRequestId), employeeId: idStr(a.employeeId), action: a.action,
      performedBy: idStr(a.performedBy), performedByName: a.performedByName ?? null,
      previousValue: a.previousValue !== undefined ? JSON.stringify(a.previousValue) : null,
      newValue: a.newValue !== undefined ? JSON.stringify(a.newValue) : null,
      comment: a.comment ?? null, timestamp: toDate(a.timestamp),
    })));

    const blackouts = await dbo.collection('leave_blackouts').find({}).toArray();
    counts.leave_blackouts = await upsertBatched('leave_blackouts', blackouts.map((b) => ({
      id: idStr(b._id), name: b.name, startDate: toDate(b.startDate), endDate: toDate(b.endDate),
      departments: b.departments || [], createdBy: idStr(b.createdBy), createdAt: toDate(b.createdAt),
    })));

    // ══════════════════════════════════════════════════════════════════════
    // Phase 3b — attendance: records (+ breaks child table), work schedules,
    // shift task templates, shifts (+ tasks/notes/applications), employee
    // schedule assignments, timesheets, attendance settings.
    // ══════════════════════════════════════════════════════════════════════

    // Real data has a handful of exact-duplicate (employeeId, date) pairs (a race in
    // autoMarkAbsent's bulkWrite upsert, confirmed live — same status, created
    // milliseconds apart) that would violate the new unique constraint the app's own
    // upsert-by-(employeeId,date) pattern needs going forward. Dedupe by keeping the
    // most recently updated row per pair — safe here since every found duplicate pair
    // was functionally identical, not divergent data.
    const rawAttendanceRecords = await dbo.collection('attendance_records').find({}).toArray();
    const attendanceRecordsByKey = new Map();
    for (const r of rawAttendanceRecords) {
      const key = `${idStr(r.employeeId)}|${r.date}`;
      const existing = attendanceRecordsByKey.get(key);
      if (!existing || new Date(r.updatedAt || r.createdAt || 0) >= new Date(existing.updatedAt || existing.createdAt || 0)) {
        attendanceRecordsByKey.set(key, r);
      }
    }
    const attendanceRecords = [...attendanceRecordsByKey.values()];
    counts.attendance_records = await upsertBatched('attendance_records', attendanceRecords.map((r) => ({
      id: idStr(r._id), employeeId: idStr(r.employeeId), date: r.date, status: r.status ?? null,
      checkInTime: r.checkInTime ?? null, checkOutTime: r.checkOutTime ?? null,
      checkInAt: toDate(r.checkInAt), checkOutAt: toDate(r.checkOutAt),
      checkInLat: r.checkInLat ?? null, checkInLng: r.checkInLng ?? null,
      checkOutLat: r.checkOutLat ?? null, checkOutLng: r.checkOutLng ?? null,
      checkInLocation: r.checkInLocation ?? null, checkOutLocation: r.checkOutLocation ?? null,
      location: r.location ?? null, mode: r.mode ?? null,
      selfMarked: r.selfMarked ?? false, isManualEntry: r.isManualEntry ?? false, markedBy: idStr(r.markedBy),
      notes: r.notes ?? null, totalWorkMinutes: r.totalWorkMinutes ?? null, totalBreakMinutes: r.totalBreakMinutes ?? null,
      regularMinutes: r.regularMinutes ?? null, overtimeMinutes: r.overtimeMinutes ?? null, overtimeHours: r.overtimeHours ?? null,
      overtimeBreakdown: r.overtimeBreakdown ? JSON.stringify(r.overtimeBreakdown) : null, payCategory: r.payCategory ?? null,
      lateMarked: r.lateMarked ?? false, missedClockOutNotified: r.missedClockOutNotified ?? false, autoMarked: r.autoMarked ?? false,
      createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
    })));

    // attendance_breaks uses an auto-increment id (plain array elements in Mongo) —
    // delete-then-insert per record, same convention as Phase 1's employee_skills.
    const breakRows = attendanceRecords.flatMap((r) => (r.breaks || []).map((b) => ({
      attendanceRecordId: idStr(r._id), startTime: toDate(b.startTime), endTime: toDate(b.endTime), duration: b.duration ?? null,
    })));
    if (!DRY_RUN) {
      for (const r of attendanceRecords) {
        await knex('attendance_breaks').where({ attendanceRecordId: idStr(r._id) }).del();
      }
    }
    counts.attendance_breaks = await upsertBatched('attendance_breaks', breakRows, null);

    const workSchedules = await dbo.collection('work_schedules').find({}).toArray();
    counts.work_schedules = await upsertBatched('work_schedules', workSchedules.map((s) => ({
      id: idStr(s._id), name: s.name, workDays: s.workDays || [], startTime: s.startTime ?? null, endTime: s.endTime ?? null,
      breakMinutes: s.breakMinutes ?? null, weeklyHours: s.weeklyHours ?? null, gracePeriod: s.gracePeriod ?? null,
      createdBy: idStr(s.createdBy), createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    const shiftTaskTemplates = await dbo.collection('shift_task_templates').find({}).toArray();
    counts.shift_task_templates = await upsertBatched('shift_task_templates', shiftTaskTemplates.map((s) => ({
      id: idStr(s._id), name: s.name, tasks: s.tasks || [], isActive: s.isActive ?? true,
      createdBy: idStr(s.createdBy), createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    const shifts = await dbo.collection('shifts').find({}).toArray();
    counts.shifts = await upsertBatched('shifts', shifts.map((s) => ({
      id: idStr(s._id), employeeId: idStr(s.employeeId), date: s.date, shiftType: s.shiftType ?? null,
      startTime: s.startTime ?? null, endTime: s.endTime ?? null, breakMinutes: s.breakMinutes ?? null,
      location: s.location ?? null, address: s.address ?? null, addressLat: s.addressLat ?? null, addressLng: s.addressLng ?? null,
      notes: s.notes ?? null, taskTemplateId: idStr(s.taskTemplateId),
      assignedBy: idStr(s.assignedBy), createdBy: idStr(s.createdBy), isOpen: s.isOpen ?? false,
      createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    const shiftTasks = await dbo.collection('shift_tasks').find({}).toArray();
    counts.shift_tasks = await upsertBatched('shift_tasks', shiftTasks.map((t) => ({
      id: idStr(t._id), shiftId: idStr(t.shiftId), title: t.title ?? null, order: t.order ?? null,
      completed: t.completed ?? false, completedAt: toDate(t.completedAt), completedBy: idStr(t.completedBy),
      createdAt: toDate(t.createdAt),
    })));

    const shiftNotes = await dbo.collection('shift_notes').find({}).toArray();
    counts.shift_notes = await upsertBatched('shift_notes', shiftNotes.map((n) => ({
      id: idStr(n._id), shiftId: idStr(n.shiftId), employeeId: idStr(n.employeeId), authorName: n.authorName ?? null,
      type: n.type ?? null, text: n.text ?? null, createdAt: toDate(n.createdAt),
    })));

    const shiftApplications = await dbo.collection('shift_applications').find({}).toArray();
    counts.shift_applications = await upsertBatched('shift_applications', shiftApplications.map((a) => ({
      id: idStr(a._id), shiftId: idStr(a.shiftId), employeeId: idStr(a.employeeId), employeeName: a.employeeName ?? null,
      status: a.status ?? 'pending', note: a.note ?? null, createdAt: toDate(a.createdAt),
      resolvedAt: toDate(a.resolvedAt), resolvedBy: idStr(a.resolvedBy),
    })));

    const shiftAssignments = await dbo.collection('employeeShiftAssignments').find({}).toArray();
    counts.employeeShiftAssignments = await upsertBatched('employeeShiftAssignments', shiftAssignments.map((a) => ({
      id: idStr(a._id), employeeId: idStr(a.employeeId), scheduleId: idStr(a.scheduleId),
      effectiveFrom: toDate(a.effectiveFrom), effectiveTo: toDate(a.effectiveTo),
      assignedBy: idStr(a.assignedBy), createdAt: toDate(a.createdAt), updatedAt: toDate(a.updatedAt),
    })));

    const timesheets = await dbo.collection('timesheets').find({}).toArray();
    counts.timesheets = await upsertBatched('timesheets', timesheets.map((s) => ({
      id: idStr(s._id), employeeId: idStr(s.employeeId), weekStart: toDate(s.weekStart), weekEnd: toDate(s.weekEnd),
      entries: s.entries ? JSON.stringify(s.entries) : null, totalMinutes: s.totalMinutes ?? null,
      totalRegularMinutes: s.totalRegularMinutes ?? null, overtimeMinutes: s.overtimeMinutes ?? null,
      overtimeBreakdown: s.overtimeBreakdown ? JSON.stringify(s.overtimeBreakdown) : null,
      totalBreakMinutes: s.totalBreakMinutes ?? null, status: s.status ?? 'draft', submittedAt: toDate(s.submittedAt),
      approvedBy: idStr(s.approvedBy), approvedAt: toDate(s.approvedAt), rejectionReason: s.rejectionReason ?? null,
      payrollRunId: idStr(s.payrollRunId), createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    const attendanceSettingsDoc = await dbo.collection('attendance_settings').findOne({});
    counts.attendance_settings = await upsertBatched('attendance_settings', attendanceSettingsDoc ? [{
      id: 'singleton', data: JSON.stringify(attendanceSettingsDoc),
      createdAt: toDate(attendanceSettingsDoc.createdAt), updatedAt: toDate(attendanceSettingsDoc.updatedAt),
    }] : []);

    // ══════════════════════════════════════════════════════════════════════
    //  PHASE 4 — Recruitment, Onboarding, Offboarding, email_templates
    // ══════════════════════════════════════════════════════════════════════

    // ── Recruitment ──────────────────────────────────────────────────────
    const jobRequisitions = await dbo.collection('jobRequisitions').find({}).toArray();
    counts.job_requisitions = await upsertBatched('job_requisitions', jobRequisitions.map((r) => ({
      id: idStr(r._id), title: r.title ?? null, department: r.department ?? null, location: r.location ?? null,
      employmentType: r.employmentType ?? null, headcount: r.headcount ?? null,
      salaryRange: r.salaryRange ? JSON.stringify(r.salaryRange) : null, description: r.description ?? null,
      applicationDeadline: toDate(r.applicationDeadline), branchId: idStr(r.branchId),
      competencies: r.competencies ? JSON.stringify(r.competencies) : null,
      pipelineStages: r.pipelineStages ? JSON.stringify(r.pipelineStages) : null,
      screeningQuestions: r.screeningQuestions ? JSON.stringify(r.screeningQuestions) : null,
      approvalChain: r.approvalChain ? JSON.stringify(r.approvalChain) : null,
      status: r.status ?? null, hiringManagerId: idStr(r.hiringManagerId), createdBy: idStr(r.createdBy),
      isDemoData: r.isDemoData ?? false,
      createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
    })));

    const candidates = await dbo.collection('candidates').find({}).toArray();
    counts.candidates = await upsertBatched('candidates', candidates.map((c) => ({
      id: idStr(c._id), firstName: c.firstName ?? null, lastName: c.lastName ?? null, email: c.email ?? null,
      source: c.source ?? null, tags: c.tags || [], isPassiveTalent: c.isPassiveTalent ?? false,
      phone: c.phone ?? null, location: c.location ?? null, resumeUrl: c.resumeUrl ?? null,
      linkedInUrl: c.linkedInUrl ?? null, referredBy: idStr(c.referredBy),
      consentGivenAt: toDate(c.consentGivenAt), consentVersion: c.consentVersion ?? null, notes: c.notes ?? null,
      isDemoData: c.isDemoData ?? false,
      createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    // candidates/job_requisitions must exist before applications (FK) — already
    // written above in this same run.
    const applications = await dbo.collection('applications').find({}).toArray();
    counts.applications = await upsertBatched('applications', applications.map((a) => ({
      id: idStr(a._id), candidateId: idStr(a.candidateId), requisitionId: idStr(a.requisitionId),
      currentStageId: a.currentStageId ?? null, stageHistory: a.stageHistory ? JSON.stringify(a.stageHistory) : null,
      status: a.status ?? null, rejectionReason: a.rejectionReason ?? null,
      offerDetails: a.offerDetails ? JSON.stringify(a.offerDetails) : null, coverLetter: a.coverLetter ?? null,
      answers: a.answers ? JSON.stringify(a.answers) : null, overallScore: a.overallScore ?? null,
      isDemoData: a.isDemoData ?? false,
      createdAt: toDate(a.createdAt), updatedAt: toDate(a.updatedAt),
      // NOTE: a.scorecards (embedded ObjectId array) deliberately dropped — see the
      // migration file's own comment on why (write-only, never read anywhere).
    })));

    // application_interview_assignments — auto-increment id, no natural conflict key,
    // so delete-then-insert per application (same idiom as employee_skills/
    // attendance_breaks in earlier phases).
    if (!DRY_RUN) await knex('application_interview_assignments').del();
    const interviewAssignmentRows = applications.flatMap((a) =>
      (a.interviewAssignments || []).map((ia) => ({
        applicationId: idStr(a._id), stageId: ia.stageId ?? null, interviewerId: idStr(ia.interviewerId),
        interviewerName: ia.interviewerName ?? null, scheduledAt: toDate(ia.scheduledAt),
        meetingLink: ia.meetingLink ?? null, location: ia.location ?? null,
        requiredDocuments: ia.requiredDocuments ?? null, assignedAt: toDate(ia.assignedAt),
      }))
    );
    counts.application_interview_assignments = await upsertBatched('application_interview_assignments', interviewAssignmentRows, null);

    const scorecards = await dbo.collection('scorecards').find({}).toArray();
    counts.scorecards = await upsertBatched('scorecards', scorecards.map((s) => ({
      id: idStr(s._id), applicationId: idStr(s.applicationId), requisitionId: idStr(s.requisitionId),
      stageId: s.stageId ?? null, interviewerId: idStr(s.interviewerId), interviewerName: s.interviewerName ?? null,
      competencyRatings: s.competencyRatings ? JSON.stringify(s.competencyRatings) : null,
      overallRecommendation: s.overallRecommendation ?? null, strengths: s.strengths ?? null, concerns: s.concerns ?? null,
      submittedAt: toDate(s.submittedAt),
    })));

    const interviewKits = await dbo.collection('interviewKits').find({}).toArray();
    counts.interview_kits = await upsertBatched('interview_kits', interviewKits.map((k) => ({
      id: idStr(k._id), name: k.name ?? null, competencies: k.competencies ? JSON.stringify(k.competencies) : null,
      createdBy: idStr(k.createdBy), createdAt: toDate(k.createdAt), updatedAt: toDate(k.updatedAt),
    })));

    const nurtureCampaigns = await dbo.collection('nurtureCampaigns').find({}).toArray();
    counts.nurture_campaigns = await upsertBatched('nurture_campaigns', nurtureCampaigns.map((c) => ({
      id: idStr(c._id), name: c.name ?? null, description: c.description ?? null, targetTags: c.targetTags || [],
      status: c.status ?? null, createdBy: idStr(c.createdBy), createdAt: toDate(c.createdAt),
    })));

    if (!DRY_RUN) await knex('nurture_campaign_touchpoints').del();
    const touchpointRows = nurtureCampaigns.flatMap((c) =>
      (c.touchpoints || []).map((tp) => ({
        campaignId: idStr(c._id), candidateId: idStr(tp.candidateId), channel: tp.channel ?? null,
        note: tp.note ?? null, sentAt: toDate(tp.sentAt), byUserId: idStr(tp.byUserId), response: tp.response ?? null,
      }))
    );
    counts.nurture_campaign_touchpoints = await upsertBatched('nurture_campaign_touchpoints', touchpointRows, null);

    const emailTemplates = await dbo.collection('emailTemplates').find({}).toArray();
    counts.email_templates = await upsertBatched('email_templates', emailTemplates.map((e) => ({
      id: idStr(e._id), name: e.name ?? null, trigger: e.trigger ?? null, subject: e.subject ?? null,
      body: e.body ?? null, createdBy: idStr(e.createdBy), updatedBy: idStr(e.updatedBy),
      createdAt: toDate(e.createdAt), updatedAt: toDate(e.updatedAt),
    })));

    // ── Onboarding ───────────────────────────────────────────────────────
    const onboardingTemplates = await dbo.collection('onboarding_templates').find({}).toArray();
    counts.onboarding_templates = await upsertBatched('onboarding_templates', onboardingTemplates.map((t) => ({
      id: idStr(t._id), name: t.name ?? null, description: t.description ?? null,
      targetRoles: t.targetRoles || [], targetDepartments: t.targetDepartments || [],
      welcomeMessage: t.welcomeMessage ?? null, firstDayDetails: t.firstDayDetails ? JSON.stringify(t.firstDayDetails) : null,
      taskLists: t.taskLists ? JSON.stringify(t.taskLists) : null, meetTheTeam: t.meetTheTeam ? JSON.stringify(t.meetTheTeam) : null,
      createdBy: idStr(t.createdBy), createdAt: toDate(t.createdAt), updatedAt: toDate(t.updatedAt),
    })));

    const onboardingRecords = await dbo.collection('onboarding_records').find({}).toArray();
    counts.onboarding_records = await upsertBatched('onboarding_records', onboardingRecords.map((r) => ({
      id: idStr(r._id), employeeId: idStr(r.employeeId), templateId: idStr(r.templateId), status: r.status ?? null,
      startDate: toDate(r.startDate), completedAt: toDate(r.completedAt), welcomeMessage: r.welcomeMessage ?? null,
      firstDayDetails: r.firstDayDetails ? JSON.stringify(r.firstDayDetails) : null,
      meetTheTeam: r.meetTheTeam ? JSON.stringify(r.meetTheTeam) : null,
      compensationSetup: r.compensationSetup ? JSON.stringify(r.compensationSetup) : null,
      createdBy: idStr(r.createdBy), createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
      // NOTE: r.progressPercentage deliberately dropped — see the migration file's
      // own comment (never written by the app, always recomputed on read).
    })));

    // onboarding_task_lists/onboarding_tasks — double-nested, auto-increment ids (see
    // the migration file's comment on why list.id/task.id can't be the real PK), so
    // delete-then-insert per record, two passes (lists first to get their new ids
    // back, then tasks referencing those ids). Real data is small (9 records) — a
    // per-record loop here is clearer than trying to batch the two-level flatten.
    if (!DRY_RUN) {
      const recordIds = onboardingRecords.map((r) => idStr(r._id));
      if (recordIds.length) {
        await knex('onboarding_tasks').whereIn('taskListId', knex('onboarding_task_lists').select('id').whereIn('recordId', recordIds)).del();
        await knex('onboarding_task_lists').whereIn('recordId', recordIds).del();
      }
    }
    let onboardingTaskListCount = 0;
    let onboardingTaskCount = 0;
    if (!DRY_RUN) {
      for (const r of onboardingRecords) {
        for (const list of (r.taskLists || [])) {
          const [inserted] = await knex('onboarding_task_lists').insert({
            recordId: idStr(r._id), listKey: list.id ?? null, name: list.name ?? null, assignedTo: list.assignedTo ?? null,
          }).returning('id');
          onboardingTaskListCount += 1;
          const newListId = inserted.id ?? inserted;
          const taskRows = (list.tasks || []).map((t) => ({
            taskListId: newListId, taskKey: t.id ?? null, title: t.title ?? null, description: t.description ?? null,
            dueDate: toDate(t.dueDate), isRequired: t.isRequired !== false, status: t.status ?? 'pending',
            completedBy: idStr(t.completedBy), completedAt: toDate(t.completedAt),
            requiresDocument: !!t.requiresDocument, documentId: idStr(t.documentId), notes: t.notes ?? null,
            resourceUrl: t.resourceUrl ?? null,
          }));
          if (taskRows.length) {
            await knex('onboarding_tasks').insert(taskRows);
            onboardingTaskCount += taskRows.length;
          }
        }
      }
    } else {
      onboardingTaskListCount = onboardingRecords.reduce((s, r) => s + (r.taskLists || []).length, 0);
      onboardingTaskCount = onboardingRecords.reduce((s, r) => s + (r.taskLists || []).reduce((s2, l) => s2 + (l.tasks || []).length, 0), 0);
    }
    counts.onboarding_task_lists = onboardingTaskListCount;
    counts.onboarding_tasks = onboardingTaskCount;

    // Shared between onboarding and offboarding (recordType discriminates) — read once.
    const onboardingDocuments = await dbo.collection('onboarding_documents').find({}).toArray();
    counts.onboarding_documents = await upsertBatched('onboarding_documents', onboardingDocuments.map((d) => ({
      id: idStr(d._id), employeeId: idStr(d.employeeId), recordId: idStr(d.recordId), recordType: d.recordType ?? null,
      taskId: d.taskId ?? null, name: d.name ?? null, type: d.type ?? null, fileUrl: d.fileUrl ?? null,
      signedAt: toDate(d.signedAt), signedBy: idStr(d.signedBy), status: d.status ?? null,
      uploadedAt: toDate(d.uploadedAt), createdAt: toDate(d.createdAt),
    })));

    // ── Offboarding ──────────────────────────────────────────────────────
    const offboardingTemplates = await dbo.collection('offboarding_templates').find({}).toArray();
    counts.offboarding_templates = await upsertBatched('offboarding_templates', offboardingTemplates.map((t) => ({
      id: idStr(t._id), name: t.name ?? null, exitTypes: t.exitTypes || [],
      taskLists: t.taskLists ? JSON.stringify(t.taskLists) : null,
      assetChecklist: t.assetChecklist ? JSON.stringify(t.assetChecklist) : null,
      accessRevocationList: t.accessRevocationList ? JSON.stringify(t.accessRevocationList) : null,
      documentsToGenerate: t.documentsToGenerate || [],
      createdBy: idStr(t.createdBy), createdAt: toDate(t.createdAt), updatedAt: toDate(t.updatedAt),
    })));

    // employees must exist before offboarding_records (FK) — already migrated (Phase 1).
    const offboardingRecords = await dbo.collection('offboarding_records').find({}).toArray();
    counts.offboarding_records = await upsertBatched('offboarding_records', offboardingRecords.map((r) => ({
      id: idStr(r._id), employeeId: idStr(r.employeeId), templateId: idStr(r.templateId), exitType: r.exitType ?? null,
      exitReason: r.exitReason ?? null, lastWorkingDay: toDate(r.lastWorkingDay), noticePeriodStartDate: toDate(r.noticePeriodStartDate),
      status: r.status ?? null, eligibleForRehire: r.eligibleForRehire ?? true,
      exitInterview: r.exitInterview ? JSON.stringify(r.exitInterview) : null,
      finalPayTriggered: r.finalPayTriggered ?? false, finalPayTriggeredAt: toDate(r.finalPayTriggeredAt),
      completedAt: toDate(r.completedAt), initiatedBy: idStr(r.initiatedBy),
      createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
    })));

    if (!DRY_RUN) {
      const offRecordIds = offboardingRecords.map((r) => idStr(r._id));
      if (offRecordIds.length) {
        await knex('offboarding_tasks').whereIn('taskListId', knex('offboarding_task_lists').select('id').whereIn('recordId', offRecordIds)).del();
        await knex('offboarding_task_lists').whereIn('recordId', offRecordIds).del();
        await knex('offboarding_asset_checklist').whereIn('recordId', offRecordIds).del();
        await knex('offboarding_access_revocation').whereIn('recordId', offRecordIds).del();
        await knex('offboarding_generated_documents').whereIn('recordId', offRecordIds).del();
      }
    }
    let offboardingTaskListCount = 0;
    let offboardingTaskCount = 0;
    if (!DRY_RUN) {
      for (const r of offboardingRecords) {
        for (const list of (r.taskLists || [])) {
          const [inserted] = await knex('offboarding_task_lists').insert({
            recordId: idStr(r._id), listKey: list.id ?? null, name: list.name ?? null, assignedTo: list.assignedTo ?? null,
          }).returning('id');
          offboardingTaskListCount += 1;
          const newListId = inserted.id ?? inserted;
          const taskRows = (list.tasks || []).map((t) => ({
            taskListId: newListId, taskKey: t.id ?? null, title: t.title ?? null, description: t.description ?? null,
            dueDate: toDate(t.dueDate), isRequired: t.isRequired !== false, status: t.status ?? 'pending',
            completedBy: idStr(t.completedBy), completedAt: toDate(t.completedAt),
            requiresDocument: !!t.requiresDocument, documentId: idStr(t.documentId), notes: t.notes ?? null,
            category: t.category ?? null, taskType: t.taskType ?? null,
          }));
          if (taskRows.length) {
            await knex('offboarding_tasks').insert(taskRows);
            offboardingTaskCount += taskRows.length;
          }
        }
      }
    } else {
      offboardingTaskListCount = offboardingRecords.reduce((s, r) => s + (r.taskLists || []).length, 0);
      offboardingTaskCount = offboardingRecords.reduce((s, r) => s + (r.taskLists || []).reduce((s2, l) => s2 + (l.tasks || []).length, 0), 0);
    }
    counts.offboarding_task_lists = offboardingTaskListCount;
    counts.offboarding_tasks = offboardingTaskCount;

    const assetRows = offboardingRecords.flatMap((r) =>
      (r.assetChecklist || []).map((a) => ({
        recordId: idStr(r._id), itemKey: a.id ?? null, item: a.item ?? null, category: a.category ?? null,
        returned: a.returned ?? false, returnedAt: toDate(a.returnedAt), returnedTo: idStr(a.returnedTo),
        condition: a.condition ?? null, notes: a.notes ?? null,
      }))
    );
    counts.offboarding_asset_checklist = await upsertBatched('offboarding_asset_checklist', assetRows, null);

    const accessRows = offboardingRecords.flatMap((r) =>
      (r.accessRevocationList || []).map((a) => ({
        recordId: idStr(r._id), itemKey: a.id ?? null, system: a.system ?? null, category: a.category ?? null,
        revoked: a.revoked ?? false, revokedAt: toDate(a.revokedAt), revokedBy: idStr(a.revokedBy),
      }))
    );
    counts.offboarding_access_revocation = await upsertBatched('offboarding_access_revocation', accessRows, null);

    const generatedDocRows = offboardingRecords.flatMap((r) =>
      (r.generatedDocuments || []).map((g) => ({
        recordId: idStr(r._id), type: g.type ?? null, fileUrl: g.fileUrl ?? null, generatedAt: toDate(g.generatedAt),
      }))
    );
    counts.offboarding_generated_documents = await upsertBatched('offboarding_generated_documents', generatedDocRows, null);

    // ══════════════════════════════════════════════════════════════════════
    //  PHASE 5 — Training, Performance
    // ══════════════════════════════════════════════════════════════════════

    // certificate_number_* counters — Phase 1's own counters migration deliberately
    // only pulled staff_number_* (the only sequence relevant at that point); this key
    // only starts mattering now that generateCertificateNumber (trainingFunctions.js)
    // is fixed to use the real Postgres counters table instead of a dead Mongo one.
    // Seeding the real current seq here (not starting fresh at 0) matters — found via
    // live verification, where a fresh-from-0 counter generated a new certificate
    // numbered CERT-2026-00001, silently overwriting the real, already-issued
    // certificate PDF of the same name on disk.
    const certNumberCounters = await dbo.collection('counters')
      .find({ _id: { $regex: /^certificate_number_/ } }).toArray();
    counts.counters = (counts.counters || 0) + await upsertBatched('counters', certNumberCounters.map((c) => ({
      id: idStr(c._id), seq: c.seq ?? 0,
    })));

    // ── Training ─────────────────────────────────────────────────────────
    const courses = await dbo.collection('courses').find({}).toArray();
    counts.courses = await upsertBatched('courses', courses.map((c) => ({
      id: idStr(c._id), title: c.title ?? null, description: c.description ?? null, coverImageUrl: c.coverImageUrl ?? null,
      category: c.category ?? null, tags: c.tags || [], skillsTaught: c.skillsTaught || [],
      estimatedDurationMinutes: c.estimatedDurationMinutes ?? null, difficultyLevel: c.difficultyLevel ?? null,
      status: c.status ?? null, isMandatory: c.isMandatory ?? false, targetRoles: c.targetRoles || [],
      targetDepartments: c.targetDepartments || [], hasCertificate: c.hasCertificate ?? false,
      certificateValidityDays: c.certificateValidityDays ?? null, deliveryMethod: c.deliveryMethod ?? null,
      createdBy: idStr(c.createdBy),
      authors: (c.authors || []).map(idStr), publishedAt: toDate(c.publishedAt),
      createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    const courseModules = await dbo.collection('courseModules').find({}).toArray();
    counts.course_modules = await upsertBatched('course_modules', courseModules.map((m) => ({
      id: idStr(m._id), courseId: idStr(m.courseId), title: m.title ?? null, order: m.order ?? null,
      type: m.type ?? null, content: m.content ? JSON.stringify(m.content) : null, isRequired: m.isRequired ?? true,
      minimumPassScore: m.minimumPassScore ?? null, createdAt: toDate(m.createdAt),
    })));

    const enrollments = await dbo.collection('enrollments').find({}).toArray();
    counts.enrollments = await upsertBatched('enrollments', enrollments.map((e) => ({
      id: idStr(e._id), employeeId: idStr(e.employeeId), courseId: idStr(e.courseId), learningPathId: idStr(e.learningPathId),
      enrolledBy: idStr(e.enrolledBy), enrollmentTrigger: e.enrollmentTrigger ?? null, dueDate: toDate(e.dueDate),
      status: e.status ?? null, completedAt: toDate(e.completedAt), progressPercentage: e.progressPercentage ?? 0,
      moduleProgress: e.moduleProgress ? JSON.stringify(e.moduleProgress) : null,
      createdAt: toDate(e.createdAt), updatedAt: toDate(e.updatedAt),
    })));

    const learningPaths = await dbo.collection('learningPaths').find({}).toArray();
    counts.learning_paths = await upsertBatched('learning_paths', learningPaths.map((p) => ({
      id: idStr(p._id), name: p.name ?? null, description: p.description ?? null,
      courses: p.courses ? JSON.stringify(p.courses) : null, targetRoles: p.targetRoles || [],
      targetDepartments: p.targetDepartments || [], enrollmentTrigger: p.enrollmentTrigger ?? null,
      dueDateOffsetDays: p.dueDateOffsetDays ?? null, status: p.status ?? null, createdBy: idStr(p.createdBy),
      createdAt: toDate(p.createdAt),
    })));

    const quizzes = await dbo.collection('quizzes').find({}).toArray();
    counts.quizzes = await upsertBatched('quizzes', quizzes.map((q) => ({
      id: idStr(q._id), moduleId: idStr(q.moduleId), courseId: idStr(q.courseId), passingScore: q.passingScore ?? null,
      maxAttempts: q.maxAttempts ?? null, shuffleQuestions: q.shuffleQuestions ?? false, shuffleOptions: q.shuffleOptions ?? false,
      timeLimitMinutes: q.timeLimitMinutes ?? null, questions: q.questions ? JSON.stringify(q.questions) : null,
    })));

    const certificates = await dbo.collection('certificates').find({}).toArray();
    counts.certificates = await upsertBatched('certificates', certificates.map((c) => ({
      id: idStr(c._id), employeeId: idStr(c.employeeId), courseId: idStr(c.courseId), enrollmentId: idStr(c.enrollmentId),
      certificateNumber: c.certificateNumber ?? null, issuedAt: toDate(c.issuedAt), expiresAt: toDate(c.expiresAt),
      pdfUrl: c.pdfUrl ?? null,
    })));

    const externalCertificates = await dbo.collection('externalCertificates').find({}).toArray();
    counts.external_certificates = await upsertBatched('external_certificates', externalCertificates.map((c) => ({
      id: idStr(c._id), employeeId: idStr(c.employeeId), name: c.name ?? null, issuingOrganization: c.issuingOrganization ?? null,
      issuedDate: toDate(c.issuedDate), expiryDate: toDate(c.expiryDate), fileUrl: c.fileUrl ?? null,
      verificationUrl: c.verificationUrl ?? null, status: c.status ?? null, verifiedBy: idStr(c.verifiedBy),
      uploadedAt: toDate(c.uploadedAt),
    })));

    const trainingRules = await dbo.collection('trainingAssignmentRules').find({}).toArray();
    counts.training_assignment_rules = await upsertBatched('training_assignment_rules', trainingRules.map((r) => ({
      id: idStr(r._id), name: r.name ?? null, trigger: r.trigger ?? null,
      triggerConditions: r.triggerConditions ? JSON.stringify(r.triggerConditions) : null,
      action: r.action ? JSON.stringify(r.action) : null, isActive: r.isActive ?? true, createdBy: idStr(r.createdBy),
      createdAt: toDate(r.createdAt),
    })));

    const ruleLogs = await dbo.collection('ruleExecutionLogs').find({}).toArray();
    counts.rule_execution_logs = await upsertBatched('rule_execution_logs', ruleLogs.map((l) => ({
      id: idStr(l._id), ruleId: idStr(l.ruleId), runAt: toDate(l.runAt), matched: l.matched ?? 0, created: l.created ?? 0,
    })));

    const trainingFeedback = await dbo.collection('trainingFeedback').find({}).toArray();
    counts.training_feedback = await upsertBatched('training_feedback', trainingFeedback.map((f) => ({
      id: idStr(f._id), enrollmentId: idStr(f.enrollmentId), courseId: idStr(f.courseId), employeeId: idStr(f.employeeId),
      rating: f.rating ?? null, review: f.review ?? null, submittedAt: toDate(f.submittedAt),
    })));

    const trainingSessions = await dbo.collection('trainingSessions').find({}).toArray();
    counts.training_sessions = await upsertBatched('training_sessions', trainingSessions.map((s) => ({
      id: idStr(s._id), courseId: idStr(s.courseId), title: s.title ?? null, facilitatorId: idStr(s.facilitatorId),
      facilitatorName: s.facilitatorName ?? null, scheduledAt: toDate(s.scheduledAt), durationMinutes: s.durationMinutes ?? null,
      meetingLink: s.meetingLink ?? null, capacity: s.capacity ?? null, attendeeIds: (s.attendeeIds || []).map(idStr),
      status: s.status ?? null, attendance: s.attendance ? JSON.stringify(s.attendance) : null, createdBy: idStr(s.createdBy),
      createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    // ── Performance ──────────────────────────────────────────────────────
    const appraisals = await dbo.collection('appraisal_records').find({}).toArray();
    counts.appraisal_records = await upsertBatched('appraisal_records', appraisals.map((a) => ({
      id: idStr(a._id), employeeId: idStr(a.employeeId), reviewPeriod: a.reviewPeriod ?? null, periodKey: a.periodKey ?? null,
      reviewerId: idStr(a.reviewerId), goalsSet: a.goalsSet || [], goalsAchieved: a.goalsAchieved || [], rating: a.rating ?? null,
      comments: a.comments ?? null, status: a.status ?? null, reviewedBy: idStr(a.reviewedBy), reviewedAt: toDate(a.reviewedAt),
      reviewComment: a.reviewComment ?? null, createdAt: toDate(a.createdAt),
    })));

    const reviewTemplates = await dbo.collection('review_templates').find({}).toArray();
    counts.review_templates = await upsertBatched('review_templates', reviewTemplates.map((t) => ({
      id: idStr(t._id), name: t.name ?? null, description: t.description ?? null, cycleTypes: t.cycleTypes || [],
      sections: t.sections ? JSON.stringify(t.sections) : null, isActive: t.isActive ?? true, createdBy: idStr(t.createdBy),
      createdAt: toDate(t.createdAt), updatedAt: toDate(t.updatedAt), isDemoSeed: t.isDemoSeed ?? false,
    })));

    const reviewCycles = await dbo.collection('review_cycles').find({}).toArray();
    counts.review_cycles = await upsertBatched('review_cycles', reviewCycles.map((c) => ({
      id: idStr(c._id), name: c.name ?? null, type: c.type ?? null, templateId: idStr(c.templateId), status: c.status ?? null,
      phases: c.phases ? JSON.stringify(c.phases) : null, audience: c.audience ? JSON.stringify(c.audience) : null,
      participants: c.participants ? JSON.stringify(c.participants) : null, createdBy: idStr(c.createdBy),
      createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt), isDemoSeed: c.isDemoSeed ?? false,
    })));

    const reviews = await dbo.collection('reviews').find({}).toArray();
    counts.reviews = await upsertBatched('reviews', reviews.map((r) => ({
      id: idStr(r._id), cycleId: idStr(r.cycleId), employeeId: idStr(r.employeeId), reviewerId: idStr(r.reviewerId),
      reviewType: r.reviewType ?? null, status: r.status ?? null, responses: r.responses ? JSON.stringify(r.responses) : null,
      overallRating: r.overallRating ?? null, recommendation: r.recommendation ?? null, calibrationBox: r.calibrationBox ?? null,
      calibrationNotes: r.calibrationNotes ?? null, submittedAt: toDate(r.submittedAt),
      createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt), isDemoSeed: r.isDemoSeed ?? false,
    })));

    const goals = await dbo.collection('goals').find({}).toArray();
    counts.goals = await upsertBatched('goals', goals.map((g) => ({
      id: idStr(g._id), employeeId: idStr(g.employeeId), department: g.department ?? null, createdBy: idStr(g.createdBy),
      title: g.title ?? null, description: g.description ?? null, category: g.category ?? null, period: g.period ?? null,
      startDate: toDate(g.startDate), endDate: toDate(g.endDate), status: g.status ?? null, progress: g.progress ?? 0,
      visibility: g.visibility ?? null, parentGoalId: idStr(g.parentGoalId), keyResults: g.keyResults ? JSON.stringify(g.keyResults) : null,
      createdAt: toDate(g.createdAt), updatedAt: toDate(g.updatedAt), isDemoSeed: g.isDemoSeed ?? false,
    })));

    // goal_check_ins — auto-increment id, delete-then-insert per goal.
    if (!DRY_RUN) await knex('goal_check_ins').whereIn('goalId', goals.map((g) => idStr(g._id))).del();
    const checkInRows = goals.flatMap((g) =>
      (g.checkIns || []).map((ci) => ({
        goalId: idStr(g._id), progress: ci.progress ?? null, note: ci.note ?? null, updatedBy: idStr(ci.updatedBy),
        updatedAt: toDate(ci.updatedAt),
      }))
    );
    counts.goal_check_ins = await upsertBatched('goal_check_ins', checkInRows, null);

    // goal_comments — real id of its own (fresh ObjectId per comment), upsert by id.
    const commentRows = goals.flatMap((g) =>
      (g.comments || []).map((c) => ({
        id: idStr(c._id), goalId: idStr(g._id), text: c.text ?? null, authorId: idStr(c.authorId),
        authorName: c.authorName ?? null, createdAt: toDate(c.createdAt),
      }))
    );
    counts.goal_comments = await upsertBatched('goal_comments', commentRows);

    const feedbackDocs = await dbo.collection('feedback').find({}).toArray();
    counts.feedback = await upsertBatched('feedback', feedbackDocs.map((f) => ({
      id: idStr(f._id), giverId: idStr(f.giverId), recipientId: idStr(f.recipientId), type: f.type ?? null,
      category: f.category ?? null, message: f.message ?? null, visibility: f.visibility ?? null,
      isAnonymous: f.isAnonymous ?? false, isVisibleToEmployee: f.isVisibleToEmployee ?? true, relatedCycleId: idStr(f.relatedCycleId),
      createdAt: toDate(f.createdAt), isDemoSeed: f.isDemoSeed ?? false,
    })));

    const oneOnOnes = await dbo.collection('oneOnOnes').find({}).toArray();
    counts.one_on_ones = await upsertBatched('one_on_ones', oneOnOnes.map((o) => ({
      id: idStr(o._id), managerId: idStr(o.managerId), employeeId: idStr(o.employeeId), scheduledAt: toDate(o.scheduledAt),
      status: o.status ?? null, sharedNotes: o.sharedNotes ?? null, privateManagerNotes: o.privateManagerNotes ?? null,
      createdBy: idStr(o.createdBy), createdAt: toDate(o.createdAt), updatedAt: toDate(o.updatedAt), completedAt: toDate(o.completedAt),
    })));

    // one_on_one_agenda_items — real id of its own (fresh randomUUID per item), upsert by id.
    const agendaItemRows = oneOnOnes.flatMap((o) =>
      (o.agendaItems || []).map((a) => ({
        id: a.id, oneOnOneId: idStr(o._id), text: a.text ?? null, addedBy: idStr(a.addedBy),
        isDone: a.isDone ?? false, createdAt: toDate(a.createdAt),
      }))
    );
    counts.one_on_one_agenda_items = await upsertBatched('one_on_one_agenda_items', agendaItemRows);

    const pips = await dbo.collection('performanceImprovementPlans').find({}).toArray();
    counts.performance_improvement_plans = await upsertBatched('performance_improvement_plans', pips.map((p) => ({
      id: idStr(p._id), employeeId: idStr(p.employeeId), managerId: idStr(p.managerId), createdBy: idStr(p.createdBy),
      reason: p.reason ?? null, startDate: toDate(p.startDate), endDate: toDate(p.endDate), status: p.status ?? null,
      goals: p.goals ? JSON.stringify(p.goals) : null, outcome: p.outcome ?? null, relatedReviewId: idStr(p.relatedReviewId),
      createdAt: toDate(p.createdAt), updatedAt: toDate(p.updatedAt), isDemoSeed: p.isDemoSeed ?? false, closedAt: toDate(p.closedAt),
    })));

    // pip_check_ins — real id of its own (fresh randomUUID per item), upsert by id.
    const pipCheckInRows = pips.flatMap((p) =>
      (p.checkIns || []).map((ci) => ({
        id: ci.id, pipId: idStr(p._id), note: ci.note ?? null, addedBy: idStr(ci.addedBy), createdAt: toDate(ci.createdAt),
      }))
    );
    counts.pip_check_ins = await upsertBatched('pip_check_ins', pipCheckInRows);

    // ══════════════════════════════════════════════════════════════════════
    //  PHASE 6 — Inventory, POS
    // ══════════════════════════════════════════════════════════════════════

    // users.isInventoryClerk/posLocationIds — Phase 6's own new columns on Phase 1's
    // users table (see the migration file's own comment on why). Applied as a targeted
    // update rather than re-running the full users upsert.
    const usersWithInvOrPosFlags = await dbo.collection('users').find({
      $or: [{ isInventoryClerk: { $exists: true } }, { posLocationIds: { $exists: true } }],
    }).toArray();
    let invPosFlagCount = 0;
    if (!DRY_RUN) {
      for (const u of usersWithInvOrPosFlags) {
        await knex('users').where({ id: idStr(u._id) }).update({
          isInventoryClerk: u.isInventoryClerk === true,
          posLocationIds: (u.posLocationIds || []).map(idStr),
        });
        invPosFlagCount += 1;
      }
    } else {
      invPosFlagCount = usersWithInvOrPosFlags.length;
    }
    counts['users.isInventoryClerk/posLocationIds'] = invPosFlagCount;

    // ── Inventory lookups ────────────────────────────────────────────────────
    const invCategories = await dbo.collection('inventory_categories').find({}).toArray();
    counts.inventory_categories = await upsertBatched('inventory_categories', invCategories.map((c) => ({
      id: idStr(c._id), name: c.name ?? null, isActive: c.isActive ?? true, createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    const invBrands = await dbo.collection('inventory_brands').find({}).toArray();
    counts.inventory_brands = await upsertBatched('inventory_brands', invBrands.map((b) => ({
      id: idStr(b._id), name: b.name ?? null, isActive: b.isActive ?? true, createdAt: toDate(b.createdAt), updatedAt: toDate(b.updatedAt),
    })));

    const invUoms = await dbo.collection('inventory_units_of_measure').find({}).toArray();
    counts.inventory_units_of_measure = await upsertBatched('inventory_units_of_measure', invUoms.map((u) => ({
      id: idStr(u._id), name: u.name ?? null, isActive: u.isActive ?? true, createdAt: toDate(u.createdAt), updatedAt: toDate(u.updatedAt),
    })));

    const invCustomFields = await dbo.collection('inventory_custom_field_defs').find({}).toArray();
    counts.inventory_custom_field_defs = await upsertBatched('inventory_custom_field_defs', invCustomFields.map((f) => ({
      id: idStr(f._id), name: f.name ?? null, fieldType: f.fieldType ?? null, options: f.options || [],
      isActive: f.isActive ?? true, createdAt: toDate(f.createdAt), updatedAt: toDate(f.updatedAt),
    })));

    const invLocations = await dbo.collection('inventory_locations').find({}).toArray();
    counts.inventory_locations = await upsertBatched('inventory_locations', invLocations.map((l) => ({
      id: idStr(l._id), name: l.name ?? null, type: l.type ?? null, address: l.address ?? null, department: l.department ?? null,
      isActive: l.isActive ?? true, createdAt: toDate(l.createdAt), updatedAt: toDate(l.updatedAt),
    })));

    const invSuppliers = await dbo.collection('inventory_suppliers').find({}).toArray();
    counts.inventory_suppliers = await upsertBatched('inventory_suppliers', invSuppliers.map((s) => ({
      id: idStr(s._id), name: s.name ?? null, contactPerson: s.contactPerson ?? null, phone: s.phone ?? null, email: s.email ?? null,
      address: s.address ?? null, linkedItemIds: (s.linkedItemIds || []).map(idStr), leadTimeDays: s.leadTimeDays ?? null,
      isActive: s.isActive ?? true, createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    // ── Items, purchase orders, lots, stock ──────────────────────────────────
    const invItems = await dbo.collection('inventory_items').find({}).toArray();
    counts.inventory_items = await upsertBatched('inventory_items', invItems.map((i) => ({
      id: idStr(i._id), sku: i.sku ?? null, name: i.name ?? null, description: i.description ?? null, barcode: i.barcode ?? null,
      category: i.category ?? null, brand: i.brand ?? null, unitOfMeasure: i.unitOfMeasure ?? null,
      costPrice: i.costPrice ?? null, salePrice: i.salePrice ?? null, avgCost: i.avgCost ?? null, costingMethod: i.costingMethod ?? null,
      expiryTrackingEnabled: i.expiryTrackingEnabled ?? false, isTracked: i.isTracked ?? true, trackingMode: i.trackingMode ?? null,
      discountType: i.discountType ?? null, discountValue: i.discountValue ?? null, taxCategory: i.taxCategory ?? null, taxRate: i.taxRate ?? null,
      imageUrl: i.imageUrl ?? null, customFieldValues: i.customFieldValues ? JSON.stringify(i.customFieldValues) : null,
      isActive: i.isActive ?? true, createdBy: idStr(i.createdBy), createdAt: toDate(i.createdAt), updatedAt: toDate(i.updatedAt),
    })));

    // purchase_orders must exist before lots (FK) — written next.
    const invPOs = await dbo.collection('inventory_purchase_orders').find({}).toArray();
    counts.inventory_purchase_orders = await upsertBatched('inventory_purchase_orders', invPOs.map((p) => ({
      id: idStr(p._id), poNumber: p.poNumber ?? null, supplierId: idStr(p.supplierId), locationId: idStr(p.locationId),
      items: p.items ? JSON.stringify(p.items) : null, status: p.status ?? null, expectedDeliveryDate: toDate(p.expectedDeliveryDate),
      createdBy: idStr(p.createdBy), createdAt: toDate(p.createdAt), updatedAt: toDate(p.updatedAt),
      sentAt: toDate(p.sentAt), receivedAt: toDate(p.receivedAt), closedAt: toDate(p.closedAt),
      invoiceNumber: p.invoiceNumber ?? null, poInvoiceNumber: p.poInvoiceNumber ?? null, invoiceAmount: p.invoiceAmount ?? null,
      invoiceDueDate: toDate(p.invoiceDueDate), invoiceReceivedAt: toDate(p.invoiceReceivedAt),
      paymentStatus: p.paymentStatus ?? null, paymentMethod: p.paymentMethod ?? null, paymentReference: p.paymentReference ?? null,
      paidAt: toDate(p.paidAt), paymentEvidenceFilename: p.paymentEvidenceFilename ?? null, paymentEvidenceOriginalName: p.paymentEvidenceOriginalName ?? null,
      // The rest of the payment-request/approve/reject workflow — missed on the first pass
      // of this table, found while rewriting inventoryPurchaseOrdersFunctions.js/
      // accountingPoPaymentsFunctions.js.
      paymentRequestedBy: idStr(p.paymentRequestedBy), paymentRequestedAt: toDate(p.paymentRequestedAt),
      paymentRejectionReason: p.paymentRejectionReason ?? null,
      paymentApprovedBy: idStr(p.paymentApprovedBy), paymentApprovedAt: toDate(p.paymentApprovedAt),
      paymentRejectedBy: idStr(p.paymentRejectedBy), paymentRejectedAt: toDate(p.paymentRejectedAt),
    })));

    const invLots = await dbo.collection('inventory_lots').find({}).toArray();
    counts.inventory_lots = await upsertBatched('inventory_lots', invLots.map((l) => ({
      id: idStr(l._id), itemId: idStr(l.itemId), locationId: idStr(l.locationId), lotNumber: l.lotNumber ?? null,
      quantityRemaining: l.quantityRemaining ?? null, expiryDate: toDate(l.expiryDate), poId: idStr(l.poId),
      receivedAt: toDate(l.receivedAt), createdAt: toDate(l.createdAt), updatedAt: toDate(l.updatedAt),
    })));

    const invStockLevels = await dbo.collection('inventory_stock_levels').find({}).toArray();
    counts.inventory_stock_levels = await upsertBatched('inventory_stock_levels', invStockLevels.map((s) => ({
      id: idStr(s._id), locationId: idStr(s.locationId), itemId: idStr(s.itemId), quantity: s.quantity ?? 0,
      reorderPoint: s.reorderPoint ?? null, updatedAt: toDate(s.updatedAt), lastLowStockAlertAt: toDate(s.lastLowStockAlertAt),
    })));

    // lots must exist before stock_movements (FK on lotId) — written above.
    const invMovements = await dbo.collection('inventory_stock_movements').find({}).toArray();
    counts.inventory_stock_movements = await upsertBatched('inventory_stock_movements', invMovements.map((m) => ({
      id: idStr(m._id), itemId: idStr(m.itemId), locationId: idStr(m.locationId), quantityChange: m.quantityChange ?? null,
      movementType: m.movementType ?? null, referenceId: idStr(m.referenceId), referenceModel: m.referenceModel ?? null,
      unitCost: m.unitCost ?? null, lotId: idStr(m.lotId), balanceAfter: m.balanceAfter ?? null, performedBy: idStr(m.performedBy),
      notes: m.notes ?? null, createdAt: toDate(m.createdAt),
    })));

    const invTransfers = await dbo.collection('inventory_transfers').find({}).toArray();
    counts.inventory_transfers = await upsertBatched('inventory_transfers', invTransfers.map((t) => ({
      id: idStr(t._id), fromLocationId: idStr(t.fromLocationId), toLocationId: idStr(t.toLocationId),
      items: t.items ? JSON.stringify(t.items) : null, status: t.status ?? null, requestNotes: t.requestNotes ?? null,
      requestedBy: idStr(t.requestedBy), approvedBy: idStr(t.approvedBy), approvedAt: toDate(t.approvedAt),
      rejectedBy: idStr(t.rejectedBy), rejectionReason: t.rejectionReason ?? null, receivedBy: idStr(t.receivedBy),
      receivedAt: toDate(t.receivedAt), createdAt: toDate(t.createdAt), updatedAt: toDate(t.updatedAt),
    })));

    // ── POS ──────────────────────────────────────────────────────────────────
    const posRegisterSessions = await dbo.collection('pos_register_sessions').find({}).toArray();
    counts.pos_register_sessions = await upsertBatched('pos_register_sessions', posRegisterSessions.map((r) => ({
      id: idStr(r._id), locationId: idStr(r.locationId), openedBy: idStr(r.openedBy), openedAt: toDate(r.openedAt),
      openingFloat: r.openingFloat ?? null, status: r.status ?? null, cashRefunds: r.cashRefunds ?? null, cashSales: r.cashSales ?? null,
      closedAt: toDate(r.closedAt), closedBy: idStr(r.closedBy), closingCount: r.closingCount ?? null, expectedCash: r.expectedCash ?? null,
      variance: r.variance ?? null, createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
    })));

    // register_sessions must exist before pos_sales (FK) — written above.
    const posSales = await dbo.collection('pos_sales').find({}).toArray();
    counts.pos_sales = await upsertBatched('pos_sales', posSales.map((s) => ({
      id: idStr(s._id), saleNumber: s.saleNumber ?? null, locationId: idStr(s.locationId), registerSessionId: idStr(s.registerSessionId),
      contactId: idStr(s.contactId), items: s.items ? JSON.stringify(s.items) : null, cartDiscount: s.cartDiscount ? JSON.stringify(s.cartDiscount) : null,
      promoCode: s.promoCode ?? null, subtotal: s.subtotal ?? null, lineDiscountTotal: s.lineDiscountTotal ?? null,
      cartDiscountAmount: s.cartDiscountAmount ?? null, autoDiscountTotal: s.autoDiscountTotal ?? null, taxTotal: s.taxTotal ?? null,
      total: s.total ?? null, payments: s.payments ? JSON.stringify(s.payments) : null, voucherCode: s.voucherCode ?? null,
      voucherAmount: s.voucherAmount ?? null, status: s.status ?? null, staffId: idStr(s.staffId), staffName: s.staffName ?? null,
      voidReason: s.voidReason ?? null, voidedAt: toDate(s.voidedAt), voidedBy: idStr(s.voidedBy),
      createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    // pos_sales must exist before pos_refunds (FK) — written above.
    const posRefunds = await dbo.collection('pos_refunds').find({}).toArray();
    counts.pos_refunds = await upsertBatched('pos_refunds', posRefunds.map((r) => ({
      id: idStr(r._id), saleId: idStr(r.saleId), saleNumber: r.saleNumber ?? null, locationId: idStr(r.locationId),
      registerSessionId: idStr(r.registerSessionId), items: r.items ? JSON.stringify(r.items) : null, amount: r.amount ?? null,
      method: r.method ?? null, reason: r.reason ?? null, refundedBy: idStr(r.refundedBy), refundedByName: r.refundedByName ?? null,
      createdAt: toDate(r.createdAt),
    })));

    const posPromoCodes = await dbo.collection('pos_promo_codes').find({}).toArray();
    counts.pos_promo_codes = await upsertBatched('pos_promo_codes', posPromoCodes.map((c) => ({
      id: idStr(c._id), code: c.code ?? null, discountType: c.discountType ?? null, discountValue: c.discountValue ?? null,
      expiresAt: toDate(c.expiresAt), isActive: c.isActive ?? true, createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    const posVouchers = await dbo.collection('pos_vouchers').find({}).toArray();
    counts.pos_vouchers = await upsertBatched('pos_vouchers', posVouchers.map((v) => ({
      id: idStr(v._id), code: v.code ?? null, value: v.value ?? null, expiresAt: toDate(v.expiresAt), isActive: v.isActive ?? true,
      redeemedAt: toDate(v.redeemedAt), redeemedSaleId: idStr(v.redeemedSaleId), createdAt: toDate(v.createdAt), updatedAt: toDate(v.updatedAt),
    })));

    // ══════════════════════════════════════════════════════════════════════
    //  PHASE 7 — CRM, Accounting
    // ══════════════════════════════════════════════════════════════════════

    // gl_journal_entry_number_*/ar_invoice_number_*/ap_bill_number_* counters — same
    // "seed the real live seq, don't start fresh at 0" lesson as Phase 5's
    // certificate_number_* fix (see above). These three sequences only start mattering
    // now that glEngine/accountingArFunctions/accountingApFunctions read the real
    // Postgres counters table instead of a dead Mongo one.
    const glCounters = await dbo.collection('counters')
      .find({ _id: { $regex: /^(gl_journal_entry_number|ar_invoice_number|ap_bill_number)_/ } }).toArray();
    counts.counters = (counts.counters || 0) + await upsertBatched('counters', glCounters.map((c) => ({
      id: idStr(c._id), seq: c.seq ?? 0,
    })));

    // ── CRM ──────────────────────────────────────────────────────────────────
    const crmCompanies = await dbo.collection('crm_companies').find({}).toArray();
    counts.crm_companies = await upsertBatched('crm_companies', crmCompanies.map((c) => ({
      id: idStr(c._id), name: c.name ?? null, industry: c.industry ?? null,
      customFieldValues: c.customFieldValues ? JSON.stringify(c.customFieldValues) : null,
      isActive: c.isActive ?? true, createdBy: idStr(c.createdBy), createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    // crm_companies must exist before crm_contacts (FK) — written above.
    const crmContacts = await dbo.collection('crm_contacts').find({}).toArray();
    counts.crm_contacts = await upsertBatched('crm_contacts', crmContacts.map((c) => ({
      id: idStr(c._id), firstName: c.firstName ?? null, lastName: c.lastName ?? null, email: c.email ?? null, phone: c.phone ?? null,
      companyId: idStr(c.companyId), tags: Array.isArray(c.tags) ? c.tags.map(String) : null,
      source: c.source ?? null, sourceWebsite: c.sourceWebsite ?? null, sourceEventName: c.sourceEventName ?? null,
      sourceEventVenue: c.sourceEventVenue ?? null, sourceEventDate: toDate(c.sourceEventDate), assignedTo: idStr(c.assignedTo),
      customFieldValues: c.customFieldValues ? JSON.stringify(c.customFieldValues) : null,
      isActive: c.isActive ?? true, createdBy: idStr(c.createdBy), createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    const crmPipelines = await dbo.collection('crm_pipelines').find({}).toArray();
    counts.crm_pipelines = await upsertBatched('crm_pipelines', crmPipelines.map((p) => ({
      id: idStr(p._id), name: p.name ?? null, stages: p.stages ? JSON.stringify(p.stages) : null,
      isDefault: p.isDefault ?? false, isActive: p.isActive ?? true, createdAt: toDate(p.createdAt), updatedAt: toDate(p.updatedAt),
    })));

    // crm_contacts/crm_companies/crm_pipelines must exist before crm_deals (FK) — written above.
    const crmDeals = await dbo.collection('crm_deals').find({}).toArray();
    counts.crm_deals = await upsertBatched('crm_deals', crmDeals.map((d) => ({
      id: idStr(d._id), title: d.title ?? null, contactId: idStr(d.contactId), companyId: idStr(d.companyId),
      pipelineId: idStr(d.pipelineId), stageId: d.stageId ?? null, value: d.value ?? null, currency: d.currency ?? null,
      expectedCloseDate: toDate(d.expectedCloseDate), nextAction: d.nextAction ? JSON.stringify(d.nextAction) : null,
      assignedTo: idStr(d.assignedTo), status: d.status ?? null, wonAt: toDate(d.wonAt), lostAt: toDate(d.lostAt),
      lostReason: d.lostReason ?? null, confirmedSaleId: idStr(d.confirmedSaleId),
      customFieldValues: d.customFieldValues ? JSON.stringify(d.customFieldValues) : null,
      createdBy: idStr(d.createdBy), createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt),
    })));

    // crm_deals must exist before crm_activities (FK) — written above.
    const crmActivities = await dbo.collection('crm_activities').find({}).toArray();
    counts.crm_activities = await upsertBatched('crm_activities', crmActivities.map((a) => ({
      id: idStr(a._id), type: a.type ?? null, contactId: idStr(a.contactId), dealId: idStr(a.dealId),
      subject: a.subject ?? null, notes: a.notes ?? null, dueDate: toDate(a.dueDate), completed: a.completed ?? null,
      completedAt: toDate(a.completedAt), assignedTo: idStr(a.assignedTo), priority: a.priority ?? null,
      performedBy: idStr(a.performedBy), performedByName: a.performedByName ?? null, createdAt: toDate(a.createdAt),
    })));

    // crm_activities must exist before crm_activity_subtasks (FK) — written above.
    const subtaskRows = crmActivities.flatMap((a) => (Array.isArray(a.subtasks) ? a.subtasks : []).map((s) => ({
      id: idStr(s._id), activityId: idStr(a._id), title: s.title ?? null,
      isCompleted: s.isCompleted ?? false, completedAt: toDate(s.completedAt),
    })));
    counts.crm_activity_subtasks = await upsertBatched('crm_activity_subtasks', subtaskRows);

    const crmFeedback = await dbo.collection('crm_feedback').find({}).toArray();
    counts.crm_feedback = await upsertBatched('crm_feedback', crmFeedback.map((f) => ({
      id: idStr(f._id), contactId: idStr(f.contactId), dealId: idStr(f.dealId), rating: f.rating ?? null,
      comment: f.comment ?? null, loggedBy: idStr(f.loggedBy), loggedByName: f.loggedByName ?? null, createdAt: toDate(f.createdAt),
    })));

    const crmCustomFieldDefs = await dbo.collection('crm_custom_field_defs').find({}).toArray();
    counts.crm_custom_field_defs = await upsertBatched('crm_custom_field_defs', crmCustomFieldDefs.map((d) => ({
      id: idStr(d._id), name: d.name ?? null, fieldType: d.fieldType ?? null, appliesTo: d.appliesTo ?? null,
      options: Array.isArray(d.options) ? d.options.map(String) : null,
      isActive: d.isActive ?? true, createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt),
    })));

    // ── Accounting ───────────────────────────────────────────────────────────
    // gl_accounts self-references (parentId) — no real data uses it (all real accounts
    // are top-level), but written as a single pass since none actually chain.
    const glAccounts = await dbo.collection('gl_accounts').find({}).toArray();
    counts.gl_accounts = await upsertBatched('gl_accounts', glAccounts.map((a) => ({
      id: idStr(a._id), code: a.code ?? null, name: a.name ?? null, type: a.type ?? null, subType: a.subType ?? null,
      parentId: idStr(a.parentId), normalBalance: a.normalBalance ?? null, isSystemAccount: a.isSystemAccount ?? false,
      systemKey: a.systemKey ?? null, linkedExpenseCategories: Array.isArray(a.linkedExpenseCategories) ? a.linkedExpenseCategories.map(String) : null,
      isActive: a.isActive ?? true, balanceCache: a.balanceCache ?? 0, createdBy: idStr(a.createdBy),
      createdAt: toDate(a.createdAt), updatedAt: toDate(a.updatedAt),
    })));

    // gl_accounts must exist before gl_journal_entries (lines[].accountId has no FK, but
    // ap_bills/bank_statement_imports below do reference gl_accounts directly).
    // gl_journal_entries self-references (reversedByEntryId/reversesEntryId) — inserted
    // in createdAt order so a reversal (created after the entry it reverses) never lands
    // before its target.
    const glEntries = (await dbo.collection('gl_journal_entries').find({}).toArray())
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    counts.gl_journal_entries = await upsertBatched('gl_journal_entries', glEntries.map((e) => ({
      id: idStr(e._id), entryNumber: e.entryNumber ?? null, date: toDate(e.date), description: e.description ?? null,
      source: e.source ?? null, sourceModule: e.sourceModule ?? null, referenceId: idStr(e.referenceId), referenceModel: e.referenceModel ?? null,
      lines: e.lines ? JSON.stringify(e.lines) : null, totalDebit: e.totalDebit ?? null, totalCredit: e.totalCredit ?? null,
      status: e.status ?? null, reversedByEntryId: idStr(e.reversedByEntryId), reversesEntryId: idStr(e.reversesEntryId),
      department: e.department ?? null, postedBy: idStr(e.postedBy), postedAt: toDate(e.postedAt), createdAt: toDate(e.createdAt),
      updatedAt: toDate(e.updatedAt), // only reversed entries have this — see migration file's column comment
    })));

    const glPeriods = await dbo.collection('gl_accounting_periods').find({}).toArray();
    counts.gl_accounting_periods = await upsertBatched('gl_accounting_periods', glPeriods.map((p) => ({
      id: idStr(p._id), year: p.year ?? null, month: p.month ?? null, status: p.status ?? null,
      closedAt: toDate(p.closedAt), closedBy: idStr(p.closedBy), createdAt: toDate(p.createdAt),
    })));

    const glPostingFailures = await dbo.collection('gl_posting_failures').find({}).toArray();
    counts.gl_posting_failures = await upsertBatched('gl_posting_failures', glPostingFailures.map((f) => ({
      id: idStr(f._id), source: f.source ?? null, sourceModule: f.sourceModule ?? null, referenceId: idStr(f.referenceId),
      referenceModel: f.referenceModel ?? null, attemptedPayload: f.attemptedPayload ? JSON.stringify(f.attemptedPayload) : null,
      error: f.error ?? null, resolved: f.resolved ?? false, resolvedAt: toDate(f.resolvedAt), resolvedBy: idStr(f.resolvedBy),
      createdAt: toDate(f.createdAt),
    })));

    const arInvoices = await dbo.collection('ar_invoices').find({}).toArray();
    counts.ar_invoices = await upsertBatched('ar_invoices', arInvoices.map((i) => ({
      id: idStr(i._id), invoiceNumber: i.invoiceNumber ?? null, customerId: idStr(i.customerId), customerModel: i.customerModel ?? null,
      customerSnapshot: i.customerSnapshot ? JSON.stringify(i.customerSnapshot) : null, items: i.items ? JSON.stringify(i.items) : null,
      subtotal: i.subtotal ?? null, taxTotal: i.taxTotal ?? null, total: i.total ?? null, amountPaid: i.amountPaid ?? 0,
      balanceDue: i.balanceDue ?? null, dueDate: toDate(i.dueDate), status: i.status ?? null, createdBy: idStr(i.createdBy),
      createdAt: toDate(i.createdAt), updatedAt: toDate(i.updatedAt), sentAt: toDate(i.sentAt), paidAt: toDate(i.paidAt),
    })));

    // ar_invoices must exist before ar_payments (FK) — written above.
    const arPayments = await dbo.collection('ar_payments').find({}).toArray();
    counts.ar_payments = await upsertBatched('ar_payments', arPayments.map((p) => ({
      id: idStr(p._id), invoiceId: idStr(p.invoiceId), amount: p.amount ?? null, method: p.method ?? null,
      reference: p.reference ?? null, paidAt: toDate(p.paidAt), recordedBy: idStr(p.recordedBy), createdAt: toDate(p.createdAt),
    })));

    // gl_accounts must exist before ap_bills (FK expenseAccountId) — written above.
    const apBills = await dbo.collection('ap_bills').find({}).toArray();
    counts.ap_bills = await upsertBatched('ap_bills', apBills.map((b) => ({
      id: idStr(b._id), billNumber: b.billNumber ?? null, vendorName: b.vendorName ?? null, expenseAccountId: idStr(b.expenseAccountId),
      items: b.items ? JSON.stringify(b.items) : null, totalAmount: b.totalAmount ?? null, dueDate: toDate(b.dueDate),
      scheduledPaymentDate: toDate(b.scheduledPaymentDate), status: b.status ?? null, approvedBy: idStr(b.approvedBy),
      approvedAt: toDate(b.approvedAt), paidAt: toDate(b.paidAt), paymentMethod: b.paymentMethod ?? null,
      paymentReference: b.paymentReference ?? null, createdBy: idStr(b.createdBy), createdAt: toDate(b.createdAt), updatedAt: toDate(b.updatedAt),
    })));

    // gl_accounts must exist before bank_statement_imports (FK) — written above.
    const bankImports = await dbo.collection('bank_statement_imports').find({}).toArray();
    counts.bank_statement_imports = await upsertBatched('bank_statement_imports', bankImports.map((i) => ({
      id: idStr(i._id), accountId: idStr(i.accountId), filename: i.filename ?? null, importedBy: idStr(i.importedBy),
      importedAt: toDate(i.importedAt), periodStart: toDate(i.periodStart), periodEnd: toDate(i.periodEnd),
      openingBalance: i.openingBalance ?? null, closingBalance: i.closingBalance ?? null, lines: i.lines ? JSON.stringify(i.lines) : null,
      status: i.status ?? null, reconciledAt: toDate(i.reconciledAt), reconciledBy: idStr(i.reconciledBy), createdAt: toDate(i.createdAt),
    })));

    // ══════════════════════════════════════════════════════════════════════
    //  PHASE 8 — Logistics, Spending/Procurement/Expenses
    // ══════════════════════════════════════════════════════════════════════

    // po_number_*/po_invoice_number_* counters — same "seed the real live seq, don't
    // start fresh at 0" lesson as every earlier phase's counter migration.
    const spendCounters = await dbo.collection('counters')
      .find({ _id: { $regex: /^(po_number|po_invoice_number)_/ } }).toArray();
    counts.counters = (counts.counters || 0) + await upsertBatched('counters', spendCounters.map((c) => ({
      id: idStr(c._id), seq: c.seq ?? 0,
    })));

    // ── Logistics ────────────────────────────────────────────────────────────
    const vehicleTypes = await dbo.collection('logistics_vehicle_types').find({}).toArray();
    counts.logistics_vehicle_types = await upsertBatched('logistics_vehicle_types', vehicleTypes.map((v) => ({
      id: idStr(v._id), name: v.name ?? null, isActive: v.isActive ?? true, createdAt: toDate(v.createdAt), updatedAt: toDate(v.updatedAt),
    })));

    const serviceBays = await dbo.collection('logistics_service_bays').find({}).toArray();
    counts.logistics_service_bays = await upsertBatched('logistics_service_bays', serviceBays.map((b) => ({
      id: idStr(b._id), name: b.name ?? null, isActive: b.isActive ?? true, createdAt: toDate(b.createdAt), updatedAt: toDate(b.updatedAt),
    })));

    const vehicles = await dbo.collection('logistics_vehicles').find({}).toArray();
    counts.logistics_vehicles = await upsertBatched('logistics_vehicles', vehicles.map((v) => ({
      id: idStr(v._id), make: v.make ?? null, model: v.model ?? null, licensePlate: v.licensePlate ?? null, vin: v.vin ?? null,
      vehicleType: v.vehicleType ?? null, driverId: idStr(v.driverId), status: v.status ?? null, currentLocation: v.currentLocation ?? null,
      odometer: v.odometer ?? 0, fuelType: v.fuelType ?? null, department: v.department ?? null, createdBy: idStr(v.createdBy),
      createdAt: toDate(v.createdAt), updatedAt: toDate(v.updatedAt), locationUpdatedAt: toDate(v.locationUpdatedAt),
    })));

    // logistics_vehicles must exist before logistics_routes (FK) — written above.
    const routes = await dbo.collection('logistics_routes').find({}).toArray();
    counts.logistics_routes = await upsertBatched('logistics_routes', routes.map((r) => ({
      id: idStr(r._id), vehicleId: idStr(r.vehicleId), driverId: idStr(r.driverId), date: toDate(r.date), status: r.status ?? null,
      department: r.department ?? null, createdBy: idStr(r.createdBy), createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
    })));

    // logistics_routes must exist before logistics_shipments (FK routeId) — written above.
    const shipments = await dbo.collection('logistics_shipments').find({}).toArray();
    counts.logistics_shipments = await upsertBatched('logistics_shipments', shipments.map((s) => ({
      id: idStr(s._id), sourceType: s.sourceType ?? null, sourceId: idStr(s.sourceId), status: s.status ?? null,
      routeId: idStr(s.routeId), stopId: s.stopId ?? null, expectedDeliveryDate: toDate(s.expectedDeliveryDate),
      actualDeliveryDate: toDate(s.actualDeliveryDate), exceptionReason: s.exceptionReason ?? null,
      exceptionResolution: s.exceptionResolution ?? null, exceptionResolvedAt: toDate(s.exceptionResolvedAt),
      department: s.department ?? null, createdBy: idStr(s.createdBy), createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    // logistics_routes/logistics_shipments must both exist before logistics_route_stops
    // (FK routeId/shipmentId) — written above.
    const stopRows = routes.flatMap((r) => (Array.isArray(r.stops) ? r.stops : []).map((s) => ({
      id: idStr(s.id), routeId: idStr(r._id), sequence: s.sequence ?? null, address: s.address ?? null,
      lat: s.lat ?? null, lng: s.lng ?? null, timeWindowStart: s.timeWindowStart ?? null, timeWindowEnd: s.timeWindowEnd ?? null,
      shipmentId: idStr(s.shipmentId), status: s.status ?? null, proofOfDeliveryUrl: s.proofOfDeliveryUrl ?? null,
      signatureUrl: s.signatureUrl ?? null, notes: s.notes ?? null, completedAt: toDate(s.completedAt),
    })));
    counts.logistics_route_stops = await upsertBatched('logistics_route_stops', stopRows);

    const workOrders = await dbo.collection('logistics_work_orders').find({}).toArray();
    counts.logistics_work_orders = await upsertBatched('logistics_work_orders', workOrders.map((w) => ({
      id: idStr(w._id), vehicleId: idStr(w.vehicleId), type: w.type ?? null, description: w.description ?? null, status: w.status ?? null,
      scheduledDate: toDate(w.scheduledDate), completedDate: toDate(w.completedDate), serviceBay: w.serviceBay ?? null,
      laborCost: w.laborCost ?? 0, otherCost: w.otherCost ?? 0, totalCost: w.totalCost ?? 0, postedToAccounting: w.postedToAccounting ?? false,
      createdBy: idStr(w.createdBy), createdAt: toDate(w.createdAt), updatedAt: toDate(w.updatedAt),
    })));

    // logistics_work_orders must exist before logistics_work_order_parts (FK) — written
    // above. No natural id on a part — auto-increment PK, plain insert (no upsert key).
    const partRows = workOrders.flatMap((w) => (Array.isArray(w.partsUsed) ? w.partsUsed : []).map((p) => ({
      workOrderId: idStr(w._id), itemId: idStr(p.itemId), itemName: p.itemName ?? null, sku: p.sku ?? null,
      locationId: idStr(p.locationId), quantity: p.quantity ?? null, unitCost: p.unitCost ?? null,
    })));
    counts.logistics_work_order_parts = await upsertBatched('logistics_work_order_parts', partRows, null);

    // ── Spending / Procurement / Expenses ─────────────────────────────────────
    const vendors = await dbo.collection('vendors').find({}).toArray();
    counts.vendors = await upsertBatched('vendors', vendors.map((v) => ({
      id: idStr(v._id), name: v.name ?? null, contactName: v.contactName ?? null, email: v.email ?? null, phone: v.phone ?? null,
      address: v.address ?? null, category: v.category ?? null, type: v.type ?? null, taxId: v.taxId ?? null, paymentTerms: v.paymentTerms ?? null,
      bankDetails: v.bankDetails ? JSON.stringify(v.bankDetails) : null, documents: v.documents ? JSON.stringify(v.documents) : null,
      status: v.status ?? null, notes: v.notes ?? null, approvedBy: idStr(v.approvedBy), approvedAt: toDate(v.approvedAt),
      rejectedBy: idStr(v.rejectedBy), rejectedAt: toDate(v.rejectedAt), rejectionReason: v.rejectionReason ?? null,
      createdBy: idStr(v.createdBy), createdAt: toDate(v.createdAt), updatedAt: toDate(v.updatedAt),
    })));

    const procPolicies = await dbo.collection('procurement_policies').find({}).toArray();
    counts.procurement_policies = await upsertBatched('procurement_policies', procPolicies.map((p) => ({
      id: idStr(p._id), name: p.name ?? null, description: p.description ?? null, appliesTo: p.appliesTo ? JSON.stringify(p.appliesTo) : null,
      approvalChain: p.approvalChain ? JSON.stringify(p.approvalChain) : null, requiresQuotationAbove: p.requiresQuotationAbove ?? null,
      preferredVendors: Array.isArray(p.preferredVendors) ? p.preferredVendors.map(String) : null,
      isDefault: p.isDefault ?? false, isActive: p.isActive ?? true, createdBy: idStr(p.createdBy),
      createdAt: toDate(p.createdAt), updatedAt: toDate(p.updatedAt),
    })));

    const expPolicies = await dbo.collection('expense_policies').find({}).toArray();
    counts.expense_policies = await upsertBatched('expense_policies', expPolicies.map((p) => ({
      id: idStr(p._id), name: p.name ?? null, description: p.description ?? null, isDefault: p.isDefault ?? false,
      appliesTo: p.appliesTo ? JSON.stringify(p.appliesTo) : null, categories: p.categories ? JSON.stringify(p.categories) : null,
      approvalChain: p.approvalChain ? JSON.stringify(p.approvalChain) : null, perDiemRates: p.perDiemRates ? JSON.stringify(p.perDiemRates) : null,
      defaultPerDiemRate: p.defaultPerDiemRate ?? null, mileageRate: p.mileageRate ?? null,
      categoryLimits: p.categoryLimits ? JSON.stringify(p.categoryLimits) : null, autoApproveUnder: p.autoApproveUnder ?? null,
      hrApprovalThreshold: p.hrApprovalThreshold ?? null, reimbursementCycle: p.reimbursementCycle ?? null,
      isActive: p.isActive ?? true, createdBy: idStr(p.createdBy), createdAt: toDate(p.createdAt), updatedAt: toDate(p.updatedAt),
    })));

    // vendors/procurement_policies/employees must all exist before purchase_requests (FK) — written above.
    const purchaseRequests = await dbo.collection('purchase_requests').find({}).toArray();
    counts.purchase_requests = await upsertBatched('purchase_requests', purchaseRequests.map((r) => ({
      id: idStr(r._id), title: r.title ?? null, description: r.description ?? null, justification: r.justification ?? null,
      estimatedCost: r.estimatedCost ?? null, currency: r.currency ?? null, priority: r.priority ?? null, vendor: r.vendor ?? null,
      vendorId: idStr(r.vendorId), department: r.department ?? null, items: r.items ? JSON.stringify(r.items) : null,
      neededBy: toDate(r.neededBy), policyId: idStr(r.policyId), approvalChain: r.approvalChain ? JSON.stringify(r.approvalChain) : null,
      currentApprovalLevel: r.currentApprovalLevel ?? 0, requestedBy: idStr(r.requestedBy), employeeId: idStr(r.employeeId),
      status: r.status ?? null, convertedToPOId: idStr(r.convertedToPOId), approvedBy: idStr(r.approvedBy), approvedAt: toDate(r.approvedAt),
      rejectedBy: idStr(r.rejectedBy), rejectedAt: toDate(r.rejectedAt), rejectionReason: r.rejectionReason ?? null,
      createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
    })));

    // purchase_requests/vendors must both exist before purchase_orders (FK) — written above.
    const purchaseOrders = await dbo.collection('purchase_orders').find({}).toArray();
    counts.purchase_orders = await upsertBatched('purchase_orders', purchaseOrders.map((o) => ({
      id: idStr(o._id), requisitionId: idStr(o.requisitionId), poNumber: o.poNumber ?? null, vendorId: idStr(o.vendorId),
      requestedBy: idStr(o.requestedBy), departmentId: o.departmentId ?? null, status: o.status ?? null,
      items: o.items ? JSON.stringify(o.items) : null, totalAmount: o.totalAmount ?? null, currency: o.currency ?? null,
      deliveryAddress: o.deliveryAddress ?? null, expectedDeliveryDate: toDate(o.expectedDeliveryDate), actualDeliveryDate: toDate(o.actualDeliveryDate),
      paymentTerms: o.paymentTerms ?? null, notes: o.notes ?? null,
      attachmentUrls: Array.isArray(o.attachmentUrls) ? o.attachmentUrls.map(String) : null, invoiceId: idStr(o.invoiceId),
      createdBy: idStr(o.createdBy), createdAt: toDate(o.createdAt), updatedAt: toDate(o.updatedAt),
    })));

    // purchase_orders must exist before goods_receipts (FK) — written above.
    const goodsReceipts = await dbo.collection('goods_receipts').find({}).toArray();
    counts.goods_receipts = await upsertBatched('goods_receipts', goodsReceipts.map((g) => ({
      id: idStr(g._id), purchaseOrderId: idStr(g.purchaseOrderId), receivedBy: idStr(g.receivedBy), receivedAt: toDate(g.receivedAt),
      items: g.items ? JSON.stringify(g.items) : null, status: g.status ?? null, notes: g.notes ?? null,
      attachmentUrls: Array.isArray(g.attachmentUrls) ? g.attachmentUrls.map(String) : null, createdAt: toDate(g.createdAt),
    })));

    // purchase_orders/vendors must both exist before vendor_invoices (FK) — written above.
    const vendorInvoices = await dbo.collection('vendor_invoices').find({}).toArray();
    counts.vendor_invoices = await upsertBatched('vendor_invoices', vendorInvoices.map((i) => ({
      id: idStr(i._id), purchaseOrderId: idStr(i.purchaseOrderId), vendorId: idStr(i.vendorId), invoiceNumber: i.invoiceNumber ?? null,
      poInvoiceNumber: i.poInvoiceNumber ?? null, invoiceDate: toDate(i.invoiceDate), dueDate: toDate(i.dueDate),
      items: i.items ? JSON.stringify(i.items) : null, totalAmount: i.totalAmount ?? null, currency: i.currency ?? null,
      status: i.status ?? null, threeWayMatchStatus: i.threeWayMatchStatus ?? null, discrepancyNotes: i.discrepancyNotes ?? null,
      fileUrl: i.fileUrl ?? null, approvedBy: idStr(i.approvedBy), approvedAt: toDate(i.approvedAt), paidAt: toDate(i.paidAt),
      paymentMethod: i.paymentMethod ?? null, paymentReference: i.paymentReference ?? null,
      createdAt: toDate(i.createdAt), updatedAt: toDate(i.updatedAt),
    })));

    const corporateCards = await dbo.collection('corporate_cards').find({}).toArray();
    counts.corporate_cards = await upsertBatched('corporate_cards', corporateCards.map((c) => ({
      id: idStr(c._id), last4: c.last4 ?? null, cardHolder: c.cardHolder ?? null, assignedTo: idStr(c.assignedTo),
      creditLimit: c.creditLimit ?? null, currency: c.currency ?? null, expiryDate: toDate(c.expiryDate), network: c.network ?? null,
      status: c.status ?? null, createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    // corporate_cards must exist before card_transactions (FK) — written above.
    const cardTransactions = await dbo.collection('card_transactions').find({}).toArray();
    counts.card_transactions = await upsertBatched('card_transactions', cardTransactions.map((c) => ({
      id: idStr(c._id), cardId: idStr(c.cardId), amount: c.amount ?? null, description: c.description ?? null, date: toDate(c.date),
      merchant: c.merchant ?? null, category: c.category ?? null, type: c.type ?? null, createdAt: toDate(c.createdAt),
    })));

    // Legacy — 0 real rows expected, migrated for completeness (see migration file header).
    const legacyExpenses = await dbo.collection('expenses').find({}).toArray();
    counts.expenses = await upsertBatched('expenses', legacyExpenses.map((e) => ({
      id: idStr(e._id), description: e.description ?? null, category: e.category ?? null, amount: e.amount ?? null,
      currency: e.currency ?? null, date: toDate(e.date), vendor: e.vendor ?? null, paymentMethod: e.paymentMethod ?? null,
      notes: e.notes ?? null, recordedBy: e.recordedBy ?? null, createdAt: toDate(e.createdAt), updatedAt: toDate(e.updatedAt),
    })));

    const legacyInvoices = await dbo.collection('invoices').find({}).toArray();
    counts.invoices = await upsertBatched('invoices', legacyInvoices.map((i) => ({
      id: idStr(i._id), vendor: i.vendor ?? null, amount: i.amount ?? null, currency: i.currency ?? null, dueDate: toDate(i.dueDate),
      description: i.description ?? null, invoiceNumber: i.invoiceNumber ?? null, type: i.type ?? null, projectId: idStr(i.projectId),
      items: i.items ? JSON.stringify(i.items) : null, status: i.status ?? null, submittedBy: idStr(i.submittedBy),
      approvedBy: idStr(i.approvedBy), approvedAt: toDate(i.approvedAt), rejectedBy: idStr(i.rejectedBy), rejectedAt: toDate(i.rejectedAt),
      rejectionReason: i.rejectionReason ?? null, paidAt: toDate(i.paidAt), paymentReference: i.paymentReference ?? null,
      createdAt: toDate(i.createdAt), updatedAt: toDate(i.updatedAt),
    })));

    // expense_policies/employees/payroll_cycles must all exist before expense_claims (FK) — payroll_cycles is Postgres since Phase 2.
    const expenseClaims = await dbo.collection('expense_claims').find({}).toArray();
    counts.expense_claims = await upsertBatched('expense_claims', expenseClaims.map((c) => ({
      id: idStr(c._id), employeeId: idStr(c.employeeId), department: c.department ?? null, type: c.type ?? null, category: c.category ?? null,
      amount: c.amount ?? null, currency: c.currency ?? null, date: toDate(c.date), description: c.description ?? null, notes: c.notes ?? null,
      receiptFile: c.receiptFile ?? null, destination: c.destination ?? null, startDate: toDate(c.startDate), endDate: toDate(c.endDate),
      perDiemDays: c.perDiemDays ?? null, fromLocation: c.fromLocation ?? null, toLocation: c.toLocation ?? null, distanceKm: c.distanceKm ?? null,
      isRoundTrip: c.isRoundTrip ?? false, projectId: idStr(c.projectId), isBillable: c.isBillable ?? false,
      items: c.items ? JSON.stringify(c.items) : null, isPolicyViolation: c.isPolicyViolation ?? false, violationReason: c.violationReason ?? null,
      policyId: idStr(c.policyId), approvalChain: c.approvalChain ? JSON.stringify(c.approvalChain) : null, currentApprovalLevel: c.currentApprovalLevel ?? 0,
      status: c.status ?? null, approvedBy: idStr(c.approvedBy), approvedAt: toDate(c.approvedAt), rejectedBy: idStr(c.rejectedBy),
      rejectedAt: toDate(c.rejectedAt), rejectionReason: c.rejectionReason ?? null, disputeReason: c.disputeReason ?? null, disputedAt: toDate(c.disputedAt),
      reimbursedAt: toDate(c.reimbursedAt), reimbursedBy: idStr(c.reimbursedBy), reimbursementMethod: c.reimbursementMethod ?? null,
      reimbursementReference: c.reimbursementReference ?? null, reimbursementEvidenceFilename: c.reimbursementEvidenceFilename ?? null,
      reimbursementEvidenceOriginalName: c.reimbursementEvidenceOriginalName ?? null, payrollCycleId: idStr(c.payrollCycleId),
      createdAt: toDate(c.createdAt), updatedAt: toDate(c.updatedAt),
    })));

    // ══════════════════════════════════════════════════════════════════════
    // PHASE 9 — Projects/Tasks, Communication/Social/Messages, Awards, IT
    // ══════════════════════════════════════════════════════════════════════

    // ── projects (+ members, invites, subtasks, notes, chat groups, messages) ──
    const projects = await dbo.collection('projects').find({}).toArray();
    counts.projects = await upsertBatched('projects', projects.map((p) => ({
      id: idStr(p._id), name: p.name ?? null, description: p.description ?? null, status: p.status ?? null,
      startDate: toDate(p.startDate), endDate: toDate(p.endDate), departments: p.departments ? JSON.stringify(p.departments) : null,
      teamLeaderId: idStr(p.teamLeaderId), teamLeaderName: p.teamLeaderName ?? null, createdBy: idStr(p.createdBy),
      supervisorName: p.supervisorName ?? null, completedAt: toDate(p.completedAt),
      code: p.code ?? null, clientName: p.clientName ?? null, clientId: idStr(p.clientId), budget: p.budget ?? null,
      currency: p.currency ?? null, billable: p.billable ?? null, createdAt: toDate(p.createdAt), updatedAt: toDate(p.updatedAt),
    })));

    const projectMembers = await dbo.collection('project_members').find({}).toArray();
    counts.project_members = await upsertBatched('project_members', projectMembers.map((m) => ({
      id: idStr(m._id), projectId: idStr(m.projectId), employeeId: idStr(m.employeeId), name: m.name ?? null,
      department: m.department ?? null, role: m.role ?? null, addedAt: toDate(m.addedAt),
    })));

    const projectInvites = await dbo.collection('project_invites').find({}).toArray();
    counts.project_invites = await upsertBatched('project_invites', projectInvites.map((i) => ({
      id: idStr(i._id), projectId: idStr(i.projectId), projectName: i.projectName ?? null, email: i.email ?? null,
      name: i.name ?? null, projectRole: i.projectRole ?? null, contractEndDate: toDate(i.contractEndDate),
      invitedBy: idStr(i.invitedBy), invitedByName: i.invitedByName ?? null, tokenHash: i.tokenHash ?? null,
      status: i.status ?? null, expiresAt: toDate(i.expiresAt), createdEmployeeId: idStr(i.createdEmployeeId),
      respondedAt: toDate(i.respondedAt), createdAt: toDate(i.createdAt), updatedAt: toDate(i.updatedAt),
    })));

    const projectSubtasks = await dbo.collection('project_subtasks').find({}).toArray();
    counts.project_subtasks = await upsertBatched('project_subtasks', projectSubtasks.map((s) => ({
      id: idStr(s._id), projectId: idStr(s.projectId), title: s.title ?? null, description: s.description ?? null,
      department: s.department ?? null, attachmentFilename: s.attachmentFilename ?? null,
      attachmentOriginalName: s.attachmentOriginalName ?? null, status: s.status ?? null,
      assignedEmployees: s.assignedEmployees ? JSON.stringify(s.assignedEmployees) : null,
      deptHeadReport: s.deptHeadReport ? JSON.stringify(s.deptHeadReport) : null,
      createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    const projectNotes = await dbo.collection('project_notes').find({}).toArray();
    counts.project_notes = await upsertBatched('project_notes', projectNotes.map((n) => ({
      id: idStr(n._id), projectId: idStr(n.projectId), text: n.text ?? null, createdBy: idStr(n.createdBy),
      createdByName: n.createdByName ?? null, createdAt: toDate(n.createdAt),
    })));

    const projectChatGroups = await dbo.collection('project_chat_groups').find({}).toArray();
    counts.project_chat_groups = await upsertBatched('project_chat_groups', projectChatGroups.map((g) => ({
      id: idStr(g._id), projectId: idStr(g.projectId), name: g.name ?? null,
      memberIds: g.memberIds ? JSON.stringify(g.memberIds.map(idStr)) : null,
      createdBy: idStr(g.createdBy), createdByName: g.createdByName ?? null,
      createdAt: toDate(g.createdAt), updatedAt: toDate(g.updatedAt),
    })));

    // project_chat_groups must exist before project_messages (FK) — written above.
    const projectMessages = await dbo.collection('project_messages').find({}).toArray();
    counts.project_messages = await upsertBatched('project_messages', projectMessages.map((m) => ({
      id: idStr(m._id), projectId: idStr(m.projectId), groupId: idStr(m.groupId), senderId: idStr(m.senderId),
      senderName: m.senderName ?? null, senderRole: m.senderRole ?? null, message: m.message ?? null,
      attachmentFilename: m.attachmentFilename ?? null, attachmentOriginalName: m.attachmentOriginalName ?? null,
      attachmentMimeType: m.attachmentMimeType ?? null, createdAt: toDate(m.createdAt),
    })));

    // project_time_entries — NEW table (see migration file header), 0 real Mongo rows
    // to migrate since the write endpoint never existed before this phase.
    const projectTimeEntries = await dbo.collection('project_time_entries').find({}).toArray();
    counts.project_time_entries = await upsertBatched('project_time_entries', projectTimeEntries.map((e) => ({
      id: idStr(e._id), projectId: idStr(e.projectId), employeeId: idStr(e.employeeId), hours: e.hours ?? null,
      date: toDate(e.date), task: e.task ?? null, description: e.description ?? null, billable: e.billable ?? false,
      createdAt: toDate(e.createdAt), updatedAt: toDate(e.updatedAt),
    })));

    // ── task_templates (+ tasks and their child tables) ──────────────────────
    const taskTemplates = await dbo.collection('task_templates').find({}).toArray();
    counts.task_templates = await upsertBatched('task_templates', taskTemplates.map((t) => ({
      id: idStr(t._id), name: t.name ?? null, description: t.description ?? null, triggerEvent: t.triggerEvent ?? null,
      applyTo: t.applyTo ? JSON.stringify(t.applyTo) : null, isActive: t.isActive ?? true, isDefault: t.isDefault ?? false,
      sections: t.sections ? JSON.stringify(t.sections) : null, tasks: t.tasks ? JSON.stringify(t.tasks) : null,
      usageCount: t.usageCount ?? 0, createdBy: t.createdBy ?? null, createdAt: toDate(t.createdAt), updatedAt: toDate(t.updatedAt),
    })));

    // task_templates must exist before tasks (FK templateId) — written above.
    const tasks = await dbo.collection('tasks').find({}).toArray();
    counts.tasks = await upsertBatched('tasks', tasks.map((t) => ({
      id: idStr(t._id), title: t.title ?? null, description: t.description ?? null, notes: t.notes ?? null,
      status: t.status ?? null, priority: t.priority ?? null, type: t.type ?? null,
      assignedTo: idStr(t.assignedTo), assignedToName: t.assignedToName ?? null, assignedToRole: t.assignedToRole ?? null,
      assignedBy: t.assignedBy ?? null, department: t.department ?? null,
      module: t.module ?? null, linkedEmployeeId: idStr(t.linkedEmployeeId), linkedEmployeeName: t.linkedEmployeeName ?? null,
      dueDate: t.dueDate ?? null, startDate: t.startDate ?? null, completedAt: toDate(t.completedAt),
      documentAction: t.documentAction ?? null, documentStatus: t.documentStatus ?? null, meetingDuration: t.meetingDuration ?? null,
      meetingLocation: t.meetingLocation ?? null, meetingLink: t.meetingLink ?? null,
      meetingAttendees: t.meetingAttendees ? JSON.stringify(t.meetingAttendees.map(idStr)) : null,
      deviceAction: t.deviceAction ?? null, deviceStatus: t.deviceStatus ?? null, approvalType: t.approvalType ?? null,
      approverId: idStr(t.approverId), approvalDecision: t.approvalDecision ?? null,
      blockedByTaskIds: t.blockedByTaskIds ? JSON.stringify(t.blockedByTaskIds.map(idStr)) : null,
      attachments: t.attachments ? JSON.stringify(t.attachments) : null, tags: t.tags ? JSON.stringify(t.tags) : null,
      templateId: idStr(t.templateId), templateTaskId: idStr(t.templateTaskId), sectionId: idStr(t.sectionId),
      isTeam: t.isTeam ?? false, teamId: idStr(t.teamId),
      createdBy: idStr(t.createdBy), createdByName: t.createdByName ?? null,
      createdAt: toDate(t.createdAt), updatedAt: toDate(t.updatedAt),
    })));

    // tasks must exist before their child tables (FK) — written above.
    const taskSubtasks = tasks.flatMap((t) => (Array.isArray(t.subtasks) ? t.subtasks : []).map((s) => ({
      id: idStr(s._id), taskId: idStr(t._id), title: s.title ?? null, isCompleted: s.isCompleted ?? false,
      completedAt: toDate(s.completedAt),
    })));
    counts.task_subtasks = await upsertBatched('task_subtasks', taskSubtasks);

    const taskComments = tasks.flatMap((t) => (Array.isArray(t.comments) ? t.comments : []).map((c) => ({
      id: idStr(c._id), taskId: idStr(t._id), authorId: idStr(c.authorId), authorName: c.authorName ?? null,
      text: c.text ?? null, mentions: c.mentions ? JSON.stringify(c.mentions) : null, createdAt: toDate(c.createdAt),
    })));
    counts.task_comments = await upsertBatched('task_comments', taskComments);

    // No natural id on activity entries — plain insert, no upsert conflict key.
    const taskActivity = tasks.flatMap((t) => (Array.isArray(t.activity) ? t.activity : []).map((a) => ({
      taskId: idStr(t._id), action: a.action ?? null, fromValue: a.from != null ? String(a.from) : null,
      toValue: a.to != null ? String(a.to) : null, performedByName: a.performedByName ?? null, timestamp: toDate(a.timestamp),
    })));
    counts.task_activity = await upsertBatched('task_activity', taskActivity, null);

    // ── communities (+ members) ───────────────────────────────────────────────
    const communities = await dbo.collection('communities').find({}).toArray();
    counts.communities = await upsertBatched('communities', communities.map((c) => ({
      id: idStr(c._id), companyId: idStr(c.companyId), name: c.name ?? null, description: c.description ?? null,
      icon: c.icon ?? null, type: c.type ?? null, adminIds: c.adminIds ? JSON.stringify(c.adminIds.map(idStr)) : null,
      isArchived: c.isArchived ?? false, createdBy: idStr(c.createdBy), createdAt: toDate(c.createdAt),
    })));

    // communities must exist before community_members (FK) — written above.
    const communityMembers = communities.flatMap((c) => (Array.isArray(c.memberIds) ? c.memberIds : []).map((personId) => ({
      communityId: idStr(c._id), personId: idStr(personId), addedAt: toDate(c.createdAt),
    })));
    counts.community_members = await upsertBatched('community_members', communityMembers, ['communityId', 'personId']);

    // ── community_posts (+ reactions) and post_comments ───────────────────────
    const communityPosts = await dbo.collection('community_posts').find({}).toArray();
    counts.community_posts = await upsertBatched('community_posts', communityPosts.map((p) => ({
      id: idStr(p._id), companyId: idStr(p.companyId), communityId: idStr(p.communityId), authorId: idStr(p.authorId),
      authorName: p.authorName ?? null, type: p.type ?? null, content: p.content ?? null,
      imageUrls: p.imageUrls ? JSON.stringify(p.imageUrls) : null, isPinned: p.isPinned ?? false, pinExpiresAt: toDate(p.pinExpiresAt),
      celebrationType: p.celebrationType ?? null, celebrationEmployeeId: idStr(p.celebrationEmployeeId),
      celebrationEmployeeName: p.celebrationEmployeeName ?? null, visibility: p.visibility ?? null,
      commentCount: p.commentCount ?? 0, viewCount: p.viewCount ?? 0, createdAt: toDate(p.createdAt), updatedAt: toDate(p.updatedAt),
    })));

    // community_posts must exist before community_post_reactions (FK) — written above.
    const communityPostReactions = communityPosts.flatMap((p) => (Array.isArray(p.reactions) ? p.reactions : []).map((r) => ({
      postId: idStr(p._id), userId: idStr(r.employeeId), type: r.type ?? null, reactedAt: toDate(r.reactedAt),
    })));
    counts.community_post_reactions = await upsertBatched('community_post_reactions', communityPostReactions, ['postId', 'userId', 'type']);

    // Top-level comments must be written before replies (self-FK parentCommentId) —
    // sort so every parent lands before its children within the same batch pass.
    const postComments = await dbo.collection('post_comments').find({}).toArray();
    const postCommentsSorted = [...postComments].sort((a, b) => (a.parentCommentId ? 1 : 0) - (b.parentCommentId ? 1 : 0));
    counts.post_comments = await upsertBatched('post_comments', postCommentsSorted.map((c) => ({
      id: idStr(c._id), postId: idStr(c.postId), authorId: idStr(c.authorId), content: c.content ?? null,
      parentCommentId: idStr(c.parentCommentId), reactions: c.reactions ? JSON.stringify(c.reactions) : null,
      createdAt: toDate(c.createdAt),
    })));

    // ── 1:1 meetings (Communication module's — see migration file header for the
    // communication_one_on_ones vs Phase 5's own one_on_ones naming collision note) ──
    const commOneOnOnes = await dbo.collection('one_on_ones').find({}).toArray();
    counts.communication_one_on_ones = await upsertBatched('communication_one_on_ones', commOneOnOnes.map((s) => ({
      id: idStr(s._id), companyId: idStr(s.companyId), participant1Id: idStr(s.participant1Id),
      participant2Id: idStr(s.participant2Id), frequency: s.frequency ?? null, dayOfWeek: s.dayOfWeek ?? null,
      time: s.time ?? null, duration: s.duration ?? null, videoLink: s.videoLink ?? null, isActive: s.isActive ?? true,
      createdAt: toDate(s.createdAt),
    })));

    // communication_one_on_ones must exist before meeting_notes (FK) — written above.
    const meetingNotes = await dbo.collection('meeting_notes').find({}).toArray();
    counts.meeting_notes = await upsertBatched('meeting_notes', meetingNotes.map((n) => ({
      id: idStr(n._id), seriesId: idStr(n.seriesId), companyId: idStr(n.companyId), date: toDate(n.date),
      agendaItems: n.agendaItems ? JSON.stringify(n.agendaItems) : null, notes: n.notes ?? null,
      actionItems: n.actionItems ? JSON.stringify(n.actionItems) : null, aiSummary: n.aiSummary ?? null,
      status: n.status ?? null, createdAt: toDate(n.createdAt), updatedAt: toDate(n.updatedAt),
    })));

    // ── trust_reports (anonymous, no FKs) ─────────────────────────────────────
    const trustReports = await dbo.collection('trust_reports').find({}).toArray();
    counts.trust_reports = await upsertBatched('trust_reports', trustReports.map((r) => ({
      id: idStr(r._id), trackingCode: r.trackingCode ?? null, category: r.category ?? null, description: r.description ?? null,
      attachmentUrl: r.attachmentUrl ?? null, status: r.status ?? null, adminNotes: r.adminNotes ?? null,
      responseToReporter: r.responseToReporter ?? null, createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
    })));

    // ── conversations (+ participants) and messages (+ reads) ────────────────
    const conversations = await dbo.collection('conversations').find({}).toArray();
    counts.conversations = await upsertBatched('conversations', conversations.map((c) => ({
      id: idStr(c._id), isGroup: c.isGroup ?? false, groupName: c.groupName ?? null, lastMessage: c.lastMessage ?? null,
      lastMessageAt: toDate(c.lastMessageAt), createdBy: idStr(c.createdBy), createdAt: toDate(c.createdAt),
    })));

    // conversations must exist before conversation_participants (FK) — written above.
    // Folds participants[] + admins[] into one row per person with an isAdmin flag.
    const conversationParticipants = conversations.flatMap((c) => {
      const adminSet = new Set((c.admins || []).map(idStr));
      return (Array.isArray(c.participants) ? c.participants : []).map((p) => ({
        conversationId: idStr(c._id), userId: idStr(p), isAdmin: adminSet.has(idStr(p)), joinedAt: toDate(c.createdAt),
      }));
    });
    counts.conversation_participants = await upsertBatched('conversation_participants', conversationParticipants, ['conversationId', 'userId']);

    const messages = await dbo.collection('messages').find({}).toArray();
    counts.messages = await upsertBatched('messages', messages.map((m) => ({
      id: idStr(m._id), conversationId: idStr(m.conversationId), senderId: idStr(m.senderId), senderName: m.senderName ?? null,
      content: m.content ?? null, attachments: m.attachments ? JSON.stringify(m.attachments) : null,
      isSystem: m.isSystem ?? false, createdAt: toDate(m.createdAt),
    })));

    // messages must exist before message_reads (FK) — written above.
    const messageReads = messages.flatMap((m) => (Array.isArray(m.readBy) ? m.readBy : []).map((userId) => ({
      messageId: idStr(m._id), userId: idStr(userId), readAt: toDate(m.createdAt),
    })));
    counts.message_reads = await upsertBatched('message_reads', messageReads, ['messageId', 'userId']);

    // ── award_types, employee_awards, company_values ──────────────────────────
    const awardTypes = await dbo.collection('award_types').find({}).toArray();
    counts.award_types = await upsertBatched('award_types', awardTypes.map((t) => ({
      id: idStr(t._id), name: t.name ?? null, description: t.description ?? null, category: t.category ?? null,
      repeatInterval: t.repeatInterval ?? null, nextDueDate: toDate(t.nextDueDate),
      createdAt: toDate(t.createdAt), updatedAt: toDate(t.updatedAt),
    })));

    // award_types must exist before employee_awards (FK) — written above.
    const employeeAwards = await dbo.collection('employee_awards').find({}).toArray();
    counts.employee_awards = await upsertBatched('employee_awards', employeeAwards.map((a) => ({
      id: idStr(a._id), employeeId: idStr(a.employeeId), employeeName: a.employeeName ?? null, staffNumber: a.staffNumber ?? null,
      department: a.department ?? null, awardTypeId: idStr(a.awardTypeId), awardTypeName: a.awardTypeName ?? null,
      notes: a.notes ?? null, year: a.year ?? null, awardedBy: a.awardedBy ?? null, awardedAt: toDate(a.awardedAt),
    })));

    const companyValues = await dbo.collection('company_values').find({}).toArray();
    counts.company_values = await upsertBatched('company_values', companyValues.map((v) => ({
      id: idStr(v._id), companyId: idStr(v.companyId), name: v.name ?? null, description: v.description ?? null,
      emoji: v.emoji ?? null, color: v.color ?? null, order: v.order ?? null, isActive: v.isActive ?? true,
      createdAt: toDate(v.createdAt), updatedAt: toDate(v.updatedAt),
    })));

    // ── kudos (+ reactions, comments) ──────────────────────────────────────────
    // company_values must exist before kudos (FK valueId) — written above.
    const kudos = await dbo.collection('kudos').find({}).toArray();
    counts.kudos = await upsertBatched('kudos', kudos.map((k) => ({
      id: idStr(k._id), companyId: idStr(k.companyId), giverId: idStr(k.giverId), giverName: k.giverName ?? null,
      recipientIds: k.recipientIds ? JSON.stringify(k.recipientIds.map(idStr)) : null, valueId: idStr(k.valueId),
      valueName: k.valueName ?? null, valueColor: k.valueColor ?? null, message: k.message ?? null, gifUrl: k.gifUrl ?? null,
      visibility: k.visibility ?? null, pointsAwarded: k.pointsAwarded ?? 0, createdAt: toDate(k.createdAt),
    })));

    // kudos must exist before its child tables (FK) — written above.
    const kudosReactions = kudos.flatMap((k) => (Array.isArray(k.reactions) ? k.reactions : []).map((r) => ({
      kudosId: idStr(k._id), personId: idStr(r.employeeId), type: r.type ?? null, reactedAt: toDate(r.reactedAt),
    })));
    counts.kudos_reactions = await upsertBatched('kudos_reactions', kudosReactions, ['kudosId', 'personId', 'type']);

    const kudosComments = kudos.flatMap((k) => (Array.isArray(k.comments) ? k.comments : []).map((c) => ({
      id: idStr(c._id), kudosId: idStr(k._id), authorId: idStr(c.authorId), authorName: c.authorName ?? null,
      content: c.content ?? null, createdAt: toDate(c.createdAt),
    })));
    counts.kudos_comments = await upsertBatched('kudos_comments', kudosComments);

    // ── award_programs (+ nominations), recognition_settings ─────────────────
    const awardPrograms = await dbo.collection('award_programs').find({}).toArray();
    counts.award_programs = await upsertBatched('award_programs', awardPrograms.map((p) => ({
      id: idStr(p._id), companyId: idStr(p.companyId), name: p.name ?? null, description: p.description ?? null,
      icon: p.icon ?? null, frequency: p.frequency ?? null, status: p.status ?? null, nominationBy: p.nominationBy ?? null,
      selectionMethod: p.selectionMethod ?? null, prizeType: p.prizeType ?? null, prizeDescription: p.prizeDescription ?? null,
      announcementMethod: p.announcementMethod ?? null, currentCycleStart: toDate(p.currentCycleStart),
      currentCycleEnd: toDate(p.currentCycleEnd), createdBy: idStr(p.createdBy), createdAt: toDate(p.createdAt), updatedAt: toDate(p.updatedAt),
    })));

    // award_programs/company_values must exist before award_nominations (FK) — written above.
    const awardNominations = await dbo.collection('award_nominations').find({}).toArray();
    counts.award_nominations = await upsertBatched('award_nominations', awardNominations.map((n) => ({
      id: idStr(n._id), companyId: idStr(n.companyId), programId: idStr(n.programId), nomineeId: idStr(n.nomineeId),
      nominatorId: idStr(n.nominatorId), reason: n.reason ?? null, valueId: idStr(n.valueId), cycleStart: toDate(n.cycleStart),
      isWinner: n.isWinner ?? false, createdAt: toDate(n.createdAt), announcedAt: toDate(n.announcedAt),
    })));

    const recognitionSettings = await dbo.collection('recognition_settings').find({}).toArray();
    counts.recognition_settings = await upsertBatched('recognition_settings', recognitionSettings.map((s) => ({
      id: idStr(s._id), companyId: idStr(s.companyId), pointsEnabled: s.pointsEnabled ?? false, pointsPerKudos: s.pointsPerKudos ?? null,
      monthlyBudget: s.monthlyBudget ?? null, allowSelfRecognition: s.allowSelfRecognition ?? false,
      minMessageLength: s.minMessageLength ?? null, maxKudosPerDay: s.maxKudosPerDay ?? null,
      notifyOnKudos: s.notifyOnKudos ?? true, postToFeed: s.postToFeed ?? true, updatedAt: toDate(s.updatedAt),
    })));

    // ── devices (+ assignment history), software_apps (+ assignments), it_requests ──
    const devices = await dbo.collection('devices').find({}).toArray();
    counts.devices = await upsertBatched('devices', devices.map((d) => ({
      id: idStr(d._id), name: d.name ?? null, type: d.type ?? null, brand: d.brand ?? null, model: d.model ?? null,
      serialNumber: d.serialNumber ?? null, assetTag: d.assetTag ?? null, purchaseDate: toDate(d.purchaseDate),
      purchasePrice: d.purchasePrice ?? null, currency: d.currency ?? null, vendor: d.vendor ?? null,
      warrantyExpiry: toDate(d.warrantyExpiry), condition: d.condition ?? null, status: d.status ?? null,
      assignedTo: idStr(d.assignedTo), assignedAt: toDate(d.assignedAt), notes: d.notes ?? null,
      createdAt: toDate(d.createdAt), updatedAt: toDate(d.updatedAt),
    })));

    // devices must exist before device_assignment_history (FK) — written above.
    const deviceAssignmentHistory = devices.flatMap((d) => (Array.isArray(d.assignmentHistory) ? d.assignmentHistory : []).map((h) => ({
      deviceId: idStr(d._id), employeeId: idStr(h.employeeId), assignedAt: toDate(h.assignedAt),
      returnedAt: toDate(h.returnedAt), condition: h.condition ?? null,
    })));
    counts.device_assignment_history = await upsertBatched('device_assignment_history', deviceAssignmentHistory, null);

    const softwareApps = await dbo.collection('software_apps').find({}).toArray();
    counts.software_apps = await upsertBatched('software_apps', softwareApps.map((s) => ({
      id: idStr(s._id), name: s.name ?? null, category: s.category ?? null, vendor: s.vendor ?? null,
      licenseType: s.licenseType ?? null, totalLicenses: s.totalLicenses ?? null, assignedLicenses: s.assignedLicenses ?? 0,
      costPerLicense: s.costPerLicense ?? null, currency: s.currency ?? null, billingCycle: s.billingCycle ?? null,
      renewalDate: toDate(s.renewalDate), adminId: idStr(s.adminId), loginUrl: s.loginUrl ?? null, status: s.status ?? null,
      notes: s.notes ?? null, createdAt: toDate(s.createdAt), updatedAt: toDate(s.updatedAt),
    })));

    // software_apps must exist before software_assignments (FK) — written above.
    const softwareAssignments = softwareApps.flatMap((s) => (Array.isArray(s.assignedEmployeeIds) ? s.assignedEmployeeIds : []).map((empId) => ({
      softwareId: idStr(s._id), employeeId: idStr(empId), assignedAt: toDate(s.updatedAt || s.createdAt),
    })));
    counts.software_assignments = await upsertBatched('software_assignments', softwareAssignments, ['softwareId', 'employeeId']);

    const itRequests = await dbo.collection('it_requests').find({}).toArray();
    counts.it_requests = await upsertBatched('it_requests', itRequests.map((r) => ({
      id: idStr(r._id), requesterId: idStr(r.requesterId), employeeId: idStr(r.employeeId), type: r.type ?? null,
      subject: r.subject ?? null, description: r.description ?? null, priority: r.priority ?? null, status: r.status ?? null,
      assignedTo: idStr(r.assignedTo), resolution: r.resolution ?? null, resolvedAt: toDate(r.resolvedAt),
      deviceId: idStr(r.deviceId), deviceName: r.deviceName ?? null, repairNotes: r.repairNotes ?? null,
      createdAt: toDate(r.createdAt), updatedAt: toDate(r.updatedAt),
    })));

    // device_asset_tag counter — devices.assetTag used a countDocuments-based
    // pseudo-sequence with no real Mongo `counters` doc backing it (see migration
    // file header). Seed it from the real current device count so the next
    // generated tag continues where the old logic would have left off, same
    // "don't start fresh at 0" lesson as every earlier phase's counter migration.
    counts.counters = (counts.counters || 0) + await upsertBatched('counters', [
      { id: 'device_asset_tag', seq: devices.length },
    ]);

    log(DRY_RUN ? 'Dry run complete — row counts that WOULD be written:' : 'Migration complete — rows written:');
    console.table(counts);
  } finally {
    await mongoClient.close();
    await knex.destroy();
  }
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
