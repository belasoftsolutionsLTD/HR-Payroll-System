const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyEmployee } = require('../../functions/HR/notifyUser');
const { triggerTasksFromTemplate } = require('../../lib/tasks/triggerTasksFromTemplate');

const HR   = ['super_admin', 'hr_manager'];
const MGMT = ['super_admin', 'hr_manager', 'department_head'];

const VALID_STATUSES  = ['not_started', 'in_progress', 'completed', 'overdue', 'blocked'];
const VALID_TYPES     = ['action', 'document', 'form', 'meeting', 'equipment', 'approval'];
const VALID_MODULES   = ['onboarding', 'offboarding', 'hr', 'it', 'performance', 'general', 'new_hire', 'probation_end', 'role_change'];
const VALID_PRIORITIES = ['high', 'medium', 'low'];

const safeId = (v) => { try { return v ? new ObjectId(v) : null; } catch { return null; } };

const getPagination = (q) => {
  const page  = Math.max(1, parseInt(q.page) || 1);
  const limit = Math.min(100, parseInt(q.limit) || 50);
  return { page, limit, skip: (page - 1) * limit };
};

function buildTaskFilter(q, extra = {}) {
  const f = { ...extra };
  if (q.status)   f.status   = q.status;
  if (q.priority) f.priority = q.priority;
  if (q.type)     f.type     = q.type;
  if (q.module)   f.module   = q.module;
  if (q.search)   f.title    = { $regex: q.search, $options: 'i' };
  if (q.department) f.department = q.department;
  if (q.linkedEmployeeId) {
    const id = safeId(q.linkedEmployeeId);
    if (id) f.linkedEmployeeId = id;
  }

  const today = new Date().toISOString().split('T')[0];
  const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().split('T')[0];

  if (q.dateFilter === 'today')    f.dueDate = today;
  if (q.dateFilter === 'overdue')  { f.status = { $nin: ['completed'] }; f.dueDate = { $lt: today }; }
  if (q.dateFilter === 'this_week') f.dueDate = { $gte: today, $lte: weekEndStr };
  if (q.dateFilter === 'no_date')  f.dueDate = { $exists: false };

  return f;
}

// ── Stats card counts ─────────────────────────────────────────────────────────
const getTaskStats = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
  const weekStartStr = weekStart.toISOString().split('T')[0];

  let baseFilter = {};
  if (!HR.includes(req.user?.role)) {
    baseFilter.assignedTo = req.user.employeeId;
  }

  const [total, dueToday, overdue, completedThisWeek] = await Promise.all([
    countDocuments('tasks', { ...baseFilter, status: { $ne: 'completed' } }),
    countDocuments('tasks', { ...baseFilter, dueDate: today, status: { $nin: ['completed', 'blocked'] } }),
    countDocuments('tasks', { ...baseFilter, status: 'overdue' }),
    countDocuments('tasks', { ...baseFilter, status: 'completed', completedAt: { $gte: weekStartStr } }),
  ]);

  return returnFunction(res, 200, true, 'OK', { total, dueToday, overdue, completedThisWeek });
};

// ── My Tasks (personal) ───────────────────────────────────────────────────────
const getMyTasks = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'OK', []);
  const filter = buildTaskFilter(req.query, { assignedTo: req.user.employeeId });
  const tasks  = await findMany('tasks', filter, { sort: { dueDate: 1, priority: 1 } });
  return returnFunction(res, 200, true, 'OK', tasks);
};

// ── Team Tasks — tasks assigned to 2+ people at once ──────────────────────────
const listTeamTasks = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  let baseFilter = { isTeam: true };

  // Dept heads only see team tasks within their department
  if (!HR.includes(req.user?.role)) {
    const empId = req.user.employeeId;
    if (!empId) return returnFunction(res, 200, true, 'OK', { data: [], total: 0 });
    const me = await findOne('employees', { _id: empId });
    if (!me?.department) return returnFunction(res, 200, true, 'OK', { data: [], total: 0 });
    baseFilter.department = me.department;
  }

  const filter = buildTaskFilter(req.query, baseFilter);

  const [total, data] = await Promise.all([
    countDocuments('tasks', filter),
    findMany('tasks', filter, { sort: { dueDate: 1 }, skip, limit }),
  ]);

  return returnFunction(res, 200, true, 'OK', { data, total, page, limit });
};

// ── All Tasks (HR admin) ──────────────────────────────────────────────────────
const listAllTasks = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = buildTaskFilter(req.query);

  const [total, data] = await Promise.all([
    countDocuments('tasks', filter),
    findMany('tasks', filter, { sort: { dueDate: 1, createdAt: -1 }, skip, limit }),
  ]);
  return returnFunction(res, 200, true, 'OK', { data, total, page, limit });
};

// ── Task detail ───────────────────────────────────────────────────────────────
const _isTaskHR = (role) => ['super_admin', 'hr_manager'].includes(role);

const getTaskDetail = async (req, res) => {
  const task = await findOne('tasks', { _id: new ObjectId(req.params.id) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(task.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  // Fetch linked employee mini-card if present
  let linkedEmployee = null;
  if (task.linkedEmployeeId) {
    linkedEmployee = await findOne('employees', { _id: task.linkedEmployeeId },
      { projection: { fullName: 1, designation: 1, department: 1 } });
  }

  return returnFunction(res, 200, true, 'OK', { ...task, linkedEmployee });
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
    title:           title.trim(),
    description:     description || '',
    notes:           notes || '',
    status:          VALID_STATUSES.includes(status) ? status : 'not_started',
    priority:        VALID_PRIORITIES.includes(priority) ? priority : 'medium',
    type:            VALID_TYPES.includes(type) ? type : 'action',

    assignedTo:      emp._id,
    assignedToName:  emp.fullName,
    assignedBy:      req.user?.name || 'HR',
    department:      emp.department || '',

    module:          VALID_MODULES.includes(mod) ? mod : 'general',
    linkedEmployeeId: safeId(linkedEmployeeId),
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
    meetingAttendees: (meetingAttendees || []).map(safeId).filter(Boolean),
    deviceAction:    deviceAction || null,
    deviceStatus:    deviceAction ? 'pending' : null,
    approvalType:    approvalType || '',
    approverId:      safeId(approverId),
    approvalDecision: approvalDecision || 'pending',

    subtasks: (Array.isArray(subtasks) ? subtasks : []).map(t => ({
      _id: new ObjectId(), title: t.title || t, isCompleted: false, completedAt: null,
    })),
    blockedByTaskIds: (Array.isArray(blockedByTaskIds) ? blockedByTaskIds : []).map(safeId).filter(Boolean),
    attachments: [],
    comments: [],
    activity: [{
      action: 'created', from: null, to: null,
      performedByName: req.user?.name || 'HR',
      timestamp: new Date(),
    }],
    tags: Array.isArray(tags) ? tags : [],
    templateId: null,
    templateTaskId: null,

    createdBy: req.user?._id,
    createdByName: req.user?.name || 'HR',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Bulk department assign
  if (bulkDepartment) {
    const employees = await findMany('employees', { department: bulkDepartment, status: 'active' },
      { projection: { _id: 1, fullName: 1, department: 1 } });
    if (!employees.length) return returnFunction(res, 404, false, 'No active employees in that department.');
    await global.dbo.collection('tasks').insertMany(employees.map(baseDoc));
    return returnFunction(res, 201, true, `Assigned to ${employees.length} employees.`);
  }

  // Multi-assignee (≥2): one task per employee, all stamped as a team task
  const assignedToIds = req.body.assignedToIds;
  if (Array.isArray(assignedToIds) && assignedToIds.length >= 2) {
    const safeIds = assignedToIds.map(safeId).filter(Boolean);
    const employees = await findMany('employees', { _id: { $in: safeIds } },
      { projection: { _id: 1, fullName: 1, department: 1 } });
    if (!employees.length) return returnFunction(res, 404, false, 'Employees not found.');
    const teamId = new ObjectId();
    await global.dbo.collection('tasks').insertMany(employees.map(emp => ({
      ...baseDoc(emp),
      isTeam: true,
      teamId,
    })));
    employees.forEach(emp => notifyEmployee(emp._id, {
      title: `New team task: ${title}`,
      body:  `${dueDate ? `Due ${dueDate} · ` : ''}${priority || 'medium'} priority`,
      type:  'task',
    }));
    return returnFunction(res, 201, true, `Assigned to ${employees.length} employees.`);
  }

  if (!assignedTo) return returnFunction(res, 400, false, 'assignedTo or bulkDepartment is required.');
  const employee = await findOne('employees', { _id: safeId(assignedTo) });
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  const doc = baseDoc(employee);

  // Resolve linked employee name
  if (doc.linkedEmployeeId) {
    const linked = await findOne('employees', { _id: doc.linkedEmployeeId }, { projection: { fullName: 1 } });
    if (linked) doc.linkedEmployeeName = linked.fullName;
  }

  const result = await insertOne('tasks', doc);

  notifyEmployee(employee._id, {
    title: `New task: ${title}`,
    body:  `${dueDate ? `Due ${dueDate} · ` : ''}${priority || 'medium'} priority`,
    type:  'task',
  });

  return returnFunction(res, 201, true, 'Task created.', { _id: result.insertedId });
};

// ── Update task ───────────────────────────────────────────────────────────────
const updateTask = async (req, res) => {
  const task = await findOne('tasks', { _id: new ObjectId(req.params.id) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');

  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  if (update.assignedTo) update.assignedTo = safeId(update.assignedTo);
  if (update.linkedEmployeeId) update.linkedEmployeeId = safeId(update.linkedEmployeeId);
  if (update.blockedByTaskIds) update.blockedByTaskIds = update.blockedByTaskIds.map(safeId).filter(Boolean);
  if (update.status === 'completed' && !task.completedAt) update.completedAt = new Date();

  // Build activity entry
  const activityEntries = [];
  if (update.status && update.status !== task.status) {
    activityEntries.push({ action: 'status_changed', from: task.status, to: update.status, performedByName: req.user?.name, timestamp: new Date() });
  }
  if (update.dueDate && update.dueDate !== task.dueDate) {
    activityEntries.push({ action: 'due_date_changed', from: task.dueDate, to: update.dueDate, performedByName: req.user?.name, timestamp: new Date() });
  }
  if (update.assignedTo && String(update.assignedTo) !== String(task.assignedTo)) {
    activityEntries.push({ action: 'reassigned', from: task.assignedToName, to: update.assignedToName || '', performedByName: req.user?.name, timestamp: new Date() });
  }

  const patch = { $set: update };
  if (activityEntries.length) patch.$push = { activity: { $each: activityEntries } };

  await global.dbo.collection('tasks').updateOne({ _id: task._id }, patch);
  return returnFunction(res, 200, true, 'Updated.');
};

// ── Delete task ───────────────────────────────────────────────────────────────
const deleteTask = async (req, res) => {
  await global.dbo.collection('tasks').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, 'Deleted.');
};

// ── Mark task complete ────────────────────────────────────────────────────────
const completeTask = async (req, res) => {
  const task = await findOne('tasks', { _id: new ObjectId(req.params.id) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(task.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  // Dependency check
  if ((task.blockedByTaskIds || []).length) {
    const blockers = await global.dbo.collection('tasks').countDocuments({
      _id: { $in: task.blockedByTaskIds }, status: { $ne: 'completed' },
    });
    if (blockers > 0) return returnFunction(res, 400, false, 'Complete prerequisite tasks first.');
  }

  await global.dbo.collection('tasks').updateOne({ _id: task._id }, {
    $set: { status: 'completed', completedAt: new Date(), updatedAt: new Date() },
    $push: { activity: { action: 'completed', from: task.status, to: 'completed', performedByName: req.user?.name, timestamp: new Date() } },
  });

  // Auto-unblock tasks that were blocked by this one
  await global.dbo.collection('tasks').updateMany(
    { blockedByTaskIds: task._id, status: 'blocked' },
    { $set: { status: 'not_started', updatedAt: new Date() } }
  );

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
  }

  return returnFunction(res, 200, true, 'Task completed.');
};

// ── Reopen task ───────────────────────────────────────────────────────────────
const reopenTask = async (req, res) => {
  const task = await findOne('tasks', { _id: new ObjectId(req.params.id) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(task.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }
  await global.dbo.collection('tasks').updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: { status: 'not_started', completedAt: null, updatedAt: new Date() },
      $push: { activity: { action: 'status_changed', from: 'completed', to: 'not_started', performedByName: req.user?.name, timestamp: new Date() } },
    }
  );
  return returnFunction(res, 200, true, 'Task reopened.');
};

// ── Add comment ───────────────────────────────────────────────────────────────
const addComment = async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return returnFunction(res, 400, false, 'Comment text is required.');
  const task = await findOne('tasks', { _id: new ObjectId(req.params.id) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(task.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  const comment = {
    _id:       new ObjectId(),
    authorId:  req.user?._id,
    authorName: req.user?.name || 'Unknown',
    text:      text.trim(),
    mentions:  [],
    createdAt: new Date(),
  };

  await global.dbo.collection('tasks').updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $push: { comments: comment },
      $set:  { updatedAt: new Date() },
    }
  );

  return returnFunction(res, 201, true, 'Comment added.', comment);
};

// ── Add subtask ───────────────────────────────────────────────────────────────
const addSubtask = async (req, res) => {
  const { title } = req.body;
  if (!title?.trim()) return returnFunction(res, 400, false, 'Subtask title required.');
  const taskCheck = await findOne('tasks', { _id: new ObjectId(req.params.id) });
  if (!taskCheck) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(taskCheck.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  const subtask = { _id: new ObjectId(), title: title.trim(), isCompleted: false, completedAt: null };

  await global.dbo.collection('tasks').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $push: { subtasks: subtask }, $set: { updatedAt: new Date() } }
  );
  return returnFunction(res, 201, true, 'Subtask added.', subtask);
};

// ── Toggle subtask ────────────────────────────────────────────────────────────
const toggleSubtask = async (req, res) => {
  const task = await findOne('tasks', { _id: new ObjectId(req.params.id) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (!_isTaskHR(req.user?.role) && String(task.assignedTo) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  const subId = new ObjectId(req.params.subId);
  const subtask = (task.subtasks || []).find(s => String(s._id) === String(subId));
  if (!subtask) return returnFunction(res, 404, false, 'Subtask not found.');

  const completed = !subtask.isCompleted;
  await global.dbo.collection('tasks').updateOne(
    { _id: task._id, 'subtasks._id': subId },
    { $set: { 'subtasks.$.isCompleted': completed, 'subtasks.$.completedAt': completed ? new Date() : null, updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Subtask updated.', { isCompleted: completed });
};

// ── Export CSV ────────────────────────────────────────────────────────────────
const exportTasksCSV = async (req, res) => {
  const filter = buildTaskFilter(req.query);
  const tasks  = await findMany('tasks', filter, { sort: { dueDate: 1 } });

  const header = 'Task,Type,Assignee,Module,Priority,Status,Due Date,Completed At,Created By\n';
  const rows   = tasks.map(t => [
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
  const [rawStatus, rawModule, rawDept, totalCompleted, totalOverdue, total] = await Promise.all([
    global.dbo.collection('tasks').aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray(),
    global.dbo.collection('tasks').aggregate([
      { $group: { _id: '$module', count: { $sum: 1 }, overdue: { $sum: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    global.dbo.collection('tasks').aggregate([
      { $match: { department: { $exists: true, $ne: null, $ne: '' } } },
      { $group: { _id: '$department', overdue: { $sum: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } } } },
      { $match: { overdue: { $gt: 0 } } },
      { $sort: { overdue: -1 } },
      { $limit: 10 },
    ]).toArray(),
    countDocuments('tasks', { status: 'completed' }),
    countDocuments('tasks', { status: 'overdue' }),
    countDocuments('tasks', {}),
  ]);

  // 30-day completion trend (batch)
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29); thirtyDaysAgo.setHours(0, 0, 0, 0);
  const [completedByDay, createdByDay] = await Promise.all([
    global.dbo.collection('tasks').aggregate([
      { $match: { status: 'completed', completedAt: { $gte: thirtyDaysAgo.toISOString().split('T')[0] } } },
      { $group: { _id: { $substr: ['$completedAt', 0, 10] }, completed: { $sum: 1 } } },
    ]).toArray(),
    global.dbo.collection('tasks').aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, created: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const completedMap = Object.fromEntries(completedByDay.map(d => [d._id, d.completed]));
  const createdMap   = Object.fromEntries(createdByDay.map(d => [d._id, d.created]));
  const completionTrend = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    completionTrend.push({ date: dateStr, completed: completedMap[dateStr] || 0, created: createdMap[dateStr] || 0 });
  }

  return returnFunction(res, 200, true, 'OK', {
    summary: {
      total,
      completed: totalCompleted,
      overdue: totalOverdue,
      completionRate: total > 0 ? Math.round((totalCompleted / total) * 100) : 0,
    },
    statusBreakdown: rawStatus.filter(s => s._id).map(s => ({ status: s._id, count: s.count })),
    moduleBreakdown: rawModule.filter(m => m._id).map(m => ({ module: m._id, count: m.count, overdue: m.overdue || 0 })),
    deptOverdue: rawDept.filter(d => d._id).map(d => ({ department: d._id, overdue: d.overdue })),
    completionTrend,
  });
};

// ── Employee search for task assignment ───────────────────────────────────────
const searchEmployeesForTask = async (req, res) => {
  const { q = '' } = req.query;
  const filter = { status: 'active' };
  if (q.trim()) filter.$or = [
    { fullName: { $regex: q.trim(), $options: 'i' } },
    { staffNumber: { $regex: q.trim(), $options: 'i' } },
  ];
  const employees = await findMany('employees', filter, {
    projection: { _id: 1, fullName: 1, staffNumber: 1, department: 1, designation: 1 },
    limit: 20, sort: { fullName: 1 },
  });
  return returnFunction(res, 200, true, 'OK', employees);
};

// ── List employees with task counts ──────────────────────────────────────────
const listEmployeesWithTaskCounts = async (req, res) => {
  const { q = '' } = req.query;
  const filter = { status: { $ne: 'terminated' } };
  if (q.trim()) filter.fullName = { $regex: q.trim(), $options: 'i' };

  const employees = await findMany('employees', filter, {
    projection: { _id: 1, fullName: 1, department: 1, designation: 1 },
    limit: 50, sort: { fullName: 1 },
  });
  if (!employees.length) return returnFunction(res, 200, true, 'OK', []);

  const ids = employees.map(e => e._id);
  const counts = await global.dbo.collection('tasks').aggregate([
    { $match: { assignedTo: { $in: ids } } },
    { $group: { _id: '$assignedTo', total: { $sum: 1 },
      not_started: { $sum: { $cond: [{ $eq: ['$status', 'not_started'] }, 1, 0] } },
      in_progress: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
      completed:   { $sum: { $cond: [{ $eq: ['$status', 'completed']   }, 1, 0] } },
      overdue:     { $sum: { $cond: [{ $eq: ['$status', 'overdue']     }, 1, 0] } },
      blocked:     { $sum: { $cond: [{ $eq: ['$status', 'blocked']     }, 1, 0] } },
    } },
  ]).toArray();

  const countMap = Object.fromEntries(counts.map(c => [String(c._id), c]));
  const result   = employees.map(e => ({ ...e, taskCounts: countMap[String(e._id)] || { total: 0, not_started: 0, in_progress: 0, completed: 0, overdue: 0, blocked: 0 } }));

  return returnFunction(res, 200, true, 'OK', result);
};

// ── Tasks for a specific employee ─────────────────────────────────────────────
const listTasksByEmployee = async (req, res) => {
  const empId = safeId(req.params.employeeId);
  if (!empId) return returnFunction(res, 400, false, 'Invalid ID.');

  const filter = { assignedTo: empId };
  if (req.query.status) filter.status = req.query.status;

  const [employee, tasks] = await Promise.all([
    findOne('employees', { _id: empId }, { projection: { fullName: 1, department: 1, designation: 1 } }),
    findMany('tasks', filter, { sort: { dueDate: 1 } }),
  ]);
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');
  return returnFunction(res, 200, true, 'OK', { employee, tasks });
};

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const listTemplates = async (req, res) => {
  const templates = await findMany('task_templates', {}, { sort: { isDefault: -1, name: 1 } });
  return returnFunction(res, 200, true, 'OK', templates);
};

const getTemplate = async (req, res) => {
  const tpl = await findOne('task_templates', { _id: new ObjectId(req.params.id) });
  if (!tpl) return returnFunction(res, 404, false, 'Template not found.');
  return returnFunction(res, 200, true, 'OK', tpl);
};

const createTemplate = async (req, res) => {
  const { name, description, triggerEvent, applyTo, isActive, sections, tasks } = req.body;
  if (!name?.trim()) return returnFunction(res, 400, false, 'Template name is required.');

  const doc = {
    name:         name.trim(),
    description:  description || '',
    triggerEvent: triggerEvent || 'custom',
    applyTo:      applyTo || { type: 'all', departments: [], roles: [], employmentTypes: [] },
    isActive:     isActive !== false,
    isDefault:    false,
    sections:     (sections || []).map((s, i) => ({ _id: new ObjectId(), name: s.name || `Section ${i+1}`, order: i })),
    tasks: (tasks || []).map((t, i) => ({
      _id:           new ObjectId(),
      title:         t.title || `Task ${i+1}`,
      description:   t.description || '',
      type:          VALID_TYPES.includes(t.type) ? t.type : 'action',
      assignTo:      t.assignTo || 'HR',
      priority:      VALID_PRIORITIES.includes(t.priority) ? t.priority : 'medium',
      sectionId:     t.sectionId ? new ObjectId(t.sectionId) : null,
      order:         i,
      dueOffset:     t.dueOffset || { direction: 'after', days: 0 },
      documentAction: t.documentAction || null,
      meetingDuration: t.meetingDuration || null,
      deviceAction:  t.deviceAction || null,
      isRequired:    t.isRequired !== false,
    })),
    usageCount: 0,
    createdBy:  req.user?.name || 'HR',
    createdAt:  new Date(),
    updatedAt:  new Date(),
  };

  const result = await insertOne('task_templates', doc);
  return returnFunction(res, 201, true, 'Template created.', { _id: result.insertedId, ...doc });
};

const updateTemplate = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  if (update.tasks) {
    update.tasks = update.tasks.map((t, i) => ({
      _id:           t._id ? new ObjectId(t._id) : new ObjectId(),
      title:         t.title || `Task ${i+1}`,
      description:   t.description || '',
      type:          VALID_TYPES.includes(t.type) ? t.type : 'action',
      assignTo:      t.assignTo || 'HR',
      priority:      VALID_PRIORITIES.includes(t.priority) ? t.priority : 'medium',
      sectionId:     t.sectionId ? new ObjectId(t.sectionId) : null,
      order:         i,
      dueOffset:     t.dueOffset || { direction: 'after', days: 0 },
      documentAction: t.documentAction || null,
      meetingDuration: t.meetingDuration || null,
      deviceAction:  t.deviceAction || null,
      isRequired:    t.isRequired !== false,
    }));
  }
  await updateOne('task_templates', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, 'Template updated.');
};

const deleteTemplate = async (req, res) => {
  const tpl = await findOne('task_templates', { _id: new ObjectId(req.params.id) });
  if (tpl?.isDefault) return returnFunction(res, 400, false, 'Cannot delete default templates. Deactivate instead.');
  await global.dbo.collection('task_templates').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, 'Template deleted.');
};

const applyTemplate = async (req, res) => {
  const { employeeId, startDate } = req.body;
  if (!employeeId) return returnFunction(res, 400, false, 'employeeId is required.');

  const result = await triggerTasksFromTemplate(req.params.id, employeeId, startDate || new Date().toISOString().split('T')[0]);

  // Increment usage count
  await global.dbo.collection('task_templates').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $inc: { usageCount: 1 } }
  );

  return returnFunction(res, 201, true, `${result.created} tasks created from template.`, result);
};

module.exports = {
  getTaskStats, getMyTasks, listTeamTasks, listAllTasks,
  getTaskDetail, createTask, updateTask, deleteTask,
  completeTask, reopenTask, addComment, addSubtask, toggleSubtask,
  exportTasksCSV, getTaskAnalytics,
  searchEmployeesForTask, listEmployeesWithTaskCounts, listTasksByEmployee,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, applyTemplate,
};
