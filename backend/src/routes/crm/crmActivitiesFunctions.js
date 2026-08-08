// Postgres migration (Phase 7) — crm_activities/crm_contacts are Postgres now (pos_sales
// was already fixed in Phase 6, kept as-is below). subtasks is a REAL child table
// (crm_activity_subtasks), not JSONB — toggleSubtask did a genuine per-row positional
// Mongo update ($set: {'subtasks.$.isCompleted': ...}), the same "real per-row mutation"
// signal that has meant "child table" every other phase — see the migration file's header.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { getCrmAccessLevel, canAccessAssignee, getScopedAssigneeIds } = require('../../lib/crm/crmAccess');

const LOGGABLE_TYPES = ['call', 'email', 'meeting', 'note'];
const TASK_PRIORITIES = ['high', 'medium', 'low'];

// System-generated timeline entries (deal created/won/lost, stage changes) — called
// internally by crmDealsFunctions, not exposed as its own route. Same table as
// human-logged activities so the contact timeline is one query, one sort, one feed.
async function logSystemActivity({ contactId, dealId, type, subject, notes, performedBy, performedByName }) {
  const doc = {
    id: newId(),
    type, contactId, dealId: dealId || null, subject, notes: notes || null,
    dueDate: null, completed: null, completedAt: null,
    assignedTo: null, performedBy, performedByName,
    createdAt: new Date(),
  };
  const [saved] = await knex('crm_activities').insert(doc).returning('*');
  return saved;
}

const logActivity = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['contactId', 'type', 'subject'])) return;
  if (!LOGGABLE_TYPES.includes(req.body.type)) return returnFunction(res, 400, false, `type must be one of: ${LOGGABLE_TYPES.join(', ')}.`);

  const contact = await knex('crm_contacts').where({ id: req.body.contactId }).first();
  if (!contact) return returnFunction(res, 404, false, 'Contact not found.');
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const doc = {
    id: newId(),
    type: req.body.type,
    contactId: contact.id,
    dealId: req.body.dealId || null,
    subject: req.body.subject.trim(),
    notes: req.body.notes?.trim() || null,
    dueDate: null, completed: null, completedAt: null,
    assignedTo: null,
    performedBy: req.user.id,
    performedByName: req.user.name,
    createdAt: new Date(),
  };
  const [saved] = await knex('crm_activities').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const createTask = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['contactId', 'subject', 'dueDate'])) return;

  const contact = await knex('crm_contacts').where({ id: req.body.contactId }).first();
  if (!contact) return returnFunction(res, 404, false, 'Contact not found.');
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const assignedTo = req.body.assignedTo || req.user.id;
  if (level === 'staff' && assignedTo !== req.user.id) {
    return returnFunction(res, 403, false, 'You can only assign tasks to yourself.');
  }

  const subtaskTitles = Array.isArray(req.body.subtasks) ? req.body.subtasks.filter((s) => s?.title?.trim()) : [];

  const taskId = newId();
  const doc = {
    id: taskId,
    type: 'task',
    contactId: contact.id,
    dealId: req.body.dealId || null,
    subject: req.body.subject.trim(),
    notes: req.body.notes?.trim() || null,
    dueDate: new Date(req.body.dueDate),
    completed: false, completedAt: null,
    assignedTo,
    priority: TASK_PRIORITIES.includes(req.body.priority) ? req.body.priority : 'medium',
    performedBy: req.user.id,
    performedByName: req.user.name,
    createdAt: new Date(),
  };
  const [saved] = await knex('crm_activities').insert(doc).returning('*');

  let subtasks = [];
  if (subtaskTitles.length) {
    const subtaskRows = subtaskTitles.map((s) => ({ id: newId(), activityId: taskId, title: s.title.trim(), isCompleted: false, completedAt: null }));
    subtasks = await knex('crm_activity_subtasks').insert(subtaskRows).returning('*');
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { ...saved, subtasks });
};

// Editing a task post-creation didn't exist before — createTask/completeTask were the
// only mutators. A richer task UI (priority, due date changes, reassignment) needs this.
const updateTask = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const task = await knex('crm_activities').where({ id: req.params.id, type: 'task' }).first();
  if (!task) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, task.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const update = {};
  if (req.body.subject !== undefined) update.subject = req.body.subject.trim();
  if (req.body.notes !== undefined) update.notes = req.body.notes?.trim() || null;
  if (req.body.dueDate !== undefined) update.dueDate = new Date(req.body.dueDate);
  if (req.body.priority !== undefined && TASK_PRIORITIES.includes(req.body.priority)) update.priority = req.body.priority;
  if (req.body.assignedTo !== undefined) {
    if (level === 'staff' && req.body.assignedTo !== req.user.id) {
      return returnFunction(res, 403, false, 'You can only assign tasks to yourself.');
    }
    update.assignedTo = req.body.assignedTo;
  }
  await knex('crm_activities').where({ id: task.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const addSubtask = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!req.body.title?.trim()) return returnFunction(res, 400, false, 'Subtask title required.');
  const task = await knex('crm_activities').where({ id: req.params.id, type: 'task' }).first();
  if (!task) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, task.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const [subtask] = await knex('crm_activity_subtasks')
    .insert({ id: newId(), activityId: task.id, title: req.body.title.trim(), isCompleted: false, completedAt: null })
    .returning('*');
  return returnFunction(res, 201, true, 'Subtask added.', subtask);
};

const toggleSubtask = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const task = await knex('crm_activities').where({ id: req.params.id, type: 'task' }).first();
  if (!task) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, task.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const subtask = await knex('crm_activity_subtasks').where({ id: req.params.subId, activityId: task.id }).first();
  if (!subtask) return returnFunction(res, 404, false, 'Subtask not found.');

  const completed = !subtask.isCompleted;
  await knex('crm_activity_subtasks').where({ id: subtask.id }).update({ isCompleted: completed, completedAt: completed ? new Date() : null });
  return returnFunction(res, 200, true, 'Subtask updated.', { isCompleted: completed });
};

const completeTask = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const task = await knex('crm_activities').where({ id: req.params.id, type: 'task' }).first();
  if (!task) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, task.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  await knex('crm_activities').where({ id: task.id }).update({ completed: Boolean(req.body.completed ?? true), completedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// The unified per-contact timeline: every logged activity, system event, and task —
// plus, when POS captured a contactId at checkout, that contact's actual purchase
// history — merged and sorted into one chronological feed. Read-only against POS;
// nothing here writes to pos_sales.
const getContactTimeline = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const contact = await knex('crm_contacts').where({ id: req.params.id }).first();
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const [activities, sales] = await Promise.all([
    knex('crm_activities').where({ contactId: contact.id }).orderBy('createdAt', 'desc'),
    knex('pos_sales').where({ contactId: String(contact.id) }).whereNot({ status: 'failed' }).orderBy('createdAt', 'desc'),
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

  let query = knex('crm_activities').where({ type: 'task' });
  if (req.query.assignedTo) {
    query = query.where({ assignedTo: req.query.assignedTo });
  } else if (level === 'staff') {
    query = query.where({ assignedTo: req.user.id });
  } else if (level === 'manager') {
    const scoped = await getScopedAssigneeIds(req.user, level);
    query = query.whereIn('assignedTo', scoped);
  }
  if (req.query.priority) query = query.where({ priority: req.query.priority });

  // 'overdue'/'upcoming' are the original dashboard-widget filters (incomplete tasks
  // only, split by due date). Omitting `filter` — as the board/calendar views do —
  // returns every task regardless of completion, so a "Completed" column has data too.
  const now = new Date();
  if (req.query.filter === 'overdue') query = query.where({ completed: false }).where('dueDate', '<', now);
  else if (req.query.filter === 'upcoming') query = query.where({ completed: false }).where('dueDate', '>=', now);

  const tasks = await query.orderBy('dueDate').limit(100);
  const contactIds = [...new Set(tasks.map((t) => t.contactId))];
  const contacts = contactIds.length ? await knex('crm_contacts').whereIn('id', contactIds).select('id', 'firstName', 'lastName') : [];
  const contactMap = Object.fromEntries(contacts.map((c) => [c.id, c]));

  return returnFunction(res, 200, true, req.locale.success, tasks.map((t) => ({ ...t, contact: contactMap[t.contactId] || null })));
};

module.exports = { logSystemActivity, logActivity, createTask, updateTask, completeTask, addSubtask, toggleSubtask, getContactTimeline, listTasks };
