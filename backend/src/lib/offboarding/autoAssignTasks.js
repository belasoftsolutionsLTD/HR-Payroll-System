// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 4) — offboarding_templates, offboarding_records (+ its child tables),
// employees, users all now live in Postgres. This file was still on the Mongo
// helpers for employees/users even after Phase 1 migrated them — a gap that went
// unnoticed until now (see the migration progress memory's "check shared low-level
// utilities every phase" lesson) since offboarding itself wasn't touched until now.
const pgDB = require('../../functions/Database/pgDBFunctions');
const { notifyUser, notifyByRoles, notifyEmployee } = require('../../functions/HR/notifyUser');
const { notifyManager } = require('../../routes/inbox/inboxFunctions');
const { sendEmail } = require('../../services/emailService');

const STAKEHOLDER_DEPARTMENTS = {
  it: 'Information Technology',
  finance: 'Finance & Accounts',
};

// Same resolution idiom as lib/onboarding/autoAssignTasks.js's notifyStakeholder —
// 'manager' resolves live off employees.managerId (no dedicated manager role in
// this app), 'it'/'finance' resolve by department and are skipped silently if
// nobody is found there, 'employee' notifies the leaving employee themselves.
const notifyStakeholder = async (assignedTo, employeeId, payload) => {
  if (assignedTo === 'hr') {
    return notifyByRoles(['super_admin', 'hr_manager'], payload);
  }
  if (assignedTo === 'manager') {
    return notifyManager(employeeId, {
      type: 'offboarding', subType: 'offboarding_tasks',
      title: payload.title, subtitle: payload.body,
      referenceId: employeeId, referenceModel: 'employees', requiresAction: true,
    }).catch(() => {});
  }
  if (assignedTo === 'employee') {
    return notifyEmployee(employeeId, payload);
  }
  const department = STAKEHOLDER_DEPARTMENTS[assignedTo];
  if (!department) return;
  const deptEmployees = await pgDB.knex('employees').where({ department }).select('id');
  if (!deptEmployees.length) return;
  const deptUsers = await pgDB.knex('users').whereIn('employeeId', deptEmployees.map(e => e.id)).select('id');
  await Promise.all(deptUsers.map(u => notifyUser(u.id, payload)));
};

const initiateOffboarding = async (employeeId, templateId, lastWorkingDay, exitType, exitReason, createdBy) => {
  const template = await pgDB.findOne('offboarding_templates', { id: String(templateId) });
  if (!template) throw new Error('Offboarding template not found.');

  const employee = await pgDB.findOne('employees', { id: String(employeeId) });
  if (!employee) throw new Error('Employee not found.');

  const lastDay = new Date(lastWorkingDay);
  const now = new Date();

  // template.taskLists/assetChecklist/accessRevocationList are JSONB — already
  // parsed JS values off the row.
  const templateTaskLists = template.taskLists || [];
  const templateAssetChecklist = template.assetChecklist || [];
  const templateAccessRevocationList = template.accessRevocationList || [];

  const recordId = pgDB.newId();
  const doc = {
    id: recordId,
    employeeId: String(employeeId),
    templateId: template.id,
    exitType,
    exitReason: exitReason || '',
    lastWorkingDay: lastDay,
    noticePeriodStartDate: now,
    status: 'initiated',
    eligibleForRehire: true,
    exitInterview: JSON.stringify({}),
    finalPayTriggered: false,
    finalPayTriggeredAt: null,
    completedAt: null,
    initiatedBy: createdBy ? String(createdBy) : null,
    createdAt: now,
    updatedAt: now,
  };
  await pgDB.insertOne('offboarding_records', doc);

  // taskLists[].tasks[] — real child tables, same template-copied-id collision
  // reasoning as onboarding (see the migration file's own comment). Insert lists
  // first to get their real internal ids, then their tasks.
  const taskListsForNotify = [];
  for (const list of templateTaskLists) {
    const [insertedList] = await pgDB.knex('offboarding_task_lists').insert({
      recordId, listKey: list.id, name: list.name, assignedTo: list.assignedTo,
    }).returning('id');
    const newListId = insertedList.id ?? insertedList;
    const tasks = (list.tasks || []).map(t => {
      const due = new Date(lastDay);
      due.setDate(due.getDate() + (Number(t.dueOffsetDays) || 0));
      return {
        taskListId: newListId, taskKey: t.id, title: t.title, description: t.description || '',
        dueDate: due, isRequired: t.isRequired !== false, status: 'pending',
        completedBy: null, completedAt: null, requiresDocument: !!t.requiresDocument, documentId: null, notes: null,
        category: t.category || 'general', taskType: t.taskType || null,
      };
    });
    if (tasks.length) await pgDB.knex('offboarding_tasks').insert(tasks);
    taskListsForNotify.push({ assignedTo: list.assignedTo, name: list.name, taskCount: tasks.length });
  }

  if (templateAssetChecklist.length) {
    await pgDB.knex('offboarding_asset_checklist').insert(templateAssetChecklist.map(a => ({
      recordId, itemKey: a.id, item: a.item, category: a.category,
      returned: false, returnedAt: null, returnedTo: null, condition: null, notes: null,
    })));
  }
  if (templateAccessRevocationList.length) {
    await pgDB.knex('offboarding_access_revocation').insert(templateAccessRevocationList.map(a => ({
      recordId, itemKey: a.id, system: a.system, category: a.category,
      revoked: false, revokedAt: null, revokedBy: null,
    })));
  }

  const record = { ...doc, exitInterview: {}, taskLists: templateTaskLists, assetChecklist: templateAssetChecklist, accessRevocationList: templateAccessRevocationList };

  if (employee.email) {
    sendEmail({
      to: employee.email,
      subject: 'Your offboarding checklist',
      html: `<p>Hi ${employee.fullName},</p><p>Your last working day is ${lastDay.toDateString()}. We've started your exit checklist — please complete your assigned tasks before then.</p><p>Track your progress here: <a href="${process.env.FRONTEND_URL || ''}/en/my/offboarding">${process.env.FRONTEND_URL || ''}/en/my/offboarding</a></p>`,
    }).catch(() => {});
  }

  await Promise.all(taskListsForNotify.filter(l => l.taskCount).map(list =>
    notifyStakeholder(list.assignedTo, employeeId, {
      title: `Offboarding: ${employee.fullName}`,
      body: `${list.taskCount} "${list.name}" task${list.taskCount !== 1 ? 's' : ''} assigned for ${employee.fullName}'s exit (last day ${lastDay.toDateString()}).`,
      type: 'offboarding',
    }).catch(() => {})
  ));

  return record;
};

module.exports = { initiateOffboarding, notifyStakeholder };
