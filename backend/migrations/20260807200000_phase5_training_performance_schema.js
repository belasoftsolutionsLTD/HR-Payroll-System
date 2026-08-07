// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 5) —
// Training (courses, course_modules, enrollments, learning_paths, quizzes,
// certificates, external_certificates, training_assignment_rules,
// rule_execution_logs, training_feedback, training_sessions) and Performance
// (appraisal_records, review_templates, review_cycles, reviews, goals + their
// check-in/comment children, feedback, one_on_ones + agenda items,
// performance_improvement_plans + check-ins).
//
// Same conventions as every phase so far: ids stay as unchanged Mongo ObjectId-hex
// TEXT primary keys; a handful of child rows that carry their own freshly-generated
// (never template-copied) id keep that id as their own TEXT primary key (goal
// comments, one-on-one agenda items, PIP check-ins — all crypto.randomUUID()'d
// fresh per row, confirmed via grep, unlike Phase 4's template-copied ids); rows
// with no id of their own get a real Postgres auto-increment integer (goal
// check-ins). Attribution-only fields get no FK by default, added back only where
// a live orphan-check confirmed the real data is clean.
//
// IMPORTANT naming quirk confirmed via a live orphan-check: throughout the Training
// module (and ONLY there — Performance's employeeId fields are real employees.id
// references), every field called "employeeId" (enrollments, certificates,
// external_certificates, training_feedback) actually holds a users.id, not an
// employees.id — confirmed 0 orphans against `users`, 100% orphans against
// `employees`. The app code itself only ever resolves these ids by querying
// `users`. Preserved as-is (a real, if confusingly named, pre-existing design),
// with FKs pointed at `users`, not `employees`.

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  // ── Training ─────────────────────────────────────────────────────────────────

  await knex.schema.createTable('courses', (t) => {
    t.text('id').primary();
    t.text('title').notNullable();
    t.text('description');
    t.text('coverImageUrl');
    t.text('category');
    t.specificType('tags', 'text[]');
    t.specificType('skillsTaught', 'text[]');
    t.integer('estimatedDurationMinutes');
    t.text('difficultyLevel');
    t.text('status');
    t.boolean('isMandatory').defaultTo(false);
    t.specificType('targetRoles', 'text[]');
    t.specificType('targetDepartments', 'text[]');
    t.boolean('hasCertificate').defaultTo(false);
    t.integer('certificateValidityDays');
    t.text('deliveryMethod'); // 'self_paced' | 'instructor_led'
    t.text('createdBy');
    t.specificType('authors', 'text[]');
    t.timestamp('publishedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
    t.index('category');
  });

  await knex.schema.createTable('course_modules', (t) => {
    t.text('id').primary();
    // Real data confirmed 0/35 orphans.
    t.text('courseId').notNullable().references('id').inTable('courses').onDelete('CASCADE');
    t.text('title');
    t.integer('order');
    t.text('type'); // 'document' | 'video' | 'quiz' | 'text' | ...
    t.jsonb('content'); // shape varies by type — {fileUrl,fileName} for document, etc.
    t.boolean('isRequired').defaultTo(true);
    t.integer('minimumPassScore');
    t.timestamp('createdAt', { useTz: true });

    t.index('courseId');
  });

  await knex.schema.createTable('enrollments', (t) => {
    t.text('id').primary();
    // See the file header — this is a users.id, not employees.id. Real data
    // confirmed 0/25 orphans against users, 25/25 against employees.
    t.text('employeeId').notNullable().references('id').inTable('users');
    t.text('courseId').references('id').inTable('courses'); // real data: 0 orphans; nullable for learning-path-only enrollments
    t.text('learningPathId'); // no FK — see learning_paths below, checked separately
    t.text('enrolledBy');
    t.text('enrollmentTrigger');
    t.timestamp('dueDate', { useTz: true });
    t.text('status');
    t.timestamp('completedAt', { useTz: true });
    t.integer('progressPercentage').defaultTo(0);
    // moduleProgress — read-whole/modify-in-JS/write-whole-back (same idiom as
    // leave_requests.approvalChain), never arrayFilters/positional updates.
    t.jsonb('moduleProgress');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('employeeId');
    t.index('courseId');
    t.index('status');
  });

  await knex.schema.createTable('learning_paths', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.jsonb('courses'); // [{courseId, order, isRequired, unlockAfterCourseId}] — whole-replaced on edit
    t.specificType('targetRoles', 'text[]');
    t.specificType('targetDepartments', 'text[]');
    t.text('enrollmentTrigger');
    t.integer('dueDateOffsetDays');
    t.text('status');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
  });

  await knex.schema.createTable('quizzes', (t) => {
    t.text('id').primary();
    // Real data confirmed 0/6 orphans on both.
    t.text('moduleId').notNullable().references('id').inTable('course_modules').onDelete('CASCADE');
    t.text('courseId').notNullable().references('id').inTable('courses').onDelete('CASCADE');
    t.integer('passingScore');
    t.integer('maxAttempts');
    t.boolean('shuffleQuestions').defaultTo(false);
    t.boolean('shuffleOptions').defaultTo(false);
    t.integer('timeLimitMinutes');
    t.jsonb('questions'); // whole-replaced on edit, never per-question updates

    t.index('moduleId');
  });

  await knex.schema.createTable('certificates', (t) => {
    t.text('id').primary();
    // users.id, same naming quirk as enrollments — real data confirmed 0/3 orphans
    // against users, 3/3 against employees.
    t.text('employeeId').notNullable().references('id').inTable('users');
    t.text('courseId').references('id').inTable('courses'); // 0/3 orphans
    t.text('enrollmentId').references('id').inTable('enrollments'); // 0/3 orphans
    t.text('certificateNumber');
    t.timestamp('issuedAt', { useTz: true });
    t.timestamp('expiresAt', { useTz: true });
    t.text('pdfUrl');

    t.index('employeeId');
  });

  await knex.schema.createTable('external_certificates', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('users'); // same naming quirk
    t.text('name');
    t.text('issuingOrganization');
    t.timestamp('issuedDate', { useTz: true });
    t.timestamp('expiryDate', { useTz: true });
    t.text('fileUrl');
    t.text('verificationUrl');
    t.text('status').defaultTo('pending');
    t.text('verifiedBy');
    t.timestamp('uploadedAt', { useTz: true });

    t.index('employeeId');
    t.index('status');
  });

  await knex.schema.createTable('training_assignment_rules', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('trigger'); // 'onHire' | 'onRoleChange' | ...
    t.jsonb('triggerConditions');
    t.jsonb('action'); // {enrollInLearningPathIds, dueDateOffsetDays, notifyEmployee, notifyManager}
    t.boolean('isActive').defaultTo(true);
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
  });

  await knex.schema.createTable('rule_execution_logs', (t) => {
    t.text('id').primary();
    t.text('ruleId'); // no FK — an execution log should survive its rule being deleted
    t.timestamp('runAt', { useTz: true });
    t.integer('matched');
    t.integer('created');

    t.index('ruleId');
  });

  await knex.schema.createTable('training_feedback', (t) => {
    t.text('id').primary();
    t.text('enrollmentId').references('id').inTable('enrollments');
    t.text('courseId').references('id').inTable('courses');
    t.text('employeeId').notNullable().references('id').inTable('users'); // same naming quirk
    t.integer('rating');
    t.text('review');
    t.timestamp('submittedAt', { useTz: true });

    t.index('courseId');
  });

  await knex.schema.createTable('training_sessions', (t) => {
    t.text('id').primary();
    t.text('courseId').references('id').inTable('courses');
    t.text('title');
    t.text('facilitatorId'); // no FK, attribution-style
    t.text('facilitatorName');
    t.timestamp('scheduledAt', { useTz: true });
    t.integer('durationMinutes');
    t.text('meetingLink');
    t.integer('capacity');
    // A real Postgres array (not JSONB) — $push/$pull of plain scalar ids in the
    // original code, and Postgres arrays support that (array_append/array_remove)
    // and containment queries (@>) directly, unlike a child table which would be
    // overkill for a bare id list with no per-attendee state of its own.
    t.specificType('attendeeIds', 'text[]');
    t.text('status').defaultTo('scheduled');
    t.jsonb('attendance'); // [{employeeId, attended}] — set once as a whole after the session
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('courseId');
  });

  // ── Performance ──────────────────────────────────────────────────────────────

  await knex.schema.createTable('appraisal_records', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees'); // real employees ref, unlike Training
    t.text('reviewPeriod');
    t.text('periodKey');
    t.text('reviewerId'); // no FK, attribution-style
    t.specificType('goalsSet', 'text[]');
    t.specificType('goalsAchieved', 'text[]');
    t.integer('rating');
    t.text('comments');
    t.text('status');
    t.text('reviewedBy');
    t.timestamp('reviewedAt', { useTz: true });
    t.text('reviewComment');
    t.timestamp('createdAt', { useTz: true });

    t.index('employeeId');
    t.index('periodKey');
  });

  await knex.schema.createTable('review_templates', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.specificType('cycleTypes', 'text[]');
    // sections[].questions[] — the plan's own named double-nested shape, but always
    // read-whole/write-whole on template edit (never per-question updates, same
    // reasoning as onboarding_templates/offboarding_templates staying JSONB while
    // only their *records* — reviews.responses here — get individually touched, and
    // even those are submitted once as a whole, not per-question either).
    t.jsonb('sections');
    t.boolean('isActive').defaultTo(true);
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
    t.boolean('isDemoSeed').defaultTo(false);
  });

  await knex.schema.createTable('review_cycles', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('type');
    t.text('templateId').references('id').inTable('review_templates'); // 0 orphans
    t.text('status');
    t.jsonb('phases'); // {selfReview, managerReview, calibration, resultsSharing} — whole-replaced
    t.jsonb('audience'); // {type, departments, employeeIds} — whole-replaced
    // participants[] — read-whole/modify-in-JS/write-whole-back, same idiom as
    // applications.stageHistory in Phase 4, not a real per-row child table.
    t.jsonb('participants');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
    t.boolean('isDemoSeed').defaultTo(false);

    t.index('status');
  });

  await knex.schema.createTable('reviews', (t) => {
    t.text('id').primary();
    t.text('cycleId').notNullable().references('id').inTable('review_cycles').onDelete('CASCADE'); // 0/3 orphans
    t.text('employeeId').notNullable().references('id').inTable('employees'); // 0/3 orphans
    t.text('reviewerId'); // no FK, attribution-style
    t.text('reviewType'); // 'self' | 'manager' | 'peer'
    t.text('status');
    t.jsonb('responses'); // [{sectionId, questionId, value}] — submitted once as a whole
    t.decimal('overallRating', 4, 2);
    t.text('recommendation');
    t.text('calibrationBox');
    t.text('calibrationNotes');
    t.timestamp('submittedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
    t.boolean('isDemoSeed').defaultTo(false);

    t.index('cycleId');
    t.index('employeeId');
  });

  await knex.schema.createTable('goals', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees'); // 0/3 orphans
    t.text('department');
    t.text('createdBy');
    t.text('title').notNullable();
    t.text('description');
    t.text('category');
    t.text('period');
    t.timestamp('startDate', { useTz: true });
    t.timestamp('endDate', { useTz: true });
    t.text('status');
    t.integer('progress').defaultTo(0);
    t.text('visibility');
    t.text('parentGoalId'); // no FK — self-reference, a deleted parent shouldn't cascade
    t.jsonb('keyResults'); // whole-replaced on edit
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
    t.boolean('isDemoSeed').defaultTo(false);

    t.index('employeeId');
    t.index('status');
  });

  // Real $push, no id of its own in the original doc — auto-increment, same call
  // as attendance_breaks (Phase 3b) / application_interview_assignments (Phase 4).
  await knex.schema.createTable('goal_check_ins', (t) => {
    t.increments('id');
    t.text('goalId').notNullable().references('id').inTable('goals').onDelete('CASCADE');
    t.integer('progress');
    t.text('note');
    t.text('updatedBy'); // no FK, attribution-style
    t.timestamp('updatedAt', { useTz: true });

    t.index('goalId');
  });

  // Real $push, but each comment DOES carry its own freshly-generated (new
  // ObjectId() at push time, never copied across goals) id — preserved as the
  // real primary key, unlike Phase 4's template-copied ids.
  await knex.schema.createTable('goal_comments', (t) => {
    t.text('id').primary();
    t.text('goalId').notNullable().references('id').inTable('goals').onDelete('CASCADE');
    t.text('text');
    t.text('authorId'); // no FK, attribution-style
    t.text('authorName');
    t.timestamp('createdAt', { useTz: true });

    t.index('goalId');
  });

  await knex.schema.createTable('feedback', (t) => {
    t.text('id').primary();
    t.text('giverId'); // no FK, attribution-style
    t.text('recipientId'); // no FK, attribution-style
    t.text('type'); // 'positive' | 'constructive'
    t.text('category');
    t.text('message');
    t.text('visibility');
    t.boolean('isAnonymous').defaultTo(false);
    t.boolean('isVisibleToEmployee').defaultTo(true);
    t.text('relatedCycleId'); // no FK — a cycle deletion shouldn't cascade-delete real feedback history
    t.timestamp('createdAt', { useTz: true });
    t.boolean('isDemoSeed').defaultTo(false);

    t.index('recipientId');
  });

  await knex.schema.createTable('one_on_ones', (t) => {
    t.text('id').primary();
    t.text('managerId'); // no FK, attribution-style
    t.text('employeeId').notNullable().references('id').inTable('employees'); // 0/2 orphans
    t.timestamp('scheduledAt', { useTz: true });
    t.text('status');
    t.text('sharedNotes');
    t.text('privateManagerNotes');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
    t.timestamp('completedAt', { useTz: true });

    t.index('employeeId');
  });

  // Real $push with a fresh randomUUID() per item (never copied across
  // one-on-ones) — preserved as the real primary key. Real per-item positional
  // update for isDone (`agendaItems.$.isDone`), confirming it's a genuine child
  // entity, not whole-replaced.
  await knex.schema.createTable('one_on_one_agenda_items', (t) => {
    t.text('id').primary();
    t.text('oneOnOneId').notNullable().references('id').inTable('one_on_ones').onDelete('CASCADE');
    t.text('text');
    t.text('addedBy'); // no FK, attribution-style
    t.boolean('isDone').defaultTo(false);
    t.timestamp('createdAt', { useTz: true });

    t.index('oneOnOneId');
  });

  await knex.schema.createTable('performance_improvement_plans', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees'); // 0/3 orphans
    t.text('managerId'); // no FK, attribution-style
    t.text('createdBy');
    t.text('reason');
    t.timestamp('startDate', { useTz: true });
    t.timestamp('endDate', { useTz: true });
    t.text('status');
    t.jsonb('goals'); // [{id, description, targetDate, status}] — whole-replaced on edit
    t.text('outcome');
    t.text('relatedReviewId'); // no FK — a review deletion shouldn't cascade into PIP history
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
    t.boolean('isDemoSeed').defaultTo(false);
    t.timestamp('closedAt', { useTz: true });

    t.index('employeeId');
    t.index('status');
  });

  // Real $push with a fresh randomUUID() per item — same reasoning as
  // one_on_one_agenda_items.
  await knex.schema.createTable('pip_check_ins', (t) => {
    t.text('id').primary();
    t.text('pipId').notNullable().references('id').inTable('performance_improvement_plans').onDelete('CASCADE');
    t.text('note');
    t.text('addedBy'); // no FK, attribution-style
    t.timestamp('createdAt', { useTz: true });

    t.index('pipId');
  });

  // employees.pendingPerformanceFlag — a genuinely new column on Phase 1's employees
  // table, needed by submitReview's promote/PIP flagging (performanceFunctions.js).
  // Phase 1 couldn't have known about this since Performance wasn't examined until
  // now; extending an earlier phase's table is the right call here rather than
  // stashing performance-specific state somewhere else.
  await knex.schema.alterTable('employees', (t) => {
    t.jsonb('pendingPerformanceFlag'); // {type, reviewId, cycleId, flaggedBy, flaggedAt} | null
  });

  // employee_certifications.alertSent — found while sweeping cronTasks.js for Phase 5
  // (checkExpiringCertifications, unrelated to training's own certificates table, was
  // still reading employees.certifications as a raw embedded Mongo array via
  // global.dbo — silently broken since Phase 1 moved certifications to this real child
  // table). Real data has 0 rows with this flag set (never actually used yet), but the
  // cron code depends on it to avoid re-notifying daily for the same expiring cert.
  await knex.schema.alterTable('employee_certifications', (t) => {
    t.boolean('alertSent').defaultTo(false);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('employee_certifications', (t) => {
    t.dropColumn('alertSent');
  });
  await knex.schema.alterTable('employees', (t) => {
    t.dropColumn('pendingPerformanceFlag');
  });
  await knex.schema.dropTableIfExists('pip_check_ins');
  await knex.schema.dropTableIfExists('performance_improvement_plans');
  await knex.schema.dropTableIfExists('one_on_one_agenda_items');
  await knex.schema.dropTableIfExists('one_on_ones');
  await knex.schema.dropTableIfExists('feedback');
  await knex.schema.dropTableIfExists('goal_comments');
  await knex.schema.dropTableIfExists('goal_check_ins');
  await knex.schema.dropTableIfExists('goals');
  await knex.schema.dropTableIfExists('reviews');
  await knex.schema.dropTableIfExists('review_cycles');
  await knex.schema.dropTableIfExists('review_templates');
  await knex.schema.dropTableIfExists('appraisal_records');

  await knex.schema.dropTableIfExists('training_sessions');
  await knex.schema.dropTableIfExists('training_feedback');
  await knex.schema.dropTableIfExists('rule_execution_logs');
  await knex.schema.dropTableIfExists('training_assignment_rules');
  await knex.schema.dropTableIfExists('external_certificates');
  await knex.schema.dropTableIfExists('certificates');
  await knex.schema.dropTableIfExists('quizzes');
  await knex.schema.dropTableIfExists('learning_paths');
  await knex.schema.dropTableIfExists('enrollments');
  await knex.schema.dropTableIfExists('course_modules');
  await knex.schema.dropTableIfExists('courses');
};
