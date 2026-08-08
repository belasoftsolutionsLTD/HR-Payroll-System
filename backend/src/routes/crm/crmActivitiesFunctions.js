const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
// pos_sales is Postgres now (Phase 6) — found while sweeping CRM; the rest of this
// file's tables (crm_activities/crm_contacts) stay Mongo, CRM's own phase (7).
const { knex } = require('../../functions/Database/pgDBFunctions');
const { getCrmAccessLevel, canAccessAssignee, getScopedAssigneeIds } = require('../../lib/crm/crmAccess');

const LOGGABLE_TYPES = ['call', 'email', 'meeting', 'note'];
const TASK_PRIORITIES = ['high', 'medium', 'low'];

// System-generated timeline entries (deal created/won/lost, stage changes) — called
// internally by crmDealsFunctions, not exposed as its own route. Same collection as
// human-logged activities so the contact timeline is one query, one sort, one feed.
async function logSystemActivity({ contactId, dealId, type, subject, notes, performedBy, performedByName }) {
  const doc = {
    type, contactId, dealId: dealId || null, subject, notes: notes || null,
    dueDate: null, completed: null, completedAt: null,
    assignedTo: null, performedBy, performedByName,
    createdAt: new Date(),
  };
  return insertOne('crm_activities', doc);
}

const logActivity = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['contactId', 'type', 'subject'])) return;
  if (!LOGGABLE_TYPES.includes(req.body.type)) return returnFunction(res, 400, false, `type must be one of: ${LOGGABLE_TYPES.join(', ')}.`);

  const contact = await findOne('crm_contacts', { _id: new ObjectId(req.body.contactId) });
  if (!contact) return returnFunction(res, 404, false, 'Contact not found.');
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const doc = {
    type: req.body.type,
    contactId: contact._id,
    dealId: req.body.dealId ? new ObjectId(req.body.dealId) : null,
    subject: req.body.subject.trim(),
    notes: req.body.notes?.trim() || null,
    dueDate: null, completed: null, completedAt: null,
    assignedTo: null,
    performedBy: req.user._id,
    performedByName: req.user.name,
    createdAt: new Date(),
  };
  const result = await insertOne('crm_activities', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const createTask = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['contactId', 'subject', 'dueDate'])) return;

  const contact = await findOne('crm_contacts', { _id: new ObjectId(req.body.contactId) });
  if (!contact) return returnFunction(res, 404, false, 'Contact not found.');
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const assignedTo = req.body.assignedTo ? new ObjectId(req.body.assignedTo) : req.user._id;
  if (level === 'staff' && String(assignedTo) !== String(req.user._id)) {
    return returnFunction(res, 403, false, 'You can only assign tasks to yourself.');
  }

  const subtasks = Array.isArray(req.body.subtasks)
    ? req.body.subtasks.filter((s) => s?.title?.trim()).map((s) => ({ _id: new ObjectId(), title: s.title.trim(), isCompleted: false, completedAt: null }))
    : [];

  const doc = {
    type: 'task',
    contactId: contact._id,
    dealId: req.body.dealId ? new ObjectId(req.body.dealId) : null,
    subject: req.body.subject.trim(),
    notes: req.body.notes?.trim() || null,
    dueDate: new Date(req.body.dueDate),
    completed: false, completedAt: null,
    assignedTo,
    priority: TASK_PRIORITIES.includes(req.body.priority) ? req.body.priority : 'medium',
    subtasks,
    performedBy: req.user._id,
    performedByName: req.user.name,
    createdAt: new Date(),
  };
  const result = await insertOne('crm_activities', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

// Editing a task post-creation didn't exist before — createTask/completeTask were the
// only mutators. A richer task UI (priority, due date changes, reassignment) needs this.
const updateTask = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const task = await findOne('crm_activities', { _id: new ObjectId(req.params.id), type: 'task' });
  if (!task) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, task.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const update = {};
  if (req.body.subject !== undefined) update.subject = req.body.subject.trim();
  if (req.body.notes !== undefined) update.notes = req.body.notes?.trim() || null;
  if (req.body.dueDate !== undefined) update.dueDate = new Date(req.body.dueDate);
  if (req.body.priority !== undefined && TASK_PRIORITIES.includes(req.body.priority)) update.priority = req.body.priority;
  if (req.body.assignedTo !== undefined) {
    const assignedTo = new ObjectId(req.body.assignedTo);
    if (level === 'staff' && String(assignedTo) !== String(req.user._id)) {
      return returnFunction(res, 403, false, 'You can only assign tasks to yourself.');
    }
    update.assignedTo = assignedTo;
  }
  await updateOne('crm_activities', { _id: task._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const addSubtask = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!req.body.title?.trim()) return returnFunction(res, 400, false, 'Subtask title required.');
  const task = await findOne('crm_activities', { _id: new ObjectId(req.params.id), type: 'task' });
  if (!task) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, task.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const subtask = { _id: new ObjectId(), title: req.body.title.trim(), isCompleted: false, completedAt: null };
  await updateOne('crm_activities', { _id: task._id }, { $push: { subtasks: subtask }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 201, true, 'Subtask added.', subtask);
};

const toggleSubtask = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const task = await findOne('crm_activities', { _id: new ObjectId(req.params.id), type: 'task' });
  if (!task) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, task.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const subId = new ObjectId(req.params.subId);
  const subtask = (task.subtasks || []).find((s) => String(s._id) === String(subId));
  if (!subtask) return returnFunction(res, 404, false, 'Subtask not found.');

  const completed = !subtask.isCompleted;
  await global.dbo.collection('crm_activities').updateOne(
    { _id: task._id, 'subtasks._id': subId },
    { $set: { 'subtasks.$.isCompleted': completed, 'subtasks.$.completedAt': completed ? new Date() : null, updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Subtask updated.', { isCompleted: completed });
};

const completeTask = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const task = await findOne('crm_activities', { _id: new ObjectId(req.params.id), type: 'task' });
  if (!task) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, task.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  await updateOne('crm_activities', { _id: task._id }, { $set: { completed: Boolean(req.body.completed ?? true), completedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// The unified per-contact timeline: every logged activity, system event, and task —
// plus, when POS captured a contactId at checkout, that contact's actual purchase
// history — merged and sorted into one chronological feed. Read-only against POS;
// nothing here writes to pos_sales.
const getContactTimeline = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const contact = await findOne('crm_contacts', { _id: new ObjectId(req.params.id) });
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const [activities, sales] = await Promise.all([
    findMany('crm_activities', { contactId: contact._id }, { sort: { createdAt: -1 } }),
    knex('pos_sales').where({ contactId: String(contact._id) }).whereNot({ status: 'failed' }).orderBy('createdAt', 'desc'),
  ]);

  const timeline = [
    ...activities.map((a) => ({ kind: 'activity', at: a.createdAt, ...a })),
    ...sales.map((s) => ({ kind: 'pos_sale', at: s.createdAt, ...s })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  return returnFunction(res, 200, true, req.locale.success, timeline);
};

// Dashboard widgets — overdue and upcoming tasks, scoped the same way everything else is.
const listTasks = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  const filter = { type: 'task' };
  if (req.query.assignedTo) {
    filter.assignedTo = new ObjectId(req.query.assignedTo);
  } else if (level === 'staff') {
    filter.assignedTo = req.user._id;
  } else if (level === 'manager') {
    const scoped = await getScopedAssigneeIds(req.user, level);
    filter.assignedTo = { $in: scoped };
  }
  if (req.query.priority) filter.priority = req.query.priority;

  // 'overdue'/'upcoming' are the original dashboard-widget filters (incomplete tasks
  // only, split by due date). Omitting `filter` — as the board/calendar views do —
  // returns every task regardless of completion, so a "Completed" column has data too.
  const now = new Date();
  if (req.query.filter === 'overdue') { filter.completed = false; filter.dueDate = { $lt: now }; }
  else if (req.query.filter === 'upcoming') { filter.completed = false; filter.dueDate = { $gte: now }; }

  const tasks = await findMany('crm_activities', filter, { sort: { dueDate: 1 }, limit: 100 });
  const contactIds = [...new Set(tasks.map((t) => String(t.contactId)))].map((id) => new ObjectId(id));
  const contacts = contactIds.length ? await findMany('crm_contacts', { _id: { $in: contactIds } }, { projection: { firstName: 1, lastName: 1 } }) : [];
  const contactMap = Object.fromEntries(contacts.map((c) => [String(c._id), c]));

  return returnFunction(res, 200, true, req.locale.success, tasks.map((t) => ({ ...t, contact: contactMap[String(t.contactId)] || null })));
};

module.exports = { logSystemActivity, logActivity, createTask, updateTask, completeTask, addSubtask, toggleSubtask, getContactTimeline, listTasks };
