// Postgres migration (Phase 9) — Projects/Tasks, Communication/Social/Messages,
// Awards, and IT. See /home/carole/.claude/plans/abundant-dreaming-flurry.md for
// the overall migration strategy. IDs stay as unchanged Mongo ObjectId-hex TEXT
// primary keys; column names stay camelCase matching Mongo field names.
//
// ── Schema decisions (read before touching any Phase 9 handler file) ──────────
//
// JSONB vs real child table, same rule as every earlier phase: an embedded array
// that is always whole-replaced (a JS array read-modify-write-back) stays JSONB.
// An array with genuine per-row Mongo ops ($push/$pull/$addToSet/positional
// "field.$.x") becomes a real child table. This phase's real child tables:
//   - task_subtasks / task_comments / task_activity (tasks.subtasks did a
//     positional `$set: {'subtasks.$.isCompleted':...}`; .comments/.activity did
//     genuine `$push`)
//   - community_post_reactions (community_posts.reactions: genuine $push/$pull)
//   - community_members (communities.memberIds: genuine $addToSet/$pull)
//   - conversation_participants (conversations.participants/admins: genuine
//     $addToSet/$pull on both — folded into one row's `isAdmin` flag instead of
//     two parallel arrays)
//   - message_reads (messages.readBy: genuine $addToSet)
//   - kudos_reactions / kudos_comments (kudos.reactions: $push/$pull;
//     .comments: $push)
//   - device_assignment_history (devices.assignmentHistory: $push at assign +
//     positional $set at unassign)
//   - software_assignments (software_apps.assignedEmployeeIds: genuine
//     $addToSet/$pull, paired with an $inc/$dec on assignedLicenses)
// Everything else embedded (projects.departments, project_subtasks.
// assignedEmployees/deptHeadReport, project_chat_groups.memberIds, tasks.
// blockedByTaskIds/meetingAttendees/tags/attachments, task_templates.sections/
// tasks, community_posts.imageUrls, meeting_notes.agendaItems/actionItems,
// kudos.recipientIds) is always whole-replaced — stays JSONB.
//
// Sub-document id safety: task_comments/community's-nothing/kudos_comments all
// generate a fresh `new ObjectId()` per row right in the handler (never copied
// across parents) — safe to reuse as the child table's own TEXT PK. Every other
// child table above has NO id on the Mongo subdocument at all (reactions,
// activity entries, assignment-history entries, junction-table rows) — those get
// a fresh Postgres `t.increments('id')`, never anything carried over from Mongo.
//
// Dead things NOT migrated: the `awards` collection (initIndexes.js still
// indexes it, but 0 rows everywhere and no route/handler ever reads or writes
// it — a stale leftover from before the module was renamed to employee_awards).
// `software_licenses` (only ever read, never written anywhere in the app; 0 rows
// in both live data and the backup dump) — getExpiringAssets's "expiring
// software" branch is fixed forward in this phase to read software_apps.
// renewalDate instead, so no Postgres table is created for it.
// post_comments.reactions (initialized `[]` at creation, no reactToComment
// handler exists anywhere) — column kept as JSONB for forward-compatibility
// (matches tasks.attachments' same "declared but never populated" treatment)
// but nothing in this phase writes to it.
//
// Genuinely-broken things found and fixed forward in this phase's handler
// rewrite (not silently carried forward — matches this project's established
// bar for fixing a live bug found during a full module rewrite):
//   - project_time_entries had real read code (meFunctions.js's getMyProjects)
//     but ZERO write endpoint anywhere — the staff portal's "log time" button
//     has always 404'd (POST /projects/:id/time-entries was never wired up).
//     Built for real this phase: schema + full CRUD + route wiring.
//   - post_comments.authorId is set to a USER id (req.user._id) at write time
//     but was looked up against the `employees` collection at read time
//     (getComments/listKudos-adjacent code) — always resolves to null, so a
//     comment's author name never actually displayed. Fixed to resolve via
//     users→employees (the same two-hop lookup communicationFunctions.js's own
//     enrichPost already does correctly for post authors).
//   - devices.assetTag numbering used a `countDocuments`-based pseudo-sequence,
//     global (not actually year-scoped despite the "IT-YYYY-" prefix) and
//     race-condition-prone. Preserved as a single non-year-scoped `counters` key
//     (not the usual `_2026`-suffixed pattern) — this is a faithful port of the
//     EXISTING (buggy) numbering behavior, not a fix, since asset tags are
//     cosmetic labels only and changing the numbering scheme would be a
//     separate, unrelated product decision.
//
// Deliberately-unconstrained polymorphic id columns: several places store
// "employeeId" fields that are actually `req.user.employeeId || req.user._id`
// (an employee id OR a user id, decided per-request depending on whether the
// requester has a linked employee record) — kudos.giverId, kudos_reactions.
// personId, kudos_comments.authorId. Same posture as Phase 6/8's polymorphic
// sourceId columns: kept as plain unconstrained TEXT, documented inline, not
// forced into a single FK that would be wrong for some rows.
// community_members.personId is similarly unconstrained: createCommunity's
// creator is added by user id but its "auto-add all employees" branch adds by
// employee id — the same array mixes both id spaces (pre-existing behavior,
// 0 real rows so nothing to lose).
//
// Denormalized-on-purpose fields preserved as columns, not normalized away
// (matches this project's established denormalization posture): employee_awards'
// employeeName/staffNumber/department/awardTypeName; kudos' giverName/
// valueName/valueColor; task's assignedToName/createdByName/linkedEmployeeName.
//
// Table-name collision found and resolved: Communication's real Mongo collection
// is `one_on_ones` (snake_case) — a generic recurring 1:1 scheduling feature
// between any two employees. Phase 5 (Performance, already committed/shipped)
// separately migrated a DIFFERENT Mongo collection, `oneOnOnes` (camelCase,
// manager/report check-ins with sharedNotes/privateManagerNotes), and named its
// own Postgres table `one_on_ones` — a deviation from this project's own
// "table names keep today's collection names unchanged" rule that wasn't
// caught until this phase collided with it. Rather than retroactively rename
// Phase 5's already-live-verified table, this phase's table is named
// `communication_one_on_ones` instead, with this note as the paper trail.

exports.up = async function up(knex) {
  // ═══════════════════════════════════════════════════════════════════════════
  //  PROJECTS
  // ═══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('projects', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.text('status'); // in_progress|completed
    t.timestamp('startDate', { useTz: true });
    t.timestamp('endDate', { useTz: true });
    t.jsonb('departments'); // string array, whole-replaced
    // No FK — live orphan-check found 2/4 real projects reference an already-
    // deleted employee as teamLeaderId (real data drift, not introduced by this
    // migration; same posture as Phase 8's purchase_orders.requisitionId find).
    t.text('teamLeaderId');
    t.text('teamLeaderName');
    t.text('createdBy').notNullable().references('id').inTable('users');
    t.text('supervisorName');
    t.timestamp('completedAt', { useTz: true });
    // Legacy-only columns: only 1 real row (predating the "Fixed the projects
    // module" commit) has these set; the current createProject handler never
    // writes them. Kept nullable to preserve that row's data losslessly, not
    // because current code uses them.
    t.text('code');
    t.text('clientName');
    t.text('clientId');
    t.decimal('budget', 14, 2);
    t.text('currency');
    t.boolean('billable');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
    t.index('createdBy');
  });

  await knex.schema.createTable('project_members', (t) => {
    t.text('id').primary();
    t.text('projectId').notNullable().references('id').inTable('projects');
    t.text('employeeId').notNullable().references('id').inTable('employees');
    t.text('name'); // denormalized snapshot
    t.text('department'); // denormalized snapshot
    t.text('role'); // team_leader|member
    t.timestamp('addedAt', { useTz: true });

    t.unique(['projectId', 'employeeId']);
    t.index('employeeId');
  });

  await knex.schema.createTable('project_invites', (t) => {
    t.text('id').primary();
    t.text('projectId').notNullable().references('id').inTable('projects');
    t.text('projectName'); // denormalized snapshot
    t.text('email').notNullable();
    t.text('name').notNullable();
    t.text('projectRole');
    t.timestamp('contractEndDate', { useTz: true }).notNullable();
    t.text('invitedBy').notNullable().references('id').inTable('users');
    t.text('invitedByName');
    t.text('tokenHash').notNullable();
    t.text('status'); // pending|accepted|declined|revoked|expired
    t.timestamp('expiresAt', { useTz: true });
    t.text('createdEmployeeId').references('id').inTable('employees'); // set on accept
    t.timestamp('respondedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('projectId');
    t.index('tokenHash');
    t.index(['projectId', 'email', 'status']);
  });

  await knex.schema.createTable('project_subtasks', (t) => {
    t.text('id').primary();
    t.text('projectId').notNullable().references('id').inTable('projects');
    t.text('title').notNullable();
    t.text('description');
    t.text('department').notNullable();
    t.text('attachmentFilename');
    t.text('attachmentOriginalName');
    t.text('status'); // not_started|in_progress|completed
    t.jsonb('assignedEmployees'); // [{employeeId, name, status}], always whole-replaced
    t.jsonb('deptHeadReport'); // {text, attachmentFilename, attachmentOriginalName, submittedAt, submittedById, submittedByName} | null
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('projectId');
    t.index('department');
  });

  await knex.schema.createTable('project_notes', (t) => {
    t.text('id').primary();
    t.text('projectId').notNullable().references('id').inTable('projects');
    t.text('text').notNullable();
    t.text('createdBy').notNullable().references('id').inTable('users');
    t.text('createdByName');
    t.timestamp('createdAt', { useTz: true });

    t.index('projectId');
  });

  await knex.schema.createTable('project_chat_groups', (t) => {
    t.text('id').primary();
    t.text('projectId').notNullable().references('id').inTable('projects');
    t.text('name').notNullable();
    // Mixes two id spaces by construction (supervisor by user id, regular
    // members by employee id) — the app's own code already handles this via
    // personMatchesIds checking both; kept unconstrained for the same reason
    // kudos.giverId is.
    t.jsonb('memberIds');
    t.text('createdBy').notNullable().references('id').inTable('users');
    t.text('createdByName');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('projectId');
  });

  await knex.schema.createTable('project_messages', (t) => {
    t.text('id').primary();
    t.text('projectId').notNullable().references('id').inTable('projects');
    t.text('groupId').references('id').inTable('project_chat_groups'); // null = general project chat
    t.text('senderId').notNullable().references('id').inTable('users');
    t.text('senderName');
    t.text('senderRole');
    t.text('message');
    t.text('attachmentFilename');
    t.text('attachmentOriginalName');
    t.text('attachmentMimeType');
    t.timestamp('createdAt', { useTz: true });

    t.index(['projectId', 'groupId', 'createdAt']);
  });

  // NEW — see file header. project_time_entries had real reads (meFunctions.js)
  // but no write endpoint anywhere; built for real this phase.
  await knex.schema.createTable('project_time_entries', (t) => {
    t.text('id').primary();
    t.text('projectId').notNullable().references('id').inTable('projects');
    t.text('employeeId').notNullable().references('id').inTable('employees');
    t.decimal('hours', 6, 2).notNullable();
    t.timestamp('date', { useTz: true }).notNullable();
    t.text('task');
    t.text('description');
    t.boolean('billable').defaultTo(false);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index(['projectId', 'employeeId']);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  TASKS
  // ═══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('task_templates', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.text('triggerEvent'); // custom|new_hire|offboarding|probation_end|role_change|...
    t.jsonb('applyTo'); // {type, departments, roles, employmentTypes}
    t.boolean('isActive').defaultTo(true);
    t.boolean('isDefault').defaultTo(false);
    t.jsonb('sections'); // [{_id, name, order}], whole-replaced
    t.jsonb('tasks'); // [{_id, title, description, type, assignTo, priority, sectionId, order, dueOffset, ...}], whole-replaced
    t.integer('usageCount').defaultTo(0);
    t.text('createdBy'); // display-name string, not an id (matches real data)
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('triggerEvent');
    t.index('isActive');
  });

  await knex.schema.createTable('tasks', (t) => {
    t.text('id').primary();
    t.text('title').notNullable();
    t.text('description');
    t.text('notes');
    t.text('status'); // not_started|in_progress|completed|overdue|blocked
    t.text('priority'); // high|medium|low
    t.text('type'); // action|document|form|meeting|equipment|approval

    // No FK on assignedTo/linkedEmployeeId — role-based template assignments
    // (HR/IT/Finance/Legal) have no concrete assignee yet (see
    // triggerTasksFromTemplate's resolveAssignee), AND a live orphan-check found
    // the large majority of real tasks reference already-deleted employees
    // (9/11 assignedTo, 38/39 linkedEmployeeId — real historical data drift,
    // not introduced by this migration).
    t.text('assignedTo');
    t.text('assignedToName');
    t.text('assignedToRole'); // only set when triggered from a template — see file header pattern
    t.text('assignedBy'); // display-name string, not an id (matches real data)
    t.text('department');

    t.text('module'); // onboarding|offboarding|hr|it|performance|general|new_hire|probation_end|role_change
    t.text('linkedEmployeeId');
    t.text('linkedEmployeeName');

    t.text('dueDate'); // stored as YYYY-MM-DD string in real data, kept as text to match exactly
    t.text('startDate');
    t.timestamp('completedAt', { useTz: true });

    // Type-specific
    t.text('documentAction');
    t.text('documentStatus');
    t.integer('meetingDuration');
    t.text('meetingLocation');
    t.text('meetingLink');
    t.jsonb('meetingAttendees'); // employee id array, whole-replaced
    t.text('deviceAction');
    t.text('deviceStatus');
    t.text('approvalType');
    t.text('approverId').references('id').inTable('employees');
    t.text('approvalDecision');

    t.jsonb('blockedByTaskIds'); // task id array, whole-replaced; dependency check queries this
    t.jsonb('attachments'); // declared, never populated by any handler (see file header) — kept for forward-compat
    t.jsonb('tags');

    t.text('templateId').references('id').inTable('task_templates');
    t.text('templateTaskId'); // id of the specific task within the template's own tasks[] jsonb — no FK target
    t.text('sectionId'); // id of a section within the template's own sections[] jsonb — no FK target; set on 30/40 real tasks

    t.boolean('isTeam').defaultTo(false);
    t.text('teamId'); // groups multi-assignee tasks created together — no FK target, just a shared tag

    t.text('createdBy').references('id').inTable('users');
    t.text('createdByName');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('assignedTo');
    t.index('status');
    t.index(['status', 'dueDate']);
    t.index('module');
    t.index('linkedEmployeeId');
    t.index('teamId');
  });

  await knex.schema.createTable('task_subtasks', (t) => {
    t.text('id').primary(); // freshly generated `new ObjectId()` per subtask — safe to reuse
    t.text('taskId').notNullable().references('id').inTable('tasks');
    t.text('title').notNullable();
    t.boolean('isCompleted').defaultTo(false);
    t.timestamp('completedAt', { useTz: true });

    t.index('taskId');
  });

  await knex.schema.createTable('task_comments', (t) => {
    t.text('id').primary(); // freshly generated `new ObjectId()` per comment — safe to reuse
    t.text('taskId').notNullable().references('id').inTable('tasks');
    t.text('authorId').references('id').inTable('users');
    t.text('authorName');
    t.text('text').notNullable();
    t.jsonb('mentions'); // declared, always empty in real handler code
    t.timestamp('createdAt', { useTz: true });

    t.index('taskId');
  });

  await knex.schema.createTable('task_activity', (t) => {
    t.increments('id').primary(); // no id on the Mongo subdocument — fresh auto-increment
    t.text('taskId').notNullable().references('id').inTable('tasks');
    t.text('action').notNullable(); // created|status_changed|due_date_changed|reassigned|completed
    t.text('fromValue'); // "from"/"to" are reserved-ish and awkward as bare column names across drivers
    t.text('toValue');
    t.text('performedByName');
    t.timestamp('timestamp', { useTz: true });

    t.index('taskId');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  COMMUNICATION / SOCIAL FEED
  // ═══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('communities', (t) => {
    t.text('id').primary();
    t.text('companyId'); // always null in real data — vestigial multi-tenant field, preserved as-is
    t.text('name').notNullable();
    t.text('description');
    t.text('icon');
    t.text('type'); // interest|department|...
    t.jsonb('adminIds'); // user-id array, set once at creation, never mutated after
    t.boolean('isArchived').defaultTo(false);
    t.text('createdBy').references('id').inTable('users');
    t.timestamp('createdAt', { useTz: true });

    t.index('isArchived');
  });

  // See file header — personId mixes user ids (creator) and employee ids
  // (auto-add-all-employees branch) by construction; unconstrained on purpose.
  await knex.schema.createTable('community_members', (t) => {
    t.increments('id').primary();
    t.text('communityId').notNullable().references('id').inTable('communities');
    t.text('personId').notNullable();
    t.timestamp('addedAt', { useTz: true });

    t.unique(['communityId', 'personId']);
  });

  await knex.schema.createTable('community_posts', (t) => {
    t.text('id').primary();
    t.text('companyId'); // always null in real data, preserved as-is
    t.text('communityId').references('id').inTable('communities'); // null = company-wide feed
    t.text('authorId').notNullable().references('id').inTable('users');
    t.text('authorName'); // fast-path cache; enrichPost falls back to a live lookup when absent
    t.text('type'); // update|celebration|announcement|...
    t.text('content');
    t.jsonb('imageUrls');
    t.boolean('isPinned').defaultTo(false);
    t.timestamp('pinExpiresAt', { useTz: true });
    // Celebration ("clap") specific — null for ordinary posts
    t.text('celebrationType');
    t.text('celebrationEmployeeId').references('id').inTable('employees');
    t.text('celebrationEmployeeName');
    t.text('visibility'); // public|... (only set on celebration posts today)
    t.integer('commentCount').defaultTo(0);
    t.integer('viewCount').defaultTo(0);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index(['companyId', 'communityId', 'createdAt']);
    t.index('authorId');
  });

  await knex.schema.createTable('community_post_reactions', (t) => {
    t.increments('id').primary(); // no id on the Mongo subdocument
    t.text('postId').notNullable().references('id').inTable('community_posts');
    t.text('userId').notNullable().references('id').inTable('users'); // field is literally named "employeeId" in Mongo but always holds req.user._id — see file header
    t.text('type').notNullable();
    t.timestamp('reactedAt', { useTz: true });

    t.unique(['postId', 'userId', 'type']);
  });

  await knex.schema.createTable('post_comments', (t) => {
    t.text('id').primary();
    // No FK on postId — the one real comment references an already-deleted
    // community_posts row (real data drift, not introduced by this migration).
    t.text('postId').notNullable();
    // No FK — fixed forward to resolve via users (see file header, was looked up
    // against employees at read time, always null); the one real legacy row
    // predates that and doesn't match any current user, so left unconstrained
    // rather than dropping it.
    t.text('authorId').notNullable();
    t.text('content').notNullable();
    t.text('parentCommentId').references('id').inTable('post_comments'); // self-FK, null = top-level
    t.jsonb('reactions'); // declared, never populated (see file header)
    t.timestamp('createdAt', { useTz: true });

    t.index(['postId', 'parentCommentId']);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  1:1 MEETINGS
  // ═══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('communication_one_on_ones', (t) => {
    t.text('id').primary();
    t.text('companyId'); // always null in real data, preserved as-is
    // No FK — the real createMeetingSeries handler had a genuine bug (participant1Id
    // written as a USER id via req.user._id, participant2Id as an EMPLOYEE id via
    // withEmployeeId; listMeetingSeries then queried both columns against a user
    // id, so the invited participant could never find their own series). Fixed
    // forward this phase to consistently resolve both to employee ids — see the
    // rewritten communicationFunctions.js — but the one real legacy row (whose
    // ids predate the fix) doesn't cleanly satisfy either interpretation, so both
    // columns are left unconstrained rather than dropping that row.
    t.text('participant1Id').notNullable();
    t.text('participant2Id').notNullable();
    t.text('frequency'); // weekly|biweekly|monthly
    t.text('dayOfWeek');
    t.text('time');
    t.integer('duration');
    t.text('videoLink');
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });

    t.index('participant1Id');
    t.index('participant2Id');
  });

  await knex.schema.createTable('meeting_notes', (t) => {
    t.text('id').primary();
    t.text('seriesId').notNullable().references('id').inTable('communication_one_on_ones');
    t.text('companyId'); // always null in real data, preserved as-is
    t.timestamp('date', { useTz: true });
    t.jsonb('agendaItems'); // whole-replaced
    t.text('notes');
    t.jsonb('actionItems'); // whole-replaced
    t.text('aiSummary');
    t.text('status'); // scheduled|completed
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('seriesId');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRUST CHANNEL (anonymous)
  // ═══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('trust_reports', (t) => {
    t.text('id').primary();
    t.text('trackingCode').notNullable();
    t.text('category').notNullable();
    t.text('description').notNullable();
    t.text('attachmentUrl');
    t.text('status'); // new|reviewing|resolved|...
    t.text('adminNotes');
    t.text('responseToReporter');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.unique('trackingCode');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  DIRECT MESSAGES
  // ═══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('conversations', (t) => {
    t.text('id').primary();
    t.boolean('isGroup').defaultTo(false);
    t.text('groupName');
    t.text('lastMessage');
    t.timestamp('lastMessageAt', { useTz: true });
    t.text('createdBy').references('id').inTable('users'); // only set for groups
    t.timestamp('createdAt', { useTz: true });

    t.index('lastMessageAt');
  });

  // Folds conversations.participants + .admins (two parallel Mongo arrays,
  // both genuinely $addToSet/$pull'd) into one row's isAdmin flag.
  await knex.schema.createTable('conversation_participants', (t) => {
    t.increments('id').primary();
    t.text('conversationId').notNullable().references('id').inTable('conversations');
    t.text('userId').notNullable().references('id').inTable('users');
    t.boolean('isAdmin').defaultTo(false);
    t.timestamp('joinedAt', { useTz: true });

    t.unique(['conversationId', 'userId']);
    t.index('userId');
  });

  await knex.schema.createTable('messages', (t) => {
    t.text('id').primary();
    t.text('conversationId').notNullable().references('id').inTable('conversations');
    t.text('senderId').references('id').inTable('users'); // null = system message
    t.text('senderName');
    t.text('content');
    t.jsonb('attachments'); // [{filename, originalName, mimetype, size}], whole-replaced
    t.boolean('isSystem').defaultTo(false);
    t.timestamp('createdAt', { useTz: true });

    t.index(['conversationId', 'createdAt']);
  });

  await knex.schema.createTable('message_reads', (t) => {
    t.increments('id').primary(); // no id on the Mongo array element
    t.text('messageId').notNullable().references('id').inTable('messages');
    t.text('userId').notNullable().references('id').inTable('users');
    t.timestamp('readAt', { useTz: true });

    t.unique(['messageId', 'userId']);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  AWARDS / RECOGNITION
  // ═══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('award_types', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.text('category');
    t.text('repeatInterval'); // none|monthly|quarterly|annual
    t.timestamp('nextDueDate', { useTz: true });
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('name');
  });

  await knex.schema.createTable('employee_awards', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees');
    t.text('employeeName'); // denormalized snapshot — deliberate, see file header
    t.text('staffNumber'); // denormalized snapshot
    t.text('department'); // denormalized snapshot
    t.text('awardTypeId').references('id').inTable('award_types');
    t.text('awardTypeName'); // denormalized snapshot
    t.text('notes');
    t.integer('year');
    t.text('awardedBy'); // free-text display name, not an id (matches real data)
    t.timestamp('awardedAt', { useTz: true });

    t.index('employeeId');
    t.index('year');
  });

  await knex.schema.createTable('company_values', (t) => {
    t.text('id').primary();
    t.text('companyId'); // always null in real data, preserved as-is
    t.text('name').notNullable();
    t.text('description');
    t.text('emoji');
    t.text('color');
    // Assigned via countDocuments() at creation (not an atomic sequence) and
    // rewritten in bulk by reorderValues — faithfully preserved as a plain
    // integer column, not upgraded to a real Postgres sequence (matches this
    // project's "faithful port, don't launder pre-existing quirks" posture).
    t.integer('order');
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('isActive');
  });

  await knex.schema.createTable('kudos', (t) => {
    t.text('id').primary();
    t.text('companyId'); // always null in real data, preserved as-is
    // See file header — polymorphic (employee id OR user id depending on
    // whether the giver has a linked employee record), unconstrained.
    t.text('giverId').notNullable();
    t.text('giverName');
    t.jsonb('recipientIds'); // employee-id array, set once at creation, never mutated after
    t.text('valueId').references('id').inTable('company_values');
    t.text('valueName'); // denormalized snapshot
    t.text('valueColor'); // denormalized snapshot
    t.text('message').notNullable();
    t.text('gifUrl');
    t.text('visibility'); // public|private
    t.integer('pointsAwarded').defaultTo(0);
    t.timestamp('createdAt', { useTz: true });

    t.index('giverId');
    t.index('createdAt');
  });

  await knex.schema.createTable('kudos_reactions', (t) => {
    t.increments('id').primary(); // no id on the Mongo subdocument
    t.text('kudosId').notNullable().references('id').inTable('kudos');
    t.text('personId').notNullable(); // polymorphic, see file header
    t.text('type').notNullable();
    t.timestamp('reactedAt', { useTz: true });

    t.unique(['kudosId', 'personId', 'type']);
  });

  await knex.schema.createTable('kudos_comments', (t) => {
    t.text('id').primary(); // freshly generated `new ObjectId()` per comment — safe to reuse
    t.text('kudosId').notNullable().references('id').inTable('kudos');
    t.text('authorId').notNullable(); // polymorphic, see file header
    t.text('authorName');
    t.text('content').notNullable();
    t.timestamp('createdAt', { useTz: true });

    t.index('kudosId');
  });

  await knex.schema.createTable('award_programs', (t) => {
    t.text('id').primary();
    t.text('companyId'); // always null in real data, preserved as-is
    t.text('name').notNullable();
    t.text('description');
    t.text('icon');
    t.text('frequency'); // monthly|quarterly|annual
    t.text('status'); // active|paused|ended
    t.text('nominationBy'); // anyone|manager|...
    t.text('selectionMethod'); // vote|committee|...
    t.text('prizeType');
    t.text('prizeDescription');
    t.text('announcementMethod');
    t.timestamp('currentCycleStart', { useTz: true });
    t.timestamp('currentCycleEnd', { useTz: true });
    t.text('createdBy').references('id').inTable('users');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
  });

  await knex.schema.createTable('award_nominations', (t) => {
    t.text('id').primary();
    t.text('companyId'); // always null in real data, preserved as-is
    t.text('programId').notNullable().references('id').inTable('award_programs');
    t.text('nomineeId').notNullable().references('id').inTable('employees');
    t.text('nominatorId').notNullable().references('id').inTable('users');
    t.text('reason');
    t.text('valueId').references('id').inTable('company_values');
    t.timestamp('cycleStart', { useTz: true });
    t.boolean('isWinner').defaultTo(false);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('announcedAt', { useTz: true });

    t.index(['programId', 'cycleStart']);
    t.index('nomineeId');
  });

  // Singleton-per-company config doc (one-row-table pattern established since
  // Phase 0/1's company_settings/tax_config).
  await knex.schema.createTable('recognition_settings', (t) => {
    t.text('id').primary();
    t.text('companyId'); // always null in real data, preserved as-is
    t.boolean('pointsEnabled').defaultTo(false);
    t.integer('pointsPerKudos');
    t.decimal('monthlyBudget', 12, 2);
    t.boolean('allowSelfRecognition').defaultTo(false);
    t.integer('minMessageLength');
    t.integer('maxKudosPerDay');
    t.boolean('notifyOnKudos').defaultTo(true);
    t.boolean('postToFeed').defaultTo(true);
    t.timestamp('updatedAt', { useTz: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  IT (Devices, Software, Requests)
  // ═══════════════════════════════════════════════════════════════════════════

  await knex.schema.createTable('devices', (t) => {
    t.text('id').primary();
    t.text('name');
    t.text('type');
    t.text('brand');
    t.text('model');
    t.text('serialNumber');
    t.text('assetTag');
    t.timestamp('purchaseDate', { useTz: true });
    t.decimal('purchasePrice', 12, 2);
    t.text('currency');
    t.text('vendor');
    t.timestamp('warrantyExpiry', { useTz: true });
    t.text('condition'); // good|fair|poor|...
    t.text('status'); // unassigned|assigned|in_repair|retired
    // No FK — the one real device references an already-deleted employee (real
    // data drift, not introduced by this migration).
    t.text('assignedTo');
    t.timestamp('assignedAt', { useTz: true });
    t.text('notes');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('assignedTo');
    t.index('warrantyExpiry');
    t.index('status');
  });

  await knex.schema.createTable('device_assignment_history', (t) => {
    t.increments('id').primary(); // no id on the Mongo subdocument
    t.text('deviceId').notNullable().references('id').inTable('devices');
    // No FK — all 4 real history entries (the one real device's full history)
    // reference already-deleted employees (real data drift, same devices.
    // assignedTo orphan above).
    t.text('employeeId').notNullable();
    t.timestamp('assignedAt', { useTz: true });
    t.timestamp('returnedAt', { useTz: true }); // null = currently open assignment
    t.text('condition');

    t.index('deviceId');
  });

  await knex.schema.createTable('software_apps', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('category');
    t.text('vendor');
    t.text('licenseType');
    t.integer('totalLicenses');
    // Maintained via $inc/$dec paired with software_assignments inserts/deletes
    // in the original Mongo code — kept as a denormalized counter column here
    // too (not a COUNT(*) over the join) to preserve identical behavior,
    // including its capacity for the same drift the original had.
    t.integer('assignedLicenses').defaultTo(0);
    t.decimal('costPerLicense', 10, 2);
    t.text('currency');
    t.text('billingCycle');
    t.timestamp('renewalDate', { useTz: true });
    t.text('adminId'); // no FK target confirmed in real handler code — kept unconstrained
    t.text('loginUrl');
    t.text('status'); // active|inactive
    t.text('notes');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
  });

  await knex.schema.createTable('software_assignments', (t) => {
    t.text('softwareId').notNullable().references('id').inTable('software_apps');
    t.text('employeeId').notNullable().references('id').inTable('employees');
    t.timestamp('assignedAt', { useTz: true });

    t.primary(['softwareId', 'employeeId']);
  });

  await knex.schema.createTable('it_requests', (t) => {
    t.text('id').primary();
    t.text('requesterId').notNullable().references('id').inTable('users');
    t.text('employeeId').references('id').inTable('employees');
    t.text('type'); // hardware|software|repair|access|other
    t.text('subject').notNullable();
    t.text('description').notNullable();
    t.text('priority').notNullable();
    t.text('status'); // open|in_progress|resolved
    t.text('assignedTo').references('id').inTable('employees');
    t.text('resolution');
    t.timestamp('resolvedAt', { useTz: true });
    // Repair-specific
    t.text('deviceId').references('id').inTable('devices');
    t.text('deviceName'); // denormalized snapshot
    t.text('repairNotes');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
    t.index('assignedTo');
    t.index('requesterId');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('it_requests');
  await knex.schema.dropTableIfExists('software_assignments');
  await knex.schema.dropTableIfExists('software_apps');
  await knex.schema.dropTableIfExists('device_assignment_history');
  await knex.schema.dropTableIfExists('devices');
  await knex.schema.dropTableIfExists('recognition_settings');
  await knex.schema.dropTableIfExists('award_nominations');
  await knex.schema.dropTableIfExists('award_programs');
  await knex.schema.dropTableIfExists('kudos_comments');
  await knex.schema.dropTableIfExists('kudos_reactions');
  await knex.schema.dropTableIfExists('kudos');
  await knex.schema.dropTableIfExists('company_values');
  await knex.schema.dropTableIfExists('employee_awards');
  await knex.schema.dropTableIfExists('award_types');
  await knex.schema.dropTableIfExists('message_reads');
  await knex.schema.dropTableIfExists('messages');
  await knex.schema.dropTableIfExists('conversation_participants');
  await knex.schema.dropTableIfExists('conversations');
  await knex.schema.dropTableIfExists('trust_reports');
  await knex.schema.dropTableIfExists('meeting_notes');
  await knex.schema.dropTableIfExists('communication_one_on_ones');
  await knex.schema.dropTableIfExists('post_comments');
  await knex.schema.dropTableIfExists('community_post_reactions');
  await knex.schema.dropTableIfExists('community_posts');
  await knex.schema.dropTableIfExists('community_members');
  await knex.schema.dropTableIfExists('communities');
  await knex.schema.dropTableIfExists('task_activity');
  await knex.schema.dropTableIfExists('task_comments');
  await knex.schema.dropTableIfExists('task_subtasks');
  await knex.schema.dropTableIfExists('tasks');
  await knex.schema.dropTableIfExists('task_templates');
  await knex.schema.dropTableIfExists('project_time_entries');
  await knex.schema.dropTableIfExists('project_messages');
  await knex.schema.dropTableIfExists('project_chat_groups');
  await knex.schema.dropTableIfExists('project_notes');
  await knex.schema.dropTableIfExists('project_subtasks');
  await knex.schema.dropTableIfExists('project_invites');
  await knex.schema.dropTableIfExists('project_members');
  await knex.schema.dropTableIfExists('projects');
};
