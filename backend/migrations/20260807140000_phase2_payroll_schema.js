// Phase 2 of the Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md):
// payroll — concepts, compensations, cycles, results (+ its five embedded line-item
// arrays: earnings/deductions/benefits/employerContributions/leave, plus a sixth child
// table for exceptions so closeCycleInternal's `exceptions.severity` check stays a plain
// WHERE instead of a JSONB path query), payslips, welfare schemes.
//
// Same conventions as Phase 1: ids stay as unchanged Mongo ObjectId-hex TEXT primary
// keys, camelCase columns, only constraints matching what Mongo actually enforced today
// (see payroll_concepts.code below — no UNIQUE, matching a real gap noted in the
// existing code). Nullability is intentionally generous here and tightened only after
// checking real data via the ETL script, same lesson learned in Phase 1 (nationalId/
// employmentType/dateOfHire turned out to have real legacy gaps).
//
// tax_config/overtime_config/company_settings are deliberately NOT part of this phase —
// they're read (not written) during a cycle lock, stay on Mongo for now, and belong to
// Phase 10 (Config/Settings) per the plan.

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  await knex.schema.createTable('payroll_concepts', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    // No UNIQUE — payroll_concepts.code has no DB-level unique index today either (only
    // an app-level findOne check that welfareFunctions.js's direct insert already
    // bypasses) — see welfareFunctions.js's own comment. Index only, matching reality.
    t.text('code');
    t.text('category').notNullable();
    t.text('subCategory').notNullable();
    t.text('type').notNullable();
    t.decimal('defaultAmount', 14, 2);
    t.text('currency').defaultTo('KES');
    t.text('percentageOf');
    t.decimal('percentageValue', 14, 4);
    t.text('formula');
    t.jsonb('brackets'); // [{limit, rate}] — small, always-replaced-together value list
    t.text('loanType');
    t.decimal('cap', 14, 2);
    t.decimal('flatCredit', 14, 2);
    t.specificType('deductConceptCodesFromBase', 'text[]').defaultTo('{}');
    t.text('statutoryKey');
    t.boolean('isActive').defaultTo(true);
    // Defaults true, not false — matches resolveConceptPayItems.js's actual read
    // semantics (`concept.isTaxable !== false`), where an absent field (real production
    // data: the BASIC concept has none) means taxable. A `false` default here would
    // silently make Basic Pay non-taxable — found live via Phase 2 verification, when
    // a locked test cycle came back with a suspicious $0 gross pay.
    t.boolean('isTaxable').defaultTo(true);
    t.boolean('isRecurring').defaultTo(false);
    t.boolean('appearsOnPayslip').defaultTo(true);
    t.boolean('alertIfUndefined').defaultTo(false);
    // No FK — a real check against production data found 3/4 existing concepts already
    // attributed to since-deleted users (an audit-attribution field, not a real relation
    // needing referential integrity — same reasoning as compensation_audit_logs in Phase 1).
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('code');
    t.index('category');
    t.index('isActive');
  });

  // period.{month,year,startDate,endDate} flattened to columns — it's a value object
  // always read/written together on the parent, never a separately-addressable entity.
  await knex.schema.createTable('payroll_cycles', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.integer('periodMonth').notNullable();
    t.integer('periodYear').notNullable();
    t.timestamp('periodStartDate', { useTz: true }).notNullable();
    t.timestamp('periodEndDate', { useTz: true }).notNullable();
    t.timestamp('payDate', { useTz: true });
    t.text('status').notNullable().defaultTo('open');
    t.text('payGroup').defaultTo('all');
    t.text('payFrequency');
    t.text('runType').defaultTo('regular');
    t.text('offCycleReason');
    // Plain array, unenforced — matches the Mongo original (a hand-picked target list,
    // never itself a join queried structurally).
    t.specificType('targetEmployeeIds', 'text[]');
    t.text('departmentId').references('id').inTable('departments');
    t.text('jobGroupId').references('id').inTable('job_groups');
    t.text('employmentType');
    t.text('currency').defaultTo('KES');
    t.decimal('totalGross', 14, 2).defaultTo(0);
    t.decimal('totalDeductions', 14, 2).defaultTo(0);
    t.decimal('totalNet', 14, 2).defaultTo(0);
    t.decimal('totalEmployerCost', 14, 2).defaultTo(0);
    t.integer('employeeCount').defaultTo(0);
    t.boolean('hasExceptions').defaultTo(false);
    t.integer('exceptionCount').defaultTo(0);
    // [{employeeId, fullName, staffNumber, missingFields[]}] — written once at lock,
    // display-only afterward, never queried structurally.
    t.jsonb('excludedEmployees');
    // Atomic-claim flags (lockCycleInternal/closeCycleInternal's race guard).
    t.boolean('isLocking').defaultTo(false);
    t.boolean('isClosing').defaultTo(false);
    t.timestamp('lockedAt', { useTz: true });
    t.text('lockedBy').references('id').inTable('users');
    t.timestamp('closedAt', { useTz: true });
    t.text('closedBy').references('id').inTable('users');
    t.text('createdBy').references('id').inTable('users');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
    t.index(['periodYear', 'periodMonth']);
    t.index('payFrequency');
  });

  await knex.schema.createTable('employee_compensations', (t) => {
    t.text('id').primary();
    // Nullable — group-scope assignments (scope:'group') have no single employeeId.
    t.text('employeeId').references('id').inTable('employees');
    t.text('conceptId').notNullable().references('id').inTable('payroll_concepts');
    t.text('conceptName');
    t.text('conceptCode');
    t.text('category');
    t.text('subCategory');
    t.decimal('amount', 14, 2).notNullable().defaultTo(0);
    t.text('currency').defaultTo('KES');
    t.timestamp('effectiveFrom', { useTz: true });
    t.timestamp('effectiveTo', { useTz: true });
    t.text('cycleId').references('id').inTable('payroll_cycles');
    t.text('scope').defaultTo('individual'); // 'individual' | 'group'
    // {type:'all'|'department'|'jobGroup'|'employmentType', departments?/jobGroupIds?/
    // employmentTypes?, excludeEmploymentTypes?} — variable shape by design (see
    // conceptTargeting.js), not a fixed set of columns.
    t.jsonb('appliesTo');
    t.boolean('isActive').defaultTo(true);
    // No FK — same real orphaned-attribution finding as payroll_concepts.createdBy above
    // (3/4 existing rows already point at a since-deleted user).
    t.text('addedBy');
    t.text('notes');
    // Loan-specific — null for every non-loan compensation row.
    t.decimal('principal', 14, 2);
    t.decimal('openingBalance', 14, 2);
    t.decimal('balanceRemaining', 14, 2);
    t.decimal('totalRepaid', 14, 2);
    t.text('loanStatus');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('employeeId');
    t.index('conceptId');
    t.index(['isActive', 'scope']);
  });

  await knex.schema.createTable('payroll_results', (t) => {
    t.text('id').primary();
    t.text('cycleId').notNullable().references('id').inTable('payroll_cycles').onDelete('CASCADE');
    t.text('employeeId').notNullable().references('id').inTable('employees');
    t.decimal('grossPay', 14, 2);
    t.decimal('totalDeductions', 14, 2);
    t.decimal('netPay', 14, 2);
    t.decimal('totalEmployerCost', 14, 2);
    t.boolean('isProRata');
    t.text('proRataReason');
    t.integer('proRataDays');
    t.integer('workingDaysInCycle');
    t.decimal('overtimeHours', 10, 2);
    t.decimal('overtimeAmount', 14, 2);
    t.decimal('expenseReimbursements', 14, 2);
    t.decimal('leaveDeductionTotal', 14, 2);
    // statutoryDeductions flattened — a small fixed-shape object, always read/written
    // whole, never queried by sub-field.
    t.decimal('statutoryPaye', 14, 2);
    t.decimal('statutoryNssf', 14, 2);
    t.decimal('statutorySha', 14, 2);
    t.decimal('statutoryAhl', 14, 2);
    t.decimal('statutoryTotal', 14, 2);
    t.jsonb('statutoryLabels');
    t.boolean('hasException').defaultTo(false);
    t.text('engine').defaultTo('concepts');
    t.text('status').defaultTo('pending');
    t.text('approvedBy').references('id').inTable('users');
    t.timestamp('approvedAt', { useTz: true });
    t.text('payslipUrl');
    t.timestamp('payslipSentAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index(['cycleId', 'status']);
    t.index('employeeId');
    t.index('hasException');
  });

  // ── payroll_results' five embedded line-item arrays, now real child tables ───────
  const lineItemChildTable = (name, extra) => knex.schema.createTable(name, (t) => {
    t.increments('id'); // plain array elements in Mongo — a real id here is new, ETL-assigned
    t.text('resultId').notNullable().references('id').inTable('payroll_results').onDelete('CASCADE');
    t.integer('position').notNullable().defaultTo(0); // preserves the embedded array's order
    extra(t);
  });

  await lineItemChildTable('payroll_result_earnings', (t) => {
    t.text('conceptId');
    t.text('conceptName');
    t.text('conceptCode');
    t.text('subCategory');
    t.decimal('amount', 14, 2).notNullable();
    t.text('source');
    t.boolean('isTaxable');
  });

  await lineItemChildTable('payroll_result_deductions', (t) => {
    t.text('conceptId');
    t.text('conceptName');
    t.text('conceptCode');
    t.text('subCategory');
    t.decimal('amount', 14, 2).notNullable();
    t.text('source');
    // Loan-installment lines only — null for every fixed/percentage deduction line.
    t.text('loanAssignmentId');
    t.decimal('balanceAfter', 14, 2);
  });

  await lineItemChildTable('payroll_result_benefits', (t) => {
    t.text('conceptId');
    t.text('conceptName');
    t.decimal('amount', 14, 2).notNullable();
  });

  await lineItemChildTable('payroll_result_employer_contributions', (t) => {
    t.text('conceptId');
    t.text('conceptName');
    t.decimal('amount', 14, 2).notNullable();
  });

  await lineItemChildTable('payroll_result_leave', (t) => {
    t.text('leaveType');
    // Stored as plain 'YYYY-MM-DD' text, matching the original (clamped to the cycle
    // period as date strings, not real Date objects — see payrollCyclesFunctions.js).
    t.text('startDate');
    t.text('endDate');
    t.integer('days');
    t.decimal('amount', 14, 2);
  });

  // Not one of the plan's "five line-item arrays" (it's a system/warning list, not a
  // payslip line), but still needs the same real-table treatment — closeCycleInternal
  // filters on exceptions.severity structurally, not just for display.
  await lineItemChildTable('payroll_result_exceptions', (t) => {
    t.text('type');
    t.text('message');
    t.text('severity');
  });

  // pdfPath, not pdfData — drops the inline-base64 PDF blob pattern in favor of a file
  // reference, per the plan, matching how employee_documents/certifications already do
  // it. The PDF is written to disk once and referenced from both places.
  await knex.schema.createTable('payslips', (t) => {
    t.text('id').primary();
    t.text('employeeId').references('id').inTable('employees');
    t.text('cycleId').references('id').inTable('payroll_cycles');
    t.text('resultId').references('id').inTable('payroll_results');
    t.integer('periodMonth');
    t.integer('periodYear');
    t.decimal('grossPay', 14, 2);
    t.decimal('netPay', 14, 2);
    t.text('status').defaultTo('paid');
    t.text('pdfPath');
    t.timestamp('generatedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });

    t.index('employeeId');
    t.index(['periodYear', 'periodMonth']);
  });

  await knex.schema.createTable('welfare_schemes', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.text('conceptId').references('id').inTable('payroll_concepts');
    t.decimal('contributionAmount', 14, 2);
    t.text('contributionType');
    t.text('percentageOf');
    t.boolean('isActive').defaultTo(true);
    t.text('createdBy').references('id').inTable('users');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('welfare_schemes');
  await knex.schema.dropTableIfExists('payslips');
  await knex.schema.dropTableIfExists('payroll_result_exceptions');
  await knex.schema.dropTableIfExists('payroll_result_leave');
  await knex.schema.dropTableIfExists('payroll_result_employer_contributions');
  await knex.schema.dropTableIfExists('payroll_result_benefits');
  await knex.schema.dropTableIfExists('payroll_result_deductions');
  await knex.schema.dropTableIfExists('payroll_result_earnings');
  await knex.schema.dropTableIfExists('payroll_results');
  await knex.schema.dropTableIfExists('employee_compensations');
  await knex.schema.dropTableIfExists('payroll_cycles');
  await knex.schema.dropTableIfExists('payroll_concepts');
};
