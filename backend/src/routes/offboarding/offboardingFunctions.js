const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 4) — offboarding_templates, offboarding_records (+ offboarding_task_lists/
// offboarding_tasks/offboarding_asset_checklist/offboarding_access_revocation/
// offboarding_generated_documents), onboarding_documents, employees, users all now
// live in Postgres. expense_claims/purchase_requests (via getOpenSpendItems) are
// unmigrated (own future Spend phase) and stay on the Mongo helper — ObjectId is
// still needed to call into it correctly.
const { knex, newId, insertOne, updateOne } = require('../../functions/Database/pgDBFunctions');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');
const { initiateOffboarding, notifyStakeholder } = require('../../lib/offboarding/autoAssignTasks');
const { getOpenSpendItems } = require('../../lib/spend/clearanceCheck');
const { generateExperienceLetter, generateRelievingLetter, generateClearanceCertificate } = require('../../lib/offboarding/generateDocument');

// Reconstructs the Mongo-shaped nested arrays from their real child tables — same
// idiom (and same reasoning) as onboardingFunctions.js's attachTaskLists.
const attachTaskLists = async (record) => {
  if (!record) return record;
  const lists = await knex('offboarding_task_lists').where({ recordId: record.id }).orderBy('id');
  const tasks = lists.length
    ? await knex('offboarding_tasks').whereIn('taskListId', lists.map((l) => l.id)).orderBy('id')
    : [];
  const tasksByListId = {};
  for (const t of tasks) (tasksByListId[t.taskListId] ||= []).push(t);
  const taskLists = lists.map((l) => ({
    id: l.listKey, _internalId: l.id, name: l.name, assignedTo: l.assignedTo,
    tasks: (tasksByListId[l.id] || []).map((t) => ({
      id: t.taskKey, _internalId: t.id, title: t.title, description: t.description, dueDate: t.dueDate,
      isRequired: t.isRequired, status: t.status, completedBy: t.completedBy, completedAt: t.completedAt,
      requiresDocument: t.requiresDocument, documentId: t.documentId, notes: t.notes,
      category: t.category, taskType: t.taskType,
    })),
  }));
  return { ...record, taskLists };
};

const attachChecklists = async (record) => {
  if (!record) return record;
  const [assetChecklist, accessRevocationList, generatedDocuments] = await Promise.all([
    knex('offboarding_asset_checklist').where({ recordId: record.id }).orderBy('id'),
    knex('offboarding_access_revocation').where({ recordId: record.id }).orderBy('id'),
    knex('offboarding_generated_documents').where({ recordId: record.id }).orderBy('id'),
  ]);
  return {
    ...record,
    assetChecklist: assetChecklist.map((a) => ({
      id: a.itemKey, _internalId: a.id, item: a.item, category: a.category, returned: a.returned,
      returnedAt: a.returnedAt, returnedTo: a.returnedTo, condition: a.condition, notes: a.notes,
    })),
    accessRevocationList: accessRevocationList.map((a) => ({
      id: a.itemKey, _internalId: a.id, system: a.system, category: a.category, revoked: a.revoked,
      revokedAt: a.revokedAt, revokedBy: a.revokedBy,
    })),
    generatedDocuments: generatedDocuments.map((g) => ({ type: g.type, fileUrl: g.fileUrl, generatedAt: g.generatedAt })),
  };
};

const attachAll = async (record) => attachChecklists(await attachTaskLists(record));

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
  const employee = await knex('employees').where({ id: String(record.employeeId) })
    .select('fullName', 'staffNumber', 'department', 'designation', 'dateOfHire', 'email').first();
  return { ...record, employee: employee || null };
};

// ══════════════════════════════════════════════════════════════════════════════
//  TEMPLATES
// ══════════════════════════════════════════════════════════════════════════════

const listTemplates = async (req, res) => {
  const templates = await knex('offboarding_templates').orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, templates);
};

const getTemplate = async (req, res) => {
  const template = await knex('offboarding_templates').where({ id: req.params.id }).first();
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
    id: newId(),
    name: name.trim(),
    exitTypes,
    taskLists: JSON.stringify(withGeneratedIds(taskLists)),
    assetChecklist: JSON.stringify(withGeneratedItemIds(assetChecklist)),
    accessRevocationList: JSON.stringify(withGeneratedItemIds(accessRevocationList)),
    documentsToGenerate: documentsToGenerate || [],
    createdBy: req.user?.id || null,
    createdAt: new Date(),
  };
  const result = await insertOne('offboarding_templates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const updateTemplate = async (req, res) => {
  const existing = await knex('offboarding_templates').where({ id: req.params.id }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const { name, exitTypes, taskLists, assetChecklist, accessRevocationList, documentsToGenerate } = req.body;
  const update = { updatedAt: new Date() };
  if (name !== undefined)  update.name = name.trim();
  if (exitTypes !== undefined) update.exitTypes = exitTypes;
  if (taskLists !== undefined) update.taskLists = JSON.stringify(withGeneratedIds(taskLists));
  if (assetChecklist !== undefined) update.assetChecklist = JSON.stringify(withGeneratedItemIds(assetChecklist));
  if (accessRevocationList !== undefined) update.accessRevocationList = JSON.stringify(withGeneratedItemIds(accessRevocationList));
  if (documentsToGenerate !== undefined) update.documentsToGenerate = documentsToGenerate;
  await updateOne('offboarding_templates', { id: existing.id }, update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteTemplate = async (req, res) => {
  const existing = await knex('offboarding_templates').where({ id: req.params.id }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('offboarding_templates').where({ id: existing.id }).del();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  RECORDS
// ══════════════════════════════════════════════════════════════════════════════

const createRecord = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'templateId', 'exitType', 'lastWorkingDay'])) return;
  const { employeeId, templateId, exitType, exitReason, lastWorkingDay } = req.body;

  const activeExisting = await knex('offboarding_records')
    .where({ employeeId: String(employeeId) }).whereNot({ status: 'completed' }).first();
  if (activeExisting) return returnFunction(res, 409, false, 'This employee already has an active offboarding record.');

  let record;
  try {
    record = await initiateOffboarding(employeeId, templateId, lastWorkingDay, exitType, exitReason, req.user?.id);
  } catch (err) {
    return returnFunction(res, 400, false, err.message || 'Could not start offboarding.');
  }
  return returnFunction(res, 201, true, 'Offboarding started.', { _id: record.id });
};

const listRecords = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  let query = knex('offboarding_records');
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.exitType) query = query.where({ exitType: req.query.exitType });

  const [{ count }] = await query.clone().count('* as count');
  const records = await query.orderBy('createdAt', 'desc').limit(limit).offset(skip);

  let enriched = await Promise.all(records.map(async (r) => enrichEmployee(computeProgress(await attachAll(r)))));
  if (req.query.department) {
    enriched = enriched.filter(r => r.employee?.department === req.query.department);
  }
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getRecord = async (req, res) => {
  const record = await knex('offboarding_records').where({ id: req.params.id }).first();
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  const enriched = await enrichEmployee(computeProgress(await attachAll(record)));
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

  const record = await knex('offboarding_records').where({ id: req.params.id }).first();
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const list = await knex('offboarding_task_lists').where({ recordId: record.id, listKey: taskListId }).first();
  const task = list && await knex('offboarding_tasks').where({ taskListId: list.id, taskKey: taskId }).first();
  if (!list || !task) return returnFunction(res, 404, false, 'Task not found on this record.');

  if (status === 'completed' && task.taskType === 'spend_clearance') {
    // expense_claims/purchase_requests are still Mongo — they expect a real ObjectId.
    const { hasOpenItems, openClaims, openRequests } = await getOpenSpendItems(new ObjectId(record.employeeId));
    if (hasOpenItems) {
      return returnFunction(res, 400, false,
        `Cannot clear: ${openClaims.length} expense claim(s) and ${openRequests.length} purchase request(s) are still open. Approve or reject them first.`);
    }
  }

  const now = new Date();
  const taskUpdate = {
    status,
    completedAt: status === 'completed' ? now : null,
    completedBy: status === 'completed' ? (req.user?.id || null) : null,
  };
  if (notes !== undefined) taskUpdate.notes = notes;
  await knex('offboarding_tasks').where({ id: task.id }).update(taskUpdate);

  const recordUpdate = { updatedAt: now };
  if (record.status === 'initiated') recordUpdate.status = 'inProgress';
  await knex('offboarding_records').where({ id: record.id }).update(recordUpdate);

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

  const record = await attachTaskLists(await knex('offboarding_records').where({ id: req.params.id }).first());
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const now = new Date();
  const taskKey = crypto.randomUUID();

  const explicitList = taskListId ? await knex('offboarding_task_lists').where({ recordId: record.id, listKey: taskListId }).first() : null;
  const matchingListKey = explicitList ? explicitList.listKey : record.taskLists.find(l => l.assignedTo === assignedTo)?.id;
  const matchingList = matchingListKey ? await knex('offboarding_task_lists').where({ recordId: record.id, listKey: matchingListKey }).first() : null;

  if (matchingList) {
    await knex('offboarding_tasks').insert({
      taskListId: matchingList.id, taskKey, title, description: description || '',
      dueDate: dueDate ? new Date(dueDate) : now, isRequired: isRequired !== false,
      status: 'pending', completedBy: null, completedAt: null,
      category: category || 'general', taskType: null, requiresDocument: !!requiresDocument, documentId: null,
    });
  } else {
    const [newList] = await knex('offboarding_task_lists').insert({
      recordId: record.id, listKey: crypto.randomUUID(), name: 'Additional Tasks', assignedTo,
    }).returning('id');
    await knex('offboarding_tasks').insert({
      taskListId: newList.id ?? newList, taskKey, title, description: description || '',
      dueDate: dueDate ? new Date(dueDate) : now, isRequired: isRequired !== false,
      status: 'pending', completedBy: null, completedAt: null,
      category: category || 'general', taskType: null, requiresDocument: !!requiresDocument, documentId: null,
    });
  }
  await knex('offboarding_records').where({ id: record.id }).update({ updatedAt: now });

  const employee = await knex('employees').where({ id: String(record.employeeId) }).select('fullName').first();
  notifyStakeholder(assignedTo, record.employeeId, {
    title: `Offboarding: ${employee?.fullName ?? 'Employee'}`,
    body: `New task added: "${title}"`,
    type: 'offboarding',
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { taskId: taskKey });
};

const updateAsset = async (req, res) => {
  const record = await knex('offboarding_records').where({ id: req.params.id }).first();
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  const { returned, condition, notes } = req.body;
  const now = new Date();
  await knex('offboarding_asset_checklist').where({ recordId: record.id, itemKey: req.params.assetId }).update({
    returned: !!returned,
    returnedAt: returned ? now : null,
    returnedTo: returned ? (req.user?.id || null) : null,
    condition: condition ?? null,
    notes: notes ?? null,
  });
  await knex('offboarding_records').where({ id: record.id }).update({ updatedAt: now });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const updateAccess = async (req, res) => {
  const record = await knex('offboarding_records').where({ id: req.params.id }).first();
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  const { revoked } = req.body;
  const now = new Date();
  await knex('offboarding_access_revocation').where({ recordId: record.id, itemKey: req.params.accessId }).update({
    revoked: !!revoked,
    revokedAt: revoked ? now : null,
    revokedBy: revoked ? (req.user?.id || null) : null,
  });
  await knex('offboarding_records').where({ id: record.id }).update({ updatedAt: now });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const updateRehire = async (req, res) => {
  const record = await knex('offboarding_records').where({ id: req.params.id }).first();
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('offboarding_records').where({ id: record.id }).update({ eligibleForRehire: !!req.body.eligibleForRehire, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Document generation (Step 10) ─────────────────────────────────────────────

const generateDocument = async (req, res) => {
  if (!validateRequiredFields(req, res, ['type'])) return;
  const { type } = req.body;
  const record = await attachChecklists(await knex('offboarding_records').where({ id: req.params.id }).first());
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  const employee = await knex('employees').where({ id: String(record.employeeId) })
    .select('fullName', 'designation', 'department', 'dateOfHire').first();
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  let fileUrl;
  if (type === 'experienceLetter') {
    fileUrl = await generateExperienceLetter(record.id, { ...employee, lastWorkingDay: record.lastWorkingDay });
  } else if (type === 'relievingLetter') {
    fileUrl = await generateRelievingLetter(record.id, { ...employee, lastWorkingDay: record.lastWorkingDay });
  } else if (type === 'clearanceCertificate') {
    fileUrl = await generateClearanceCertificate(record.id, { ...employee, assetChecklist: record.assetChecklist, accessRevocationList: record.accessRevocationList });
  } else if (type === 'finalPayslip') {
    return returnFunction(res, 400, false, 'Final payslips are generated from the Payroll module once the final pay run is processed, not here.');
  } else {
    return returnFunction(res, 400, false, 'Invalid document type.');
  }

  const generatedDoc = { type, generatedAt: new Date(), fileUrl };
  await knex('offboarding_generated_documents').insert({ recordId: record.id, ...generatedDoc });
  await knex('offboarding_records').where({ id: record.id }).update({ updatedAt: new Date() });
  return returnFunction(res, 201, true, 'Document generated.', generatedDoc);
};

// ── Final pay trigger (Step 11) — flags Payroll/Finance rather than reaching
// into the payroll module's request-coupled cycle-creation logic directly. ────

const triggerFinalPay = async (req, res) => {
  const record = await knex('offboarding_records').where({ id: req.params.id }).first();
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  if (record.finalPayTriggered) return returnFunction(res, 400, false, 'Final pay has already been triggered for this employee.');

  const employee = await knex('employees').where({ id: String(record.employeeId) }).select('fullName').first();
  const now = new Date();
  await knex('offboarding_records').where({ id: record.id }).update({ finalPayTriggered: true, finalPayTriggeredAt: now, updatedAt: now });

  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Final Pay Required',
    body: `${employee?.fullName ?? 'An employee'}'s final pay needs to be processed (last working day ${new Date(record.lastWorkingDay).toDateString()}). Create an off-cycle payroll run from the Payroll module.`,
    type: 'offboarding',
  }).catch(() => {});

  {
    const hrUsers = await knex('users').whereIn('role', ['super_admin', 'hr_manager']).whereNot({ isActive: false }).select('email');
    const tokens = { employeeName: employee?.fullName ?? 'An employee', lastWorkingDay: new Date(record.lastWorkingDay).toDateString() };
    hrUsers.filter(u => u.email).forEach(u => sendTemplatedEmail({
      trigger: 'offboardingFinalPayRequired', to: u.email, tokens,
      fallbackSubject: `Final pay required — ${tokens.employeeName}`,
      fallbackHtml: `<p>${tokens.employeeName}'s final pay needs to be processed (last working day ${tokens.lastWorkingDay}). Create an off-cycle payroll run from the Payroll module.</p>`,
    }).catch(() => {}));
  }

  return returnFunction(res, 200, true, 'Final pay flagged for Payroll.');
};

// ── Complete record (explicit HR action — closes the record, deactivates employee) ─

const completeRecord = async (req, res) => {
  const record = await knex('offboarding_records').where({ id: req.params.id }).first();
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);
  if (record.status === 'completed') return returnFunction(res, 400, false, 'This record is already completed.');

  const progressed = computeProgress(await attachTaskLists(record));
  const requiredTasks = progressed.taskLists.flatMap(l => l.tasks).filter(t => t.isRequired);
  const incompleteRequired = requiredTasks.filter(t => t.status !== 'completed');
  if (incompleteRequired.length) {
    return returnFunction(res, 400, false, `${incompleteRequired.length} required task(s) are not yet complete.`);
  }

  const now = new Date();
  await knex('offboarding_records').where({ id: record.id }).update({ status: 'completed', completedAt: now, updatedAt: now });
  await knex('employees').where({ id: String(record.employeeId) }).update({ status: 'inactive', updatedAt: now });
  // The notification below has always said "account has been deactivated" — actually do it.
  await knex('users').where({ employeeId: String(record.employeeId) }).update({ isActive: false });

  const employee = await knex('employees').where({ id: String(record.employeeId) }).select('fullName').first();
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
  const records = await Promise.all((await knex('offboarding_records')).map(attachChecklists));

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
  const record = await knex('offboarding_records').where({ employeeId: String(req.user.employeeId) }).orderBy('createdAt', 'desc').first();
  if (!record) return returnFunction(res, 200, true, req.locale.success, null);

  const progressed = computeProgress(await attachAll(record));
  const myTaskList = progressed.taskLists.filter(l => l.assignedTo === 'employee');
  // Employees can see whether documents have been generated + download them, but
  // never the HR/IT/manager/finance task lists.
  return returnFunction(res, 200, true, req.locale.success, { ...progressed, taskLists: myTaskList });
};

const updateMyTask = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 403, false, 'No employee record linked.');
  const { taskId } = req.params;

  const record = await attachTaskLists(await knex('offboarding_records').where({ employeeId: String(req.user.employeeId) }).orderBy('createdAt', 'desc').first());
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const owningList = record.taskLists.find(l => l.tasks.some(t => t.id === taskId));
  if (!owningList || owningList.assignedTo !== 'employee') {
    return returnFunction(res, 403, false, 'You cannot update this task.');
  }

  const now = new Date();
  const listRow = await knex('offboarding_task_lists').where({ recordId: record.id, listKey: owningList.id }).first();
  await knex('offboarding_tasks').where({ taskListId: listRow.id, taskKey: taskId }).update({
    status: 'completed', completedAt: now, completedBy: req.user?.id || null,
  });
  const recordUpdate = { updatedAt: now };
  if (record.status === 'initiated') recordUpdate.status = 'inProgress';
  await knex('offboarding_records').where({ id: record.id }).update(recordUpdate);

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Employee uploads a document for their own employee-assigned task — mirrors
// onboarding's uploadMyDocument exactly, sharing the same onboarding_documents
// table (discriminated by recordType) so HR review/verify works identically.
const uploadMyDocument = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 403, false, 'No employee record linked.');
  if (!validateRequiredFields(req, res, ['taskId'])) return;
  if (!req.file) return returnFunction(res, 400, false, 'A file is required.');

  const record = await attachTaskLists(await knex('offboarding_records').where({ employeeId: String(req.user.employeeId) }).orderBy('createdAt', 'desc').first());
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const owningList = record.taskLists.find(l => l.tasks.some(t => t.id === req.body.taskId));
  const task = owningList?.tasks.find(t => t.id === req.body.taskId);
  if (!owningList || owningList.assignedTo !== 'employee' || !task) {
    return returnFunction(res, 403, false, 'You cannot upload a document for this task.');
  }

  const docResult = await insertOne('onboarding_documents', {
    id: newId(), employeeId: String(req.user.employeeId), recordId: record.id, recordType: 'offboarding',
    taskId: req.body.taskId, name: task.title, type: 'upload', fileUrl: `/uploads/${req.file.filename}`,
    signedAt: null, signedBy: null, status: 'uploaded', uploadedAt: new Date(), createdAt: new Date(),
  });

  const listRow = await knex('offboarding_task_lists').where({ recordId: record.id, listKey: owningList.id }).first();
  await knex('offboarding_tasks').where({ taskListId: listRow.id, taskKey: req.body.taskId }).update({ documentId: docResult.id });
  await knex('offboarding_records').where({ id: record.id }).update({ updatedAt: new Date() });

  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Offboarding Document Uploaded',
    body: `A document was uploaded for task "${task.title}".`,
    type: 'general',
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: docResult.id });
};

// HR uploads a document on behalf of any task, regardless of assignee — same
// idiom as onboarding's uploadRecordDocument.
const uploadRecordDocument = async (req, res) => {
  if (!validateRequiredFields(req, res, ['taskId'])) return;
  if (!req.file) return returnFunction(res, 400, false, 'A file is required.');

  const record = await attachTaskLists(await knex('offboarding_records').where({ id: req.params.id }).first());
  if (!record) return returnFunction(res, 404, false, req.locale.notFound);

  const owningList = record.taskLists.find(l => l.tasks.some(t => t.id === req.body.taskId));
  const task = owningList?.tasks.find(t => t.id === req.body.taskId);
  if (!owningList || !task) return returnFunction(res, 404, false, 'Task not found on this record.');

  const docResult = await insertOne('onboarding_documents', {
    id: newId(), employeeId: String(record.employeeId), recordId: record.id, recordType: 'offboarding',
    taskId: req.body.taskId, name: task.title, type: 'upload', fileUrl: `/uploads/${req.file.filename}`,
    signedAt: null, signedBy: null, status: 'uploaded', uploadedAt: new Date(), createdAt: new Date(),
  });

  const listRow = await knex('offboarding_task_lists').where({ recordId: record.id, listKey: owningList.id }).first();
  await knex('offboarding_tasks').where({ taskListId: listRow.id, taskKey: req.body.taskId }).update({ documentId: docResult.id });
  await knex('offboarding_records').where({ id: record.id }).update({ updatedAt: new Date() });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: docResult.id });
};

// ── Documents (HR view — supports the Record Detail "Documents" tab) ──────────

const listRecordDocuments = async (req, res) => {
  const docs = await knex('onboarding_documents').where({ recordId: req.params.id, recordType: 'offboarding' }).orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, docs);
};

const verifyDocument = async (req, res) => {
  const doc = await knex('onboarding_documents').where({ id: req.params.id }).first();
  if (!doc) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('onboarding_documents').where({ id: doc.id }).update({ status: 'verified' });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// One submission only — cannot edit after (Step 9)
const submitExitInterview = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 403, false, 'No employee record linked.');
  if (!validateRequiredFields(req, res, ['reasonForLeaving', 'jobSatisfactionRating', 'managementRating', 'wouldRecommendCompany'])) return;

  const record = await knex('offboarding_records').where({ employeeId: String(req.user.employeeId) }).orderBy('createdAt', 'desc').first();
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
  await knex('offboarding_records').where({ id: record.id }).update({ exitInterview: JSON.stringify(exitInterview), updatedAt: now });

  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Exit Interview Submitted',
    body: 'An employee has submitted their exit interview.',
    type: 'offboarding',
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Exit interview submitted. Thank you for your feedback.');
};

const getMyDocuments = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const record = await knex('offboarding_records').where({ employeeId: String(req.user.employeeId) }).orderBy('createdAt', 'desc').first();
  if (!record) return returnFunction(res, 200, true, req.locale.success, []);
  // Employees only ever see experience/relieving letters — clearance certificates
  // are an internal HR/finance document, not something to hand to the departing employee.
  const generatedDocuments = await knex('offboarding_generated_documents').where({ recordId: record.id });
  const visible = generatedDocuments.filter(d => ['experienceLetter', 'relievingLetter'].includes(d.type));
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
