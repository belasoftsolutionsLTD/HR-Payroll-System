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
