const { ObjectId } = require('mongodb');
const { findOne, findMany, insertOne } = require('../../functions/Database/commonDBFunctions');
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
  const deptEmployees = await findMany('employees', { department }, { projection: { _id: 1 } });
  if (!deptEmployees.length) return;
  const deptUsers = await findMany('users', { employeeId: { $in: deptEmployees.map(e => e._id) } }, { projection: { _id: 1 } });
  await Promise.all(deptUsers.map(u => notifyUser(u._id, payload)));
};

const initiateOffboarding = async (employeeId, templateId, lastWorkingDay, exitType, exitReason, createdBy) => {
  const template = await findOne('offboarding_templates', { _id: new ObjectId(templateId) });
  if (!template) throw new Error('Offboarding template not found.');

  const employee = await findOne('employees', { _id: new ObjectId(employeeId) }, { projection: { fullName: 1, email: 1 } });
  if (!employee) throw new Error('Employee not found.');

  const lastDay = new Date(lastWorkingDay);
  const now = new Date();

  const taskLists = (template.taskLists || []).map(list => ({
    id: list.id,
    name: list.name,
    assignedTo: list.assignedTo,
    tasks: (list.tasks || []).map(t => {
      const due = new Date(lastDay);
      due.setDate(due.getDate() + (Number(t.dueOffsetDays) || 0));
      return {
        id: t.id,
        title: t.title,
        description: t.description || '',
        dueDate: due,
        isRequired: t.isRequired !== false,
        status: 'pending',
        completedBy: null,
        completedAt: null,
        requiresDocument: !!t.requiresDocument,
        documentId: null,
        notes: null,
        category: t.category || 'general',
        taskType: t.taskType || null,
      };
    }),
  }));

  const assetChecklist = (template.assetChecklist || []).map(a => ({
    id: a.id, item: a.item, category: a.category,
    returned: false, returnedAt: null, returnedTo: null, condition: null, notes: null,
  }));

  const accessRevocationList = (template.accessRevocationList || []).map(a => ({
    id: a.id, system: a.system, category: a.category,
    revoked: false, revokedAt: null, revokedBy: null,
  }));

  const doc = {
    employeeId: new ObjectId(employeeId),
    templateId: template._id,
    exitType,
    exitReason: exitReason || '',
    lastWorkingDay: lastDay,
    noticePeriodStartDate: now,
    status: 'initiated',
    eligibleForRehire: true,
    taskLists,
    assetChecklist,
    accessRevocationList,
    exitInterview: {},
    generatedDocuments: [],
    finalPayTriggered: false,
    finalPayTriggeredAt: null,
    completedAt: null,
    initiatedBy: createdBy ? new ObjectId(createdBy) : null,
    createdAt: now,
    updatedAt: now,
  };

  const result = await insertOne('offboarding_records', doc);
  const record = { ...doc, _id: result.insertedId };

  if (employee.email) {
    sendEmail({
      to: employee.email,
      subject: 'Your offboarding checklist',
      html: `<p>Hi ${employee.fullName},</p><p>Your last working day is ${lastDay.toDateString()}. We've started your exit checklist — please complete your assigned tasks before then.</p><p>Track your progress here: <a href="${process.env.FRONTEND_URL || ''}/en/my/offboarding">${process.env.FRONTEND_URL || ''}/en/my/offboarding</a></p>`,
    }).catch(() => {});
  }

  await Promise.all(taskLists.filter(l => l.tasks.length).map(list =>
    notifyStakeholder(list.assignedTo, employeeId, {
      title: `Offboarding: ${employee.fullName}`,
      body: `${list.tasks.length} "${list.name}" task${list.tasks.length !== 1 ? 's' : ''} assigned for ${employee.fullName}'s exit (last day ${lastDay.toDateString()}).`,
      type: 'offboarding',
    }).catch(() => {})
  ));

  return record;
};

module.exports = { initiateOffboarding, notifyStakeholder };
