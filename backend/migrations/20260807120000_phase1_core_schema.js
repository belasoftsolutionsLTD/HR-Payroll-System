// Phase 1 of the Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md):
// the FK root every later phase hangs off — users, employees (+ its embedded-array
// child tables), the org lookups (departments/branches/job_groups/designations),
// job_history, company_accounts, compensation_audit_logs, staff_notes, counters.
//
// Design decisions carried over unchanged from the plan:
//  - Every id is the exact same string as the current Mongo ObjectId hex — TEXT
//    PRIMARY KEY, never remapped, so the ETL step never has to rewrite a foreign key.
//  - Column names stay camelCase, matching today's Mongo field names exactly.
//  - Only constraints that already exist as real guarantees in the Mongo app get a
//    matching Postgres constraint (e.g. employees.email has a unique+sparse index
//    today, so it gets a real UNIQUE here). Fields the app only checks in JS
//    (e.g. employees.nationalId, checked via a pre-insert findOne, not a DB index)
//    get a plain lookup index instead of a UNIQUE constraint, so this migration
//    doesn't silently introduce a stricter guarantee than the system already has.

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  // ── Lookups with no dependencies ──────────────────────────────────────────
  await knex.schema.createTable('departments', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('branches', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('address');
    t.text('phone');
    t.text('email');
    t.text('contactPerson');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('job_groups', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.decimal('salaryMin', 14, 2);
    t.decimal('salaryMax', 14, 2);
    t.text('description');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('designations', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  // Replaces the embedded designations.departmentIds[] array.
  await knex.schema.createTable('designation_departments', (t) => {
    t.text('designationId').notNullable().references('id').inTable('designations').onDelete('CASCADE');
    t.text('departmentId').notNullable().references('id').inTable('departments').onDelete('CASCADE');
    t.primary(['designationId', 'departmentId']);
  });

  // ── employees (self-referencing via managerId, so create before job_history/users) ──
  await knex.schema.createTable('employees', (t) => {
    t.text('id').primary();
    t.text('fullName').notNullable();
    t.text('firstName');
    t.text('lastName');
    // Checked for uniqueness in JS (a pre-insert findOne), not a DB index today —
    // see file header. Index for lookup speed, not a UNIQUE constraint. Also NOT
    // marked notNullable — the create form requires it, but at least one real
    // legacy/edited record has none (found live via the Phase 1 ETL dry-run
    // against real data), so a hard NOT NULL here would be a stricter guarantee
    // than the system has ever actually enforced.
    t.text('nationalId');
    t.text('staffNumber').unique();
    t.text('designation').notNullable();
    // Not notNullable — 2 real records predate this being a required form field
    // (found live via the Phase 1 ETL dry-run against real data); same reasoning
    // as nationalId above.
    t.text('employmentType');
    // Plain text today (matches the value typed/selected on the employee form) — not
    // an FK to departments.id. departments/designations are free-text lookups the
    // frontend offers as suggestions, not enforced relations. Preserved as-is.
    t.text('department').notNullable();
    t.text('jobGroupId').references('id').inTable('job_groups');
    // Not notNullable — same 2 legacy records also predate dateOfHire being required.
    t.timestamp('dateOfHire', { useTz: true });
    t.timestamp('dateOfBirth', { useTz: true });
    t.timestamp('contractEndDate', { useTz: true });
    t.timestamp('probationEndDate', { useTz: true });
    t.timestamp('confirmationDate', { useTz: true });
    t.timestamp('terminationDate', { useTz: true });
    t.text('terminationReason');
    t.text('preferredName');
    t.text('gender');
    t.text('maritalStatus');
    t.text('nationality');
    t.text('passportNumber');
    t.timestamp('passportExpiryDate', { useTz: true });
    t.text('address');
    // Object today ({name, relationship, phone, nationalId, email, ...}) — kept as
    // JSONB rather than its own child table since nothing queries into its fields.
    t.jsonb('nextOfKin');
    t.decimal('grossPay', 14, 2);
    t.text('kraPin');
    t.text('paymentMethod').defaultTo('bank_transfer');
    t.text('bankName');
    t.text('bankAccountNumber');
    t.text('mpesaNumber');
    t.text('paypalEmail');
    t.text('cryptoWalletAddress');
    t.text('cryptoNetwork');
    t.text('email').notNullable().unique();
    t.text('phone');
    t.text('profilePhoto');
    t.text('location');
    t.text('branchId').references('id').inTable('branches');
    t.text('costCenter');
    t.text('managerId').references('id').inTable('employees');
    t.text('payGroup').defaultTo('all');
    t.text('payFrequency').defaultTo('monthly');
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('nationalId');
    t.index('department');
    t.index('status');
    t.index('managerId');
  });

  // ── employees' embedded-array child tables ────────────────────────────────
  await knex.schema.createTable('employee_documents', (t) => {
    t.text('id').primary(); // was documents[].docId
    t.text('employeeId').notNullable().references('id').inTable('employees').onDelete('CASCADE');
    t.text('docType').notNullable();
    t.text('fileName').notNullable();
    t.text('filePath').notNullable();
    t.timestamp('uploadedAt', { useTz: true });
    t.index('employeeId');
  });

  await knex.schema.createTable('employee_emergency_contacts', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees').onDelete('CASCADE');
    t.text('name');
    t.text('relationship');
    t.text('phone');
    t.text('email');
    t.index('employeeId');
  });

  await knex.schema.createTable('employee_skills', (t) => {
    t.increments('id'); // plain strings in Mongo — a real id here is new, ETL-assigned
    t.text('employeeId').notNullable().references('id').inTable('employees').onDelete('CASCADE');
    t.text('skill').notNullable();
    // Preserves the embedded array's order, which Postgres row storage doesn't
    // otherwise guarantee.
    t.integer('position').notNullable().defaultTo(0);
    t.index('employeeId');
  });

  await knex.schema.createTable('employee_certifications', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees').onDelete('CASCADE');
    t.text('name').notNullable();
    t.text('issuingOrganization').notNullable();
    t.timestamp('issueDate', { useTz: true }).notNullable();
    t.timestamp('expiryDate', { useTz: true });
    t.text('fileUrl');
    t.index('employeeId');
  });

  await knex.schema.createTable('employee_education_history', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees').onDelete('CASCADE');
    t.text('institution').notNullable();
    t.text('degree').notNullable();
    t.text('fieldOfStudy').notNullable();
    t.integer('startYear').notNullable();
    t.integer('endYear');
    t.index('employeeId');
  });

  // ── users (references employees; self-references via createdBy) ──────────
  await knex.schema.createTable('users', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('email').notNullable().unique();
    t.text('password').notNullable();
    t.text('role').notNullable();
    t.text('employeeId').references('id').inTable('employees');
    t.text('department');
    t.boolean('mustResetPassword').defaultTo(false);
    t.boolean('isActive').defaultTo(true);
    // JWT revocation-on-demand (see AuthMiddleware.js's getUserData) — bumped on
    // password change/reset to invalidate any still-time-valid access token.
    t.integer('tokenVersion').notNullable().defaultTo(0);
    t.text('refreshTokenHash');
    t.timestamp('refreshTokenExpiresAt', { useTz: true });
    t.text('passwordResetToken');
    t.timestamp('passwordResetExpires', { useTz: true });
    t.boolean('mfaEnabled').defaultTo(false);
    t.text('mfaSecret');
    t.text('createdBy').references('id').inTable('users');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('employeeId');
    t.index('refreshTokenHash');
    t.index('passwordResetToken');
  });

  // ── Tables that reference both employees and users ────────────────────────
  await knex.schema.createTable('job_history', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees').onDelete('CASCADE');
    t.text('changeType').notNullable();
    t.timestamp('effectiveDate', { useTz: true }).notNullable();
    t.jsonb('previousValues');
    t.jsonb('newValues');
    t.text('reason');
    t.text('changedBy').references('id').inTable('users');
    t.text('changedByName');
    t.timestamp('createdAt', { useTz: true });

    t.index(['employeeId', 'effectiveDate']);
  });

  await knex.schema.createTable('company_accounts', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('accountType').notNullable();
    t.text('bankName');
    t.text('accountNumber');
    t.text('swiftCode');
    t.text('ibanNumber');
    t.text('mpesaNumber');
    t.text('paypalEmail');
    t.text('wiseEmail');
    t.text('stripeAccountId');
    t.text('flutterwaveAccountId');
    t.text('currency');
    t.boolean('isActive');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  // No FK constraints on employeeId/performedBy/compensationId here, deliberately —
  // this is an append-only audit trail, and real data confirms it's meant to outlive
  // what it references: a live check found 1/5 employeeId and 7/8 performedBy values
  // already pointing at deleted records (found live via the Phase 1 ETL run against
  // real data). That's not corruption to fix, it's the same intentional
  // survives-the-source-being-deleted pattern the plan already documents for
  // employee_awards' denormalized snapshots — an audit log that lost its history
  // every time an employee or user was deleted would defeat its own purpose.
  // compensationId additionally has no referenced table yet (employee_compensations
  // is built in Phase 2/payroll).
  await knex.schema.createTable('compensation_audit_logs', (t) => {
    t.text('id').primary();
    t.text('employeeId');
    t.text('compensationId');
    t.text('conceptName');
    t.text('action').notNullable();
    t.jsonb('changes');
    t.text('performedBy');
    t.timestamp('performedAt', { useTz: true });

    t.index(['employeeId', 'performedAt']);
  });

  await knex.schema.createTable('staff_notes', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees').onDelete('CASCADE');
    t.text('category').notNullable();
    t.text('note').notNullable();
    t.text('createdBy').notNullable().references('id').inTable('users');
    t.timestamp('createdAt', { useTz: true });

    t.index('employeeId');
  });

  // ── counters (composite string key -> integer seq, atomic UPDATE...RETURNING) ──
  await knex.schema.createTable('counters', (t) => {
    t.text('id').primary(); // e.g. "staff_number_2026"
    t.integer('seq').notNullable().defaultTo(0);
  });
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  // Reverse creation order so FK dependents drop before what they reference.
  await knex.schema.dropTableIfExists('counters');
  await knex.schema.dropTableIfExists('staff_notes');
  await knex.schema.dropTableIfExists('compensation_audit_logs');
  await knex.schema.dropTableIfExists('company_accounts');
  await knex.schema.dropTableIfExists('job_history');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.dropTableIfExists('employee_education_history');
  await knex.schema.dropTableIfExists('employee_certifications');
  await knex.schema.dropTableIfExists('employee_skills');
  await knex.schema.dropTableIfExists('employee_emergency_contacts');
  await knex.schema.dropTableIfExists('employee_documents');
  await knex.schema.dropTableIfExists('employees');
  await knex.schema.dropTableIfExists('designation_departments');
  await knex.schema.dropTableIfExists('designations');
  await knex.schema.dropTableIfExists('job_groups');
  await knex.schema.dropTableIfExists('branches');
  await knex.schema.dropTableIfExists('departments');
};
