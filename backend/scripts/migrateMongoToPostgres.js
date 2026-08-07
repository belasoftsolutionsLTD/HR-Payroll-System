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
