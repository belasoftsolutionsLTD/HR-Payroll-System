// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 4) —
// Recruitment (job_requisitions, candidates, applications + interview assignments,
// scorecards, interview_kits, nurture_campaigns + touchpoints), Onboarding
// (onboarding_templates, onboarding_records + the double-nested task-list/task
// child tables the plan calls out by name), Offboarding (the same double-nested
// shape, plus asset-checklist/access-revocation/generated-document child tables),
// and email_templates (small, genuinely shared between recruitment's own CRUD and
// the Settings module's trigger-catalog overrides — folded in here rather than
// waiting for its own phase, same "shared low-level utility" call as Phase 1).
//
// Same conventions as every phase so far: ids stay as unchanged Mongo ObjectId-hex
// TEXT primary keys (except genuinely-new child rows that never had a Mongo
// sub-document id of their own — those get a real Postgres auto-increment integer,
// same distinction Phase 3b drew for attendance_breaks vs employee_documents).
// Attribution-only fields (createdBy/updatedBy/hiringManagerId/interviewerId/
// completedBy/revokedBy/returnedTo/initiatedBy/assignedBy/byUserId/signedBy) get no
// FK by default; added back only where a live orphan-check confirmed the real data
// is clean (see each table's own comment below).

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  // ── Recruitment ──────────────────────────────────────────────────────────────

  await knex.schema.createTable('job_requisitions', (t) => {
    t.text('id').primary();
    t.text('title').notNullable();
    t.text('department');
    t.text('location');
    t.text('employmentType');
    t.integer('headcount');
    t.jsonb('salaryRange'); // {min, max, currency} — small fixed shape, always whole-replaced
    t.text('description');
    t.timestamp('applicationDeadline', { useTz: true });
    t.text('branchId'); // no FK — real data has 1/1 pointing at a since-deleted branch
    t.jsonb('competencies');      // always read-whole/modify-in-JS/write-whole-back, never $push/$pull
    t.jsonb('pipelineStages');    // same
    t.jsonb('screeningQuestions');// same
    t.jsonb('approvalChain');     // same (identical idiom to leave_requests.approvalChain, Phase 3a)
    t.text('status');
    t.text('hiringManagerId');
    t.text('createdBy');
    t.boolean('isDemoData').defaultTo(false); // sales-demo-mode flag (demoFunctions.js) — real feature, not test cruft
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
    t.index('department');
  });

  await knex.schema.createTable('candidates', (t) => {
    t.text('id').primary();
    t.text('firstName');
    t.text('lastName');
    t.text('email');
    t.text('source');
    t.specificType('tags', 'text[]');
    t.boolean('isPassiveTalent').defaultTo(false);
    t.text('phone');
    t.text('location');
    t.text('resumeUrl');
    t.text('linkedInUrl');
    t.text('referredBy'); // no FK — free-text/employee reference, attribution-only
    t.timestamp('consentGivenAt', { useTz: true });
    t.text('consentVersion');
    t.text('notes');
    t.boolean('isDemoData').defaultTo(false);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('email');
  });

  await knex.schema.createTable('applications', (t) => {
    t.text('id').primary();
    // Real data confirmed 0 orphans for both — safe to FK, matching the
    // "add back only where a live check confirmed it" rule.
    t.text('candidateId').notNullable().references('id').inTable('candidates');
    t.text('requisitionId').notNullable().references('id').inTable('job_requisitions');
    t.text('currentStageId');
    t.jsonb('stageHistory'); // read-whole/modify-in-JS/write-whole-back, same idiom as above
    t.text('status');
    t.text('rejectionReason');
    t.jsonb('offerDetails'); // {salary, currency, startDate, expiresAt, status} — small, whole-replaced
    t.text('coverLetter');
    t.jsonb('answers'); // screening-question answers — set once at creation, never modified after
    t.decimal('overallScore', 4, 2); // an average of 1-5 competency ratings — real data confirmed
                                      // non-integer values (e.g. 2.67), not a whole-number score
    t.boolean('isDemoData').defaultTo(false);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    // NOTE: Mongo's `applications.scorecards` (an embedded array of scorecard ids) is
    // deliberately NOT replicated here. Confirmed via a full grep of
    // recruitmentFunctions.js that it is written (`$push`) on every scorecard
    // submission but never once read anywhere in the codebase — every actual read
    // goes through a live `scorecards.applicationId` query instead (see
    // getMyInterviews, listScorecardsForApplication, etc). A real but write-only,
    // never-read field has zero observable behavior either way; scorecards.applicationId
    // (below) is the only path anything actually uses, matching the "don't replicate
    // dead code" call already made for clockOut's 'holidays' lookup in Phase 3b.

    t.index('status');
    t.index('currentStageId');
  });

  await knex.schema.createTable('application_interview_assignments', (t) => {
    t.increments('id'); // no Mongo sub-document id of its own — real Postgres auto-increment,
                         // same distinction Phase 3b drew for attendance_breaks
    t.text('applicationId').notNullable().references('id').inTable('applications').onDelete('CASCADE');
    t.text('stageId').notNullable();
    t.text('interviewerId').notNullable(); // no FK — a real users.id, but attribution-style,
                                            // matching every other *Id-of-a-person column so far
    t.text('interviewerName'); // denormalized snapshot at assignment time, same reasoning as
                                // employee_awards.employeeName (plan's "deliberately denormalized")
    t.timestamp('scheduledAt', { useTz: true });
    t.text('meetingLink');
    t.text('location');
    t.text('requiredDocuments');
    t.timestamp('assignedAt', { useTz: true });

    t.index('applicationId');
    t.index('interviewerId');
  });

  await knex.schema.createTable('scorecards', (t) => {
    t.text('id').primary();
    // Real data confirmed 0/17 orphans.
    t.text('applicationId').notNullable().references('id').inTable('applications').onDelete('CASCADE');
    t.text('requisitionId'); // denormalized copy, no FK (never queried through it independently)
    t.text('stageId');
    t.text('interviewerId'); // no FK, attribution-style
    t.text('interviewerName');
    t.jsonb('competencyRatings'); // small, fixed-shape, submitted once as a whole
    t.text('overallRecommendation');
    t.text('strengths');
    t.text('concerns');
    t.timestamp('submittedAt', { useTz: true });

    t.index('applicationId');
    t.index('interviewerId');
  });

  await knex.schema.createTable('interview_kits', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.jsonb('competencies');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('nurture_campaigns', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.specificType('targetTags', 'text[]');
    t.text('status');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
  });

  await knex.schema.createTable('nurture_campaign_touchpoints', (t) => {
    t.increments('id'); // $push-only in the original code — a real per-row append,
                         // no Mongo sub-document id of its own
    t.text('campaignId').notNullable().references('id').inTable('nurture_campaigns').onDelete('CASCADE');
    t.text('candidateId'); // no FK — candidate may be deleted, this is a historical log entry
    t.text('channel');
    t.text('note');
    t.timestamp('sentAt', { useTz: true });
    t.text('byUserId');
    t.text('response');

    t.index('campaignId');
  });

  // Shared between recruitment's own direct CRUD (keyed by real _id, a `name` field,
  // a `trigger` constrained to recruitment-specific values) and the Settings module's
  // trigger-catalog override pattern (findOne/upsert/delete all keyed by `trigger`,
  // never by id). No UNIQUE(trigger) — real data has no duplicates today, but Mongo
  // never enforced one either and recruitment's own createEmailTemplate has no such
  // check, so adding one now would be inventing a stricter guarantee than existed.
  await knex.schema.createTable('email_templates', (t) => {
    t.text('id').primary();
    t.text('name'); // only ever set by recruitment's own CRUD; settings' upsert leaves it null
    t.text('trigger').notNullable();
    t.text('subject');
    t.text('body');
    t.text('createdBy');
    t.text('updatedBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('trigger');
  });

  // ── Onboarding ───────────────────────────────────────────────────────────────

  await knex.schema.createTable('onboarding_templates', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.specificType('targetRoles', 'text[]');
    t.specificType('targetDepartments', 'text[]');
    t.text('welcomeMessage');
    t.jsonb('firstDayDetails');
    // Template task lists are definitions only (no per-task completion state) and are
    // always replaced as a whole on template edit — unlike onboarding_records' own
    // taskLists (below), which get real per-task field updates and are real child
    // tables instead. Same distinction the plan draws between config docs and records.
    t.jsonb('taskLists');
    t.jsonb('meetTheTeam');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('onboarding_records', (t) => {
    t.text('id').primary();
    // Real data confirmed 1/9 employeeId values point at a since-deleted employee —
    // same recurring finding as every other phase; no FK.
    t.text('employeeId').notNullable();
    t.text('templateId'); // no FK — template may be edited/deleted after use, this is a
                           // point-in-time reference only (the record copies everything
                           // it needs out of the template at creation time)
    t.text('status');
    t.timestamp('startDate', { useTz: true });
    t.timestamp('completedAt', { useTz: true });
    t.text('welcomeMessage');
    t.jsonb('firstDayDetails');
    t.jsonb('meetTheTeam'); // {employeeId, note, met} — small, always whole-replaced
    t.jsonb('compensationSetup'); // {grossPay, paymentMethod, setAt, setBy} — set once as a whole
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    // NOTE: Mongo's stored `progressPercentage` field is deliberately NOT replicated —
    // confirmed via grep it is never written anywhere in onboardingFunctions.js, only
    // computed fresh on every read (computeProgress) and spread onto the response.
    // The real documents carry a stale leftover value from an older code version;
    // the current (and this rewrite's) behavior already recomputes it every time, so
    // persisting it would just be a second, never-updated copy of derived data.

    t.index('employeeId');
    t.index('status');
  });

  // The plan's own "double-nested arrays become two child tables" pattern, named
  // explicitly for onboarding_records/offboarding_records' taskLists[].tasks[].
  // Real per-task field updates (status/completedBy/completedAt/notes/documentId) via
  // Mongo arrayFilters — the case the plan calls out as needing a genuine Postgres
  // rewrite, not a mechanical port.
  //
  // IMPORTANT: unlike employee_documents' own Mongo sub-document ids (Phase 1, always
  // globally unique), initiateOnboarding COPIES a template's list.id/task.id verbatim
  // onto every record instantiated from that template (see lib/onboarding/
  // autoAssignTasks.js) — real data confirms the same list/task id (e.g. 'list-hr',
  // 't-1on1') repeats across every onboarding_records row created from the same
  // template. That id is NOT a valid global primary key. So: a real Postgres
  // auto-increment integer id (same call as attendance_breaks in Phase 3b), with the
  // original Mongo key preserved in its own `listKey`/`taskKey` column — which IS what
  // the app's own arrayFilters/`req.body.taskId` lookups actually match on — scoped
  // uniquely per parent via a composite UNIQUE constraint instead of a bare PK.
  await knex.schema.createTable('onboarding_task_lists', (t) => {
    t.increments('id');
    t.text('recordId').notNullable().references('id').inTable('onboarding_records').onDelete('CASCADE');
    t.text('listKey').notNullable(); // the original Mongo list.id, e.g. 'list-hr'
    t.text('name');
    t.text('assignedTo'); // 'hr' | 'manager' | 'newHire' | 'it' | 'finance'

    t.unique(['recordId', 'listKey']);
  });

  await knex.schema.createTable('onboarding_tasks', (t) => {
    t.increments('id');
    t.integer('taskListId').notNullable().references('id').inTable('onboarding_task_lists').onDelete('CASCADE');
    t.text('taskKey').notNullable(); // the original Mongo task.id, e.g. 't-1on1'
    t.text('title');
    t.text('description');
    t.timestamp('dueDate', { useTz: true });
    t.boolean('isRequired').defaultTo(true);
    t.text('status').defaultTo('pending');
    t.text('completedBy'); // no FK, attribution-style
    t.timestamp('completedAt', { useTz: true });
    t.boolean('requiresDocument').defaultTo(false);
    t.text('documentId'); // no FK — set after onboarding_documents' own insert, both
                           // tables reference each other's row by plain id only
    t.text('notes');
    t.text('resourceUrl');

    t.unique(['taskListId', 'taskKey']);
  });

  // Shared between onboarding and offboarding (see the `recordType` discriminator) —
  // no FK on recordId since it can point into either onboarding_records or
  // offboarding_records and Postgres has no single-column FK to two tables.
  await knex.schema.createTable('onboarding_documents', (t) => {
    t.text('id').primary();
    t.text('employeeId');
    t.text('recordId');
    t.text('recordType'); // 'onboarding' | 'offboarding'
    t.text('taskId');
    t.text('name');
    t.text('type');
    t.text('fileUrl');
    t.timestamp('signedAt', { useTz: true });
    t.text('signedBy');
    t.text('status');
    t.timestamp('uploadedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });

    t.index(['recordId', 'recordType']);
    t.index('employeeId');
  });

  // ── Offboarding ──────────────────────────────────────────────────────────────

  await knex.schema.createTable('offboarding_templates', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.specificType('exitTypes', 'text[]');
    t.jsonb('taskLists'); // definitions only, same reasoning as onboarding_templates
    t.jsonb('assetChecklist');
    t.jsonb('accessRevocationList');
    t.specificType('documentsToGenerate', 'text[]');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('offboarding_records', (t) => {
    t.text('id').primary();
    // Real data (n=1) confirmed 0 orphans — FK added on that basis, same threshold
    // used for timesheets.employeeId in Phase 3b.
    t.text('employeeId').notNullable().references('id').inTable('employees');
    t.text('templateId'); // no FK, same reasoning as onboarding_records.templateId
    t.text('exitType');
    t.text('exitReason');
    t.timestamp('lastWorkingDay', { useTz: true });
    t.timestamp('noticePeriodStartDate', { useTz: true });
    t.text('status');
    t.boolean('eligibleForRehire').defaultTo(true);
    t.jsonb('exitInterview'); // fixed shape, set once as a whole on submission
    t.boolean('finalPayTriggered').defaultTo(false);
    t.timestamp('finalPayTriggeredAt', { useTz: true });
    t.timestamp('completedAt', { useTz: true });
    t.text('initiatedBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('employeeId');
    t.index('status');
  });

  // Same template-copied-id collision as onboarding_task_lists/onboarding_tasks above
  // (lib/offboarding/autoAssignTasks.js's initiateOffboarding copies list.id/task.id
  // verbatim from the template into every record) — auto-increment id + a scoped
  // unique key column, not a bare TEXT primary key.
  await knex.schema.createTable('offboarding_task_lists', (t) => {
    t.increments('id');
    t.text('recordId').notNullable().references('id').inTable('offboarding_records').onDelete('CASCADE');
    t.text('listKey').notNullable();
    t.text('name');
    t.text('assignedTo');

    t.unique(['recordId', 'listKey']);
  });

  await knex.schema.createTable('offboarding_tasks', (t) => {
    t.increments('id');
    t.integer('taskListId').notNullable().references('id').inTable('offboarding_task_lists').onDelete('CASCADE');
    t.text('taskKey').notNullable();
    t.text('title');
    t.text('description');
    t.timestamp('dueDate', { useTz: true });
    t.boolean('isRequired').defaultTo(true);
    t.text('status').defaultTo('pending');
    t.text('completedBy');
    t.timestamp('completedAt', { useTz: true });
    t.boolean('requiresDocument').defaultTo(false);
    t.text('documentId');
    t.text('notes');
    t.text('category');
    t.text('taskType');

    t.unique(['taskListId', 'taskKey']);
  });

  // Real per-item field updates (`assetChecklist.$.returned` etc, matched by a query
  // filter on the item's own id) — same "$X.$ positional update = real child table"
  // call as onboarding_tasks, not JSONB. Same template-copied-id collision risk as
  // above (a template's assetChecklist/accessRevocationList item ids are copied
  // verbatim onto every record instantiated from it) — auto-increment id + scoped key.
  await knex.schema.createTable('offboarding_asset_checklist', (t) => {
    t.increments('id');
    t.text('recordId').notNullable().references('id').inTable('offboarding_records').onDelete('CASCADE');
    t.text('itemKey').notNullable(); // the original Mongo item.id, e.g. 'asset-laptop'
    t.text('item');
    t.text('category');
    t.boolean('returned').defaultTo(false);
    t.timestamp('returnedAt', { useTz: true });
    t.text('returnedTo');
    t.text('condition');
    t.text('notes');

    t.unique(['recordId', 'itemKey']);
  });

  await knex.schema.createTable('offboarding_access_revocation', (t) => {
    t.increments('id');
    t.text('recordId').notNullable().references('id').inTable('offboarding_records').onDelete('CASCADE');
    t.text('itemKey').notNullable(); // the original Mongo item.id, e.g. 'access-email'
    t.text('system');
    t.text('category');
    t.boolean('revoked').defaultTo(false);
    t.timestamp('revokedAt', { useTz: true });
    t.text('revokedBy');

    t.unique(['recordId', 'itemKey']);
  });

  await knex.schema.createTable('offboarding_generated_documents', (t) => {
    t.increments('id'); // $push-only, no Mongo sub-document id of its own
    t.text('recordId').notNullable().references('id').inTable('offboarding_records').onDelete('CASCADE');
    t.text('type');
    t.text('fileUrl');
    t.timestamp('generatedAt', { useTz: true });

    t.index('recordId');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('offboarding_generated_documents');
  await knex.schema.dropTableIfExists('offboarding_access_revocation');
  await knex.schema.dropTableIfExists('offboarding_asset_checklist');
  await knex.schema.dropTableIfExists('offboarding_tasks');
  await knex.schema.dropTableIfExists('offboarding_task_lists');
  await knex.schema.dropTableIfExists('offboarding_records');
  await knex.schema.dropTableIfExists('offboarding_templates');

  await knex.schema.dropTableIfExists('onboarding_documents');
  await knex.schema.dropTableIfExists('onboarding_tasks');
  await knex.schema.dropTableIfExists('onboarding_task_lists');
  await knex.schema.dropTableIfExists('onboarding_records');
  await knex.schema.dropTableIfExists('onboarding_templates');

  await knex.schema.dropTableIfExists('email_templates');
  await knex.schema.dropTableIfExists('nurture_campaign_touchpoints');
  await knex.schema.dropTableIfExists('nurture_campaigns');
  await knex.schema.dropTableIfExists('interview_kits');
  await knex.schema.dropTableIfExists('scorecards');
  await knex.schema.dropTableIfExists('application_interview_assignments');
  await knex.schema.dropTableIfExists('applications');
  await knex.schema.dropTableIfExists('candidates');
  await knex.schema.dropTableIfExists('job_requisitions');
};
