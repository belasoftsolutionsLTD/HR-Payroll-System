const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, deleteOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { initiateOnboarding, notifyStakeholder } = require('../../lib/onboarding/autoAssignTasks');

const HR_ROLE_LIST = ['super_admin', 'hr_manager'];
const isHR = (req) => HR_ROLE_LIST.includes(req.user?.role);

// A task counts as overdue for display purposes if it isn't finished and its due
// date has passed — computed at read time rather than stored, so it's always
// correct without a cron job (same idiom as the old getOverdueTasks endpoint).
const withComputedStatus = (task) => {
  if (task.status === 'completed') return task;
  const isOverdue = task.dueDate && new Date(task.dueDate) < new Date();
  return isOverdue ? { ...task, status: 'overdue' } : task;
};

const computeProgress = (record) => {
  const allTasks = (record.taskLists || []).flatMap(l => l.tasks || []);
  const total = allTasks.length;
  const completed = allTasks.filter(t => t.status === 'completed').length;
  const progressPercentage = total ? Math.round((completed / total) * 100) : 0;
  const taskLists = (record.taskLists || []).map(l => ({ ...l, tasks: (l.tasks || []).map(withComputedStatus) }));
  return { ...record, taskLists, progressPercentage };
};

const enrichEmployee = async (record) => {
  const employee = await findOne('employees', { _id: record.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1 } });
  return { ...record, employee: employee || null };
};

// ══════════════════════════════════════════════════════════════════════════════
//  TEMPLATES
// ══════════════════════════════════════════════════════════════════════════════

const listTemplates = async (req, res) => {
  const templates = await findMany('onboarding_templates', {}, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, templates);
};

const getTemplate = async (req, res) => {
  const template = await findOne('onboarding_templates', { _id: new ObjectId(req.params.id) });
  if (!template) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, template);
};

const withGeneratedIds = (taskLists = []) => taskLists.map(list => ({
  id: list.id || crypto.randomUUID(),
  name: list.name,
  assignedTo: list.assignedTo,
  tasks: (list.tasks || []).map(t => ({
    id: t.id || crypto.randomUUID(),
    title: t.title,
    description: t.description || '',
    dueOffsetDays: Number(t.dueOffsetDays) || 0,
    isRequired: t.isRequired !== false,
    requiresDocument: !!t.requiresDocument,
    documentTemplateId: t.documentTemplateId || null,
    resourceUrl: t.resourceUrl || null,
  })),
}));

// HR attaches a reference file (e.g. employee handbook PDF) to a task template —
// the resulting URL is stored on the task and copied onto every instantiated
// record's task by initiateOnboarding, so the new hire can view/download it.
const uploadTemplateResource = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, 'A file is required.');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { fileUrl: `/uploads/${req.file.filename}` });
};

const createTemplate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const { name, description, targetRoles, targetDepartments, welcomeMessage, firstDayDetails, taskLists, meetTheTeam } = req.body;
  const doc = {
    name: name.trim(),
    description: description || '',
    targetRoles: targetRoles || [],
    targetDepartments: targetDepartments || [],
    welcomeMessage: welcomeMessage || '',
    firstDayDetails: firstDayDetails || { location: '', reportingTime: '', whatToBring: '', additionalNotes: '' },
    taskLists: withGeneratedIds(taskLists),
    meetTheTeam: (meetTheTeam || []).map(m => ({ employeeId: new ObjectId(m.employeeId), note: m.note || '' })),
    createdBy: req.user?._id || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('onboarding_templates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateTemplate = async (req, res) => {
  const existing = await findOne('onboarding_templates', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const { name, description, targetRoles, targetDepartments, welcomeMessage, firstDayDetails, taskLists, meetTheTeam } = req.body;
  const update = { updatedAt: new Date() };
  if (name !== undefined)              update.name = name.trim();
  if (description !== undefined)       update.description = description;
  if (targetRoles !== undefined)       update.targetRoles = targetRoles;
  if (targetDepartments !== undefined) update.targetDepartments = targetDepartments;
  if (welcomeMessage !== undefined)    update.welcomeMessage = welcomeMessage;
  if (firstDayDetails !== undefined)   update.firstDayDetails = firstDayDetails;
  if (taskLists !== undefined)         update.taskLists = withGeneratedIds(taskLists);
  if (meetTheTeam !== undefined)       update.meetTheTeam = meetTheTeam.map(m => ({ employeeId: new ObjectId(m.employeeId), note: m.note || '' }));
  await updateOne('onboarding_templates', { _id: existing._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteTemplate = async (req, res) => {
  const existing = await findOne('onboarding_templates', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await deleteOne('onboarding_templates', { _id: existing._id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  RECORDS
// ══════════════════════════════════════════════════════════════════════════════

const createRecord = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'templateId', 'startDate'])) return;
  const { employeeId, templateId, startDate } = req.body;

  const activeExisting = await findOne('onboarding_records', {
    employeeId: new ObjectId(employeeId),
    status: { $in: ['preboarding', 'active', 'stalled'] },
  });
  if (activeExisting) return returnFunction(res, 409, false, 'This employee already has an active onboarding record.');

  let record;
  try {
    record = await initiateOnboarding(employeeId, templateId, startDate, req.user?._id);
  } catch (err) {
    return returnFunction(res, 400, false, err.message || 'Could not start onboarding.');
  }
  return returnFunction(res, 201, true, 'Onboarding started.', { _id: record._id });
};

const listRecords = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.startFrom || req.query.startTo) {
    filter.startDate = {};
    if (req.query.startFrom) filter.startDate.$gte = new Date(req.query.startFrom);
    if (req.query.startTo)   filter.startDate.$lte = new Date(req.query.startTo);
  }

  const [total, records] = await Promise.all([
    countDocuments('onboarding_records', filter),
    findMany('onboarding_records', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  let enriched = await Promise.all(records.map(r => enrichEmployee(computeProgress(r))));
  if (req.query.department) {
    enriched = enriched.filter(r => r.employee?.department === req.query.department);
  }
  // Stalled = active, no task completed/updated in the last 7 days
  const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  enriched = enriched.map(r => {
    if (r.status !== 'active') return r;
    const lastActivity = new Date(r.updatedAt || r.createdAt);
    return lastActivity < staleCutoff ? { ...r, status: 'stalled' } : r;
  });

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getRecord = async (req, res) => {
  const record = await findOne('onboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  const enriched = await enrichEmployee(computeProgress(record));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const finalizeIfComplete = async (record) => {
  const progressed = computeProgress(record);
  const requiredTasks = progressed.taskLists.flatMap(l => l.tasks).filter(t => t.isRequired);
  const allRequiredDone = requiredTasks.length > 0 && requiredTasks.every(t => t.status === 'completed');
  if (allRequiredDone && record.status !== 'completed') {
    const now = new Date();
    await updateOne('onboarding_records', { _id: record._id }, { $set: { status: 'completed', completedAt: now, updatedAt: now } });
    const employee = await findOne('employees', { _id: record.employeeId }, { projection: { fullName: 1 } });
    if (employee) {
      notifyByRoles(['super_admin', 'hr_manager'], {
        title: 'Onboarding Complete',
        body: `All required onboarding tasks for ${employee.fullName} have been completed.`,
        type: 'onboarding',
      }).catch(() => {});
    }
    return true;
  }
  return false;
};

// HR updates a task's status — body: { taskListId, taskId, status, notes }
const updateRecordTask = async (req, res) => {
  if (!validateRequiredFields(req, res, ['taskListId', 'taskId', 'status'])) return;
  const { taskListId, taskId, status, notes } = req.body;
  const VALID = ['pending', 'inProgress', 'completed'];
  if (!VALID.includes(status)) return returnFunction(res, 400, false, 'Invalid status.');

  const record = await findOne('onboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const now = new Date();
  const setFields = {
    'taskLists.$[list].tasks.$[task].status': status,
    'taskLists.$[list].tasks.$[task].completedAt': status === 'completed' ? now : null,
    'taskLists.$[list].tasks.$[task].completedBy': status === 'completed' ? (req.user?._id ? new ObjectId(req.user._id) : null) : null,
    updatedAt: now,
  };
  if (notes !== undefined) setFields['taskLists.$[list].tasks.$[task].notes'] = notes;

  await global.dbo.collection('onboarding_records').updateOne(
    { _id: record._id },
    { $set: setFields },
    { arrayFilters: [{ 'list.id': taskListId }, { 'task.id': taskId }] }
  );

  const updated = await findOne('onboarding_records', { _id: record._id });
  await finalizeIfComplete(updated);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// HR adds a one-off custom task directly to an already-initiated record — unlike
// editing a template (which only affects records created afterward), this only
// affects this specific employee's record.
const addRecordTask = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'assignedTo'])) return;
  const VALID_ASSIGNEES = ['hr', 'it', 'manager', 'newHire', 'finance'];
  const { title, description, dueDate, isRequired, assignedTo, taskListId, requiresDocument } = req.body;
  if (!VALID_ASSIGNEES.includes(assignedTo)) return returnFunction(res, 400, false, 'Invalid assignedTo.');
  // Any assignee can require a document now: the newHire themselves can upload via
  // /my/document for their own tasks, and HR can upload on behalf of any other
  // assignee's task via uploadRecordDocument.

  const record = await findOne('onboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const now = new Date();
  const newTask = {
    id: crypto.randomUUID(),
    title, description: description || '',
    dueDate: dueDate ? new Date(dueDate) : now,
    isRequired: isRequired !== false,
    status: 'pending', completedBy: null, completedAt: null,
    requiresDocument: !!requiresDocument, documentId: null, notes: null, resourceUrl: null,
  };

  const explicitList = taskListId ? record.taskLists.find(l => l.id === taskListId) : null;
  const matchingList = explicitList || record.taskLists.find(l => l.assignedTo === assignedTo);

  if (matchingList) {
    await global.dbo.collection('onboarding_records').updateOne(
      { _id: record._id, 'taskLists.id': matchingList.id },
      { $push: { 'taskLists.$.tasks': newTask }, $set: { updatedAt: now } }
    );
  } else {
    const newList = { id: crypto.randomUUID(), name: 'Additional Tasks', assignedTo, tasks: [newTask] };
    await global.dbo.collection('onboarding_records').updateOne(
      { _id: record._id },
      { $push: { taskLists: newList }, $set: { updatedAt: now } }
    );
  }

  // A completed record with a new pending required task is no longer actually complete
  if (record.status === 'completed' && newTask.isRequired) {
    await updateOne('onboarding_records', { _id: record._id }, { $set: { status: 'active', completedAt: null, updatedAt: now } });
  }

  const employee = await findOne('employees', { _id: record.employeeId }, { projection: { fullName: 1 } });
  notifyStakeholder(assignedTo, record.employeeId, {
    title: `Onboarding: ${employee?.fullName ?? 'Employee'}`,
    body: `New task added: "${title}"`,
    type: 'onboarding',
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { taskId: newTask.id });
};

const updateWelcome = async (req, res) => {
  const record = await findOne('onboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  const { welcomeMessage, firstDayDetails } = req.body;
  const update = { updatedAt: new Date() };
  if (welcomeMessage !== undefined)  update.welcomeMessage = welcomeMessage;
  if (firstDayDetails !== undefined) update.firstDayDetails = firstDayDetails;
  await updateOne('onboarding_records', { _id: record._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  ANALYTICS
// ══════════════════════════════════════════════════════════════════════════════

const getAnalytics = async (req, res) => {
  const records = await findMany('onboarding_records', {}, {});
  const empIds = [...new Set(records.map(r => String(r.employeeId)))].map(id => new ObjectId(id));
  const employees = await findMany('employees', { _id: { $in: empIds } }, { projection: { department: 1 } });
  const deptById = Object.fromEntries(employees.map(e => [String(e._id), e.department]));

  const templates = await findMany('onboarding_templates', {}, { projection: { name: 1 } });
  const templateNameById = Object.fromEntries(templates.map(t => [String(t._id), t.name]));

  // Avg completion time (days) by department and by template — completed records only
  const completed = records.filter(r => r.status === 'completed' && r.completedAt);
  const daysFor = (r) => (new Date(r.completedAt) - new Date(r.startDate)) / (1000 * 60 * 60 * 24);

  const byDept = {};
  for (const r of completed) {
    const dept = deptById[String(r.employeeId)] || 'Unknown';
    if (!byDept[dept]) byDept[dept] = { totalDays: 0, count: 0 };
    byDept[dept].totalDays += daysFor(r);
    byDept[dept].count += 1;
  }
  const avgCompletionDaysByDepartment = Object.entries(byDept).map(([department, v]) => ({
    department, avgDays: Math.round((v.totalDays / v.count) * 10) / 10, count: v.count,
  }));

  const byTemplate = {};
  for (const r of completed) {
    const key = String(r.templateId);
    if (!byTemplate[key]) byTemplate[key] = { totalDays: 0, count: 0 };
    byTemplate[key].totalDays += daysFor(r);
    byTemplate[key].count += 1;
  }
  const avgCompletionDaysByTemplate = Object.entries(byTemplate).map(([templateId, v]) => ({
    templateId, templateName: templateNameById[templateId] || 'Unknown', avgDays: Math.round((v.totalDays / v.count) * 10) / 10, count: v.count,
  }));

  // Task completion rate by stakeholder type
  const byStakeholder = {};
  for (const r of records) {
    for (const list of r.taskLists || []) {
      if (!byStakeholder[list.assignedTo]) byStakeholder[list.assignedTo] = { total: 0, completed: 0 };
      byStakeholder[list.assignedTo].total += list.tasks.length;
      byStakeholder[list.assignedTo].completed += list.tasks.filter(t => t.status === 'completed').length;
    }
  }
  const taskCompletionRateByStakeholder = Object.entries(byStakeholder).map(([assignedTo, v]) => ({
    assignedTo, total: v.total, completed: v.completed, rate: v.total ? Math.round((v.completed / v.total) * 100) : 0,
  }));

  // Stalled = active, no activity in 7+ days
  const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stalledEmployees = await Promise.all(
    records.filter(r => r.status === 'active' && new Date(r.updatedAt || r.createdAt) < staleCutoff)
      .map(async r => {
        const emp = await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1, department: 1 } });
        return { employeeId: String(r.employeeId), fullName: emp?.fullName || 'Unknown', department: emp?.department || 'Unknown', daysSinceActivity: Math.floor((Date.now() - new Date(r.updatedAt || r.createdAt)) / (1000 * 60 * 60 * 24)) };
      })
  );

  // New hires by month (last 12 months)
  const monthBuckets = [];
  const cursor = new Date(); cursor.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    monthBuckets.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, count: 0 });
  }
  const bucketMap = Object.fromEntries(monthBuckets.map(b => [b.key, b]));
  for (const r of records) {
    const d = new Date(r.startDate);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (bucketMap[key]) bucketMap[key].count += 1;
  }

  return returnFunction(res, 200, true, req.locale.success, {
    avgCompletionDaysByDepartment,
    avgCompletionDaysByTemplate,
    taskCompletionRateByStakeholder,
    stalledEmployees,
    newHiresByMonth: monthBuckets,
  });
};

// ══════════════════════════════════════════════════════════════════════════════
//  EMPLOYEE SELF-SERVICE (own record only — always scoped to req.user.employeeId)
// ══════════════════════════════════════════════════════════════════════════════

const getMyOnboarding = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, null);
  const record = await findOne('onboarding_records', { employeeId: new ObjectId(req.user.employeeId) }, { sort: { createdAt: -1 } });
  if (!record) return returnFunction(res, 200, true, req.locale.success, null);

  const progressed = computeProgress(record);
  // Employees only ever see their own ("newHire") task list — never HR/IT/manager/finance lists.
  const myTaskList = progressed.taskLists.filter(l => l.assignedTo === 'newHire');

  const meetTheTeam = await Promise.all((progressed.meetTheTeam || []).map(async (m) => {
    const person = await findOne('employees', { _id: m.employeeId }, { projection: { fullName: 1, designation: 1, department: 1 } });
    return { ...m, employee: person || null };
  }));

  return returnFunction(res, 200, true, req.locale.success, { ...progressed, taskLists: myTaskList, meetTheTeam });
};

const updateMyTask = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 403, false, 'No employee record linked.');
  const { taskId } = req.params;

  const record = await findOne('onboarding_records', {
    employeeId: new ObjectId(req.user.employeeId),
    'taskLists.tasks.id': taskId,
  });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  // Employees may only complete tasks from their own ("newHire") list.
  const owningList = record.taskLists.find(l => l.tasks.some(t => t.id === taskId));
  if (!owningList || owningList.assignedTo !== 'newHire') {
    return returnFunction(res, 403, false, 'You cannot update this task.');
  }

  const now = new Date();
  await global.dbo.collection('onboarding_records').updateOne(
    { _id: record._id },
    {
      $set: {
        'taskLists.$[list].tasks.$[task].status': 'completed',
        'taskLists.$[list].tasks.$[task].completedAt': now,
        'taskLists.$[list].tasks.$[task].completedBy': req.user?._id ? new ObjectId(req.user._id) : null,
        updatedAt: now,
      },
    },
    { arrayFilters: [{ 'list.id': owningList.id }, { 'task.id': taskId }] }
  );

  const updated = await findOne('onboarding_records', { _id: record._id });
  await finalizeIfComplete(updated);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const uploadMyDocument = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 403, false, 'No employee record linked.');
  if (!validateRequiredFields(req, res, ['taskId'])) return;
  if (!req.file) return returnFunction(res, 400, false, 'A file is required.');

  const record = await findOne('onboarding_records', {
    employeeId: new ObjectId(req.user.employeeId),
    'taskLists.tasks.id': req.body.taskId,
  });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const owningList = record.taskLists.find(l => l.tasks.some(t => t.id === req.body.taskId));
  const task = owningList?.tasks.find(t => t.id === req.body.taskId);
  if (!owningList || owningList.assignedTo !== 'newHire' || !task) {
    return returnFunction(res, 403, false, 'You cannot upload a document for this task.');
  }

  const docResult = await insertOne('onboarding_documents', {
    employeeId: new ObjectId(req.user.employeeId),
    recordId: record._id,
    recordType: 'onboarding',
    taskId: req.body.taskId,
    name: task.title,
    type: 'upload',
    fileUrl: `/uploads/${req.file.filename}`,
    signedAt: null,
    signedBy: null,
    status: 'uploaded',
    uploadedAt: new Date(),
    createdAt: new Date(),
  });

  await global.dbo.collection('onboarding_records').updateOne(
    { _id: record._id },
    { $set: { 'taskLists.$[list].tasks.$[task].documentId': docResult.insertedId, updatedAt: new Date() } },
    { arrayFilters: [{ 'list.id': owningList.id }, { 'task.id': req.body.taskId }] }
  );

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: docResult.insertedId });
};

// HR uploads a document on behalf of any task, regardless of assignee — unlike
// uploadMyDocument (self-service, newHire-list only), this lets HR fulfil a
// requiresDocument task assigned to hr/it/manager/finance, since those
// stakeholders have no dedicated portal of their own to upload through.
const uploadRecordDocument = async (req, res) => {
  if (!validateRequiredFields(req, res, ['taskId'])) return;
  if (!req.file) return returnFunction(res, 400, false, 'A file is required.');

  const record = await findOne('onboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const owningList = record.taskLists.find(l => l.tasks.some(t => t.id === req.body.taskId));
  const task = owningList?.tasks.find(t => t.id === req.body.taskId);
  if (!owningList || !task) return returnFunction(res, 404, false, 'Task not found on this record.');

  const docResult = await insertOne('onboarding_documents', {
    employeeId: record.employeeId,
    recordId: record._id,
    recordType: 'onboarding',
    taskId: req.body.taskId,
    name: task.title,
    type: 'upload',
    fileUrl: `/uploads/${req.file.filename}`,
    signedAt: null,
    signedBy: null,
    status: 'uploaded',
    uploadedAt: new Date(),
    createdAt: new Date(),
  });

  await global.dbo.collection('onboarding_records').updateOne(
    { _id: record._id },
    { $set: { 'taskLists.$[list].tasks.$[task].documentId': docResult.insertedId, updatedAt: new Date() } },
    { arrayFilters: [{ 'list.id': owningList.id }, { 'task.id': req.body.taskId }] }
  );

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: docResult.insertedId });
};

const updateMeetTheTeam = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 403, false, 'No employee record linked.');
  const record = await findOne('onboarding_records', { employeeId: new ObjectId(req.user.employeeId) }, { sort: { createdAt: -1 } });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  await global.dbo.collection('onboarding_records').updateOne(
    { _id: record._id, 'meetTheTeam.employeeId': new ObjectId(req.params.personId) },
    { $set: { 'meetTheTeam.$.met': true, updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Documents (HR view — supports the Record Detail "Documents" tab) ──────────

const listRecordDocuments = async (req, res) => {
  const docs = await findMany('onboarding_documents', { recordId: new ObjectId(req.params.id), recordType: 'onboarding' }, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, docs);
};

const verifyDocument = async (req, res) => {
  const doc = await findOne('onboarding_documents', { _id: new ObjectId(req.params.id) });
  if (!doc) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('onboarding_documents', { _id: doc._id }, { $set: { status: 'verified' } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

module.exports = {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, uploadTemplateResource,
  createRecord, listRecords, getRecord, updateRecordTask, addRecordTask, updateWelcome,
  getMyOnboarding, updateMyTask, uploadMyDocument, uploadRecordDocument, updateMeetTheTeam,
  listRecordDocuments, verifyDocument, getAnalytics,
  computeProgress, enrichEmployee, isHR,
};
