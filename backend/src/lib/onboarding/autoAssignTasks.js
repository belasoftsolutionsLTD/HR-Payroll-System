const bcrypt = require('bcryptjs');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 4) — onboarding_templates, onboarding_records (+ onboarding_task_lists/
// onboarding_tasks), employees, users all now live in Postgres.
const pgDB = require('../../functions/Database/pgDBFunctions');
const { notifyUser, notifyByRoles, notifyEmployee } = require('../../functions/HR/notifyUser');
const { notifyManager } = require('../../routes/inbox/inboxFunctions');
const { sendEmail } = require('../../services/emailService');
const { STAFF } = require('../../constants/roles');

// Same generator as accountFunctions.js's createAccount — kept local (not imported)
// to avoid a route-layer -> route-layer require; both produce an equally strong
// random temporary password.
const generatePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

// A new hire's "Welcome" email used to link straight to the login-gated onboarding
// portal without ever provisioning them a login — they had no way in. This
// provisions a staff account (if one doesn't already exist for this employee) right
// before the welcome email goes out, so the credentials and the portal link travel
// together in the same message. Returns the raw password when a new account was
// created, or null if the employee already had one (or has no email on file).
const ensureLoginAccount = async (employeeId, employee) => {
  if (!employee.email) return null;

  const existing = await pgDB.findOne('users', { employeeId: String(employeeId) });
  if (existing) return null;

  const byEmail = await pgDB.findOne('users', { email: employee.email.toLowerCase().trim() });
  if (byEmail) return null;

  const rawPassword = generatePassword();
  const hashed = await bcrypt.hash(rawPassword, 12);
  await pgDB.insertOne('users', {
    name: employee.fullName,
    email: employee.email.toLowerCase().trim(),
    password: hashed,
    role: STAFF,
    employeeId: String(employeeId),
    department: employee.department || null,
    mustResetPassword: true,
    isActive: true,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return rawPassword;
};

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
  const deptEmployees = await pgDB.knex('employees').where({ department }).select('id');
  if (!deptEmployees.length) return;
  const deptUsers = await pgDB.knex('users').whereIn('employeeId', deptEmployees.map(e => e.id)).select('id');
  await Promise.all(deptUsers.map(u => notifyUser(u.id, payload)));
};

const initiateOnboarding = async (employeeId, templateId, startDate, createdBy) => {
  const template = await pgDB.findOne('onboarding_templates', { id: String(templateId) });
  if (!template) throw new Error('Onboarding template not found.');

  const employee = await pgDB.findOne('employees', { id: String(employeeId) });
  if (!employee) throw new Error('Employee not found.');

  const start = new Date(startDate);
  const now = new Date();

  // template.taskLists/meetTheTeam are JSONB — already parsed JS values off the row.
  const templateTaskLists = template.taskLists || [];
  const meetTheTeam = (template.meetTheTeam || []).map(m => ({
    employeeId: String(m.employeeId), note: m.note || '', met: false,
  }));

  const recordId = pgDB.newId();
  const doc = {
    id: recordId,
    employeeId: String(employeeId),
    templateId: template.id,
    status: start > now ? 'preboarding' : 'active',
    startDate: start,
    completedAt: null,
    welcomeMessage: template.welcomeMessage || '',
    firstDayDetails: JSON.stringify(template.firstDayDetails || { location: '', reportingTime: '', whatToBring: '', additionalNotes: '' }),
    meetTheTeam: JSON.stringify(meetTheTeam),
    compensationSetup: null,
    createdBy: createdBy ? String(createdBy) : null,
    createdAt: now,
    updatedAt: now,
  };
  await pgDB.insertOne('onboarding_records', doc);

  // taskLists[].tasks[] — real child tables (see the migration file's own comment on
  // why list.id/task.id can't be the primary key: templates copy the same id onto
  // every record instantiated from them). Insert lists first to get their real
  // internal ids, then their tasks.
  const taskListsForNotify = [];
  for (const list of templateTaskLists) {
    const [insertedList] = await pgDB.knex('onboarding_task_lists').insert({
      recordId, listKey: list.id, name: list.name, assignedTo: list.assignedTo,
    }).returning('id');
    const newListId = insertedList.id ?? insertedList;
    const tasks = (list.tasks || []).map(t => {
      const due = new Date(start);
      due.setDate(due.getDate() + (Number(t.dueOffsetDays) || 0));
      return {
        taskListId: newListId, taskKey: t.id, title: t.title, description: t.description || '',
        dueDate: due, isRequired: t.isRequired !== false, status: 'pending',
        completedBy: null, completedAt: null, requiresDocument: !!t.requiresDocument,
        documentId: null, notes: null, resourceUrl: t.resourceUrl || null,
      };
    });
    if (tasks.length) await pgDB.knex('onboarding_tasks').insert(tasks);
    taskListsForNotify.push({ assignedTo: list.assignedTo, name: list.name, taskCount: tasks.length });
  }

  const record = { ...doc, taskLists: templateTaskLists, meetTheTeam };

  // Welcome email (fire-and-forget — should never block onboarding creation). Provisioning
  // happens first so the credentials and the portal link that needs them travel together —
  // sending someone a link to a page they have no way to log into is the exact gap this closes.
  if (employee.email) {
    const rawPassword = await ensureLoginAccount(employeeId, employee).catch(() => null);
    const portalLink = `${process.env.FRONTEND_URL || ''}/en/my/onboarding`;
    const credentialsBlock = rawPassword
      ? `<p>Your login has been created so you can access the onboarding portal:</p>
         <table style="background:#f5f5f5;padding:16px;border-radius:8px;width:100%;">
           <tr><td><strong>Email:</strong></td><td>${employee.email}</td></tr>
           <tr><td><strong>Password:</strong></td><td style="font-family:monospace;font-size:16px;">${rawPassword}</td></tr>
         </table>
         <p style="color:#e53e3e;font-size:13px;margin-top:8px;">You'll be prompted to set a new password on your first login.</p>`
      : '';
    sendEmail({
      to: employee.email,
      subject: `Welcome to ${process.env.COMPANY_NAME || 'the team'}!`,
      html: `<p>Hi ${employee.fullName},</p><p>${(template.welcomeMessage || 'Welcome aboard! We\'re excited to have you join us.').replace(/\n/g, '<br/>')}</p>${credentialsBlock}<p>You can track your onboarding tasks here: <a href="${portalLink}">${portalLink}</a></p>`,
      bypassUnsubscribe: true,
    }).catch(() => {});
  }

  // Per-stakeholder notifications, one per non-empty task list
  await Promise.all(taskListsForNotify.filter(l => l.taskCount).map(list =>
    notifyStakeholder(list.assignedTo, employeeId, {
      title: `Onboarding: ${employee.fullName}`,
      body: `${list.taskCount} "${list.name}" task${list.taskCount !== 1 ? 's' : ''} assigned for ${employee.fullName}'s onboarding.`,
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
  const templates = await pgDB.knex('onboarding_templates');
  if (!templates.length) return null;
  return (
    templates.find(t => (t.targetDepartments || []).includes(department)) ||
    templates.find(t => !(t.targetDepartments || []).length) ||
    templates[0]
  );
};

module.exports = { initiateOnboarding, notifyStakeholder, resolveDefaultTemplate };
