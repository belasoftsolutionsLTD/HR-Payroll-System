// Postgres migration (Phase 9) — tasks/task_templates (+ child tables
// task_subtasks/task_comments/task_activity) are Postgres now. employees/users
// have been Postgres since Phase 1.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { notifyEmployee } = require('../../functions/HR/notifyUser');
const { triggerTasksFromTemplate } = require('../../lib/tasks/triggerTasksFromTemplate');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

const emailTaskAssigned = async (employeeId, employeeName, title, dueDate, priority) => {
  const empUser = await knex('users').where({ employeeId }).select('email').first();
  if (!empUser?.email) return;
  const tokens = { employeeName, taskTitle: title, dueInfo: dueDate ? `Due ${dueDate} · ` : '', priority: priority || 'medium' };
  return sendTemplatedEmail({
    trigger: 'taskAssigned', to: empUser.email, tokens,
    fallbackSubject: `New task: ${title}`,
    fallbackHtml: `<p>Dear ${employeeName},</p><p>You've been assigned a new task: "${title}". ${tokens.dueInfo}${tokens.priority} priority.</p>`,
  }).catch(() => {});
};

const HR   = ['super_admin', 'hr_manager'];
const MGMT = ['super_admin', 'hr_manager', 'department_head'];

const VALID_STATUSES  = ['not_started', 'in_progress', 'completed', 'overdue', 'blocked'];
const VALID_TYPES     = ['action', 'document', 'form', 'meeting', 'equipment', 'approval'];
const VALID_MODULES   = ['onboarding', 'offboarding', 'hr', 'it', 'performance', 'general', 'new_hire', 'probation_end', 'role_change'];
const VALID_PRIORITIES = ['high', 'medium', 'low'];

const getPagination = (q) => {
  const page  = Math.max(1, parseInt(q.page) || 1);
  const limit = Math.min(100, parseInt(q.limit) || 50);
  return { page, limit, skip: (page - 1) * limit };
};

// dueDate is stored as a plain 'YYYY-MM-DD' text column (matches real data —
// never a timestamp), so every comparison here is a string comparison.
function applyTaskFilter(query, q, extra = {}) {
  let r = query;
  if (extra.assignedTo) r = r.where({ assignedTo: extra.assignedTo });
  if (extra.isTeam !== undefined) r = r.where({ isTeam: extra.isTeam });
  if (extra.department) r = r.where({ department: extra.department });
  if (q.status)   r = r.where({ status: q.status });
  if (q.priority) r = r.where({ priority: q.priority });
  if (q.type)     r = r.where({ type: q.type });
  if (q.module)   r = r.where({ module: q.module });
  if (q.search)   r = r.whereILike('title', `%${q.search}%`);
  if (q.department) r = r.where({ department: q.department });
  if (q.linkedEmployeeId) r = r.where({ linkedEmployeeId: q.linkedEmployeeId });

  const today = new Date().toISOString().split('T')[0];
  const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().split('T')[0];

  if (q.dateFilter === 'today')     r = r.where({ dueDate: today });
  if (q.dateFilter === 'overdue')   r = r.whereNot({ status: 'completed' }).where('dueDate', '<', today);
  if (q.dateFilter === 'this_week') r = r.where('dueDate', '>=', today).where('dueDate', '<=', weekEndStr);
  if (q.dateFilter === 'no_date')   r = r.whereNull('dueDate');

  return r;
}

// ── Stats card counts ─────────────────────────────────────────────────────────
const getTaskStats = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
  const weekStartStr = weekStart.toISOString().split('T')[0];

  const myEmployeeId = req.user?.employeeId ? String(req.user.employeeId) : null;
  const base = () => {
    let q = knex('tasks');
    if (!HR.includes(req.user?.role)) q = q.where({ assignedTo: myEmployeeId });
    return q;
  };

  const [[{ count: total }], [{ count: dueToday }], [{ count: overdue }], [{ count: completedThisWeek }]] = await Promise.all([
    base().whereNot({ status: 'completed' }).count('* as count'),
    base().where({ dueDate: today }).whereNotIn('status', ['completed', 'blocked']).count('* as count'),
    base().where({ status: 'overdue' }).count('* as count'),
    base().where({ status: 'completed' }).where('completedAt', '>=', weekStartStr).count('* as count'),
  ]);

  return returnFunction(res, 200, true, 'OK', {
    total: Number(total), dueToday: Number(dueToday), overdue: Number(overdue), completedThisWeek: Number(completedThisWeek),
  });
};

// ── My Tasks (personal) ───────────────────────────────────────────────────────
const getMyTasks = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'OK', []);
  const myId = String(req.user.employeeId);
  const query = applyTaskFilter(knex('tasks'), req.query, { assignedTo: myId });
  const tasks = await query.orderBy('dueDate', 'asc').orderBy('priority', 'asc');
  return returnFunction(res, 200, true, 'OK', tasks);
};

// ── Team Tasks — tasks assigned to 2+ people at once ──────────────────────────
const listTeamTasks = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const extra = { isTeam: true };

  // Dept heads only see team tasks within their department
  if (!HR.includes(req.user?.role)) {
    const empId = req.user.employeeId ? String(req.user.employeeId) : null;
    if (!empId) return returnFunction(res, 200, true, 'OK', { data: [], total: 0 });
    const me = await knex('employees').where({ id: empId }).select('department').first();
    if (!me?.department) return returnFunction(res, 200, true, 'OK', { data: [], total: 0 });
    extra.department = me.department;
  }

  const [{ count }] = await applyTaskFilter(knex('tasks'), req.query, extra).count('* as count');
  const data = await applyTaskFilter(knex('tasks'), req.query, extra).orderBy('dueDate', 'asc').limit(limit).offset(skip);

  return returnFunction(res, 200, true, 'OK', { data, total: Number(count), page, limit });
};

// ── All Tasks (HR admin) ──────────────────────────────────────────────────────
const listAllTasks = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const [{ count }] = await applyTaskFilter(knex('tasks'), req.query).count('* as count');
  const data = await applyTaskFilter(knex('tasks'), req.query).orderBy('dueDate', 'asc').orderBy('createdAt', 'desc').limit(limit).offset(skip);
  return returnFunction(res, 200, true, 'OK', { data, total: Number(count), page, limit });
};

// ── Task detail ───────────────────────────────────────────────────────────────
const _isTaskHR = (role) => ['super_admin', 'hr_manager'].includes(role);

const getTaskDetail = async (req, res) => {
  const task = await knex('tasks').where({ id: req.params.id }).first();
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(task.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  const [subtasks, comments, activity] = await Promise.all([
    knex('task_subtasks').where({ taskId: task.id }),
    knex('task_comments').where({ taskId: task.id }).orderBy('createdAt', 'asc'),
    knex('task_activity').where({ taskId: task.id }).orderBy('timestamp', 'asc'),
  ]);

  // Fetch linked employee mini-card if present
  let linkedEmployee = null;
  if (task.linkedEmployeeId) {
    linkedEmployee = await knex('employees').where({ id: task.linkedEmployeeId }).select('fullName', 'designation', 'department').first();
  }

  return returnFunction(res, 200, true, 'OK', {
    ...task, linkedEmployee, subtasks, comments,
    activity: activity.map((a) => ({ action: a.action, from: a.fromValue, to: a.toValue, performedByName: a.performedByName, timestamp: a.timestamp })),
  });
};

// ── Create task ───────────────────────────────────────────────────────────────
const createTask = async (req, res) => {
  const {
    title, description, status, priority, type, dueDate, startDate,
    assignedTo, bulkDepartment, module: mod, linkedEmployeeId,
    subtasks, blockedByTaskIds, tags, notes,
    documentAction, meetingDuration, meetingLocation, meetingLink, meetingAttendees,
    deviceAction, approvalType, approverId, approvalDecision,
  } = req.body;

  if (!title) return returnFunction(res, 400, false, 'Title is required.');

  const baseDoc = (emp) => ({
    id: newId(),
    title:           title.trim(),
    description:     description || '',
    notes:           notes || '',
    status:          VALID_STATUSES.includes(status) ? status : 'not_started',
    priority:        VALID_PRIORITIES.includes(priority) ? priority : 'medium',
    type:            VALID_TYPES.includes(type) ? type : 'action',

    assignedTo:      emp.id,
    assignedToName:  emp.fullName,
    assignedBy:      req.user?.name || 'HR',
    department:      emp.department || '',

    module:          VALID_MODULES.includes(mod) ? mod : 'general',
    linkedEmployeeId: linkedEmployeeId || null,
    linkedEmployeeName: null,

    dueDate:    dueDate  || null,
    startDate:  startDate || null,
    completedAt: null,

    // Type-specific
    documentAction: documentAction || null,
    documentStatus: documentAction ? 'pending' : null,
    meetingDuration: meetingDuration || null,
    meetingLocation: meetingLocation || '',
    meetingLink:     meetingLink || '',
    meetingAttendees: JSON.stringify((meetingAttendees || []).filter(Boolean)),
    deviceAction:    deviceAction || null,
    deviceStatus:    deviceAction ? 'pending' : null,
    approvalType:    approvalType || '',
    approverId:      approverId || null,
    approvalDecision: approvalDecision || 'pending',

    blockedByTaskIds: JSON.stringify((Array.isArray(blockedByTaskIds) ? blockedByTaskIds : []).filter(Boolean)),
    attachments: JSON.stringify([]),
    tags: JSON.stringify(Array.isArray(tags) ? tags : []),
    templateId: null,
    templateTaskId: null,

    createdBy: req.user?.id ?? null,
    createdByName: req.user?.name || 'HR',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Bulk department assign
  if (bulkDepartment) {
    const employees = await knex('employees').where({ department: bulkDepartment, status: 'active' }).select('id', 'fullName', 'department');
    if (!employees.length) return returnFunction(res, 404, false, 'No active employees in that department.');
    const docs = employees.map((e) => baseDoc(e));
    await knex('tasks').insert(docs);
    for (const d of docs) {
      await knex('task_activity').insert({ taskId: d.id, action: 'created', fromValue: null, toValue: null, performedByName: d.createdByName, timestamp: d.createdAt });
    }
    return returnFunction(res, 201, true, `Assigned to ${employees.length} employees.`);
  }

  // Multi-assignee (≥2): one task per employee, all stamped as a team task
  const assignedToIds = req.body.assignedToIds;
  if (Array.isArray(assignedToIds) && assignedToIds.length >= 2) {
    const safeIds = assignedToIds.filter(Boolean).map(String);
    const employees = await knex('employees').whereIn('id', safeIds).select('id', 'fullName', 'department');
    if (!employees.length) return returnFunction(res, 404, false, 'Employees not found.');
    const teamId = newId();
    const docs = employees.map((emp) => ({ ...baseDoc(emp), isTeam: true, teamId }));
    await knex('tasks').insert(docs);
    for (const d of docs) {
      await knex('task_activity').insert({ taskId: d.id, action: 'created', fromValue: null, toValue: null, performedByName: d.createdByName, timestamp: d.createdAt });
    }
    employees.forEach((emp) => notifyEmployee(emp.id, {
      title: `New team task: ${title}`,
      body:  `${dueDate ? `Due ${dueDate} · ` : ''}${priority || 'medium'} priority`,
      type:  'task',
    }));
    employees.forEach((emp) => emailTaskAssigned(emp.id, emp.fullName, title, dueDate, priority));
    return returnFunction(res, 201, true, `Assigned to ${employees.length} employees.`);
  }

  if (!assignedTo) return returnFunction(res, 400, false, 'assignedTo or bulkDepartment is required.');
  const employee = await knex('employees').where({ id: assignedTo }).select('id', 'fullName', 'department').first();
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  const doc = baseDoc(employee);

  // Resolve linked employee name
  if (doc.linkedEmployeeId) {
    const linked = await knex('employees').where({ id: doc.linkedEmployeeId }).select('fullName').first();
    if (linked) doc.linkedEmployeeName = linked.fullName;
  }

  const [saved] = await knex('tasks').insert(doc).returning('*');
  await knex('task_activity').insert({ taskId: saved.id, action: 'created', fromValue: null, toValue: null, performedByName: doc.createdByName, timestamp: doc.createdAt });

  notifyEmployee(employee.id, {
    title: `New task: ${title}`,
    body:  `${dueDate ? `Due ${dueDate} · ` : ''}${priority || 'medium'} priority`,
    type:  'task',
  });
  emailTaskAssigned(employee.id, employee.fullName, title, dueDate, priority);

  return returnFunction(res, 201, true, 'Task created.', { id: saved.id });
};

// ── Update task ───────────────────────────────────────────────────────────────
const JSONB_TASK_FIELDS = ['meetingAttendees', 'blockedByTaskIds', 'attachments', 'tags'];

const updateTask = async (req, res) => {
  const task = await knex('tasks').where({ id: req.params.id }).first();
  if (!task) return returnFunction(res, 404, false, 'Task not found.');

  const update = { updatedAt: new Date() };
  for (const [key, val] of Object.entries(req.body)) {
    if (key === 'id' || key === '_id') continue;
    update[key] = JSONB_TASK_FIELDS.includes(key) ? JSON.stringify(val) : val;
  }
  if (update.status === 'completed' && !task.completedAt) update.completedAt = new Date();

  // Build activity entries
  const activityEntries = [];
  if (update.status && update.status !== task.status) {
    activityEntries.push({ taskId: task.id, action: 'status_changed', fromValue: task.status, toValue: update.status, performedByName: req.user?.name, timestamp: new Date() });
  }
  if (update.dueDate && update.dueDate !== task.dueDate) {
    activityEntries.push({ taskId: task.id, action: 'due_date_changed', fromValue: task.dueDate, toValue: update.dueDate, performedByName: req.user?.name, timestamp: new Date() });
  }
  if (update.assignedTo && String(update.assignedTo) !== String(task.assignedTo)) {
    activityEntries.push({ taskId: task.id, action: 'reassigned', fromValue: task.assignedToName, toValue: update.assignedToName || '', performedByName: req.user?.name, timestamp: new Date() });
  }

  await knex('tasks').where({ id: task.id }).update(update);
  if (activityEntries.length) await knex('task_activity').insert(activityEntries);
  return returnFunction(res, 200, true, 'Updated.');
};

// ── Delete task ───────────────────────────────────────────────────────────────
const deleteTask = async (req, res) => {
  await knex('task_subtasks').where({ taskId: req.params.id }).delete();
  await knex('task_comments').where({ taskId: req.params.id }).delete();
  await knex('task_activity').where({ taskId: req.params.id }).delete();
  await knex('tasks').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, 'Deleted.');
};

// ── Mark task complete ────────────────────────────────────────────────────────
const completeTask = async (req, res) => {
  const task = await knex('tasks').where({ id: req.params.id }).first();
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(task.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  // Dependency check
  const blockedByIds = task.blockedByTaskIds || [];
  if (blockedByIds.length) {
    const [{ count: blockers }] = await knex('tasks').whereIn('id', blockedByIds).whereNot({ status: 'completed' }).count('* as count');
    if (Number(blockers) > 0) return returnFunction(res, 400, false, 'Complete prerequisite tasks first.');
  }

  const now = new Date();
  await knex('tasks').where({ id: task.id }).update({ status: 'completed', completedAt: now, updatedAt: now });
  await knex('task_activity').insert({ taskId: task.id, action: 'completed', fromValue: task.status, toValue: 'completed', performedByName: req.user?.name, timestamp: now });

  // Auto-unblock tasks that were blocked by this one — blockedByTaskIds is JSONB,
  // so a Postgres-native "contains this id" check via the @> operator.
  await knex('tasks').where({ status: 'blocked' }).whereRaw('"blockedByTaskIds" @> ?', [JSON.stringify([task.id])])
    .update({ status: 'not_started', updatedAt: now });

  // Approval-type tasks have a dedicated approverId field that nothing in the codebase
  // ever notified — the assignee could mark it complete and the approver would never
  // know a decision was waiting on them. (Note: there's no createdBy id on a task, only
  // an assignedBy display-name string, so the assignee's own manager/creator can't be
  // notified the same way — approverId is the one reliable id this schema has.)
  if (task.type === 'approval' && task.approverId) {
    notifyEmployee(task.approverId, {
      title: 'Task completed — awaiting your approval',
      body: `"${task.title}" was marked complete by ${req.user?.name || 'the assignee'} and needs your sign-off.`,
      type: 'general',
    }).catch(() => {});

    const approverUser = await knex('users').where({ employeeId: task.approverId }).select('email').first();
    if (approverUser?.email) {
      const tokens = { taskTitle: task.title, assigneeName: req.user?.name || 'the assignee' };
      sendTemplatedEmail({
        trigger: 'taskApprovalNeeded', to: approverUser.email, tokens,
        fallbackSubject: `Task awaiting your approval — ${task.title}`,
        fallbackHtml: `<p>"${tokens.taskTitle}" was marked complete by ${tokens.assigneeName} and needs your sign-off.</p>`,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, 'Task completed.');
};

// ── Reopen task ───────────────────────────────────────────────────────────────
const reopenTask = async (req, res) => {
  const task = await knex('tasks').where({ id: req.params.id }).first();
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(task.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }
  const now = new Date();
  await knex('tasks').where({ id: task.id }).update({ status: 'not_started', completedAt: null, updatedAt: now });
  await knex('task_activity').insert({ taskId: task.id, action: 'status_changed', fromValue: 'completed', toValue: 'not_started', performedByName: req.user?.name, timestamp: now });
  return returnFunction(res, 200, true, 'Task reopened.');
};

// ── Quick status patch — used by staff portal (moved from tasks.js's own
// inline handler, which bypassed this file's shared VALID_STATUSES/auth pattern) ─
const updateTaskStatus = async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) return returnFunction(res, 400, false, 'Invalid status.');
  const task = await knex('tasks').where({ id: req.params.id }).first();
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  const isHR = _isTaskHR(req.user?.role);
  if (!isHR && String(task.assignedTo) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Forbidden.');
  const patch = { status, updatedAt: new Date() };
  if (status === 'completed') patch.completedAt = new Date();
  await knex('tasks').where({ id: task.id }).update(patch);
  return returnFunction(res, 200, true, 'Status updated.');
};

// ── Add comment ───────────────────────────────────────────────────────────────
const addComment = async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return returnFunction(res, 400, false, 'Comment text is required.');
  const task = await knex('tasks').where({ id: req.params.id }).first();
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(task.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  const comment = {
    id: newId(),
    taskId: task.id,
    authorId: req.user?.id ?? null,
    authorName: req.user?.name || 'Unknown',
    text: text.trim(),
    mentions: JSON.stringify([]),
    createdAt: new Date(),
  };

  const [saved] = await knex('task_comments').insert(comment).returning('*');
  await knex('tasks').where({ id: task.id }).update({ updatedAt: new Date() });

  return returnFunction(res, 201, true, 'Comment added.', saved);
};

// ── Add subtask ───────────────────────────────────────────────────────────────
const addSubtask = async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return returnFunction(res, 400, false, 'Subtask title required.');
  const taskCheck = await knex('tasks').where({ id: req.params.id }).first();
  if (!taskCheck) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(taskCheck.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  const subtask = { id: newId(), taskId: taskCheck.id, title: title.trim(), isCompleted: false, completedAt: null };
  const [saved] = await knex('task_subtasks').insert(subtask).returning('*');
  await knex('tasks').where({ id: taskCheck.id }).update({ updatedAt: new Date() });
  return returnFunction(res, 201, true, 'Subtask added.', saved);
};

// ── Toggle subtask ────────────────────────────────────────────────────────────
const toggleSubtask = async (req, res) => {
  const task = await knex('tasks').where({ id: req.params.id }).first();
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(task.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  const subtask = await knex('task_subtasks').where({ id: req.params.subId, taskId: task.id }).first();
  if (!subtask) return returnFunction(res, 404, false, 'Subtask not found.');

  const completed = !subtask.isCompleted;
  await knex('task_subtasks').where({ id: subtask.id }).update({ isCompleted: completed, completedAt: completed ? new Date() : null });
  await knex('tasks').where({ id: task.id }).update({ updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Subtask updated.', { isCompleted: completed });
};

// ── Export CSV ────────────────────────────────────────────────────────────────
const exportTasksCSV = async (req, res) => {
  const tasks = await applyTaskFilter(knex('tasks'), req.query).orderBy('dueDate', 'asc');

  const header = 'Task,Type,Assignee,Module,Priority,Status,Due Date,Completed At,Created By\n';
  const rows = tasks.map((t) => [
    `"${(t.title || '').replace(/"/g, '""')}"`,
    t.type, t.assignedToName, t.module, t.priority, t.status,
    t.dueDate || '', t.completedAt ? String(t.completedAt).split('T')[0] : '',
    t.createdByName || '',
  ].join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="tasks-export.csv"');
  return res.send(header + rows);
};

// ── Analytics ─────────────────────────────────────────────────────────────────
const getTaskAnalytics = async (req, res) => {
  const [rawStatus, rawModule, rawDept, [{ count: totalCompleted }], [{ count: totalOverdue }], [{ count: total }]] = await Promise.all([
    knex('tasks').select('status').count('* as count').groupBy('status'),
    knex('tasks').select('module').count('* as count')
      .sum({ overdue: knex.raw(`CASE WHEN status = 'overdue' THEN 1 ELSE 0 END`) }).groupBy('module').orderBy('count', 'desc'),
    knex('tasks').whereNotNull('department').whereNot({ department: '' }).select('department')
      .sum({ overdue: knex.raw(`CASE WHEN status = 'overdue' THEN 1 ELSE 0 END`) }).groupBy('department'),
    knex('tasks').where({ status: 'completed' }).count('* as count'),
    knex('tasks').where({ status: 'overdue' }).count('* as count'),
    knex('tasks').count('* as count'),
  ]);

  // 30-day completion trend (batch)
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29); thirtyDaysAgo.setHours(0, 0, 0, 0);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
  const [completedByDay, createdByDay] = await Promise.all([
    knex('tasks').where({ status: 'completed' }).where('completedAt', '>=', thirtyDaysAgoStr)
      .select(knex.raw(`substr("completedAt"::text, 1, 10) as day`)).count('* as completed').groupByRaw(`substr("completedAt"::text, 1, 10)`),
    knex('tasks').where('createdAt', '>=', thirtyDaysAgo)
      .select(knex.raw(`to_char("createdAt", 'YYYY-MM-DD') as day`)).count('* as created').groupByRaw(`to_char("createdAt", 'YYYY-MM-DD')`),
  ]);
  const completedMap = Object.fromEntries(completedByDay.map((d) => [d.day, Number(d.completed)]));
  const createdMap   = Object.fromEntries(createdByDay.map((d) => [d.day, Number(d.created)]));
  const completionTrend = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    completionTrend.push({ date: dateStr, completed: completedMap[dateStr] || 0, created: createdMap[dateStr] || 0 });
  }

  return returnFunction(res, 200, true, 'OK', {
    summary: {
      total: Number(total),
      completed: Number(totalCompleted),
      overdue: Number(totalOverdue),
      completionRate: Number(total) > 0 ? Math.round((Number(totalCompleted) / Number(total)) * 100) : 0,
    },
    statusBreakdown: rawStatus.filter((s) => s.status).map((s) => ({ status: s.status, count: Number(s.count) })),
    moduleBreakdown: rawModule.filter((m) => m.module).map((m) => ({ module: m.module, count: Number(m.count), overdue: Number(m.overdue) || 0 })),
    deptOverdue: rawDept.filter((d) => Number(d.overdue) > 0).sort((a, b) => Number(b.overdue) - Number(a.overdue)).slice(0, 10)
      .map((d) => ({ department: d.department, overdue: Number(d.overdue) })),
    completionTrend,
  });
};

// ── Employee search for task assignment ───────────────────────────────────────
const searchEmployeesForTask = async (req, res) => {
  const { q = '' } = req.query;
  let query = knex('employees').where({ status: 'active' });
  if (q.trim()) query = query.where((qb) => qb.whereILike('fullName', `%${q.trim()}%`).orWhereILike('staffNumber', `%${q.trim()}%`));
  const employees = await query.select('id', 'fullName', 'staffNumber', 'department', 'designation').orderBy('fullName').limit(20);
  return returnFunction(res, 200, true, 'OK', employees);
};

// ── List employees with task counts ──────────────────────────────────────────
const listEmployeesWithTaskCounts = async (req, res) => {
  const { q = '' } = req.query;
  let query = knex('employees').whereNot({ status: 'terminated' });
  if (q.trim()) query = query.whereILike('fullName', `%${q.trim()}%`);
  const employees = await query.select('id', 'fullName', 'department', 'designation').orderBy('fullName').limit(50);
  if (!employees.length) return returnFunction(res, 200, true, 'OK', []);

  const ids = employees.map((e) => e.id);
  const counts = await knex('tasks').whereIn('assignedTo', ids).select('assignedTo')
    .count('* as total')
    .sum({ not_started: knex.raw(`CASE WHEN status = 'not_started' THEN 1 ELSE 0 END`) })
    .sum({ in_progress: knex.raw(`CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END`) })
    .sum({ completed: knex.raw(`CASE WHEN status = 'completed' THEN 1 ELSE 0 END`) })
    .sum({ overdue: knex.raw(`CASE WHEN status = 'overdue' THEN 1 ELSE 0 END`) })
    .sum({ blocked: knex.raw(`CASE WHEN status = 'blocked' THEN 1 ELSE 0 END`) })
    .groupBy('assignedTo');

  const countMap = Object.fromEntries(counts.map((c) => [c.assignedTo, {
    total: Number(c.total), not_started: Number(c.not_started), in_progress: Number(c.in_progress),
    completed: Number(c.completed), overdue: Number(c.overdue), blocked: Number(c.blocked),
  }]));
  const result = employees.map((e) => ({ ...e, taskCounts: countMap[e.id] || { total: 0, not_started: 0, in_progress: 0, completed: 0, overdue: 0, blocked: 0 } }));

  return returnFunction(res, 200, true, 'OK', result);
};

// ── Tasks for a specific employee ─────────────────────────────────────────────
const listTasksByEmployee = async (req, res) => {
  const empId = req.params.employeeId;
  if (!empId) return returnFunction(res, 400, false, 'Invalid ID.');

  let query = knex('tasks').where({ assignedTo: empId });
  if (req.query.status) query = query.where({ status: req.query.status });

  const [employee, tasks] = await Promise.all([
    knex('employees').where({ id: empId }).select('fullName', 'department', 'designation').first(),
    query.orderBy('dueDate', 'asc'),
  ]);
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');
  return returnFunction(res, 200, true, 'OK', { employee, tasks });
};

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const listTemplates = async (req, res) => {
  const templates = await knex('task_templates').orderBy('isDefault', 'desc').orderBy('name', 'asc');
  return returnFunction(res, 200, true, 'OK', templates);
};

const getTemplate = async (req, res) => {
  const tpl = await knex('task_templates').where({ id: req.params.id }).first();
  if (!tpl) return returnFunction(res, 404, false, 'Template not found.');
  return returnFunction(res, 200, true, 'OK', tpl);
};

const createTemplate = async (req, res) => {
  const { name, description, triggerEvent, applyTo, isActive, sections, tasks } = req.body;
  if (!name?.trim()) return returnFunction(res, 400, false, 'Template name is required.');

  const doc = {
    id: newId(),
    name:         name.trim(),
    description:  description || '',
    triggerEvent: triggerEvent || 'custom',
    applyTo:      JSON.stringify(applyTo || { type: 'all', departments: [], roles: [], employmentTypes: [] }),
    isActive:     isActive !== false,
    isDefault:    false,
    sections:     JSON.stringify((sections || []).map((s, i) => ({ _id: newId(), name: s.name || `Section ${i + 1}`, order: i }))),
    tasks: JSON.stringify((tasks || []).map((t, i) => ({
      _id:           newId(),
      title:         t.title || `Task ${i + 1}`,
      description:   t.description || '',
      type:          VALID_TYPES.includes(t.type) ? t.type : 'action',
      assignTo:      t.assignTo || 'HR',
      priority:      VALID_PRIORITIES.includes(t.priority) ? t.priority : 'medium',
      sectionId:     t.sectionId || null,
      order:         i,
      dueOffset:     t.dueOffset || { direction: 'after', days: 0 },
      documentAction: t.documentAction || null,
      meetingDuration: t.meetingDuration || null,
      deviceAction:  t.deviceAction || null,
      isRequired:    t.isRequired !== false,
    }))),
    usageCount: 0,
    createdBy:  req.user?.name || 'HR',
    createdAt:  new Date(),
    updatedAt:  new Date(),
  };

  const [saved] = await knex('task_templates').insert(doc).returning('*');
  return returnFunction(res, 201, true, 'Template created.', saved);
};

const updateTemplate = async (req, res) => {
  const update = { updatedAt: new Date() };
  for (const [key, val] of Object.entries(req.body)) {
    if (key === 'id' || key === '_id') continue;
    if (key === 'tasks') {
      update.tasks = JSON.stringify(val.map((t, i) => ({
        _id:           t._id || newId(),
        title:         t.title || `Task ${i + 1}`,
        description:   t.description || '',
        type:          VALID_TYPES.includes(t.type) ? t.type : 'action',
        assignTo:      t.assignTo || 'HR',
        priority:      VALID_PRIORITIES.includes(t.priority) ? t.priority : 'medium',
        sectionId:     t.sectionId || null,
        order:         i,
        dueOffset:     t.dueOffset || { direction: 'after', days: 0 },
        documentAction: t.documentAction || null,
        meetingDuration: t.meetingDuration || null,
        deviceAction:  t.deviceAction || null,
        isRequired:    t.isRequired !== false,
      })));
    } else if (key === 'sections' || key === 'applyTo') {
      update[key] = JSON.stringify(val);
    } else {
      update[key] = val;
    }
  }
  await knex('task_templates').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, 'Template updated.');
};

const deleteTemplate = async (req, res) => {
  const tpl = await knex('task_templates').where({ id: req.params.id }).first();
  if (tpl?.isDefault) return returnFunction(res, 400, false, 'Cannot delete default templates. Deactivate instead.');
  await knex('task_templates').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, 'Template deleted.');
};

const applyTemplate = async (req, res) => {
  const { employeeId, startDate } = req.body;
  if (!employeeId) return returnFunction(res, 400, false, 'employeeId is required.');

  const result = await triggerTasksFromTemplate(req.params.id, employeeId, startDate || new Date().toISOString().split('T')[0]);

  await knex('task_templates').where({ id: req.params.id }).increment('usageCount', 1);

  return returnFunction(res, 201, true, `${result.created} tasks created from template.`, result);
};

module.exports = {
  getTaskStats, getMyTasks, listTeamTasks, listAllTasks,
  getTaskDetail, createTask, updateTask, deleteTask,
  completeTask, reopenTask, updateTaskStatus, addComment, addSubtask, toggleSubtask,
  exportTasksCSV, getTaskAnalytics,
  searchEmployeesForTask, listEmployeesWithTaskCounts, listTasksByEmployee,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, applyTemplate,
};
