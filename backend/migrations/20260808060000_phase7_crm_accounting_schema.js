// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 7) —
// CRM (companies, contacts, pipelines, deals, activities, activity subtasks, feedback,
// custom field defs) and Accounting (chart of accounts, journal entries, accounting
// periods, posting failures, AR invoices/payments, AP bills, bank statement imports).
//
// Same conventions as every phase so far: ids stay as unchanged Mongo ObjectId-hex TEXT
// primary keys. Line-item / whole-replace arrays (crm_pipelines.stages, crm_deals.
// nextAction, gl_journal_entries.lines, ar_invoices.items, ap_bills.items,
// bank_statement_imports.lines) stay JSONB — confirmed via reading every handler that
// none of them ever do a Mongo $push/$pull/positional update; each one is read, modified
// in JS, and the whole array/object written back. The one exception:
// crm_activities.subtasks IS a real child table (crm_activity_subtasks) — toggleSubtask
// does a genuine positional `$set: {'subtasks.$.isCompleted': ...}` update, the same
// "real per-row mutation" signal that has meant "child table" every other phase.
// Subtask ids are safe as a real PK: generated fresh via `new ObjectId()` per subtask,
// per task, never copied from a shared template (unlike Phase 4's onboarding trap).
//
// crm_pipelines.stages' own per-stage `id` is also always `s.id || new ObjectId()` —
// fresh and stable across edits, never copied across pipelines — but stages are still
// kept as JSONB (not a child table) since they're always whole-replaced on save
// (normalizeStages() rebuilds and rewrites the entire array every time), matching the
// same "no $push/$pull found" rule as everything else. crm_deals.stageId and
// crm_reports' byStage grouping therefore have no FK into a stage row — matches how
// Mongo never enforced this either.
//
// Attribution-only fields (assignedTo, createdBy, performedBy, postedBy, loggedBy,
// approvedBy, closedBy, resolvedBy, importedBy, reconciledBy, recordedBy) get no FK,
// matching every earlier phase's convention — confirmed via a live orphan-check that
// gl_journal_entries.postedBy has 1 orphan out of 20 real rows (a stale reference), so
// even a "looks clean" attribution field isn't assumed FK-safe without checking; every
// other attribution field checked 0/N orphans but is still left FK-less on principle,
// same as Phases 1-6. Real ownership FKs (contactId, dealId, companyId, pipelineId,
// invoiceId, accountId, expenseAccountId, activityId) DO get FKs — all confirmed clean.
//
// ar_invoices.customerId/customerModel is deliberately polymorphic (could point at
// crm_contacts or a future customer type) — no FK, matches original Mongo (which never
// enforced this either); customerSnapshot is denormalized at invoice-creation time on
// purpose (a later CRM contact edit must never retroactively change a posted invoice),
// preserved as JSONB.
//
// gl_journal_entries.referenceId/referenceModel is the same polymorphic-reference
// pattern used throughout Phases 4-6 (inventory_stock_movements.referenceId, etc.) — no
// FK, since it can point at pos_sales, inventory_purchase_orders, payroll_cycles,
// ar_invoices, ap_bills, or a manual entry's null.
//
// counters gets 3 new keys this phase (gl_journal_entry_number_YYYY,
// ar_invoice_number_YYYY, ap_bill_number_YYYY) — migrated via the ETL with their real
// live `seq` values, not left to start fresh at 0 (the Phase 5 certificate-numbering
// lesson: a structurally-correct-but-fresh counter is a silent collision waiting to
// happen). No schema change needed for `counters` itself — already exists since Phase 1.

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  // ── CRM ──────────────────────────────────────────────────────────────────────

  await knex.schema.createTable('crm_companies', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('industry');
    t.jsonb('customFieldValues'); // {defId: value} — whole-replaced
    t.boolean('isActive').defaultTo(true);
    t.text('createdBy'); // no FK, attribution-style
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('name');
  });

  await knex.schema.createTable('crm_contacts', (t) => {
    t.text('id').primary();
    t.text('firstName').notNullable();
    t.text('lastName');
    t.text('email');
    t.text('phone');
    t.text('companyId').references('id').inTable('crm_companies');
    t.specificType('tags', 'text[]');
    t.text('source');
    t.text('sourceWebsite');
    t.text('sourceEventName');
    t.text('sourceEventVenue');
    t.timestamp('sourceEventDate', { useTz: true });
    t.text('assignedTo'); // no FK, attribution-style (a real "who owns this" field, but
    // still left unconstrained like every other assignedTo in this migration so far —
    // see file header)
    t.jsonb('customFieldValues');
    t.boolean('isActive').defaultTo(true);
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('companyId');
    t.index('assignedTo');
    t.index('email');
  });

  await knex.schema.createTable('crm_pipelines', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.jsonb('stages'); // [{id, name, order, isWon, isLost, color}] — whole-replaced, see file header
    t.boolean('isDefault').defaultTo(false);
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('crm_deals', (t) => {
    t.text('id').primary();
    t.text('title').notNullable();
    t.text('contactId').notNullable().references('id').inTable('crm_contacts');
    t.text('companyId').references('id').inTable('crm_companies');
    t.text('pipelineId').notNullable().references('id').inTable('crm_pipelines');
    t.text('stageId'); // no FK — points into pipeline.stages[], a JSONB array, see file header
    t.decimal('value', 14, 2);
    t.text('currency');
    t.timestamp('expectedCloseDate', { useTz: true });
    t.jsonb('nextAction'); // {description, dueDate} | null — whole-replaced single sub-object
    t.text('assignedTo');
    t.text('status'); // 'open' | 'won' | 'lost'
    t.timestamp('wonAt', { useTz: true });
    t.timestamp('lostAt', { useTz: true });
    t.text('lostReason');
    t.text('confirmedSaleId'); // no FK across module boundary — points at pos_sales.id (Phase 6), same posture as every other polymorphic/cross-module reference in this migration
    t.jsonb('customFieldValues');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('contactId');
    t.index('companyId');
    t.index('pipelineId');
    t.index('assignedTo');
    t.index('status');
  });

  await knex.schema.createTable('crm_activities', (t) => {
    t.text('id').primary();
    t.text('type').notNullable(); // 'call'|'email'|'meeting'|'note'|'task'|system-generated types
    t.text('contactId').notNullable().references('id').inTable('crm_contacts');
    t.text('dealId').references('id').inTable('crm_deals');
    t.text('subject');
    t.text('notes');
    t.timestamp('dueDate', { useTz: true });
    t.boolean('completed');
    t.timestamp('completedAt', { useTz: true });
    t.text('assignedTo');
    t.text('priority'); // task only: 'high'|'medium'|'low'
    t.text('performedBy');
    t.text('performedByName'); // denormalized at creation, same posture as every other *Name snapshot in this app
    t.timestamp('createdAt', { useTz: true });

    t.index('contactId');
    t.index('dealId');
    t.index('assignedTo');
    t.index('type');
  });

  // Real child table, not JSONB — see file header. Own id kept as PK since it's a fresh
  // ObjectId per subtask, never copied across parents.
  await knex.schema.createTable('crm_activity_subtasks', (t) => {
    t.text('id').primary();
    t.text('activityId').notNullable().references('id').inTable('crm_activities');
    t.text('title').notNullable();
    t.boolean('isCompleted').defaultTo(false);
    t.timestamp('completedAt', { useTz: true });

    t.index('activityId');
  });

  await knex.schema.createTable('crm_feedback', (t) => {
    t.text('id').primary();
    t.text('contactId').notNullable().references('id').inTable('crm_contacts');
    t.text('dealId').references('id').inTable('crm_deals');
    t.integer('rating').notNullable();
    t.text('comment');
    t.text('loggedBy');
    t.text('loggedByName');
    t.timestamp('createdAt', { useTz: true });

    t.index('contactId');
  });

  await knex.schema.createTable('crm_custom_field_defs', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('fieldType').notNullable();
    t.text('appliesTo').notNullable(); // 'contact'|'company'|'deal'
    t.specificType('options', 'text[]');
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  // ── Accounting ───────────────────────────────────────────────────────────────

  await knex.schema.createTable('gl_accounts', (t) => {
    t.text('id').primary();
    t.text('code').notNullable().unique();
    t.text('name').notNullable();
    t.text('type').notNullable(); // asset|liability|equity|revenue|expense
    t.text('subType');
    t.text('parentId').references('id').inTable('gl_accounts');
    t.text('normalBalance').notNullable(); // debit|credit
    t.boolean('isSystemAccount').defaultTo(false);
    t.text('systemKey').unique(); // resolveSystemAccount's lookup key — never user-assignable
    t.specificType('linkedExpenseCategories', 'text[]');
    t.boolean('isActive').defaultTo(true);
    t.decimal('balanceCache', 14, 2).defaultTo(0);
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('code');
    t.index('type');
  });

  await knex.schema.createTable('gl_journal_entries', (t) => {
    t.text('id').primary();
    t.text('entryNumber');
    t.timestamp('date', { useTz: true });
    t.text('description');
    t.text('source'); // 'manual' | 'pos_sale' | 'pos_refund' | 'inventory_po_receipt' | ... | 'reversal'
    t.text('sourceModule');
    t.text('referenceId'); // no FK — polymorphic, see file header
    t.text('referenceModel');
    t.jsonb('lines'); // [{accountId, accountCode, accountName, debit, credit, department, memo}] — whole-replaced, never per-line updates
    t.decimal('totalDebit', 14, 2);
    t.decimal('totalCredit', 14, 2);
    t.text('status'); // 'posted' | 'reversed'
    t.text('reversedByEntryId').references('id').inTable('gl_journal_entries');
    t.text('reversesEntryId').references('id').inTable('gl_journal_entries');
    t.text('department');
    t.text('postedBy'); // no FK — 1/20 real rows orphaned, see file header
    t.timestamp('postedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });
    // Not part of a freshly-posted entry's own shape (postJournalEntry never sets it) —
    // only reverseJournalEntry's own $set adds it, on both sides of a reversal. Missed on
    // the first pass of this table (derived from one sample doc, which had never been
    // reversed) — found live when reverseJournalEntryHandler's own verification call
    // failed. 1 real row already has it (the one real reversal in production data).
    t.timestamp('updatedAt', { useTz: true });

    t.index('date');
    t.index('status');
    t.index(['referenceId', 'referenceModel']);
    t.index('source');
  });

  await knex.schema.createTable('gl_accounting_periods', (t) => {
    t.text('id').primary();
    t.integer('year').notNullable();
    t.integer('month').notNullable();
    t.text('status').notNullable(); // 'open' | 'closed'
    t.timestamp('closedAt', { useTz: true });
    t.text('closedBy');
    t.timestamp('createdAt', { useTz: true });

    t.unique(['year', 'month']);
  });

  await knex.schema.createTable('gl_posting_failures', (t) => {
    t.text('id').primary();
    t.text('source');
    t.text('sourceModule');
    t.text('referenceId');
    t.text('referenceModel');
    t.jsonb('attemptedPayload');
    t.text('error');
    t.boolean('resolved').defaultTo(false);
    t.timestamp('resolvedAt', { useTz: true });
    t.text('resolvedBy');
    t.timestamp('createdAt', { useTz: true });

    t.index('resolved');
  });

  await knex.schema.createTable('ar_invoices', (t) => {
    t.text('id').primary();
    t.text('invoiceNumber');
    t.text('customerId'); // no FK — polymorphic (crm_contacts today, could be another customerModel), see file header
    t.text('customerModel');
    t.jsonb('customerSnapshot'); // {name, email, billingAddress} — denormalized at creation, see file header
    t.jsonb('items'); // [{description, quantity, unitPrice, taxRate, lineSubtotal, lineTax, lineTotal}] — whole-replaced
    t.decimal('subtotal', 14, 2);
    t.decimal('taxTotal', 14, 2);
    t.decimal('total', 14, 2);
    t.decimal('amountPaid', 14, 2).defaultTo(0);
    t.decimal('balanceDue', 14, 2);
    t.timestamp('dueDate', { useTz: true });
    t.text('status'); // 'draft' | 'sent' (deriveStatus() computes paid/partially_paid/overdue on read)
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
    t.timestamp('sentAt', { useTz: true });
    t.timestamp('paidAt', { useTz: true });

    t.index('status');
  });

  await knex.schema.createTable('ar_payments', (t) => {
    t.text('id').primary();
    t.text('invoiceId').notNullable().references('id').inTable('ar_invoices');
    t.decimal('amount', 14, 2);
    t.text('method');
    t.text('reference');
    t.timestamp('paidAt', { useTz: true });
    t.text('recordedBy');
    t.timestamp('createdAt', { useTz: true });

    t.index('invoiceId');
  });

  await knex.schema.createTable('ap_bills', (t) => {
    t.text('id').primary();
    t.text('billNumber');
    t.text('vendorName');
    t.text('expenseAccountId').references('id').inTable('gl_accounts');
    t.jsonb('items'); // [{description, quantity, unitPrice, lineTotal}] — whole-replaced
    t.decimal('totalAmount', 14, 2);
    t.timestamp('dueDate', { useTz: true });
    t.timestamp('scheduledPaymentDate', { useTz: true });
    t.text('status'); // draft|approved|scheduled|paid
    t.text('approvedBy');
    t.timestamp('approvedAt', { useTz: true });
    t.timestamp('paidAt', { useTz: true });
    t.text('paymentMethod');
    t.text('paymentReference');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
    t.index('expenseAccountId');
  });

  await knex.schema.createTable('bank_statement_imports', (t) => {
    t.text('id').primary();
    t.text('accountId').notNullable().references('id').inTable('gl_accounts');
    t.text('filename');
    t.text('importedBy');
    t.timestamp('importedAt', { useTz: true });
    t.timestamp('periodStart', { useTz: true });
    t.timestamp('periodEnd', { useTz: true });
    t.decimal('openingBalance', 14, 2);
    t.decimal('closingBalance', 14, 2);
    // [{date, description, amount, matched, matchedJournalEntryId, matchedLineIndex, flagged, flagReason}]
    // — accessed by array INDEX (req.params.lineIndex), never a per-row id — whole-replaced, JSONB.
    t.jsonb('lines');
    t.text('status'); // 'in_progress' | 'reconciled'
    t.timestamp('reconciledAt', { useTz: true });
    t.text('reconciledBy');
    t.timestamp('createdAt', { useTz: true });
    // Same miss as gl_journal_entries.updatedAt above: not part of importBankStatement's
    // own insert doc, only ever set by the later auto/manual-match and unmatch $set
    // calls — missed because this table had 0 real rows to sample from, only the create
    // path's own code. Found live when autoMatchStatementLines' own verification call
    // failed with "column updatedAt does not exist".
    t.timestamp('updatedAt', { useTz: true });

    t.index('accountId');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('bank_statement_imports');
  await knex.schema.dropTableIfExists('ap_bills');
  await knex.schema.dropTableIfExists('ar_payments');
  await knex.schema.dropTableIfExists('ar_invoices');
  await knex.schema.dropTableIfExists('gl_posting_failures');
  await knex.schema.dropTableIfExists('gl_accounting_periods');
  await knex.schema.dropTableIfExists('gl_journal_entries');
  await knex.schema.dropTableIfExists('gl_accounts');

  await knex.schema.dropTableIfExists('crm_custom_field_defs');
  await knex.schema.dropTableIfExists('crm_feedback');
  await knex.schema.dropTableIfExists('crm_activity_subtasks');
  await knex.schema.dropTableIfExists('crm_activities');
  await knex.schema.dropTableIfExists('crm_deals');
  await knex.schema.dropTableIfExists('crm_pipelines');
  await knex.schema.dropTableIfExists('crm_contacts');
  await knex.schema.dropTableIfExists('crm_companies');
};
