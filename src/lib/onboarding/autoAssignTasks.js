const { ObjectId } = require('mongodb');
const { findOne, findMany, insertOne } = require('../../functions/Database/commonDBFunctions');
const { notifyUser, notifyByRoles, notifyEmployee } = require('../../functions/HR/notifyUser');
const { notifyManager } = require('../../routes/inbox/inboxFunctions');
const { sendEmail } = require('../../services/emailService');

const STAKEHOLDER_DEPARTMENTS = {
  it: 'Information Technology',
  finance: 'Finance & Accounts',
};

// Resolves the user accounts that should be notified for a given task-list
// assignee type. 'manager' resolves live off employees.managerId (no dedicated
// manager role exists in this app — see [[spend-management-build]] for the
// same pattern). 'it'/'finance' resolve by department since there's no
// dedicated role for them either; if nobody is found the notification is
// simply skipped rather than blocking onboarding.
const notifyStakeholder = async (assignedTo, employeeId, payload) => {
  if (assignedTo === 'hr') {
    return notifyByRoles(['super_admin', 'hr_manager'], payload);
  }
  if (assignedTo === 'manager') {
    return notifyManager(employeeId, {
      type: 'onboarding', subType: 'onboarding_tasks',
      title: payload.title, subtitle: payload.body,
      referenceId: employeeId, referenceModel: 'employees', requiresAction: true,
    }).catch(() => {});
  }
  if (assignedTo === 'newHire') {
    return notifyEmployee(employeeId, payload);
  }
  const department = STAKEHOLDER_DEPARTMENTS[assignedTo];
  if (!department) return;
  const deptEmployees = await findMany('employees', { department }, { projection: { _id: 1 } });
  if (!deptEmployees.length) return;
  const deptUsers = await findMany('users', { employeeId: { $in: deptEmployees.map(e => e._id) } }, { projection: { _id: 1 } });
  await Promise.all(deptUsers.map(u => notifyUser(u._id, payload)));
};

const initiateOnboarding = async (employeeId, templateId, startDate, createdBy) => {
  const template = await findOne('onboarding_templates', { _id: new ObjectId(templateId) });
  if (!template) throw new Error('Onboarding template not found.');

  const employee = await findOne('employees', { _id: new ObjectId(employeeId) }, { projection: { fullName: 1, email: 1 } });
  if (!employee) throw new Error('Employee not found.');

  const start = new Date(startDate);
  const now = new Date();

  const taskLists = (template.taskLists || []).map(list => ({
    id: list.id,
    name: list.name,
    assignedTo: list.assignedTo,
    tasks: (list.tasks || []).map(t => {
      const due = new Date(start);
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
        resourceUrl: t.resourceUrl || null,
      };
    }),
  }));

  const meetTheTeam = (template.meetTheTeam || []).map(m => ({
    employeeId: new ObjectId(m.employeeId),
    note: m.note || '',
    met: false,
  }));

  const doc = {
    employeeId: new ObjectId(employeeId),
    templateId: template._id,
    status: start > now ? 'preboarding' : 'active',
    startDate: start,
    completedAt: null,
    welcomeMessage: template.welcomeMessage || '',
    firstDayDetails: template.firstDayDetails || { location: '', reportingTime: '', whatToBring: '', additionalNotes: '' },
    meetTheTeam,
    taskLists,
    progressPercentage: 0,
    createdBy: createdBy ? new ObjectId(createdBy) : null,
    createdAt: now,
    updatedAt: now,
  };

  const result = await insertOne('onboarding_records', doc);
  const record = { ...doc, _id: result.insertedId };

  // Welcome email (fire-and-forget — should never block onboarding creation)
  if (employee.email) {
    const portalLink = `${process.env.FRONTEND_URL || ''}/en/my/onboarding`;
    sendEmail({
      to: employee.email,
      subject: `Welcome to ${process.env.COMPANY_NAME || 'the team'}!`,
      html: `<p>Hi ${employee.fullName},</p><p>${(template.welcomeMessage || 'Welcome aboard! We\'re excited to have you join us.').replace(/\n/g, '<br/>')}</p><p>You can track your onboarding tasks here: <a href="${portalLink}">${portalLink}</a></p>`,
    }).catch(() => {});
  }

  // Per-stakeholder notifications, one per non-empty task list
  await Promise.all(taskLists.filter(l => l.tasks.length).map(list =>
    notifyStakeholder(list.assignedTo, employeeId, {
      title: `Onboarding: ${employee.fullName}`,
      body: `${list.tasks.length} "${list.name}" task${list.tasks.length !== 1 ? 's' : ''} assigned for ${employee.fullName}'s onboarding.`,
      type: 'onboarding',
    }).catch(() => {})
  ));

  return record;
};

// Used by the employee-creation and recruitment-hire flows, which don't have a
// template picker UI — picks the most specific template for the employee's
// department, falling back to an untargeted/default template, then to whatever
// template exists first. Returns null (caller should skip silently) if no
// onboarding templates have been configured yet.
const resolveDefaultTemplate = async (department) => {
  const templates = await findMany('onboarding_templates', {});
  if (!templates.length) return null;
  return (
    templates.find(t => (t.targetDepartments || []).includes(department)) ||
    templates.find(t => !(t.targetDepartments || []).length) ||
    templates[0]
  );
};

module.exports = { initiateOnboarding, notifyStakeholder, resolveDefaultTemplate };
