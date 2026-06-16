const { ObjectId } = require('mongodb');
const path = require('path');
const fs   = require('fs');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyEmployee } = require('../../functions/HR/notifyUser');

const getPagination = (query) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(50, parseInt(query.limit) || 20);
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
};

// ── HR: list all tasks ────────────────────────────────────────────────────────
const listTasks = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status)     filter.status     = req.query.status;
  if (req.query.priority)   filter.priority   = req.query.priority;
  if (req.query.department) filter.department = req.query.department;
  if (req.query.taskType)   filter.taskType   = req.query.taskType;
  if (req.query.search)     filter.assignedToName = { $regex: req.query.search, $options: 'i' };

  const [total, data] = await Promise.all([
    countDocuments('employee_tasks', filter),
    findMany('employee_tasks', filter, { sort: { dueDate: 1, createdAt: -1 }, skip, limit }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, { data, total, page, limit });
};

// ── HR: create task (single or bulk-by-department) ────────────────────────────
const createTask = async (req, res) => {
  const { title, description, dueDate, priority, assignedTo, bulkDepartment, taskType, phases } = req.body;
  if (!title || !dueDate) return returnFunction(res, 400, false, 'title and dueDate are required.');

  const type = taskType === 'milestone' ? 'milestone' : 'task';

  let parsedPhases = [];
  if (type === 'milestone') {
    const raw = typeof phases === 'string' ? JSON.parse(phases) : (phases || []);
    parsedPhases = raw.map((p, i) => ({
      index: i,
      title:       p.title       || `Phase ${i + 1}`,
      description: p.description || '',
      dueDate:     p.dueDate     || dueDate,
      status:      'pending',
      completedAt:    null,
      completionFile: null,
    }));
  }

  const baseDoc = (emp) => ({
    title:          title.trim(),
    description:    description || '',
    taskType:       type,
    phases:         parsedPhases.map(p => ({ ...p })),
    assignedTo:     emp._id,
    assignedToName: emp.fullName,
    department:     emp.department || '',
    assignedBy:     req.user?.name || 'HR',
    dueDate,
    priority:       priority || 'medium',
    status:         'pending',
    completionFile: null,
    completedAt:    null,
    createdAt:      new Date(),
    updatedAt:      new Date(),
  });

  // Bulk: assign to every active employee in a department
  if (bulkDepartment) {
    const employees = await findMany('employees',
      { department: bulkDepartment, status: 'active' },
      { projection: { _id: 1, fullName: 1, department: 1 } }
    );
    if (!employees.length) return returnFunction(res, 404, false, 'No active employees in that department.');
    await global.dbo.collection('employee_tasks').insertMany(employees.map(baseDoc));
    for (const e of employees) {
      notifyEmployee(e._id, {
        title: `New ${type === 'milestone' ? 'Milestone' : 'Task'}: ${title}`,
        body: `Due ${new Date(dueDate).toLocaleDateString('en-KE', { dateStyle: 'medium' })} · ${priority || 'medium'} priority`,
        type: 'general',
      });
    }
    return returnFunction(res, 201, true, `Assigned to ${employees.length} employees.`);
  }

  // Single employee
  if (!assignedTo) return returnFunction(res, 400, false, 'assignedTo or bulkDepartment is required.');
  const employee = await findOne('employees', { _id: new ObjectId(assignedTo) });
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  const result = await insertOne('employee_tasks', baseDoc(employee));

  notifyEmployee(employee._id, {
    title: `New ${type === 'milestone' ? 'Milestone' : 'Task'}: ${title}`,
    body: `Due ${new Date(dueDate).toLocaleDateString('en-KE', { dateStyle: 'medium' })} · ${priority || 'medium'} priority`,
    type: 'general',
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// ── HR: update task ───────────────────────────────────────────────────────────
const updateTask = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  if (update.status === 'completed' && !update.completedAt) update.completedAt = new Date();
  await updateOne('employee_tasks', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── HR: delete task ───────────────────────────────────────────────────────────
const deleteTask = async (req, res) => {
  await global.dbo.collection('employee_tasks').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted.');
};

// ── Employee: mark a regular task as complete (with optional file) ─────────────
const completeTask = async (req, res) => {
  const task = await findOne('employee_tasks', { _id: new ObjectId(req.params.id) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (String(task.assignedTo) !== String(req.user.employeeId)) return returnFunction(res, 403, false, 'Not your task.');
  if (task.taskType === 'milestone') return returnFunction(res, 400, false, 'Use phase completion for milestones.');

  const fileInfo = req.file ? {
    originalName: req.file.originalname,
    path:         req.file.path,
    mimeType:     req.file.mimetype,
    size:         req.file.size,
    uploadedAt:   new Date(),
  } : null;

  await updateOne('employee_tasks', { _id: task._id }, {
    $set: { status: 'completed', completedAt: new Date(), completionFile: fileInfo, updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Task marked as complete.');
};

// ── Employee: complete one phase of a milestone (with optional file) ───────────
const completePhase = async (req, res) => {
  const task = await findOne('employee_tasks', { _id: new ObjectId(req.params.id) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (String(task.assignedTo) !== String(req.user.employeeId)) return returnFunction(res, 403, false, 'Not your task.');
  if (task.taskType !== 'milestone') return returnFunction(res, 400, false, 'Not a milestone.');

  const idx = parseInt(req.params.phaseIndex);
  if (isNaN(idx) || idx < 0 || idx >= (task.phases || []).length) {
    return returnFunction(res, 400, false, 'Invalid phase index.');
  }

  const fileInfo = req.file ? {
    originalName: req.file.originalname,
    path:         req.file.path,
    mimeType:     req.file.mimetype,
    size:         req.file.size,
    uploadedAt:   new Date(),
  } : null;

  const phases = (task.phases || []).map((p, i) =>
    i === idx ? { ...p, status: 'completed', completedAt: new Date(), completionFile: fileInfo } : p
  );

  const allDone = phases.every(p => p.status === 'completed');
  const patch = { phases, updatedAt: new Date() };
  if (allDone) { patch.status = 'completed'; patch.completedAt = new Date(); }

  await updateOne('employee_tasks', { _id: task._id }, { $set: patch });
  return returnFunction(res, 200, true, allDone ? 'All phases done — milestone complete!' : 'Phase marked complete.');
};

// ── Download a completion file (task or phase) ────────────────────────────────
const downloadCompletionFile = async (req, res) => {
  const task = await findOne('employee_tasks', { _id: new ObjectId(req.params.id) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');

  // Authorisation: HR can see any, employee can see their own
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(task.assignedTo) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  let fileInfo = task.completionFile;
  if (req.params.phaseIndex !== undefined) {
    const idx = parseInt(req.params.phaseIndex);
    fileInfo = (task.phases || [])[idx]?.completionFile;
  }

  if (!fileInfo?.path) return returnFunction(res, 404, false, 'No completion file found.');
  if (!fs.existsSync(fileInfo.path)) return returnFunction(res, 404, false, 'File not found on disk.');

  res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.originalName}"`);
  res.setHeader('Content-Type', fileInfo.mimeType || 'application/octet-stream');
  return res.sendFile(path.resolve(fileInfo.path));
};

// ── Employee: update own task status (quick toggle) ───────────────────────────
const updateMyTaskStatus = async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'in_progress', 'completed'].includes(status)) return returnFunction(res, 400, false, 'Invalid status.');
  const task = await findOne('employee_tasks', { _id: new ObjectId(req.params.id) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (String(task.assignedTo) !== String(req.user.employeeId)) return returnFunction(res, 403, false, 'Not your task.');
  const patch = { status, updatedAt: new Date() };
  if (status === 'completed') patch.completedAt = new Date();
  await updateOne('employee_tasks', { _id: task._id }, { $set: patch });
  return returnFunction(res, 200, true, 'Status updated.');
};

// ── Employee: list own tasks ──────────────────────────────────────────────────
const getMyTasks = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'OK', []);
  const filter = { assignedTo: req.user.employeeId };
  if (req.query.status) filter.status = req.query.status;
  const tasks = await findMany('employee_tasks', filter, { sort: { dueDate: 1 } });
  return returnFunction(res, 200, true, 'OK', tasks);
};

// ── HR: search employees for task assignment ──────────────────────────────────
const searchEmployeesForTask = async (req, res) => {
  const { q = '', department } = req.query;
  const filter = { status: 'active' };
  if (q)          filter.$or = [{ fullName: { $regex: q, $options: 'i' } }, { staffNumber: { $regex: q, $options: 'i' } }];
  if (department) filter.department = department;
  const employees = await findMany('employees', filter, {
    projection: { _id: 1, fullName: 1, staffNumber: 1, department: 1, designation: 1 },
    limit: 20, sort: { fullName: 1 },
  });
  return returnFunction(res, 200, true, 'OK', employees);
};

module.exports = {
  listTasks, createTask, updateTask, deleteTask,
  updateMyTaskStatus, getMyTasks, searchEmployeesForTask,
  completeTask, completePhase, downloadCompletionFile,
};
