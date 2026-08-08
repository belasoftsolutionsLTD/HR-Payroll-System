// Postgres migration (Phase 9) — projects/project_members/project_invites/
// project_subtasks/project_notes/project_chat_groups/project_messages/
// project_time_entries are Postgres now. employees/users have been Postgres
// since Phase 1.
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { createInboxItem } = require('../inbox/inboxFunctions');
const { sendEmail } = require('../../services/emailService');
const { generateStaffNumber } = require('../../functions/HR/staffNumberGenerator');

const HR_ROLES   = ['super_admin', 'hr_manager'];
const MGMT_ROLES = ['super_admin', 'hr_manager', 'department_head'];
const COMPANY_NAME = process.env.COMPANY_NAME || 'School ERP';
const INVITE_EXPIRY_DAYS = 7;

const UPLOAD_BASE = path.join(
  process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', '..', '..', 'uploads'),
  'projects'
);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getEmployeeDept(userId) {
  if (!userId) return null;
  const emp = await knex('employees').where({ id: String(userId) }).first();
  return emp?.department ?? null;
}

function isSupervisor(project, userId) {
  return String(project.createdBy) === String(userId);
}

// Whether a user may view/participate in a project at all — HR, the project's
// supervisor, a registered project_members row, or (department_head only) their
// department is listed on the project. Used to gate the general project chat, which
// previously had no membership check at all (any authenticated user could read/post
// to any project's chat by guessing the project id).
//
// IMPORTANT: `project_members.employeeId` (and `assignedEmployees.employeeId`) store
// the EMPLOYEE record's id, not the USER account's id — these are different rows in
// different tables, never equal. `req.user.id` is the user id; `req.user.employeeId`
// (attached by AuthMiddleware, a Mongo ObjectId instance — always String()-wrap it) is
// the linked employee id. Every membership/department lookup below must use
// `reqUser.employeeId`, while `isSupervisor` (which compares against
// `project.createdBy`, itself always a user id) correctly keeps using `reqUser.id`.
async function canAccessProject(project, reqUser) {
  if (HR_ROLES.includes(reqUser.role)) return true;
  if (isSupervisor(project, reqUser.id)) return true;
  if (reqUser.employeeId) {
    const member = await knex('project_members').where({ projectId: project.id, employeeId: String(reqUser.employeeId) }).first();
    if (member) return true;
  }
  if (reqUser.role === 'department_head') {
    const dept = await getEmployeeDept(reqUser.employeeId);
    if (dept && (project.departments || []).includes(dept)) return true;
  }
  return false;
}

async function notifyProjectMembers(projectId, item, excludeId = null) {
  const members = await knex('project_members').where({ projectId: String(projectId) }).select('employeeId');
  const project = await knex('projects').where({ id: String(projectId) }).select('createdBy').first();

  const recipientIds = new Set(members.map((m) => String(m.employeeId)));
  if (project?.createdBy) recipientIds.add(String(project.createdBy));
  if (excludeId) recipientIds.delete(String(excludeId));

  for (const rId of recipientIds) {
    try {
      await createInboxItem({ ...item, recipientId: rId, referenceId: String(projectId) });
    } catch { /* ignore individual notification failures */ }
  }
}

// ── List Projects ─────────────────────────────────────────────────────────────

const listProjects = async (req, res) => {
  const userId = req.user.id;
  const role   = req.user.role;
  const { page, limit, skip } = getPagination(req.query);

  let query = knex('projects');
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.search) query = query.whereILike('name', `%${req.query.search}%`);

  if (!HR_ROLES.includes(role)) {
    // Build a filter that includes: projects I created OR I'm a member of OR (dept head) dept is involved.
    // project_members.employeeId is an EMPLOYEE id, not a user id — must match against
    // req.user.employeeId, never req.user.id (see canAccessProject's comment above).
    const myEmployeeId = req.user.employeeId ? String(req.user.employeeId) : null;
    const memberProjects = myEmployeeId
      ? await knex('project_members').where({ employeeId: myEmployeeId }).select('projectId')
      : [];
    const memberIds = memberProjects.map((m) => m.projectId);

    let myDept = null;
    if (role === 'department_head') myDept = await getEmployeeDept(myEmployeeId);

    query = query.where((qb) => {
      qb.where({ createdBy: userId });
      if (memberIds.length) qb.orWhereIn('id', memberIds);
      if (myDept) qb.orWhereRaw('departments @> ?', [JSON.stringify([myDept])]);
    });
  }

  const [{ count }] = await query.clone().count('* as count');
  const data = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const enriched = await Promise.all(data.map(async (p) => {
    const [[{ count: memberCount }], [{ count: subtaskCount }], [{ count: completedSubtasks }]] = await Promise.all([
      knex('project_members').where({ projectId: p.id }).count('* as count'),
      knex('project_subtasks').where({ projectId: p.id }).count('* as count'),
      knex('project_subtasks').where({ projectId: p.id, status: 'completed' }).count('* as count'),
    ]);
    return { ...p, memberCount: Number(memberCount), subtaskCount: Number(subtaskCount), completedSubtasks: Number(completedSubtasks) };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

// ── Create Project ────────────────────────────────────────────────────────────

const createProject = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const { name, description, startDate, endDate, departments, teamLeaderId, memberIds } = req.body;

  const depts   = Array.isArray(departments) ? departments.filter(Boolean) : (departments ? [departments] : []);
  const members = Array.isArray(memberIds)   ? memberIds.filter(Boolean)   : (memberIds   ? [memberIds]   : []);

  let supervisorName = req.user.name || '';
  if (!supervisorName) {
    const supEmp = await knex('employees').where({ id: req.user.id }).select('fullName').first();
    supervisorName = supEmp?.fullName ?? 'Supervisor';
  }

  let teamLeaderName = null;
  if (teamLeaderId) {
    const tl = await knex('employees').where({ id: teamLeaderId }).select('fullName').first();
    teamLeaderName = tl?.fullName ?? null;
  }

  const doc = {
    id: newId(),
    name: name.trim(),
    description: description || null,
    status: 'in_progress',
    startDate:  startDate ? new Date(startDate) : null,
    endDate:    endDate   ? new Date(endDate)   : null,
    departments: JSON.stringify(depts),
    teamLeaderId: teamLeaderId || null,
    teamLeaderName,
    createdBy: req.user.id,
    supervisorName,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const [saved] = await knex('projects').insert(doc).returning('*');
  const projectId = saved.id;

  // Add team leader as member (role: team_leader)
  const addedIds = new Set();
  if (teamLeaderId) {
    const tl = await knex('employees').where({ id: teamLeaderId }).select('fullName', 'department').first();
    await knex('project_members').insert({
      id: newId(), projectId, employeeId: teamLeaderId,
      name: tl?.fullName ?? 'Team Leader', department: tl?.department ?? '',
      role: 'team_leader', addedAt: new Date(),
    });
    addedIds.add(String(teamLeaderId));
  }

  // Add remaining members
  for (const empId of members) {
    if (addedIds.has(String(empId))) continue;
    const emp = await knex('employees').where({ id: empId }).select('fullName', 'department').first();
    if (!emp) continue;
    await knex('project_members').insert({
      id: newId(), projectId, employeeId: empId,
      name: emp.fullName, department: emp.department ?? '',
      role: 'member', addedAt: new Date(),
    });
    addedIds.add(String(empId));
  }

  // Inbox notifications for all added members
  const allNotifyIds = [...(teamLeaderId ? [teamLeaderId] : []), ...members];
  for (const empId of allNotifyIds) {
    await createInboxItem({
      recipientId: empId,
      type: 'project', subType: 'project_assigned',
      title: `You've been added to project: ${name.trim()}`,
      subtitle: `Supervisor: ${supervisorName}`,
      referenceId: projectId, referenceModel: 'projects',
      requiresAction: false, priority: 'normal',
      triggeredBy: req.user.id,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: projectId });
};

// ── Get Project ───────────────────────────────────────────────────────────────

const getProject = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  // Was reachable by any authenticated user regardless of role — the route-level
  // `allRoles` middleware only checks you're logged in, not that you're actually on
  // this project. Every other per-project action in this file (messages, notes,
  // subtasks) already gates on canAccessProject; this was the one place that didn't,
  // exposing every member's name/department/job title and all subtasks to anyone who
  // had (or guessed) a project id.
  if (!(await canAccessProject(project, req.user))) {
    return returnFunction(res, 403, false, 'You do not have access to this project.');
  }

  const [members, subtasks] = await Promise.all([
    knex('project_members').where({ projectId: project.id }),
    knex('project_subtasks').where({ projectId: project.id }).orderBy('createdAt', 'asc'),
  ]);

  const enrichedMembers = await Promise.all(members.map(async (m) => {
    const emp = await knex('employees').where({ id: m.employeeId }).select('fullName', 'department', 'designation').first();
    return { ...m, employee: emp ?? null };
  }));

  const supervisor = await knex('employees').where({ id: project.createdBy }).select('fullName', 'department', 'designation').first();

  const userId = String(req.user.id);
  const role   = req.user.role;
  const myEmployeeId = req.user.employeeId ? String(req.user.employeeId) : null;
  let myRole       = null;
  let myDepartment = null;

  if (HR_ROLES.includes(role) || isSupervisor(project, userId)) {
    myRole = 'supervisor';
  } else if (myEmployeeId) {
    const member = enrichedMembers.find((m) => String(m.employeeId) === myEmployeeId);
    myRole = member?.role ?? null;
  }

  if (role === 'department_head') {
    myDepartment = await getEmployeeDept(myEmployeeId);
  }

  const deptProgress = {};
  for (const dept of (project.departments || [])) {
    const deptSubs = subtasks.filter((s) => s.department === dept);
    deptProgress[dept] = {
      total:     deptSubs.length,
      completed: deptSubs.filter((s) => s.status === 'completed').length,
    };
  }

  return returnFunction(res, 200, true, req.locale.success, {
    ...project,
    supervisor: supervisor ?? null,
    members: enrichedMembers,
    subtaskCount:       subtasks.length,
    completedSubtasks:  subtasks.filter((s) => s.status === 'completed').length,
    deptProgress,
    myRole,
    myDepartment,
  });
};

// ── Update Project ────────────────────────────────────────────────────────────

const updateProject = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user.id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can edit this project.');
  }

  const { name, description, startDate, endDate, status, departments } = req.body;
  const update = { updatedAt: new Date() };
  if (name        !== undefined) update.name        = name.trim();
  if (description !== undefined) update.description = description || null;
  if (startDate   !== undefined) update.startDate   = startDate ? new Date(startDate) : null;
  if (endDate     !== undefined) update.endDate     = endDate   ? new Date(endDate)   : null;
  if (status      !== undefined) update.status      = status;
  if (departments !== undefined) update.departments = JSON.stringify(Array.isArray(departments) ? departments : [departments]);

  await knex('projects').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Complete Project (supervisor only) ────────────────────────────────────────

const completeProject = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!isSupervisor(project, req.user.id) && !HR_ROLES.includes(req.user.role)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can mark this project as complete.');
  }
  if (project.status === 'completed') {
    return returnFunction(res, 400, false, 'Project is already completed.');
  }

  const now = new Date();
  await knex('projects').where({ id: req.params.id }).update({ status: 'completed', completedAt: now, updatedAt: now });

  await notifyProjectMembers(req.params.id, {
    type: 'project', subType: 'project_completed',
    title: `Project "${project.name}" has been completed`,
    subtitle: `Marked complete by ${req.user.name || 'Supervisor'}`,
    referenceModel: 'projects', requiresAction: false, priority: 'normal',
    triggeredBy: req.user.id,
  }, req.user.id);

  return returnFunction(res, 200, true, 'Project marked as completed.');
};

// ── Delete Project ────────────────────────────────────────────────────────────

const deleteProject = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  // Delete attachments
  const subtasks = await knex('project_subtasks').where({ projectId: project.id });
  for (const s of subtasks) {
    for (const f of [s.attachmentFilename, s.deptHeadReport?.attachmentFilename]) {
      if (f) { try { fs.unlinkSync(path.join(UPLOAD_BASE, f)); } catch { /* ok */ } }
    }
  }

  await knex('project_time_entries').where({ projectId: project.id }).delete();
  await knex('project_messages').where({ projectId: project.id }).delete();
  await knex('project_chat_groups').where({ projectId: project.id }).delete();
  await knex('project_notes').where({ projectId: project.id }).delete();
  await knex('project_subtasks').where({ projectId: project.id }).delete();
  await knex('project_invites').where({ projectId: project.id }).delete();
  await knex('project_members').where({ projectId: project.id }).delete();
  await knex('projects').where({ id: project.id }).delete();

  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Members ───────────────────────────────────────────────────────────────────

const addMembers = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user.id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can add members.');
  }

  const { memberIds, role: memberRole } = req.body;
  const ids = Array.isArray(memberIds) ? memberIds : [memberIds];

  for (const empId of ids.filter(Boolean)) {
    const existing = await knex('project_members').where({ projectId: project.id, employeeId: empId }).first();
    if (existing) continue;
    const emp = await knex('employees').where({ id: empId }).select('fullName', 'department').first();
    await knex('project_members').insert({
      id: newId(), projectId: project.id, employeeId: empId,
      name: emp?.fullName ?? '', department: emp?.department ?? '',
      role: memberRole || 'member', addedAt: new Date(),
    });
    await createInboxItem({
      recipientId: empId,
      type: 'project', subType: 'project_assigned',
      title: `You've been added to project: ${project.name}`,
      subtitle: `You have been assigned as ${memberRole || 'member'}.`,
      referenceId: project.id, referenceModel: 'projects',
      requiresAction: false, priority: 'normal',
      triggeredBy: req.user.id,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, 'Members added.');
};

const removeMember = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user.id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can remove members.');
  }

  await knex('project_members').where({ projectId: project.id, employeeId: req.params.employeeId }).delete();
  return returnFunction(res, 200, true, 'Member removed.');
};

// ── Invites (external / not-yet-in-system members, e.g. short-term contractors) ─
// Every existing project-membership mechanic (chat, subtask assignment, notifications,
// canAccessProject) is built entirely around project_members.employeeId, which requires
// a real `employees` record. So inviting someone who isn't in the system yet works by
// creating that record (plus a `users` login, same shape createAccount uses) the moment
// they accept — not a parallel access mechanism. `contractEndDate` is mandatory here
// (unlike on the general employee form) so short engagements self-expire — see
// deactivateExpiredContractors in lib/tasks/cronTasks.js, which reads this field to
// auto-deactivate the login and flip employee status once it passes.

const generateInvitePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const createInvite = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'email', 'contractEndDate'])) return;
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user.id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can invite members.');
  }

  const email = String(req.body.email).toLowerCase().trim();
  const name  = String(req.body.name).trim();
  const projectRole = req.body.role || 'member';
  const contractEndDate = new Date(req.body.contractEndDate);
  if (Number.isNaN(contractEndDate.getTime()) || contractEndDate <= new Date()) {
    return returnFunction(res, 400, false, 'contractEndDate must be a valid future date.');
  }

  const existingUser = await knex('users').where({ email }).first();
  if (existingUser) {
    return returnFunction(res, 409, false, `${email} already has an account — add them as a regular member instead of inviting them.`);
  }
  // Only a still-live pending invite blocks a re-invite — one that's pending in name
  // only (the invitee never clicked through before expiresAt passed) must not lock HR
  // out of ever inviting that email again.
  const existingInvite = await knex('project_invites').where({ projectId: project.id, email, status: 'pending' }).where('expiresAt', '>', new Date()).first();
  if (existingInvite) return returnFunction(res, 409, false, 'There is already a pending invite for this email on this project.');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const doc = {
    id: newId(),
    projectId: project.id,
    projectName: project.name,
    email, name,
    projectRole,
    contractEndDate,
    invitedBy: req.user.id,
    invitedByName: req.user.name || 'Supervisor',
    tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
    status: 'pending',
    expiresAt,
    createdEmployeeId: null,
    respondedAt: null,
    createdAt: now, updatedAt: now,
  };
  const [saved] = await knex('project_invites').insert(doc).returning('*');

  const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/en/project-invite/${rawToken}`;
  sendEmail({
    to: email,
    subject: `You've been invited to join a project at ${COMPANY_NAME}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;">
        <h2>Project Invitation</h2>
        <p>Hi <strong>${name}</strong>,</p>
        <p>${doc.invitedByName} has invited you to join the project <strong>${project.name}</strong> at ${COMPANY_NAME} through ${contractEndDate.toDateString()}.</p>
        <p><a href="${inviteUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none;">View Invitation</a></p>
        <p style="color:#888;font-size:13px;">This invite link expires on ${expiresAt.toDateString()}.</p>
      </div>
    `,
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id });
};

const listInvites = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user.id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can view invites.');
  }

  const invites = await knex('project_invites').where({ projectId: project.id }).orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, invites);
};

const revokeInvite = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user.id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can revoke invites.');
  }

  const invite = await knex('project_invites').where({ id: req.params.inviteId, projectId: project.id }).first();
  if (!invite) return returnFunction(res, 404, false, req.locale.notFound);
  if (invite.status !== 'pending') return returnFunction(res, 400, false, 'Only pending invites can be revoked.');

  await knex('project_invites').where({ id: invite.id }).update({ status: 'revoked', updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Invite revoked.');
};

// Shared by both the public accept/decline routes (publicRoutes.js) — no logged-in
// user exists for either action, matching respondToOfferCore's actingUser-less pattern.
const findInviteByToken = async (rawToken) => {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return knex('project_invites').where({ tokenHash }).first();
};

const acceptInviteCore = async (invite) => {
  const project = await knex('projects').where({ id: invite.projectId }).first();
  const hireDate = new Date();
  const staffNumber = await generateStaffNumber(hireDate.getFullYear());

  const empDoc = {
    id: newId(),
    fullName: invite.name,
    firstName: null, lastName: null,
    email: invite.email,
    phone: null, nationalId: null,
    staffNumber,
    designation: 'Contractor',
    employmentType: 'contract',
    department: project?.departments?.[0] || null,
    jobGroupId: null,
    dateOfHire: hireDate,
    dateOfBirth: null,
    contractEndDate: invite.contractEndDate,
    probationEndDate: null, confirmationDate: null,
    terminationDate: null, terminationReason: null,
    grossPay: null, profilePhoto: null,
    status: 'active',
    createdAt: hireDate, updatedAt: hireDate,
  };
  const [savedEmp] = await knex('employees').insert(empDoc).returning('*');

  const rawPassword = generateInvitePassword();
  const hashedPassword = await bcrypt.hash(rawPassword, 12);
  await knex('users').insert({
    id: newId(),
    name: invite.name,
    email: invite.email,
    password: hashedPassword,
    role: 'staff',
    employeeId: savedEmp.id,
    department: empDoc.department,
    mustResetPassword: true,
    isActive: true,
    createdBy: invite.invitedBy,
    createdAt: hireDate, updatedAt: hireDate,
  });

  await knex('project_members').insert({
    id: newId(), projectId: invite.projectId, employeeId: savedEmp.id,
    name: invite.name, department: empDoc.department || '',
    role: invite.projectRole || 'member', addedAt: hireDate,
  });

  await knex('project_invites').where({ id: invite.id }).update({
    status: 'accepted', respondedAt: hireDate, createdEmployeeId: savedEmp.id, updatedAt: hireDate,
  });

  sendEmail({
    to: invite.email,
    subject: `Your ${COMPANY_NAME} account is ready`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;">
        <h2>Welcome to ${COMPANY_NAME}</h2>
        <p>Hi <strong>${invite.name}</strong>,</p>
        <p>You've accepted the invitation to join <strong>${invite.projectName}</strong>. Your account is ready:</p>
        <table style="background:#f5f5f5;padding:16px;border-radius:8px;width:100%;">
          <tr><td><strong>Email:</strong></td><td>${invite.email}</td></tr>
          <tr><td><strong>Password:</strong></td><td style="font-family:monospace;font-size:16px;">${rawPassword}</td></tr>
        </table>
        <p style="color:#e53e3e;font-size:13px;margin-top:12px;">You will be prompted to set a new password on your first login. Your access ends on ${new Date(invite.contractEndDate).toDateString()}.</p>
      </div>
    `,
  }).catch(() => {});

  if (project?.createdBy) {
    await createInboxItem({
      recipientId: project.createdBy,
      type: 'project', subType: 'project_invite_accepted',
      title: `${invite.name} accepted your invite to "${invite.projectName}"`,
      referenceId: invite.projectId, referenceModel: 'projects',
      requiresAction: false, priority: 'normal', triggeredBy: null,
    }).catch(() => {});
  }

  return savedEmp.id;
};

const declineInviteCore = async (invite) => {
  await knex('project_invites').where({ id: invite.id }).update({ status: 'declined', respondedAt: new Date(), updatedAt: new Date() });

  const project = await knex('projects').where({ id: invite.projectId }).select('createdBy', 'name').first();
  if (project?.createdBy) {
    await createInboxItem({
      recipientId: project.createdBy,
      type: 'project', subType: 'project_invite_declined',
      title: `${invite.name} declined your invite to "${invite.projectName}"`,
      referenceId: invite.projectId, referenceModel: 'projects',
      requiresAction: false, priority: 'normal', triggeredBy: null,
    }).catch(() => {});
  }
};

// ── Subtasks ──────────────────────────────────────────────────────────────────

const listSubtasks = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const userId = String(req.user.id);
  const role   = req.user.role;
  let query = knex('project_subtasks').where({ projectId: project.id });

  if (!HR_ROLES.includes(role) && !isSupervisor(project, userId)) {
    if (role === 'department_head') {
      const dept = await getEmployeeDept(req.user.employeeId);
      if (dept) query = query.where({ department: dept });
    } else if (req.user.employeeId) {
      // Staff: see subtasks assigned to them — assignedEmployees.employeeId is an
      // employee id, must match req.user.employeeId, not req.user.id.
      const myId = String(req.user.employeeId);
      query = query.whereRaw(`"assignedEmployees" @> ?`, [JSON.stringify([{ employeeId: myId }])]);
    } else {
      query = query.whereRaw('1 = 0'); // no linked employee record — nothing can be assigned to them
    }
  }

  const subtasks = await query.orderBy('createdAt', 'asc');
  return returnFunction(res, 200, true, req.locale.success, subtasks);
};

const createSubtask = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user.id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can create subtasks.');
  }

  const { title, description, department } = req.body;
  if (!title?.trim() || !department) {
    return returnFunction(res, 400, false, 'Title and department are required.');
  }

  const doc = {
    id: newId(),
    projectId: project.id,
    title:       title.trim(),
    description: description || null,
    department,
    attachmentFilename:    req.file?.filename     ?? null,
    attachmentOriginalName: req.file?.originalname ?? null,
    status: 'not_started',
    assignedEmployees: JSON.stringify([]),
    deptHeadReport: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const [saved] = await knex('project_subtasks').insert(doc).returning('*');

  // Notify department heads in the target department. Fixed forward — the
  // original query filtered `employees` by a `role` field that only ever
  // existed on `users` (employees has no role column at all; this silently
  // matched nothing under Mongo too, a pre-existing dead notification path,
  // not something this migration introduced — see approvalChain.js's
  // department_head resolution in lib/spend/ for the same, already-correct
  // pattern used elsewhere in this project).
  const deptHeads = await knex('users').where({ department, role: 'department_head' }).select('id');
  for (const dh of deptHeads) {
    await createInboxItem({
      recipientId: dh.id,
      type: 'project', subType: 'subtask_assigned',
      title: `New subtask for ${department}: "${title.trim()}"`,
      subtitle: `Project: ${project.name}`,
      referenceId: project.id, referenceModel: 'projects',
      requiresAction: true, priority: 'normal',
      triggeredBy: req.user.id,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id });
};

const updateSubtask = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user.id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can edit subtasks.');
  }

  const { title, description, department, status } = req.body;
  const update = { updatedAt: new Date() };
  if (title       !== undefined) update.title       = title.trim();
  if (description !== undefined) update.description = description || null;
  if (department  !== undefined) update.department  = department;
  if (status      !== undefined) update.status      = status;

  await knex('project_subtasks').where({ id: req.params.subId }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteSubtask = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user.id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can delete subtasks.');
  }

  const subtask = await knex('project_subtasks').where({ id: req.params.subId }).first();
  if (subtask) {
    for (const f of [subtask.attachmentFilename, subtask.deptHeadReport?.attachmentFilename]) {
      if (f) { try { fs.unlinkSync(path.join(UPLOAD_BASE, f)); } catch { /* ok */ } }
    }
    await knex('project_subtasks').where({ id: req.params.subId }).delete();
  }

  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// Dept head assigns employees to their department's subtask
const assignSubtaskEmployees = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const subtask = await knex('project_subtasks').where({ id: req.params.subId }).first();
  if (!subtask) return returnFunction(res, 404, false, req.locale.notFound);

  const userId     = String(req.user.id);
  const isSup      = isSupervisor(project, userId) || HR_ROLES.includes(req.user.role);
  const isDeptHead = req.user.role === 'department_head';

  if (!isSup && isDeptHead) {
    const dept = await getEmployeeDept(req.user.employeeId);
    if (dept !== subtask.department) {
      return returnFunction(res, 403, false, "You can only assign employees for your department's subtasks.");
    }
  } else if (!isSup) {
    return returnFunction(res, 403, false, 'Not authorized.');
  }

  const { employeeIds } = req.body;
  const ids = (Array.isArray(employeeIds) ? employeeIds : [employeeIds]).filter(Boolean);

  const assignedEmployees = [];
  for (const empId of ids) {
    const emp = await knex('employees').where({ id: empId }).select('fullName', 'department').first();
    if (!emp) continue;
    assignedEmployees.push({ employeeId: String(empId), name: emp.fullName, status: 'not_started' });

    // A subtask assignee needs to be a real project member — otherwise listProjects
    // never surfaces this project to them at all (they'd have no way to see the
    // project, its chat, or anything else about it, even though work was assigned).
    const existingMember = await knex('project_members').where({ projectId: project.id, employeeId: empId }).first();
    if (!existingMember) {
      await knex('project_members').insert({
        id: newId(), projectId: project.id, employeeId: empId,
        name: emp.fullName ?? '', department: emp.department ?? '',
        role: 'member', addedAt: new Date(),
      });
    }

    await createInboxItem({
      recipientId: empId,
      type: 'project', subType: 'subtask_assigned_to_you',
      title: `New subtask assigned to you: "${subtask.title}"`,
      subtitle: `Project: ${project.name}`,
      referenceId: req.params.id, referenceModel: 'projects',
      requiresAction: false, priority: 'normal',
      triggeredBy: userId,
    }).catch(() => {});
  }

  await knex('project_subtasks').where({ id: req.params.subId }).update({
    assignedEmployees: JSON.stringify(assignedEmployees), status: 'in_progress', updatedAt: new Date(),
  });

  return returnFunction(res, 200, true, 'Employees assigned to subtask.');
};

// Dept head submits report back to supervisor
const submitSubtaskReport = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const subtask = await knex('project_subtasks').where({ id: req.params.subId }).first();
  if (!subtask) return returnFunction(res, 404, false, req.locale.notFound);

  const userId = String(req.user.id);
  const isSup  = isSupervisor(project, userId) || HR_ROLES.includes(req.user.role);

  if (!isSup && req.user.role === 'department_head') {
    const dept = await getEmployeeDept(req.user.employeeId);
    if (dept !== subtask.department) {
      return returnFunction(res, 403, false, "You can only report on your department's subtasks.");
    }
  } else if (!isSup) {
    return returnFunction(res, 403, false, 'Not authorized.');
  }

  let submitterName = req.user.name || '';
  if (!submitterName) {
    const emp = await knex('employees').where({ id: userId }).select('fullName').first();
    submitterName = emp?.fullName ?? 'Department Head';
  }

  const now = new Date();
  await knex('project_subtasks').where({ id: req.params.subId }).update({
    deptHeadReport: JSON.stringify({
      text:                   req.body.reportText || '',
      attachmentFilename:     req.file?.filename     ?? null,
      attachmentOriginalName: req.file?.originalname ?? null,
      submittedAt:            now,
      submittedById:          userId,
      submittedByName:        submitterName,
    }),
    status:    'completed',
    updatedAt: now,
  });

  // Notify supervisor
  await createInboxItem({
    recipientId: project.createdBy,
    type: 'project', subType: 'subtask_report_submitted',
    title: `Report submitted for subtask: "${subtask.title}"`,
    subtitle: `${submitterName} submitted their team's report for project "${project.name}"`,
    referenceId: req.params.id, referenceModel: 'projects',
    requiresAction: false, priority: 'normal',
    triggeredBy: userId,
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Report submitted successfully.');
};

// ── Notes ─────────────────────────────────────────────────────────────────────

const listNotes = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const notes = await knex('project_notes').where({ projectId: project.id }).orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, notes);
};

const createNote = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const { text } = req.body;
  if (!text?.trim()) return returnFunction(res, 400, false, 'Note text is required.');

  let creatorName = req.user.name || '';
  if (!creatorName) {
    const emp = await knex('employees').where({ id: req.user.id }).select('fullName').first();
    creatorName = emp?.fullName ?? 'Unknown';
  }

  const doc = {
    id: newId(),
    projectId: project.id,
    text:          text.trim(),
    createdBy:     req.user.id,
    createdByName: creatorName,
    createdAt:     new Date(),
  };

  const [saved] = await knex('project_notes').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const deleteNote = async (req, res) => {
  const note = await knex('project_notes').where({ id: req.params.noteId }).first();
  if (!note) return returnFunction(res, 404, false, req.locale.notFound);

  if (String(note.createdBy) !== String(req.user.id) && !HR_ROLES.includes(req.user.role)) {
    return returnFunction(res, 403, false, 'You can only delete your own notes.');
  }

  await knex('project_notes').where({ id: req.params.noteId }).delete();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Chat Groups ───────────────────────────────────────────────────────────────
// A project's default chat ("General", groupId: null) always includes every project
// member — that's the project itself acting as the group. These are optional smaller
// sub-groups (e.g. just 3 of 8 members) layered on top, scoped to a chosen subset of
// people who are already on the project.

async function getValidProjectPersonIds(project) {
  const members = await knex('project_members').where({ projectId: project.id }).select('employeeId');
  const ids = new Set(members.map((m) => String(m.employeeId)));
  ids.add(String(project.createdBy)); // supervisor identified by USER id — may have no employee record at all
  return ids;
}

// Chat group memberIds mixes two id spaces by construction: the supervisor is stored by
// their user id (project.createdBy), regular members by employee id (project_members).
// So "is this logged-in person in this list" must check both req.user.id and
// req.user.employeeId, not just one.
function personMatchesIds(reqUser, idList) {
  const userIdStr = String(reqUser.id);
  const empIdStr  = reqUser.employeeId ? String(reqUser.employeeId) : null;
  return (idList || []).some((id) => { const s = String(id); return s === userIdStr || s === empIdStr; });
}

const listChatGroups = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const userId = String(req.user.id);
  const isSup  = isSupervisor(project, userId) || HR_ROLES.includes(req.user.role);

  let query = knex('project_chat_groups').where({ projectId: project.id });
  if (!isSup) {
    // memberIds may hold this person's user id (if they're the group creator) or
    // employee id (if they were invited as a regular member) — check both.
    const candidateIds = [userId];
    if (req.user.employeeId) candidateIds.push(String(req.user.employeeId));
    query = query.where((qb) => {
      for (const id of candidateIds) qb.orWhereRaw('"memberIds" @> ?', [JSON.stringify([id])]);
    });
  }

  const groups = await query.orderBy('createdAt', 'asc');
  return returnFunction(res, 200, true, req.locale.success, groups);
};

const createChatGroup = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const { name, memberIds } = req.body;
  if (!name?.trim()) return returnFunction(res, 400, false, 'Group name is required.');
  if (!Array.isArray(memberIds) || memberIds.length === 0) return returnFunction(res, 400, false, 'Select at least one member.');

  const userId = String(req.user.id);
  const isSup  = isSupervisor(project, userId) || HR_ROLES.includes(req.user.role);
  const validIds = await getValidProjectPersonIds(project);
  const empIdStr = req.user.employeeId ? String(req.user.employeeId) : null;

  if (!isSup && !validIds.has(userId) && !(empIdStr && validIds.has(empIdStr))) {
    return returnFunction(res, 403, false, 'Only project members can create chat groups.');
  }

  const cleanMemberIds = new Set(memberIds.map(String).filter((id) => validIds.has(id)));
  // Creator is always a member of their own group, represented by whichever id space
  // they actually appear under in validIds (employee id for a regular member, user id
  // for the supervisor/HR, who may have no linked employee record at all).
  cleanMemberIds.add(empIdStr && validIds.has(empIdStr) ? empIdStr : userId);
  if (cleanMemberIds.size < 2) return returnFunction(res, 400, false, 'Select at least one other project member.');

  let creatorName = req.user.name || '';
  if (!creatorName) {
    const emp = await knex('employees').where({ id: userId }).select('fullName').first();
    creatorName = emp?.fullName ?? 'Unknown';
  }

  const doc = {
    id: newId(),
    projectId:     project.id,
    name:          name.trim(),
    memberIds:     JSON.stringify([...cleanMemberIds]),
    createdBy:     userId,
    createdByName: creatorName,
    createdAt:     new Date(),
  };

  const [saved] = await knex('project_chat_groups').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateChatGroup = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const group = await knex('project_chat_groups').where({ id: req.params.groupId }).first();
  if (!group) return returnFunction(res, 404, false, req.locale.notFound);

  const userId = String(req.user.id);
  const isSup  = isSupervisor(project, userId) || HR_ROLES.includes(req.user.role);
  if (!isSup && String(group.createdBy) !== userId) {
    return returnFunction(res, 403, false, 'Only the group creator can update this group.');
  }

  const update = { updatedAt: new Date() };
  if (req.body.name?.trim()) update.name = req.body.name.trim();
  if (Array.isArray(req.body.memberIds)) {
    const validIds = await getValidProjectPersonIds(project);
    const cleanMemberIds = new Set(req.body.memberIds.map(String).filter((id) => validIds.has(id)));
    cleanMemberIds.add(String(group.createdBy));
    update.memberIds = JSON.stringify([...cleanMemberIds]);
  }

  await knex('project_chat_groups').where({ id: group.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteChatGroup = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const group = await knex('project_chat_groups').where({ id: req.params.groupId }).first();
  if (!group) return returnFunction(res, 404, false, req.locale.notFound);

  const userId = String(req.user.id);
  const isSup  = isSupervisor(project, userId) || HR_ROLES.includes(req.user.role);
  if (!isSup && String(group.createdBy) !== userId) {
    return returnFunction(res, 403, false, 'Only the group creator can delete this group.');
  }

  await knex('project_messages').where({ groupId: group.id }).delete();
  await knex('project_chat_groups').where({ id: group.id }).delete();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Chat / Messages ───────────────────────────────────────────────────────────

const getMessages = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const isSup  = isSupervisor(project, req.user.id) || HR_ROLES.includes(req.user.role);
  if (!(await canAccessProject(project, req.user))) {
    return returnFunction(res, 403, false, 'You do not have access to this project.');
  }

  let groupId = null;
  if (req.query.groupId) {
    const group = await knex('project_chat_groups').where({ id: req.query.groupId }).first();
    if (!group) return returnFunction(res, 404, false, req.locale.notFound);
    if (!isSup && !personMatchesIds(req.user, group.memberIds)) {
      return returnFunction(res, 403, false, 'Not a member of this chat group.');
    }
    groupId = group.id;
  }

  const limit  = Math.min(Number(req.query.limit) || 60, 100);
  let query = knex('project_messages').where({ projectId: req.params.id });
  query = groupId ? query.where({ groupId }) : query.whereNull('groupId');
  if (req.query.before) query = query.where('id', '<', req.query.before);

  const messages = await query.orderBy('id', 'desc').limit(limit);

  return returnFunction(res, 200, true, req.locale.success, messages.reverse());
};

const sendMessage = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const { message } = req.body;
  if (!message?.trim() && !req.file) return returnFunction(res, 400, false, 'Message or attachment is required.');

  const userId = String(req.user.id);
  const isSup  = isSupervisor(project, userId) || HR_ROLES.includes(req.user.role);
  if (!(await canAccessProject(project, req.user))) {
    return returnFunction(res, 403, false, 'You do not have access to this project.');
  }

  let groupId = null;
  if (req.body.groupId) {
    const group = await knex('project_chat_groups').where({ id: req.body.groupId }).first();
    if (!group) return returnFunction(res, 404, false, req.locale.notFound);
    if (!isSup && !personMatchesIds(req.user, group.memberIds)) {
      return returnFunction(res, 403, false, 'Not a member of this chat group.');
    }
    groupId = group.id;
  }

  let senderName = req.user.name || '';
  if (!senderName) {
    const emp = await knex('employees').where({ id: userId }).select('fullName').first();
    senderName = emp?.fullName ?? 'Unknown';
  }

  let senderRole = 'member';
  if (isSup) {
    senderRole = 'supervisor';
  } else if (req.user.employeeId) {
    const member = await knex('project_members').where({ projectId: req.params.id, employeeId: String(req.user.employeeId) }).first();
    senderRole = member?.role ?? req.user.role ?? 'member';
  } else {
    senderRole = req.user.role ?? 'member';
  }

  const doc = {
    id: newId(),
    projectId:  req.params.id,
    groupId,
    senderId:   userId,
    senderName,
    senderRole,
    message:    message?.trim() ?? '',
    attachmentFilename:     req.file?.filename     ?? null,
    attachmentOriginalName: req.file?.originalname ?? null,
    attachmentMimeType:     req.file?.mimetype      ?? null,
    createdAt:  new Date(),
  };

  const [saved] = await knex('project_messages').insert(doc).returning('*');
  return returnFunction(res, 201, true, 'Message sent.', saved);
};

// ── Time Entries ──────────────────────────────────────────────────────────────
// NEW this phase — meFunctions.js's getMyProjects already reads project_time_entries
// (aggregated hours + recent entries) but no write endpoint existed anywhere; the
// staff portal's "log time" button has always 404'd against POST /projects/:id/
// time-entries. Built for real here.

const createTimeEntry = async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id }).first();
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessProject(project, req.user))) {
    return returnFunction(res, 403, false, 'You do not have access to this project.');
  }
  if (!req.user.employeeId) {
    return returnFunction(res, 400, false, 'Your account is not linked to an employee profile.');
  }

  const { hours, date, task, description, billable } = req.body;
  if (!hours || Number(hours) <= 0) return returnFunction(res, 400, false, 'hours must be a positive number.');
  if (!date) return returnFunction(res, 400, false, 'date is required.');

  const doc = {
    id: newId(),
    projectId: project.id,
    employeeId: String(req.user.employeeId),
    hours: Number(hours),
    date: new Date(date),
    task: task || null,
    description: description || null,
    billable: Boolean(billable),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('project_time_entries').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

module.exports = {
  listProjects, createProject, getProject, updateProject, completeProject, deleteProject,
  addMembers, removeMember,
  createInvite, listInvites, revokeInvite, findInviteByToken, acceptInviteCore, declineInviteCore,
  listSubtasks, createSubtask, updateSubtask, deleteSubtask,
  assignSubtaskEmployees, submitSubtaskReport,
  listNotes, createNote, deleteNote,
  listChatGroups, createChatGroup, updateChatGroup, deleteChatGroup,
  getMessages, sendMessage,
  createTimeEntry,
};
