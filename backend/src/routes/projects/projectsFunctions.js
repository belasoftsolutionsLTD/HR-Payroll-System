const { ObjectId } = require('mongodb');
const path = require('path');
const fs   = require('fs');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { createInboxItem } = require('../inbox/inboxFunctions');

const HR_ROLES   = ['super_admin', 'hr_manager'];
const MGMT_ROLES = ['super_admin', 'hr_manager', 'department_head'];

const UPLOAD_BASE = path.join(
  process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', '..', '..', 'uploads'),
  'projects'
);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getEmployeeDept(userId) {
  try {
    const emp = await findOne('employees', { _id: new ObjectId(String(userId)) });
    return emp?.department ?? null;
  } catch { return null; }
}

function isSupervisor(project, userId) {
  return String(project.createdBy) === String(userId);
}

async function notifyProjectMembers(projectId, item, excludeId = null) {
  const members = await findMany('project_members', { projectId: new ObjectId(String(projectId)) }, { projection: { employeeId: 1 } });
  const project = await findOne('projects', { _id: new ObjectId(String(projectId)) }, { projection: { createdBy: 1 } });

  const recipientIds = new Set(members.map(m => String(m.employeeId)));
  if (project?.createdBy) recipientIds.add(String(project.createdBy));
  if (excludeId) recipientIds.delete(String(excludeId));

  for (const rId of recipientIds) {
    try {
      await createInboxItem({ ...item, recipientId: new ObjectId(rId), referenceId: new ObjectId(String(projectId)) });
    } catch { /* ignore individual notification failures */ }
  }
}

// ── List Projects ─────────────────────────────────────────────────────────────

const listProjects = async (req, res) => {
  const userId = req.user._id;
  const role   = req.user.role;
  const { page, limit, skip } = getPagination(req.query);

  let filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.search) {
    filter.name = { $regex: req.query.search, $options: 'i' };
  }

  if (!HR_ROLES.includes(role)) {
    // Build a filter that includes: projects I created OR I'm a member of OR (dept head) dept is involved
    const memberProjects = await findMany('project_members', { employeeId: new ObjectId(String(userId)) }, { projection: { projectId: 1 } });
    const memberIds = memberProjects.map(m => m.projectId);

    const orClauses = [
      { createdBy: new ObjectId(String(userId)) },
      ...(memberIds.length ? [{ _id: { $in: memberIds } }] : []),
    ];

    if (role === 'department_head') {
      const dept = await getEmployeeDept(userId);
      if (dept) orClauses.push({ departments: dept });
    }

    if (filter.name) {
      const baseOr = { $or: orClauses };
      filter = { $and: [{ name: filter.name }, baseOr] };
    } else {
      filter.$or = orClauses;
    }
    if (filter.status) filter.status = req.query.status;
  }

  const [total, data] = await Promise.all([
    countDocuments('projects', filter),
    findMany('projects', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const enriched = await Promise.all(data.map(async p => {
    const [memberCount, subtaskCount, completedSubtasks] = await Promise.all([
      countDocuments('project_members', { projectId: p._id }),
      countDocuments('project_subtasks', { projectId: p._id }),
      countDocuments('project_subtasks', { projectId: p._id, status: 'completed' }),
    ]);
    return { ...p, memberCount, subtaskCount, completedSubtasks };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

// ── Create Project ────────────────────────────────────────────────────────────

const createProject = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const { name, description, startDate, endDate, departments, teamLeaderId, memberIds } = req.body;

  const depts   = Array.isArray(departments) ? departments.filter(Boolean) : (departments ? [departments] : []);
  const members = Array.isArray(memberIds)   ? memberIds.filter(Boolean)   : (memberIds   ? [memberIds]   : []);

  let supervisorName = req.user.name || '';
  if (!supervisorName) {
    const supEmp = await findOne('employees', { _id: new ObjectId(String(req.user._id)) }, { projection: { fullName: 1 } });
    supervisorName = supEmp?.fullName ?? 'Supervisor';
  }

  let teamLeaderName = null;
  if (teamLeaderId) {
    const tl = await findOne('employees', { _id: new ObjectId(String(teamLeaderId)) }, { projection: { fullName: 1 } });
    teamLeaderName = tl?.fullName ?? null;
  }

  const doc = {
    name: name.trim(),
    description: description || null,
    status: 'in_progress',
    startDate:  startDate ? new Date(startDate) : null,
    endDate:    endDate   ? new Date(endDate)   : null,
    departments: depts,
    teamLeaderId:   teamLeaderId ? new ObjectId(String(teamLeaderId)) : null,
    teamLeaderName,
    createdBy:      new ObjectId(String(req.user._id)),
    supervisorName,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result    = await insertOne('projects', doc);
  const projectId = result.insertedId;

  // Add team leader as member (role: team_leader)
  const addedIds = new Set();
  if (teamLeaderId) {
    const tl = await findOne('employees', { _id: new ObjectId(String(teamLeaderId)) }, { projection: { fullName: 1, department: 1 } });
    await global.dbo.collection('project_members').insertOne({
      projectId, employeeId: new ObjectId(String(teamLeaderId)),
      name: tl?.fullName ?? 'Team Leader', department: tl?.department ?? '',
      role: 'team_leader', addedAt: new Date(),
    });
    addedIds.add(String(teamLeaderId));
  }

  // Add remaining members
  for (const empId of members) {
    if (addedIds.has(String(empId))) continue;
    const emp = await findOne('employees', { _id: new ObjectId(String(empId)) }, { projection: { fullName: 1, department: 1 } });
    if (!emp) continue;
    await global.dbo.collection('project_members').insertOne({
      projectId, employeeId: new ObjectId(String(empId)),
      name: emp.fullName, department: emp.department ?? '',
      role: 'member', addedAt: new Date(),
    });
    addedIds.add(String(empId));
  }

  // Inbox notifications for all added members
  const allNotifyIds = [...(teamLeaderId ? [teamLeaderId] : []), ...members];
  for (const empId of allNotifyIds) {
    await createInboxItem({
      recipientId: new ObjectId(String(empId)),
      type: 'project', subType: 'project_assigned',
      title: `You've been added to project: ${name.trim()}`,
      subtitle: `Supervisor: ${supervisorName}`,
      referenceId: projectId, referenceModel: 'projects',
      requiresAction: false, priority: 'normal',
      triggeredBy: req.user._id,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: projectId });
};

// ── Get Project ───────────────────────────────────────────────────────────────

const getProject = async (req, res) => {
  const projectId = new ObjectId(req.params.id);
  const project   = await findOne('projects', { _id: projectId });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const [members, subtasks] = await Promise.all([
    findMany('project_members', { projectId }),
    findMany('project_subtasks', { projectId }, { sort: { createdAt: 1 } }),
  ]);

  const enrichedMembers = await Promise.all(members.map(async m => {
    const emp = await findOne('employees', { _id: m.employeeId }, { projection: { fullName: 1, department: 1, jobTitle: 1 } });
    return { ...m, employee: emp ?? null };
  }));

  const supervisor = await findOne('employees', { _id: project.createdBy }, { projection: { fullName: 1, department: 1, jobTitle: 1 } });

  const userId = String(req.user._id);
  const role   = req.user.role;
  let myRole       = null;
  let myDepartment = null;

  if (HR_ROLES.includes(role) || isSupervisor(project, userId)) {
    myRole = 'supervisor';
  } else {
    const member = enrichedMembers.find(m => String(m.employeeId) === userId);
    myRole = member?.role ?? null;
  }

  if (role === 'department_head') {
    myDepartment = await getEmployeeDept(userId);
  }

  const deptProgress = {};
  for (const dept of (project.departments || [])) {
    const deptSubs = subtasks.filter(s => s.department === dept);
    deptProgress[dept] = {
      total:     deptSubs.length,
      completed: deptSubs.filter(s => s.status === 'completed').length,
    };
  }

  return returnFunction(res, 200, true, req.locale.success, {
    ...project,
    supervisor: supervisor ?? null,
    members: enrichedMembers,
    subtaskCount:       subtasks.length,
    completedSubtasks:  subtasks.filter(s => s.status === 'completed').length,
    deptProgress,
    myRole,
    myDepartment,
  });
};

// ── Update Project ────────────────────────────────────────────────────────────

const updateProject = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user._id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can edit this project.');
  }

  const { name, description, startDate, endDate, status, departments } = req.body;
  const update = { updatedAt: new Date() };
  if (name        !== undefined) update.name        = name.trim();
  if (description !== undefined) update.description = description || null;
  if (startDate   !== undefined) update.startDate   = startDate ? new Date(startDate) : null;
  if (endDate     !== undefined) update.endDate     = endDate   ? new Date(endDate)   : null;
  if (status      !== undefined) update.status      = status;
  if (departments !== undefined) update.departments = Array.isArray(departments) ? departments : [departments];

  await updateOne('projects', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Complete Project (supervisor only) ────────────────────────────────────────

const completeProject = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!isSupervisor(project, req.user._id) && !HR_ROLES.includes(req.user.role)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can mark this project as complete.');
  }
  if (project.status === 'completed') {
    return returnFunction(res, 400, false, 'Project is already completed.');
  }

  const now = new Date();
  await updateOne('projects', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'completed', completedAt: now, updatedAt: now },
  });

  await notifyProjectMembers(req.params.id, {
    type: 'project', subType: 'project_completed',
    title: `Project "${project.name}" has been completed`,
    subtitle: `Marked complete by ${req.user.name || 'Supervisor'}`,
    referenceModel: 'projects', requiresAction: false, priority: 'normal',
    triggeredBy: req.user._id,
  }, req.user._id);

  return returnFunction(res, 200, true, 'Project marked as completed.');
};

// ── Delete Project ────────────────────────────────────────────────────────────

const deleteProject = async (req, res) => {
  const projectId = new ObjectId(req.params.id);
  const project   = await findOne('projects', { _id: projectId });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  // Delete attachments
  const subtasks = await findMany('project_subtasks', { projectId });
  for (const s of subtasks) {
    for (const f of [s.attachmentFilename, s.deptHeadReport?.attachmentFilename]) {
      if (f) { try { fs.unlinkSync(path.join(UPLOAD_BASE, f)); } catch { /* ok */ } }
    }
  }

  await Promise.all([
    global.dbo.collection('projects').deleteOne({ _id: projectId }),
    global.dbo.collection('project_members').deleteMany({ projectId }),
    global.dbo.collection('project_subtasks').deleteMany({ projectId }),
    global.dbo.collection('project_notes').deleteMany({ projectId }),
    global.dbo.collection('project_messages').deleteMany({ projectId }),
  ]);

  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Members ───────────────────────────────────────────────────────────────────

const addMembers = async (req, res) => {
  const projectId = new ObjectId(req.params.id);
  const project   = await findOne('projects', { _id: projectId });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user._id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can add members.');
  }

  const { memberIds, role: memberRole } = req.body;
  const ids = Array.isArray(memberIds) ? memberIds : [memberIds];

  for (const empId of ids.filter(Boolean)) {
    const existing = await findOne('project_members', { projectId, employeeId: new ObjectId(String(empId)) });
    if (existing) continue;
    const emp = await findOne('employees', { _id: new ObjectId(String(empId)) }, { projection: { fullName: 1, department: 1 } });
    await global.dbo.collection('project_members').insertOne({
      projectId, employeeId: new ObjectId(String(empId)),
      name: emp?.fullName ?? '', department: emp?.department ?? '',
      role: memberRole || 'member', addedAt: new Date(),
    });
    await createInboxItem({
      recipientId: new ObjectId(String(empId)),
      type: 'project', subType: 'project_assigned',
      title: `You've been added to project: ${project.name}`,
      subtitle: `You have been assigned as ${memberRole || 'member'}.`,
      referenceId: projectId, referenceModel: 'projects',
      requiresAction: false, priority: 'normal',
      triggeredBy: req.user._id,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, 'Members added.');
};

const removeMember = async (req, res) => {
  const projectId = new ObjectId(req.params.id);
  const project   = await findOne('projects', { _id: projectId });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user._id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can remove members.');
  }

  await global.dbo.collection('project_members').deleteOne({
    projectId, employeeId: new ObjectId(req.params.employeeId),
  });
  return returnFunction(res, 200, true, 'Member removed.');
};

// ── Subtasks ──────────────────────────────────────────────────────────────────

const listSubtasks = async (req, res) => {
  const projectId = new ObjectId(req.params.id);
  const project   = await findOne('projects', { _id: projectId });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const userId = String(req.user._id);
  const role   = req.user.role;
  const filter = { projectId };

  if (!HR_ROLES.includes(role) && !isSupervisor(project, userId)) {
    if (role === 'department_head') {
      const dept = await getEmployeeDept(userId);
      if (dept) filter.department = dept;
    } else {
      // Staff: see subtasks assigned to them
      filter['assignedEmployees.employeeId'] = new ObjectId(userId);
    }
  }

  const subtasks = await findMany('project_subtasks', filter, { sort: { createdAt: 1 } });
  return returnFunction(res, 200, true, req.locale.success, subtasks);
};

const createSubtask = async (req, res) => {
  const projectId = new ObjectId(req.params.id);
  const project   = await findOne('projects', { _id: projectId });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user._id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can create subtasks.');
  }

  const { title, description, department } = req.body;
  if (!title?.trim() || !department) {
    return returnFunction(res, 400, false, 'Title and department are required.');
  }

  const doc = {
    projectId,
    title:       title.trim(),
    description: description || null,
    department,
    attachmentFilename:    req.file?.filename     ?? null,
    attachmentOriginalName: req.file?.originalname ?? null,
    status: 'not_started',
    assignedEmployees: [],
    deptHeadReport: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('project_subtasks', doc);

  // Notify department heads in the target department
  const deptHeads = await findMany('employees',
    { department, role: 'department_head' },
    { projection: { _id: 1 } }
  );
  for (const dh of deptHeads) {
    await createInboxItem({
      recipientId: dh._id,
      type: 'project', subType: 'subtask_assigned',
      title: `New subtask for ${department}: "${title.trim()}"`,
      subtitle: `Project: ${project.name}`,
      referenceId: projectId, referenceModel: 'projects',
      requiresAction: true, priority: 'normal',
      triggeredBy: req.user._id,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateSubtask = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user._id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can edit subtasks.');
  }

  const { title, description, department, status } = req.body;
  const update = { updatedAt: new Date() };
  if (title       !== undefined) update.title       = title.trim();
  if (description !== undefined) update.description = description || null;
  if (department  !== undefined) update.department  = department;
  if (status      !== undefined) update.status      = status;

  await updateOne('project_subtasks', { _id: new ObjectId(req.params.subId) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteSubtask = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  if (!HR_ROLES.includes(req.user.role) && !isSupervisor(project, req.user._id)) {
    return returnFunction(res, 403, false, 'Only the project supervisor can delete subtasks.');
  }

  const subtask = await findOne('project_subtasks', { _id: new ObjectId(req.params.subId) });
  if (subtask) {
    for (const f of [subtask.attachmentFilename, subtask.deptHeadReport?.attachmentFilename]) {
      if (f) { try { fs.unlinkSync(path.join(UPLOAD_BASE, f)); } catch { /* ok */ } }
    }
    await global.dbo.collection('project_subtasks').deleteOne({ _id: new ObjectId(req.params.subId) });
  }

  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// Dept head assigns employees to their department's subtask
const assignSubtaskEmployees = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const subtask = await findOne('project_subtasks', { _id: new ObjectId(req.params.subId) });
  if (!subtask) return returnFunction(res, 404, false, req.locale.notFound);

  const userId     = String(req.user._id);
  const isSup      = isSupervisor(project, userId) || HR_ROLES.includes(req.user.role);
  const isDeptHead = req.user.role === 'department_head';

  if (!isSup && isDeptHead) {
    const dept = await getEmployeeDept(userId);
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
    const emp = await findOne('employees', { _id: new ObjectId(String(empId)) }, { projection: { fullName: 1 } });
    if (!emp) continue;
    assignedEmployees.push({ employeeId: new ObjectId(String(empId)), name: emp.fullName, status: 'not_started' });

    await createInboxItem({
      recipientId: new ObjectId(String(empId)),
      type: 'project', subType: 'subtask_assigned_to_you',
      title: `New subtask assigned to you: "${subtask.title}"`,
      subtitle: `Project: ${project.name}`,
      referenceId: new ObjectId(req.params.id), referenceModel: 'projects',
      requiresAction: false, priority: 'normal',
      triggeredBy: new ObjectId(userId),
    }).catch(() => {});
  }

  await updateOne('project_subtasks', { _id: new ObjectId(req.params.subId) }, {
    $set: { assignedEmployees, status: 'in_progress', updatedAt: new Date() },
  });

  return returnFunction(res, 200, true, 'Employees assigned to subtask.');
};

// Dept head submits report back to supervisor
const submitSubtaskReport = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const subtask = await findOne('project_subtasks', { _id: new ObjectId(req.params.subId) });
  if (!subtask) return returnFunction(res, 404, false, req.locale.notFound);

  const userId = String(req.user._id);
  const isSup  = isSupervisor(project, userId) || HR_ROLES.includes(req.user.role);

  if (!isSup && req.user.role === 'department_head') {
    const dept = await getEmployeeDept(userId);
    if (dept !== subtask.department) {
      return returnFunction(res, 403, false, "You can only report on your department's subtasks.");
    }
  } else if (!isSup) {
    return returnFunction(res, 403, false, 'Not authorized.');
  }

  let submitterName = req.user.name || '';
  if (!submitterName) {
    const emp = await findOne('employees', { _id: new ObjectId(userId) }, { projection: { fullName: 1 } });
    submitterName = emp?.fullName ?? 'Department Head';
  }

  const now = new Date();
  await updateOne('project_subtasks', { _id: new ObjectId(req.params.subId) }, {
    $set: {
      deptHeadReport: {
        text:                   req.body.reportText || '',
        attachmentFilename:     req.file?.filename     ?? null,
        attachmentOriginalName: req.file?.originalname ?? null,
        submittedAt:            now,
        submittedById:          new ObjectId(userId),
        submittedByName:        submitterName,
      },
      status:    'completed',
      updatedAt: now,
    },
  });

  // Notify supervisor
  await createInboxItem({
    recipientId: project.createdBy,
    type: 'project', subType: 'subtask_report_submitted',
    title: `Report submitted for subtask: "${subtask.title}"`,
    subtitle: `${submitterName} submitted their team's report for project "${project.name}"`,
    referenceId: new ObjectId(req.params.id), referenceModel: 'projects',
    requiresAction: false, priority: 'normal',
    triggeredBy: new ObjectId(userId),
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Report submitted successfully.');
};

// ── Notes ─────────────────────────────────────────────────────────────────────

const listNotes = async (req, res) => {
  const projectId = new ObjectId(req.params.id);
  const project   = await findOne('projects', { _id: projectId });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const notes = await findMany('project_notes', { projectId }, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, notes);
};

const createNote = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const { text } = req.body;
  if (!text?.trim()) return returnFunction(res, 400, false, 'Note text is required.');

  let creatorName = req.user.name || '';
  if (!creatorName) {
    const emp = await findOne('employees', { _id: new ObjectId(String(req.user._id)) }, { projection: { fullName: 1 } });
    creatorName = emp?.fullName ?? 'Unknown';
  }

  const doc = {
    projectId: new ObjectId(req.params.id),
    text:          text.trim(),
    createdBy:     new ObjectId(String(req.user._id)),
    createdByName: creatorName,
    createdAt:     new Date(),
  };

  const result = await insertOne('project_notes', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const deleteNote = async (req, res) => {
  const note = await findOne('project_notes', { _id: new ObjectId(req.params.noteId) });
  if (!note) return returnFunction(res, 404, false, req.locale.notFound);

  if (String(note.createdBy) !== String(req.user._id) && !HR_ROLES.includes(req.user.role)) {
    return returnFunction(res, 403, false, 'You can only delete your own notes.');
  }

  await global.dbo.collection('project_notes').deleteOne({ _id: new ObjectId(req.params.noteId) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Chat / Messages ───────────────────────────────────────────────────────────

const getMessages = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const limit  = Math.min(Number(req.query.limit) || 60, 100);
  const filter = { projectId: new ObjectId(req.params.id) };
  if (req.query.before) {
    try { filter._id = { $lt: new ObjectId(req.query.before) }; } catch { /* ignore invalid id */ }
  }

  const messages = await global.dbo.collection('project_messages')
    .find(filter)
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();

  return returnFunction(res, 200, true, req.locale.success, messages.reverse());
};

const sendMessage = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const { message } = req.body;
  if (!message?.trim()) return returnFunction(res, 400, false, 'Message is required.');

  const userId = String(req.user._id);

  let senderName = req.user.name || '';
  if (!senderName) {
    const emp = await findOne('employees', { _id: new ObjectId(userId) }, { projection: { fullName: 1 } });
    senderName = emp?.fullName ?? 'Unknown';
  }

  let senderRole = 'member';
  if (isSupervisor(project, userId) || HR_ROLES.includes(req.user.role)) {
    senderRole = 'supervisor';
  } else {
    const member = await findOne('project_members', { projectId: new ObjectId(req.params.id), employeeId: new ObjectId(userId) });
    senderRole = member?.role ?? req.user.role ?? 'member';
  }

  const doc = {
    projectId:  new ObjectId(req.params.id),
    senderId:   new ObjectId(userId),
    senderName,
    senderRole,
    message:    message.trim(),
    createdAt:  new Date(),
  };

  const result = await insertOne('project_messages', doc);
  return returnFunction(res, 201, true, 'Message sent.', { _id: result.insertedId, ...doc });
};

module.exports = {
  listProjects, createProject, getProject, updateProject, completeProject, deleteProject,
  addMembers, removeMember,
  listSubtasks, createSubtask, updateSubtask, deleteSubtask,
  assignSubtaskEmployees, submitSubtaskReport,
  listNotes, createNote, deleteNote,
  getMessages, sendMessage,
};
