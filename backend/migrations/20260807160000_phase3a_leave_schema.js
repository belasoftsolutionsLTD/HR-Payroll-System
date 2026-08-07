// Phase 3a of the Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md):
// Leave — the first half of "Leave + Attendance, the shared time domain". Attendance
// (attendance_records, shifts, timesheets) is its own migration, built right after this
// one, since it's a comparably large module in its own right.
//
// Same conventions as Phases 1-2: ids stay as unchanged Mongo ObjectId-hex TEXT primary
// keys, camelCase columns, nullability generous until checked against real data.
//
// leave_requests.approvalChain stays JSONB, not a child table — unlike payroll_results'
// line items (unbounded per cycle, queried in bulk across thousands of rows), this is a
// small (1-3 entries), fixed-shape, always-read-whole-then-filtered-in-JS array scoped to
// one request; nothing ever queries it at the SQL level. Matches the same reasoning
// already used for payroll_concepts.brackets in Phase 2.

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  await knex.schema.createTable('leave_types', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('code');
    t.text('description');
    t.boolean('isPaid').defaultTo(true);
    t.boolean('isCarryOverAllowed').defaultTo(false);
    t.integer('maxCarryOverDays');
    t.integer('carryOverExpiryMonths');
    t.boolean('requiresApproval').defaultTo(true);
    t.boolean('requiresAttachment').defaultTo(false);
    t.integer('minNoticeDays');
    t.integer('maxConsecutiveDays');
    t.integer('eligibilityMonths');
    t.boolean('countPublicHolidays').defaultTo(false);
    t.text('color').defaultTo('#3b82f6');
    t.boolean('isActive').defaultTo(true);
    t.jsonb('appliesTo');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('code');
    t.index('isActive');
  });

  await knex.schema.createTable('public_holidays', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('date').notNullable(); // 'YYYY-MM-DD' string, matching the original exactly
    t.boolean('isRecurringAnnually').defaultTo(false);
    t.jsonb('appliesTo'); // array of department names, or empty = applies to all
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });

    t.index('date');
  });

  await knex.schema.createTable('leave_accrual_policies', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('leaveTypeId').notNullable().references('id').inTable('leave_types');
    t.text('accrualFrequency').notNullable();
    t.decimal('accrualAmount', 10, 2).notNullable();
    t.decimal('maxAnnualEntitlement', 10, 2).notNullable();
    t.jsonb('appliesTo'); // {roles?, departments?, employmentTypes?}
    t.boolean('isActive').defaultTo(true);
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });

    t.index('leaveTypeId');
    t.index('isActive');
  });

  await knex.schema.createTable('leave_balances', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees').onDelete('CASCADE');
    t.text('leaveTypeId').notNullable().references('id').inTable('leave_types');
    t.integer('year').notNullable();
    t.decimal('openingBalance', 10, 2).notNullable().defaultTo(0);
    t.decimal('accrued', 10, 2).notNullable().defaultTo(0);
    t.decimal('used', 10, 2).notNullable().defaultTo(0);
    t.decimal('pending', 10, 2).notNullable().defaultTo(0);
    t.decimal('carriedOver', 10, 2).notNullable().defaultTo(0);
    t.timestamp('carryOverExpiry', { useTz: true });
    t.decimal('closingBalance', 10, 2).notNullable().defaultTo(0);
    t.timestamp('lastAccrualDate', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.unique(['employeeId', 'leaveTypeId', 'year']);
    t.index(['employeeId', 'year']);
  });

  await knex.schema.createTable('leave_requests', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees');
    t.text('leaveTypeId').notNullable().references('id').inTable('leave_types');
    t.timestamp('startDate', { useTz: true }).notNullable();
    t.timestamp('endDate', { useTz: true }).notNullable();
    t.decimal('totalDays', 6, 2).notNullable();
    t.text('halfDay');
    t.text('reason');
    t.text('attachmentUrl');
    t.text('status').notNullable().defaultTo('pending');
    t.jsonb('approvalChain'); // [{level, approverId, approverName, approverRole, status, actedAt, comment}]
    t.integer('currentApprovalLevel').defaultTo(0);
    t.text('rejectionReason');
    t.timestamp('cancelledAt', { useTz: true });
    t.text('cancelledBy');
    t.timestamp('revokedAt', { useTz: true });
    t.text('revokedBy');
    t.text('disputeReason');
    t.text('disputeSource');
    t.timestamp('disputeResolvedAt', { useTz: true });
    t.text('disputeResolvedBy');
    t.decimal('proposedDays', 6, 2);
    t.text('counterOfferReason');
    t.text('payrollRunId'); // no FK — payroll_cycles' own id, cross-checked in app code only, matching the original (a plain ObjectId reference, no $lookup)
    // Sent-flags for cronTasks.js's leaveStartReminder/leaveEndReminder — found only
    // while patching that file's cross-cutting touches, not in leaveFunctions.js itself.
    t.boolean('leaveStartReminderSent').defaultTo(false);
    t.boolean('leaveEndReminderSent').defaultTo(false);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('employeeId');
    t.index('status');
    t.index(['startDate', 'endDate']);
  });

  // No FK on leaveRequestId/employeeId — real data confirmed orphans (a request and an
  // employee that no longer exist), and an audit log is meant to survive its subjects
  // being deleted, same reasoning as compensation_audit_logs in Phase 1/2.
  await knex.schema.createTable('leave_audit_log', (t) => {
    t.text('id').primary();
    t.text('leaveRequestId');
    t.text('employeeId');
    t.text('action').notNullable();
    t.text('performedBy');
    t.text('performedByName');
    t.jsonb('previousValue');
    t.jsonb('newValue');
    t.text('comment');
    t.timestamp('timestamp', { useTz: true });

    t.index('leaveRequestId');
    t.index('employeeId');
  });

  await knex.schema.createTable('leave_blackouts', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.timestamp('startDate', { useTz: true }).notNullable();
    t.timestamp('endDate', { useTz: true }).notNullable();
    t.specificType('departments', 'text[]');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
  });
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('leave_blackouts');
  await knex.schema.dropTableIfExists('leave_audit_log');
  await knex.schema.dropTableIfExists('leave_requests');
  await knex.schema.dropTableIfExists('leave_balances');
  await knex.schema.dropTableIfExists('leave_accrual_policies');
  await knex.schema.dropTableIfExists('public_holidays');
  await knex.schema.dropTableIfExists('leave_types');
};
