const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, deleteOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { initiateOffboarding, notifyStakeholder } = require('../../lib/offboarding/autoAssignTasks');
const { getOpenSpendItems } = require('../../lib/spend/clearanceCheck');
const { generateExperienceLetter, generateRelievingLetter, generateClearanceCertificate } = require('../../lib/offboarding/generateDocument');

// A task counts as overdue for display if it isn't finished and its due date has
// passed — computed at read time, same idiom as the onboarding module.
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
  const employee = await findOne('employees', { _id: record.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1, dateOfHire: 1, email: 1 } });
  return { ...record, employee: employee || null };
};

// ══════════════════════════════════════════════════════════════════════════════
//  TEMPLATES
// ══════════════════════════════════════════════════════════════════════════════

const listTemplates = async (req, res) => {
  const templates = await findMany('offboarding_templates', {}, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, templates);
};

const getTemplate = async (req, res) => {
  const template = await findOne('offboarding_templates', { _id: new ObjectId(req.params.id) });
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
    category: t.category || 'general',
    taskType: t.taskType || null,
    requiresDocument: !!t.requiresDocument,
  })),
}));

const withGeneratedItemIds = (items = []) => items.map(i => ({ ...i, id: i.id || crypto.randomUUID() }));

const createTemplate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'exitTypes'])) return;
  const { name, exitTypes, taskLists, assetChecklist, accessRevocationList, documentsToGenerate } = req.body;
  if (!Array.isArray(exitTypes) || !exitTypes.length) return returnFunction(res, 400, false, 'Select at least one exit type.');
  const doc = {
    name: name.trim(),
    exitTypes,
    taskLists: withGeneratedIds(taskLists),
    assetChecklist: withGeneratedItemIds(assetChecklist),
    accessRevocationList: withGeneratedItemIds(accessRevocationList),
    documentsToGenerate: documentsToGenerate || [],
    createdBy: req.user?._id || null,
    createdAt: new Date(),
  };
  const result = await insertOne('offboarding_templates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateTemplate = async (req, res) => {
  const existing = await findOne('offboarding_templates', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const { name, exitTypes, taskLists, assetChecklist, accessRevocationList, documentsToGenerate } = req.body;
  const update = {};
  if (name !== undefined)  update.name = name.trim();
  if (exitTypes !== undefined) update.exitTypes = exitTypes;
  if (taskLists !== undefined) update.taskLists = withGeneratedIds(taskLists);
  if (assetChecklist !== undefined) update.assetChecklist = withGeneratedItemIds(assetChecklist);
  if (accessRevocationList !== undefined) update.accessRevocationList = withGeneratedItemIds(accessRevocationList);
  if (documentsToGenerate !== undefined) update.documentsToGenerate = documentsToGenerate;
  await updateOne('offboarding_templates', { _id: existing._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteTemplate = async (req, res) => {
  const existing = await findOne('offboarding_templates', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await deleteOne('offboarding_templates', { _id: existing._id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  RECORDS
// ══════════════════════════════════════════════════════════════════════════════

const createRecord = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'templateId', 'exitType', 'lastWorkingDay'])) return;
  const { employeeId, templateId, exitType, exitReason, lastWorkingDay } = req.body;

  const activeExisting = await findOne('offboarding_records', {
    employeeId: new ObjectId(employeeId),
    status: { $ne: 'completed' },
  });
  if (activeExisting) return returnFunction(res, 409, false, 'This employee already has an active offboarding record.');

  let record;
  try {
    record = await initiateOffboarding(employeeId, templateId, lastWorkingDay, exitType, exitReason, req.user?._id);
  } catch (err) {
    return returnFunction(res, 400, false, err.message || 'Could not start offboarding.');
  }
  return returnFunction(res, 201, true, 'Offboarding started.', { _id: record._id });
};

const listRecords = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.exitType) filter.exitType = req.query.exitType;

  const [total, records] = await Promise.all([
    countDocuments('offboarding_records', filter),
    findMany('offboarding_records', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  let enriched = await Promise.all(records.map(r => enrichEmployee(computeProgress(r))));
  if (req.query.department) {
    enriched = enriched.filter(r => r.employee?.department === req.query.department);
  }
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getRecord = async (req, res) => {
  const record = await findOne('offboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  const enriched = await enrichEmployee(computeProgress(record));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// HR updates a task's status — body: { taskListId, taskId, status, notes }
// The 'spend_clearance' taskType is ported from the old system: it cannot be
// marked complete while the employee has an open expense claim or purchase request.
const updateRecordTask = async (req, res) => {
  if (!validateRequiredFields(req, res, ['taskListId', 'taskId', 'status'])) return;
  const { taskListId, taskId, status, notes } = req.body;
  const VALID = ['pending', 'inProgress', 'completed'];
  if (!VALID.includes(status)) return returnFunction(res, 400, false, 'Invalid status.');

  const record = await findOne('offboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  if (status === 'completed') {
    const list = record.taskLists.find(l => l.id === taskListId);
    const task = list?.tasks.find(t => t.id === taskId);
    if (task?.taskType === 'spend_clearance') {
      const { hasOpenItems, openClaims, openRequests } = await getOpenSpendItems(record.employeeId);
      if (hasOpenItems) {
        return returnFunction(res, 400, false,
          `Cannot clear: ${openClaims.length} expense claim(s) and ${openRequests.length} purchase request(s) are still open. Approve or reject them first.`);
      }
    }
  }

  const now = new Date();
  const setFields = {
    'taskLists.$[list].tasks.$[task].status': status,
    'taskLists.$[list].tasks.$[task].completedAt': status === 'completed' ? now : null,
    'taskLists.$[list].tasks.$[task].completedBy': status === 'completed' ? (req.user?._id ? new ObjectId(req.user._id) : null) : null,
    updatedAt: now,
  };
  if (notes !== undefined) setFields['taskLists.$[list].tasks.$[task].notes'] = notes;
  if (record.status === 'initiated') setFields.status = 'inProgress';

  await global.dbo.collection('offboarding_records').updateOne(
    { _id: record._id },
    { $set: setFields },
    { arrayFilters: [{ 'list.id': taskListId }, { 'task.id': taskId }] }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// HR adds a one-off custom task directly to an already-initiated record — same
// idiom as onboarding's addRecordTask. Offboarding never auto-completes, so
// there's no "reopen on new task" concern here.
const addRecordTask = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'assignedTo'])) return;
  const VALID_ASSIGNEES = ['hr', 'it', 'manager', 'finance', 'employee'];
  const { title, description, dueDate, isRequired, assignedTo, taskListId, category, requiresDocument } = req.body;
  if (!VALID_ASSIGNEES.includes(assignedTo)) return returnFunction(res, 400, false, 'Invalid assignedTo.');
  // Any assignee can require a document now: the employee themselves can upload via
  // /my/document for their own tasks, and HR can upload on behalf of any other
  // assignee's task via uploadRecordDocument.

  const record = await findOne('offboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const now = new Date();
  const newTask = {
    id: crypto.randomUUID(),
    title, description: description || '',
    dueDate: dueDate ? new Date(dueDate) : now,
    isRequired: isRequired !== false,
    status: 'pending', completedBy: null, completedAt: null,
    category: category || 'general', taskType: null,
    requiresDocument: !!requiresDocument, documentId: null,
  };

  const explicitList = taskListId ? record.taskLists.find(l => l.id === taskListId) : null;
  const matchingList = explicitList || record.taskLists.find(l => l.assignedTo === assignedTo);

  if (matchingList) {
    await global.dbo.collection('offboarding_records').updateOne(
      { _id: record._id, 'taskLists.id': matchingList.id },
      { $push: { 'taskLists.$.tasks': newTask }, $set: { updatedAt: now } }
    );
  } else {
    const newList = { id: crypto.randomUUID(), name: 'Additional Tasks', assignedTo, tasks: [newTask] };
    await global.dbo.collection('offboarding_records').updateOne(
      { _id: record._id },
      { $push: { taskLists: newList }, $set: { updatedAt: now } }
    );
  }

  const employee = await findOne('employees', { _id: record.employeeId }, { projection: { fullName: 1 } });
  notifyStakeholder(assignedTo, record.employeeId, {
    title: `Offboarding: ${employee?.fullName ?? 'Employee'}`,
    body: `New task added: "${title}"`,
    type: 'offboarding',
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { taskId: newTask.id });
};

const updateAsset = async (req, res) => {
  const record = await findOne('offboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  const { returned, condition, notes } = req.body;
  const now = new Date();
  await global.dbo.collection('offboarding_records').updateOne(
    { _id: record._id, 'assetChecklist.id': req.params.assetId },
    {
      $set: {
        'assetChecklist.$.returned': !!returned,
        'assetChecklist.$.returnedAt': returned ? now : null,
        'assetChecklist.$.returnedTo': returned ? (req.user?._id ? new ObjectId(req.user._id) : null) : null,
        'assetChecklist.$.condition': condition ?? null,
        'assetChecklist.$.notes': notes ?? null,
        updatedAt: now,
      },
    }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const updateAccess = async (req, res) => {
  const record = await findOne('offboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  const { revoked } = req.body;
  const now = new Date();
  await global.dbo.collection('offboarding_records').updateOne(
    { _id: record._id, 'accessRevocationList.id': req.params.accessId },
    {
      $set: {
        'accessRevocationList.$.revoked': !!revoked,
        'accessRevocationList.$.revokedAt': revoked ? now : null,
        'accessRevocationList.$.revokedBy': revoked ? (req.user?._id ? new ObjectId(req.user._id) : null) : null,
        updatedAt: now,
      },
    }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const updateRehire = async (req, res) => {
  const record = await findOne('offboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('offboarding_records', { _id: record._id }, { $set: { eligibleForRehire: !!req.body.eligibleForRehire, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Document generation (Step 10) ─────────────────────────────────────────────

const generateDocument = async (req, res) => {
  if (!validateRequiredFields(req, res, ['type'])) return;
  const { type } = req.body;
  const record = await findOne('offboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  const employee = await findOne('employees', { _id: record.employeeId }, { projection: { fullName: 1, designation: 1, department: 1, dateOfHire: 1 } });
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  let fileUrl;
  if (type === 'experienceLetter') {
    fileUrl = await generateExperienceLetter(record._id, { ...employee, lastWorkingDay: record.lastWorkingDay });
  } else if (type === 'relievingLetter') {
    fileUrl = await generateRelievingLetter(record._id, { ...employee, lastWorkingDay: record.lastWorkingDay });
  } else if (type === 'clearanceCertificate') {
    fileUrl = await generateClearanceCertificate(record._id, { ...employee, assetChecklist: record.assetChecklist, accessRevocationList: record.accessRevocationList });
  } else if (type === 'finalPayslip') {
    return returnFunction(res, 400, false, 'Final payslips are generated from the Payroll module once the final pay run is processed, not here.');
  } else {
    return returnFunction(res, 400, false, 'Invalid document type.');
  }

  const generatedDoc = { type, generatedAt: new Date(), fileUrl };
  await updateOne('offboarding_records', { _id: record._id }, { $push: { generatedDocuments: generatedDoc }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 201, true, 'Document generated.', generatedDoc);
};

// ── Final pay trigger (Step 11) — flags Payroll/Finance rather than reaching
// into the payroll module's request-coupled cycle-creation logic directly. ────

const triggerFinalPay = async (req, res) => {
  const record = await findOne('offboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  if (record.finalPayTriggered) return returnFunction(res, 400, false, 'Final pay has already been triggered for this employee.');

  const employee = await findOne('employees', { _id: record.employeeId }, { projection: { fullName: 1 } });
  const now = new Date();
  await updateOne('offboarding_records', { _id: record._id }, { $set: { finalPayTriggered: true, finalPayTriggeredAt: now, updatedAt: now } });

  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Final Pay Required',
    body: `${employee?.fullName ?? 'An employee'}'s final pay needs to be processed (last working day ${new Date(record.lastWorkingDay).toDateString()}). Create an off-cycle payroll run from the Payroll module.`,
    type: 'offboarding',
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Final pay flagged for Payroll.');
};

// ── Complete record (explicit HR action — closes the record, deactivates employee) ─

const completeRecord = async (req, res) => {
  const record = await findOne('offboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  if (record.status === 'completed') return returnFunction(res, 400, false, 'This record is already completed.');

  const progressed = computeProgress(record);
  const requiredTasks = progressed.taskLists.flatMap(l => l.tasks).filter(t => t.isRequired);
  const incompleteRequired = requiredTasks.filter(t => t.status !== 'completed');
  if (incompleteRequired.length) {
    return returnFunction(res, 400, false, `${incompleteRequired.length} required task(s) are not yet complete.`);
  }

  const now = new Date();
  await updateOne('offboarding_records', { _id: record._id }, { $set: { status: 'completed', completedAt: now, updatedAt: now } });
  await updateOne('employees', { _id: record.employeeId }, { $set: { status: 'inactive', updatedAt: now } });
  // The notification below has always said "account has been deactivated" — actually do it.
  await global.dbo.collection('users').updateMany({ employeeId: record.employeeId }, { $set: { isActive: false } });

  const employee = await findOne('employees', { _id: record.employeeId }, { projection: { fullName: 1 } });
  if (employee) {
    notifyByRoles(['super_admin', 'hr_manager'], {
      title: 'Offboarding Complete',
      body: `${employee.fullName}'s offboarding is complete. Their account has been deactivated.`,
      type: 'offboarding',
    }).catch(() => {});
  }

  return returnFunction(res, 200, true, 'Offboarding complete. Employee marked inactive.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  ANALYTICS
// ══════════════════════════════════════════════════════════════════════════════

const getAnalytics = async (req, res) => {
  const records = await findMany('offboarding_records', {}, {});

  // Exit type breakdown
  const exitTypeCounts = {};
  for (const r of records) exitTypeCounts[r.exitType] = (exitTypeCounts[r.exitType] || 0) + 1;
  const exitTypeBreakdown = Object.entries(exitTypeCounts).map(([exitType, count]) => ({ exitType, count }));

  // Avg completion time (days) — from notice period start to completion
  const completed = records.filter(r => r.status === 'completed' && r.completedAt);
  const avgCompletionDays = completed.length
    ? Math.round((completed.reduce((s, r) => s + (new Date(r.completedAt) - new Date(r.noticePeriodStartDate)) / (1000 * 60 * 60 * 24), 0) / completed.length) * 10) / 10
    : null;

  // Outstanding assets/access across all non-completed records
  const active = records.filter(r => r.status !== 'completed');
  const assetsOutstanding = active.reduce((s, r) => s + (r.assetChecklist || []).filter(a => !a.returned).length, 0);
  const accessesOutstanding = active.reduce((s, r) => s + (r.accessRevocationList || []).filter(a => !a.revoked).length, 0);

  // Exit interview sentiment
  const withInterview = records.filter(r => r.exitInterview?.completedAt);
  const exitInterviewSentiment = {
    responseCount: withInterview.length,
    avgJobSatisfaction: withInterview.length ? Math.round((withInterview.reduce((s, r) => s + r.exitInterview.jobSatisfactionRating, 0) / withInterview.length) * 10) / 10 : null,
    avgManagementRating: withInterview.length ? Math.round((withInterview.reduce((s, r) => s + r.exitInterview.managementRating, 0) / withInterview.length) * 10) / 10 : null,
    wouldRecommendPct: withInterview.length ? Math.round((withInterview.filter(r => r.exitInterview.wouldRecommendCompany).length / withInterview.length) * 100) : null,
  };

  return returnFunction(res, 200, true, req.locale.success, {
    exitTypeBreakdown, avgCompletionDays, assetsOutstanding, accessesOutstanding, exitInterviewSentiment,
  });
};

// ══════════════════════════════════════════════════════════════════════════════
//  EMPLOYEE SELF-SERVICE (own record only)
// ══════════════════════════════════════════════════════════════════════════════

const getMyOffboarding = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, null);
  const record = await findOne('offboarding_records', { employeeId: new ObjectId(req.user.employeeId) }, { sort: { createdAt: -1 } });
  if (!record) return returnFunction(res, 200, true, req.locale.success, null);

  const progressed = computeProgress(record);
  const myTaskList = progressed.taskLists.filter(l => l.assignedTo === 'employee');
  // Employees can see whether documents have been generated + download them, but
  // never the HR/IT/manager/finance task lists.
  return returnFunction(res, 200, true, req.locale.success, { ...progressed, taskLists: myTaskList });
};

const updateMyTask = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 403, false, 'No employee record linked.');
  const { taskId } = req.params;

  const record = await findOne('offboarding_records', {
    employeeId: new ObjectId(req.user.employeeId),
    'taskLists.tasks.id': taskId,
  });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const owningList = record.taskLists.find(l => l.tasks.some(t => t.id === taskId));
  if (!owningList || owningList.assignedTo !== 'employee') {
    return returnFunction(res, 403, false, 'You cannot update this task.');
  }

  const now = new Date();
  const setFields = {
    'taskLists.$[list].tasks.$[task].status': 'completed',
    'taskLists.$[list].tasks.$[task].completedAt': now,
    'taskLists.$[list].tasks.$[task].completedBy': req.user?._id ? new ObjectId(req.user._id) : null,
    updatedAt: now,
  };
  if (record.status === 'initiated') setFields.status = 'inProgress';

  await global.dbo.collection('offboarding_records').updateOne(
    { _id: record._id },
    { $set: setFields },
    { arrayFilters: [{ 'list.id': owningList.id }, { 'task.id': taskId }] }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Employee uploads a document for their own employee-assigned task — mirrors
// onboarding's uploadMyDocument exactly, sharing the same onboarding_documents
// collection (discriminated by recordType) so HR review/verify works identically.
const uploadMyDocument = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 403, false, 'No employee record linked.');
  if (!validateRequiredFields(req, res, ['taskId'])) return;
  if (!req.file) return returnFunction(res, 400, false, 'A file is required.');

  const record = await findOne('offboarding_records', {
    employeeId: new ObjectId(req.user.employeeId),
    'taskLists.tasks.id': req.body.taskId,
  });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const owningList = record.taskLists.find(l => l.tasks.some(t => t.id === req.body.taskId));
  const task = owningList?.tasks.find(t => t.id === req.body.taskId);
  if (!owningList || owningList.assignedTo !== 'employee' || !task) {
    return returnFunction(res, 403, false, 'You cannot upload a document for this task.');
  }

  const docResult = await insertOne('onboarding_documents', {
    employeeId: new ObjectId(req.user.employeeId),
    recordId: record._id,
    recordType: 'offboarding',
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

  await global.dbo.collection('offboarding_records').updateOne(
    { _id: record._id },
    { $set: { 'taskLists.$[list].tasks.$[task].documentId': docResult.insertedId, updatedAt: new Date() } },
    { arrayFilters: [{ 'list.id': owningList.id }, { 'task.id': req.body.taskId }] }
  );

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: docResult.insertedId });
};

// HR uploads a document on behalf of any task, regardless of assignee — same
// idiom as onboarding's uploadRecordDocument.
const uploadRecordDocument = async (req, res) => {
  if (!validateRequiredFields(req, res, ['taskId'])) return;
  if (!req.file) return returnFunction(res, 400, false, 'A file is required.');

  const record = await findOne('offboarding_records', { _id: new ObjectId(req.params.id) });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const owningList = record.taskLists.find(l => l.tasks.some(t => t.id === req.body.taskId));
  const task = owningList?.tasks.find(t => t.id === req.body.taskId);
  if (!owningList || !task) return returnFunction(res, 404, false, 'Task not found on this record.');

  const docResult = await insertOne('onboarding_documents', {
    employeeId: record.employeeId,
    recordId: record._id,
    recordType: 'offboarding',
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

  await global.dbo.collection('offboarding_records').updateOne(
    { _id: record._id },
    { $set: { 'taskLists.$[list].tasks.$[task].documentId': docResult.insertedId, updatedAt: new Date() } },
    { arrayFilters: [{ 'list.id': owningList.id }, { 'task.id': req.body.taskId }] }
  );

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: docResult.insertedId });
};

// ── Documents (HR view — supports the Record Detail "Documents" tab) ──────────

const listRecordDocuments = async (req, res) => {
  const docs = await findMany('onboarding_documents', { recordId: new ObjectId(req.params.id), recordType: 'offboarding' }, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, docs);
};

const verifyDocument = async (req, res) => {
  const doc = await findOne('onboarding_documents', { _id: new ObjectId(req.params.id) });
  if (!doc) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('onboarding_documents', { _id: doc._id }, { $set: { status: 'verified' } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// One submission only — cannot edit after (Step 9)
const submitExitInterview = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 403, false, 'No employee record linked.');
  if (!validateRequiredFields(req, res, ['reasonForLeaving', 'jobSatisfactionRating', 'managementRating', 'wouldRecommendCompany'])) return;

  const record = await findOne('offboarding_records', { employeeId: new ObjectId(req.user.employeeId) }, { sort: { createdAt: -1 } });
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  if (record.exitInterview?.completedAt) return returnFunction(res, 409, false, 'You have already submitted your exit interview.');

  const { reasonForLeaving, jobSatisfactionRating, managementRating, wouldRecommendCompany, suggestions, additionalComments } = req.body;
  const RATING = [1, 2, 3, 4, 5];
  if (!RATING.includes(Number(jobSatisfactionRating)) || !RATING.includes(Number(managementRating))) {
    return returnFunction(res, 400, false, 'Ratings must be between 1 and 5.');
  }

  const now = new Date();
  const exitInterview = {
    completedAt: now,
    reasonForLeaving,
    jobSatisfactionRating: Number(jobSatisfactionRating),
    managementRating: Number(managementRating),
    wouldRecommendCompany: !!wouldRecommendCompany,
    suggestions: suggestions || '',
    additionalComments: additionalComments || '',
  };
  await updateOne('offboarding_records', { _id: record._id }, { $set: { exitInterview, updatedAt: now } });

  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Exit Interview Submitted',
    body: 'An employee has submitted their exit interview.',
    type: 'offboarding',
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Exit interview submitted. Thank you for your feedback.');
};

const getMyDocuments = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const record = await findOne('offboarding_records', { employeeId: new ObjectId(req.user.employeeId) }, { sort: { createdAt: -1 } });
  if (!record) return returnFunction(res, 200, true, req.locale.success, []);
  // Employees only ever see experience/relieving letters — clearance certificates
  // are an internal HR/finance document, not something to hand to the departing employee.
  const visible = (record.generatedDocuments || []).filter(d => ['experienceLetter', 'relievingLetter'].includes(d.type));
  return returnFunction(res, 200, true, req.locale.success, visible);
};

module.exports = {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
  createRecord, listRecords, getRecord, updateRecordTask, addRecordTask, updateAsset, updateAccess, updateRehire,
  generateDocument, triggerFinalPay, completeRecord, getAnalytics,
  getMyOffboarding, updateMyTask, uploadMyDocument, uploadRecordDocument, submitExitInterview, getMyDocuments,
  listRecordDocuments, verifyDocument,
  computeProgress, enrichEmployee,
};
