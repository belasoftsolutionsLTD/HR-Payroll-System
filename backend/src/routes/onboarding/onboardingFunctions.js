const { ObjectId } = require('mongodb');
const path = require('path');
const fs   = require('fs');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, updateOne, insertOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');

// ── Templates ──────────────────────────────────────────────────────────────────
const listTemplates = async (req, res) => {
  const templates = await findMany('onboarding_templates', {}, { sort: { order: 1, name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, templates);
};

const createTemplate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title'])) return;
  const { title, description, department, daysToComplete } = req.body;
  const doc = {
    title: title.trim(),
    description: description?.trim() || '',
    department: department || 'All',
    daysToComplete: parseInt(daysToComplete) || 7,
    createdAt: new Date(),
  };
  const result = await insertOne('onboarding_templates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateTemplate = async (req, res) => {
  const { title, description, department, daysToComplete } = req.body;
  const update = {};
  if (title !== undefined)          update.title          = title.trim();
  if (description !== undefined)    update.description    = description.trim();
  if (department !== undefined)     update.department     = department;
  if (daysToComplete !== undefined) update.daysToComplete = parseInt(daysToComplete) || 7;
  if (!Object.keys(update).length)  return returnFunction(res, 400, false, 'Nothing to update.');
  await updateOne('onboarding_templates', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully || 'Updated.');
};

const deleteTemplate = async (req, res) => {
  await global.dbo.collection('onboarding_templates').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted.');
};

// ── Assign default template tasks to an employee ───────────────────────────────
const assignDefaultTasks = async (employeeId, hireDate) => {
  const templates = await findMany('onboarding_templates', {});
  if (!templates.length) return;

  const base = hireDate ? new Date(hireDate) : new Date();
  const tasks = templates.map((t) => {
    const due = new Date(base);
    due.setDate(due.getDate() + (t.daysToComplete || 7));
    return {
      employeeId: new ObjectId(employeeId),
      taskTitle: t.title,
      description: t.description || '',
      assignedDepartment: t.department || 'HR',
      dueDate: due.toISOString().slice(0, 10),
      status: 'pending',
      templateId: t._id,
      createdAt: new Date(),
    };
  });

  if (tasks.length) {
    await global.dbo.collection('onboarding_tasks').insertMany(tasks);
  }
};

// ── Add a single task to an employee ──────────────────────────────────────────
const addEmployeeTask = async (req, res) => {
  if (!validateRequiredFields(req, res, ['taskTitle', 'dueDate'])) return;
  const { taskTitle, description, assignedDepartment, dueDate } = req.body;
  const doc = {
    employeeId: new ObjectId(req.params.employeeId),
    taskTitle: taskTitle.trim(),
    description: description?.trim() || '',
    assignedDepartment: assignedDepartment || 'HR',
    dueDate,
    status: 'pending',
    templateId: null,
    createdAt: new Date(),
  };
  const result = await insertOne('onboarding_tasks', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// ── HTTP handler: assign template tasks to an employee ─────────────────────────
const assignDefaultTasksHandler = async (req, res) => {
  const employee = await findOne('employees', { _id: new ObjectId(req.params.employeeId) });
  if (!employee) return returnFunction(res, 404, false, req.locale.notFound);

  // Prevent double onboarding — check for existing active tasks or details record
  const existingTasks = await countDocuments('onboarding_tasks', {
    employeeId: employee._id, status: { $ne: 'completed' },
  });
  const existingDetails = await findOne('onboarding_details', { employeeId: employee._id });
  if (existingTasks > 0 || existingDetails) {
    return returnFunction(res, 409, false, `${employee.fullName} is already in onboarding. Remove them first before restarting.`);
  }

  const { jobTitle, grossPay, startDate, jobGroupId, designationId, jdTemplateId, jdType, probationMonths } = req.body;

  // Update employee record with confirmed offer details
  const empUpdate = { updatedAt: new Date() };
  if (jobTitle)   empUpdate.designation = jobTitle.trim();
  if (grossPay)   empUpdate.grossPay    = parseFloat(grossPay);
  if (startDate)  empUpdate.dateOfHire  = startDate;
  if (jobGroupId) empUpdate.jobGroupId  = jobGroupId;
  if (Object.keys(empUpdate).length > 1) {
    await updateOne('employees', { _id: employee._id }, { $set: empUpdate });
  }

  // Compute probation end date
  const probMonths = parseInt(probationMonths) || 0;
  let probationEndDate = null;
  if (probMonths > 0 && startDate) {
    const d = new Date(startDate);
    d.setMonth(d.getMonth() + probMonths);
    probationEndDate = d.toISOString().slice(0, 10);
  }

  // Build details patch (existingDetails is null here — 409 guard above blocks any existing record)
  const detailsPatch = {
    employeeId:          employee._id,
    jobTitle:            jobTitle?.trim()  || employee.designation || '',
    grossPay:            grossPay          ? parseFloat(grossPay)  : (employee.grossPay || 0),
    startDate:           startDate         || employee.dateOfHire  || '',
    jobGroupId:          jobGroupId        || '',
    designationId:       designationId     || null,
    jdType:              jdType            || (req.file ? 'custom' : null),
    jdTemplateId:        (jdType === 'template' && jdTemplateId) ? jdTemplateId : null,
    jdPdfPath:           req.file ? req.file.path         : null,
    jdPdfOriginalName:   req.file ? req.file.originalname : null,
    probationMonths:     probMonths,
    probationEndDate,
    updatedAt:           new Date(),
  };

  await global.dbo.collection('onboarding_details').updateOne(
    { employeeId: employee._id },
    { $set: detailsPatch, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );

  // Remove any existing pending template tasks (avoid duplicates on re-assign)
  await global.dbo.collection('onboarding_tasks').deleteMany({
    employeeId: employee._id,
    status: 'pending',
    templateId: { $ne: null },
  });

  await assignDefaultTasks(employee._id, startDate || employee.dateOfHire);
  return returnFunction(res, 200, true, 'Onboarding started.');
};

// ── List employees with in-progress onboarding ────────────────────────────────
const listOnboarding = async (req, res) => {
  // 1. Employees with tasks (standard case)
  const taskGroups = await global.dbo.collection('onboarding_tasks').aggregate([
    { $group: {
      _id: '$employeeId',
      total:     { $sum: 1 },
      completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
    }},
    { $match: { $expr: { $lt: ['$completed', '$total'] } } },
  ]).toArray();

  const taskEmployeeIds = new Set(taskGroups.map(e => String(e._id)));

  // 2. Employees started via onboarding_details but with no tasks yet
  const detailRecords = await global.dbo.collection('onboarding_details').find({}).toArray();
  const tasklessEmployees = detailRecords
    .filter(d => !taskEmployeeIds.has(String(d.employeeId)))
    .map(d => ({ _id: d.employeeId, total: 0, completed: 0 }));

  const all = [...taskGroups, ...tasklessEmployees];

  const result = await Promise.all(all.map(async (e) => {
    const employee = await findOne('employees', { _id: e._id }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1 } });
    if (!employee) return null;
    return {
      employee,
      total:      e.total,
      completed:  e.completed,
      percentage: e.total ? Math.round((e.completed / e.total) * 100) : 0,
    };
  }));

  return returnFunction(res, 200, true, req.locale.success, result.filter(Boolean));
};

const getEmployeeOnboarding = async (req, res) => {
  const tasks = await findMany('onboarding_tasks',
    { employeeId: new ObjectId(req.params.employeeId) },
    { sort: { status: 1, dueDate: 1 } }
  );
  return returnFunction(res, 200, true, req.locale.success, tasks);
};

const getOnboardingDetails = async (req, res) => {
  const details = await findOne('onboarding_details', { employeeId: new ObjectId(req.params.employeeId) });
  if (!details) return returnFunction(res, 200, true, req.locale.success, {});

  let jobGroupName   = '';
  let designationName = '';

  if (details.jobGroupId) {
    try {
      const jg = await findOne('job_groups', { _id: new ObjectId(details.jobGroupId) });
      jobGroupName = jg?.name || '';
    } catch (_) {}
  }

  if (details.designationId) {
    try {
      const desig = await findOne('designations', { _id: new ObjectId(details.designationId) });
      designationName = desig?.name || '';
    } catch (_) {}
  }

  return returnFunction(res, 200, true, req.locale.success, { ...details, jobGroupName, designationName });
};

const serveJdPdf = async (req, res) => {
  const details = await findOne('onboarding_details', { employeeId: new ObjectId(req.params.employeeId) });
  if (!details) return returnFunction(res, 404, false, 'No onboarding record found.');

  // Template JD: stream from the template's stored PDF
  if (details.jdType === 'template' && details.jdTemplateId) {
    try {
      const template = await findOne('jd_templates', { _id: new ObjectId(details.jdTemplateId) });
      if (template?.pdfPath) {
        const tplPath = path.resolve(template.pdfPath);
        if (fs.existsSync(tplPath)) {
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `inline; filename="${template.pdfOriginalName || template.name + '.pdf'}"`);
          return fs.createReadStream(tplPath).pipe(res);
        }
      }
    } catch (_) {}
  }

  // Custom uploaded PDF
  if (!details.jdPdfPath) return returnFunction(res, 404, false, 'No JD PDF for this employee.');
  const filePath = path.resolve(details.jdPdfPath);
  if (!fs.existsSync(filePath)) return returnFunction(res, 404, false, 'File not found on server.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${details.jdPdfOriginalName || 'job-description.pdf'}"`);
  fs.createReadStream(filePath).pipe(res);
};

const updateTask = async (req, res) => {
  const { taskTitle, assignedDepartment, dueDate, description, status } = req.body;
  const VALID_STATUSES = ['pending', 'in_progress', 'completed'];
  const update = {};
  if (taskTitle !== undefined)          update.taskTitle          = taskTitle.trim();
  if (assignedDepartment !== undefined) update.assignedDepartment = assignedDepartment;
  if (dueDate !== undefined)            update.dueDate            = dueDate;
  if (description !== undefined)        update.description        = description.trim();
  if (status !== undefined) {
    if (!VALID_STATUSES.includes(status)) return returnFunction(res, 400, false, 'Invalid status.');
    update.status = status;
    if (status === 'completed') update.completedAt = new Date();
    if (status !== 'completed') update.completedAt = null;
  }
  if (!Object.keys(update).length) return returnFunction(res, 400, false, 'Nothing to update.');
  await updateOne('onboarding_tasks', { _id: new ObjectId(req.params.taskId) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully || 'Updated.');
};

const deleteTask = async (req, res) => {
  await global.dbo.collection('onboarding_tasks').deleteOne({ _id: new ObjectId(req.params.taskId) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted.');
};

const clearEmployeeOnboarding = async (req, res) => {
  const employee = await findOne('employees', { _id: new ObjectId(req.params.employeeId) });
  if (!employee) return returnFunction(res, 404, false, req.locale.notFound);
  await global.dbo.collection('onboarding_tasks').deleteMany({ employeeId: new ObjectId(req.params.employeeId) });
  await global.dbo.collection('onboarding_details').deleteOne({ employeeId: new ObjectId(req.params.employeeId) });
  return returnFunction(res, 200, true, 'Onboarding record removed.');
};

const completeTask = async (req, res) => {
  const task = await findOne('onboarding_tasks', { _id: new ObjectId(req.params.taskId) });
  if (!task) return returnFunction(res, 404, false, req.locale.notFound);

  const isHR = ['super_admin', 'hr_manager', 'department_head'].includes(req.user?.role);
  if (!isHR && String(task.employeeId) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  await updateOne('onboarding_tasks',
    { _id: new ObjectId(req.params.taskId) },
    { $set: { status: 'completed', completedAt: new Date(), completedBy: req.user?._id ? new ObjectId(req.user._id) : null } }
  );

  // Notify HR when all tasks are done
  const remaining = await countDocuments('onboarding_tasks', { employeeId: task.employeeId, status: { $ne: 'completed' } });
  if (remaining === 0) {
    const employee = await findOne('employees', { _id: task.employeeId }, { projection: { fullName: 1 } });
    if (employee) {
      notifyHR({
        type: 'onboarding', subType: 'onboarding_complete',
        title: 'Onboarding Complete',
        subtitle: `All onboarding tasks for ${employee.fullName} have been completed.`,
        referenceId: task.employeeId, referenceModel: 'employees',
        requiresAction: false, triggeredBy: req.user?._id,
      }).catch(() => {});
      notifyByRoles(['super_admin', 'hr_manager'], {
        title: 'Onboarding Complete',
        body: `All onboarding tasks for ${employee.fullName} have been completed.`,
        type: 'onboarding',
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Offboarding ───────────────────────────────────────────────────────────────

const DEFAULT_OFFBOARDING_TASKS = [
  { taskTitle: 'Submit resignation letter',      taskSection: 'before_last_day', assignedDepartment: 'Employee', daysFromNow: -14 },
  { taskTitle: 'Complete knowledge transfer doc', taskSection: 'before_last_day', assignedDepartment: 'Employee', daysFromNow: -7  },
  { taskTitle: 'Schedule handover meetings',      taskSection: 'before_last_day', assignedDepartment: 'Manager',  daysFromNow: -5  },
  { taskTitle: 'Return company devices',          taskSection: 'before_last_day', assignedDepartment: 'IT',       daysFromNow: -1  },
  { taskTitle: 'Exit interview completed',        taskSection: 'last_day',        assignedDepartment: 'HR',       daysFromNow: 0   },
  { taskTitle: 'Revoke email access',             taskSection: 'last_day',        assignedDepartment: 'IT',       daysFromNow: 0   },
  { taskTitle: 'Revoke system & platform access', taskSection: 'last_day',        assignedDepartment: 'IT',       daysFromNow: 0   },
  { taskTitle: 'Process final payslip',           taskSection: 'last_day',        assignedDepartment: 'HR',       daysFromNow: 0   },
  { taskTitle: 'Issue reference letter',          taskSection: 'after_departure', assignedDepartment: 'HR',       daysFromNow: 7   },
  { taskTitle: 'Send alumni network invite',      taskSection: 'after_departure', assignedDepartment: 'HR',       daysFromNow: 14  },
];

const startOffboarding = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId'])) return;
  const empId = new ObjectId(req.body.employeeId);
  const employee = await findOne('employees', { _id: empId });
  if (!employee) return returnFunction(res, 404, false, req.locale.notFound);

  const existing = await countDocuments('offboarding_tasks', { employeeId: empId, status: 'pending' });
  if (existing > 0) return returnFunction(res, 409, false, `${employee.fullName} is already in offboarding.`);

  const lastDay = req.body.lastDay ? new Date(req.body.lastDay) : new Date();
  const tasks = DEFAULT_OFFBOARDING_TASKS.map(t => {
    const due = new Date(lastDay);
    due.setDate(due.getDate() + t.daysFromNow);
    return {
      employeeId: empId,
      taskTitle: t.taskTitle,
      taskSection: t.taskSection,
      assignedDepartment: t.assignedDepartment,
      dueDate: due.toISOString().slice(0, 10),
      status: 'pending',
      createdAt: new Date(),
    };
  });
  await global.dbo.collection('offboarding_tasks').insertMany(tasks);

  if (req.body.lastDay) {
    await updateOne('employees', { _id: empId }, { $set: { contractEndDate: new Date(req.body.lastDay), updatedAt: new Date() } });
  }

  return returnFunction(res, 201, true, 'Offboarding started.');
};

const listOffboarding = async (req, res) => {
  const groups = await global.dbo.collection('offboarding_tasks').aggregate([
    { $group: {
      _id: '$employeeId',
      total:     { $sum: 1 },
      completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
    } },
  ]).toArray();

  const result = await Promise.all(groups.map(async (g) => {
    const employee = await findOne('employees', { _id: g._id }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1, contractEndDate: 1 } });
    if (!employee) return null;
    return {
      employee,
      total:      g.total,
      completed:  g.completed,
      percentage: g.total ? Math.round((g.completed / g.total) * 100) : 0,
    };
  }));

  return returnFunction(res, 200, true, req.locale.success, result.filter(Boolean));
};

const getEmployeeOffboarding = async (req, res) => {
  const tasks = await findMany('offboarding_tasks',
    { employeeId: new ObjectId(req.params.employeeId) },
    { sort: { taskSection: 1, dueDate: 1 } }
  );
  return returnFunction(res, 200, true, req.locale.success, tasks);
};

const completeOffboardingTask = async (req, res) => {
  const task = await findOne('offboarding_tasks', { _id: new ObjectId(req.params.taskId) });
  if (!task) return returnFunction(res, 404, false, req.locale.notFound);

  const isHR = ['super_admin', 'hr_manager', 'department_head'].includes(req.user?.role);
  if (!isHR && String(task.employeeId) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  await updateOne(
    'offboarding_tasks',
    { _id: new ObjectId(req.params.taskId) },
    { $set: { status: 'completed', completedAt: new Date(), completedBy: req.user?._id ? new ObjectId(req.user._id) : null } }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const addOffboardingTask = async (req, res) => {
  if (!validateRequiredFields(req, res, ['taskTitle', 'dueDate'])) return;
  const doc = {
    employeeId: new ObjectId(req.params.employeeId),
    taskTitle: req.body.taskTitle.trim(),
    taskSection: req.body.taskSection || 'before_last_day',
    assignedDepartment: req.body.assignedDepartment || 'HR',
    dueDate: req.body.dueDate,
    status: 'pending',
    createdAt: new Date(),
  };
  const result = await insertOne('offboarding_tasks', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const clearEmployeeOffboarding = async (req, res) => {
  await global.dbo.collection('offboarding_tasks').deleteMany({ employeeId: new ObjectId(req.params.employeeId) });
  return returnFunction(res, 200, true, 'Offboarding record removed.');
};

// ── Overdue Tasks ─────────────────────────────────────────────────────────────
// Returns all incomplete onboarding tasks whose due date has passed.
// Also sends in-app notifications to HR (once per run, fire-and-forget).

const getOverdueTasks = async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const overdue = await findMany('onboarding_tasks', {
    status: { $ne: 'completed' },
    dueDate: { $lt: today, $ne: null },
  }, { sort: { dueDate: 1 } });

  if (!overdue.length) return returnFunction(res, 200, true, 'No overdue tasks.', []);

  // Enrich with employee names
  const empIds = [...new Set(overdue.map(t => String(t.employeeId)))];
  const employees = await findMany('employees', { _id: { $in: empIds.map(id => new ObjectId(id)) } }, { projection: { fullName: 1 } });
  const empMap = Object.fromEntries(employees.map(e => [String(e._id), e]));

  const enriched = overdue.map(t => ({
    ...t,
    employee: empMap[String(t.employeeId)] ?? null,
    daysOverdue: Math.floor((new Date(today) - new Date(t.dueDate)) / (1000 * 60 * 60 * 24)),
  }));

  // Notify HR about overdue tasks (fire-and-forget)
  if (enriched.length) {
    notifyByRoles(['super_admin', 'hr_manager'], {
      title: `${enriched.length} Overdue Onboarding Task(s)`,
      body: `${enriched.length} onboarding task(s) are past their due date and need attention.`,
      type: 'onboarding',
    }).catch(() => {});
  }

  return returnFunction(res, 200, true, 'Overdue tasks fetched', enriched);
};

module.exports = {
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  addEmployeeTask, updateTask, deleteTask, assignDefaultTasksHandler, assignDefaultTasks,
  listOnboarding, getEmployeeOnboarding, getOnboardingDetails, completeTask, clearEmployeeOnboarding,
  serveJdPdf,
  startOffboarding, listOffboarding, getEmployeeOffboarding, completeOffboardingTask, addOffboardingTask, clearEmployeeOffboarding,
  getOverdueTasks,
};
