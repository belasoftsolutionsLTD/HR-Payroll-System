// Postgres migration (Phase 10) — Notifications, Inbox, Config/Settings,
// audit_logs, Reports' own customReports, and (found during this phase's
// cross-cutting sweep, not part of the original plan) Announcements — a
// live, mounted module (/api/announcements → announcementFunctions.js) that
// every prior phase's plan simply never named. This is the last
// module-schema phase before Phase 11 (ETL consolidation) and Phase 12
// (cutover) — every other collection in the app is Postgres after this. See
// /home/carole/.claude/plans/abundant-dreaming-flurry.md for the overall
// migration strategy. IDs stay as unchanged Mongo ObjectId-hex TEXT primary
// keys; column names stay camelCase matching Mongo field names.
//
// ── Schema decisions ────────────────────────────────────────────────────────
//
// notifications: the plan's own explicitly-called-out cleanup target — this
// collection had a real dual-key design smell (`recipientId` and `userId`
// both present, queried with an `$or`). A live check of all 451 real rows
// found the smell was already cosmetic in practice: 447 rows have BOTH keys
// set and they are IDENTICAL in every single one (0 divergent), and the
// other 4 rows (all pre-dating the current notifyUser.js helper) have only
// `userId` set. Same story for two more duplicate-field pairs the schema
// carried: `link`/`navigateTo` (0 divergent across all 451) and
// `read`/`isRead` (0 divergent) and `subtitle`/`body` (0 divergent) — all
// three are always written identically by the one active write path
// (notifyUser.js's `notifyUser`). Normalized to ONE column each:
// recipientId (backfilled from userId when recipientId is absent),
// navigateTo, isRead, body. The API response layer still returns the old
// duplicate field names too (computed from the single column) for frontend
// compatibility, matching every earlier phase's "preserve the response
// contract" discipline.
// referenceId/referenceModel/emailSent/emailSentAt were declared in the
// document shape `createNotification`/`notifyHRNotification` would have
// written, but a full-codebase grep found those two functions have ZERO
// callers anywhere — completely dead code, and consequently these four
// fields appear in 0 of the 451 real rows. Dropped from the schema entirely
// (not carried forward as unused nullable columns) and the two dead
// functions are not reimplemented in the rewritten notificationFunctions.js.
//
// inbox_items: already a single, consistently-shaped table in Mongo (every
// field present on all 132 real rows, single recipientId key already) — a
// straightforward 1:1 port, no normalization needed. referenceId has no FK
// (polymorphic — referenceModel names the target table, which varies by
// row: projects/applications/expense_claims/employees/leave_requests/
// applicants/shift_applications/shift_notes/purchase_requests/
// vendor_invoices/externalCertificates/invoices/it_requests, all Postgres
// tables now but never a single fixed one).
//
// company_settings/tax_config/overtime_config/communication_settings:
// singleton config docs, one-row tables (same pattern as Phase 0/1's
// designation of this shape). tax_config's incomeTax/statutoryDeductions
// are the only nested structures in this group — stay JSONB (always
// whole-replaced via replaceOne in the original code, never a per-row Mongo
// op). All four
// currently have 0 real rows except overtime_config (1) — the app has
// never had company_settings/tax_config/communication_settings/jd_templates/
// scheduled_events actually configured through their admin panels in this
// environment; code-level defaults (KENYA_DEFAULT, DEFAULT_OVERTIME_CONFIG,
// process.env.COMPANY_NAME) have carried everything until now. Migrated as
// real (currently-empty, for 3 of the 4) singleton tables regardless, so
// the first real save through the admin panel works correctly post-cutover.
//
// jd_templates/scheduled_events: real (multi-row) tables, flat, no arrays.
//
// audit_logs: a high-write-volume, write-mostly forensic log (every
// mutating API call, via AuditMiddleware.js) — never read back through any
// route (no admin viewer exists). Flat columns + a `body` JSONB column for
// the redacted request body (arbitrary per-endpoint shape).
//
// customReports (Reports module's custom report builder + scheduling): 0
// real rows (never used yet), flat metadata + JSONB for dataSources/fields/
// filters/dateRange (whole-replaced arrays/objects) and `schedule` (a
// {frequency, recipients, lastRunAt, nextRunAt} object, also always
// whole-replaced via `$set: {schedule: {...}}` — queried by
// `schedule.nextRunAt` in the original Mongo code, translated to a
// `schedule->>'nextRunAt'` JSONB path expression here).
//
// announcements: found live and mounted (/api/announcements) but absent from
// every phase of the original plan — 1 real row, no orphan concerns
// (createdBy references a real user). `audiences`
// (array of 'all'|'staff'|'department_head'|'hr_only'|'department:X'|
// 'employee:X'|'jobGroup:X'|'employmentType:X' strings) is always
// whole-replaced at creation, never mutated per-element — stays JSONB.
// `readBy` is different: the original code used `$addToSet`, a real
// per-row/per-element mutation (one user marks one announcement read at a
// time) — matching this phase's established "real $push/$addToSet
// semantics → real child table" heuristic, so it becomes its own
// announcement_reads table (one row per user who has read one announcement)
// instead of a JSONB array.

exports.up = async function up(knex) {
  await knex.schema.createTable('notifications', (t) => {
    t.text('id').primary();
    // No FK — live orphan-check found 36/455 real notifications reference an
    // already-deleted user (real historical data drift, not introduced by
    // this migration; same posture as every earlier phase's orphan finds).
    t.text('recipientId').notNullable();
    t.text('title').notNullable();
    t.text('body');
    t.text('type'); // general|recruitment|training|expense|onboarding|offboarding|leave|task|payroll|inventory|group_chat|...
    t.text('navigateTo');
    t.boolean('isRead').defaultTo(false);
    t.timestamp('readAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });

    t.index(['recipientId', 'isRead']);
    t.index('createdAt');
  });

  await knex.schema.createTable('inbox_items', (t) => {
    t.text('id').primary();
    // No FK — live orphan-check found 34/132 real inbox items reference an
    // already-deleted user (same real data drift as notifications above).
    t.text('recipientId').notNullable();
    t.text('type').notNullable();
    t.text('subType');
    t.text('title').notNullable();
    t.text('subtitle');
    t.text('referenceId'); // polymorphic — see file header, no FK target
    t.text('referenceModel');
    t.text('priority'); // normal|high|...
    t.boolean('requiresAction').defaultTo(true);
    t.text('status'); // unread|read|actioned|dismissed
    t.text('actionTaken');
    t.timestamp('actionedAt', { useTz: true });
    t.text('actionedBy').references('id').inTable('users');
    // No FK on triggeredBy — 36/112 real rows reference an already-deleted user.
    t.text('triggeredBy');
    t.timestamp('expiresAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index(['recipientId', 'status']);
    t.index(['recipientId', 'requiresAction']);
  });

  // Singleton — one row, no natural id to preserve from Mongo (0 real rows
  // in this environment), so a fresh generated id at first-write time.
  await knex.schema.createTable('company_settings', (t) => {
    t.text('id').primary();
    t.text('companyName');
    t.text('mission');
    t.text('vision');
    t.text('coreValues');
    t.text('address');
    t.text('phone');
    t.text('email');
    t.text('website');
    t.text('workStartTime');
    t.text('workEndTime');
    t.text('primaryColor');
    t.text('gradientEndColor');
    t.boolean('gradientEnabled');
    t.decimal('officeLatitude', 10, 7);
    t.decimal('officeLongitude', 10, 7);
    t.integer('officeRadiusMeters');
    t.text('facebook');
    t.text('twitter');
    t.text('linkedin');
    t.text('instagram');
    t.text('youtube');
    t.text('tiktok');
    t.text('tagline');
    t.text('country');
    t.text('currency');
    t.text('timezone');
    t.text('fiscalYearStart');
    t.decimal('defaultVatRate', 5, 2);
    t.text('defaultTaxCategory');
    t.text('logoPath');
    t.text('logoFilename');
    t.text('termsPath');
    t.text('termsFilename');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('tax_config', (t) => {
    t.text('id').primary();
    t.text('currency');
    t.text('currencySymbol');
    t.jsonb('incomeTax'); // {name, enabled, deductPensionFirst, personalRelief, brackets:[{limit,rate}]}, whole-replaced
    t.jsonb('statutoryDeductions'); // [{key,name,enabled,type,cap,rate|tiers|amount}], whole-replaced
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('overtime_config', (t) => {
    t.text('id').primary();
    t.text('nightStart');
    t.text('nightEnd');
    t.decimal('weekdayDayRate', 5, 2);
    t.decimal('weekdayNightRate', 5, 2);
    t.decimal('weekendDayRate', 5, 2);
    t.decimal('weekendNightRate', 5, 2);
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('communication_settings', (t) => {
    t.text('id').primary();
    t.text('emailProvider');
    t.text('smtpHost');
    t.text('smtpPort');
    t.text('smtpUser');
    t.text('smtpFrom');
    t.text('smsProvider');
    t.text('smsApiKey');
    t.text('smsFrom');
    t.boolean('notifyOnLeave');
    t.boolean('notifyOnPayroll');
    t.boolean('notifyOnAppraisal');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('jd_templates', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.text('roles');
    t.text('pdfPath');
    t.text('pdfOriginalName');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('scheduled_events', (t) => {
    t.text('id').primary();
    t.text('title').notNullable();
    t.text('type'); // training|team_building
    t.text('description');
    t.text('scheduledDate'); // stored as plain date string in real data, kept as text to match
    t.text('endDate');
    t.text('location');
    t.text('audience'); // all|department
    t.text('department');
    t.text('createdBy'); // display-name string, not an id (matches real data)
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('scheduledDate');
    t.index('type');
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.text('id').primary();
    t.text('userId'); // no FK — a pre-login request (e.g. a failed /auth/login) legitimately has no user yet
    t.text('userEmail');
    t.text('userRole');
    t.text('method').notNullable();
    t.text('path').notNullable();
    t.jsonb('body'); // redacted request body, arbitrary per-endpoint shape
    t.integer('statusCode');
    t.text('ip');
    t.text('userAgent');
    t.timestamp('timestamp', { useTz: true });

    t.index('userId');
    t.index('timestamp');
    t.index(['path', 'timestamp']);
  });

  await knex.schema.createTable('announcements', (t) => {
    t.text('id').primary();
    t.text('title').notNullable();
    t.text('body').notNullable();
    t.text('type'); // news|alert|campaign
    t.jsonb('audiences'); // string array, whole-replaced — see file header
    t.text('audience'); // legacy singular field, kept for the staff-portal fallback match
    t.text('department');
    t.text('createdBy').references('id').inTable('users');
    t.text('createdByName');
    t.timestamp('createdAt', { useTz: true });

    t.index('createdAt');
  });

  await knex.schema.createTable('announcement_reads', (t) => {
    t.text('id').primary();
    t.text('announcementId').notNullable().references('id').inTable('announcements').onDelete('CASCADE');
    t.text('userId').notNullable().references('id').inTable('users');
    t.timestamp('readAt', { useTz: true });

    t.unique(['announcementId', 'userId']); // mirrors $addToSet's own dedup semantics
  });

  await knex.schema.createTable('customReports', (t) => {
    t.text('id').primary();
    t.text('name');
    t.jsonb('dataSources'); // string array, whole-replaced
    t.jsonb('fields'); // string array, whole-replaced
    t.jsonb('filters'); // array, whole-replaced
    t.text('groupBy');
    t.jsonb('dateRange'); // {from?, to?}, whole-replaced
    t.text('format'); // json|csv
    t.jsonb('schedule'); // {frequency, recipients, lastRunAt, nextRunAt} | null, whole-replaced
    t.text('createdBy').references('id').inTable('users');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('customReports');
  await knex.schema.dropTableIfExists('announcement_reads');
  await knex.schema.dropTableIfExists('announcements');
  await knex.schema.dropTableIfExists('audit_logs');
  await knex.schema.dropTableIfExists('scheduled_events');
  await knex.schema.dropTableIfExists('jd_templates');
  await knex.schema.dropTableIfExists('communication_settings');
  await knex.schema.dropTableIfExists('overtime_config');
  await knex.schema.dropTableIfExists('tax_config');
  await knex.schema.dropTableIfExists('company_settings');
  await knex.schema.dropTableIfExists('inbox_items');
  await knex.schema.dropTableIfExists('notifications');
};
