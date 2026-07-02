const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { createInboxItem } = require('../inbox/inboxFunctions');

// ── List Projects ─────────────────────────────────────────────────────────────
const listProjects = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status)   filter.status   = req.query.status;
  if (req.query.clientId) filter.clientId = req.query.clientId;
  if (req.query.search) {
    filter.$or = [
      { name: { $regex: req.query.search, $options: 'i' } },
      { code: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  const [total, data] = await Promise.all([
    countDocuments('projects', filter),
    findMany('projects', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const enriched = await Promise.all(data.map(async p => {
    const [timeEntries, expenses, memberCount] = await Promise.all([
      global.dbo.collection('project_time_entries').aggregate([
        { $match: { projectId: p._id } },
        { $group: { _id: null, totalHours: { $sum: '$hours' } } },
      ]).toArray(),
      global.dbo.collection('project_expenses').aggregate([
        { $match: { projectId: p._id } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]).toArray(),
      countDocuments('project_members', { projectId: p._id }),
    ]);
    return {
      ...p,
      totalHours:   timeEntries[0]?.totalHours ?? 0,
      totalExpenses: expenses[0]?.total ?? 0,
      memberCount,
      budgetUsed: (expenses[0]?.total ?? 0) / (p.budget || 1) * 100,
    };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

// ── Create Project ────────────────────────────────────────────────────────────
const createProject = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'code'])) return;
  const { name, code, description, clientName, clientId, budget, currency, startDate, endDate, status, billable, teamMembers } = req.body;

  const exists = await findOne('projects', { code: code.trim().toUpperCase() });
  if (exists) return returnFunction(res, 409, false, 'Project code already exists.');

  const doc = {
    name:        name.trim(),
    code:        code.trim().toUpperCase(),
    description: description || null,
    clientName:  clientName  || null,
    clientId:    clientId    || null,
    budget:      budget      ? Number(budget) : null,
    currency:    currency    || 'KES',
    startDate:   startDate   ? new Date(startDate) : null,
    endDate:     endDate     ? new Date(endDate)   : null,
    status:      status      || 'active',
    billable:    Boolean(billable),
    createdBy:   req.user?._id ?? null,
    createdAt:   new Date(),
    updatedAt:   new Date(),
  };

  const result = await insertOne('projects', doc);
  const projectId = result.insertedId;

  if (Array.isArray(teamMembers) && teamMembers.length) {
    const members = teamMembers.map(m => ({
      projectId,
      employeeId: new ObjectId(m.employeeId),
      role:       m.role || 'member',
      hourlyRate: m.hourlyRate ? Number(m.hourlyRate) : null,
      addedAt:    new Date(),
    }));
    if (members.length) await global.dbo.collection('project_members').insertMany(members);
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: projectId });
};

// ── Get Project ───────────────────────────────────────────────────────────────
const getProject = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const [members, timeEntries, expenses] = await Promise.all([
    findMany('project_members', { projectId: project._id }),
    findMany('project_time_entries', { projectId: project._id }, { sort: { date: -1 }, limit: 50 }),
    findMany('project_expenses', { projectId: project._id }, { sort: { date: -1 } }),
  ]);

  const enrichedMembers = await Promise.all(members.map(async m => {
    const emp = await findOne('employees', { _id: m.employeeId }, { projection: { fullName: 1, department: 1, jobTitle: 1 } });
    const hours = await global.dbo.collection('project_time_entries').aggregate([
      { $match: { projectId: project._id, employeeId: m.employeeId } },
      { $group: { _id: null, total: { $sum: '$hours' } } },
    ]).toArray();
    return { ...m, employee: emp ?? null, totalHours: hours[0]?.total ?? 0 };
  }));

  const totalHours    = timeEntries.reduce((s, t) => s + (t.hours || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const budgetUsed    = project.budget ? totalExpenses / project.budget * 100 : 0;

  return returnFunction(res, 200, true, req.locale.success, {
    ...project, members: enrichedMembers, timeEntries, expenses,
    summary: { totalHours, totalExpenses, budgetUsed: Math.round(budgetUsed * 10) / 10 },
  });
};

// ── Update Project ────────────────────────────────────────────────────────────
const updateProject = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const { name, description, clientName, budget, currency, startDate, endDate, status, billable } = req.body;
  const update = { updatedAt: new Date() };
  if (name !== undefined)        update.name        = name;
  if (description !== undefined) update.description = description;
  if (clientName !== undefined)  update.clientName  = clientName;
  if (budget !== undefined)      update.budget      = Number(budget);
  if (currency !== undefined)    update.currency    = currency;
  if (startDate !== undefined)   update.startDate   = new Date(startDate);
  if (endDate !== undefined)     update.endDate     = new Date(endDate);
  if (status !== undefined)      update.status      = status;
  if (billable !== undefined)    update.billable    = Boolean(billable);

  await updateOne('projects', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Delete Project ────────────────────────────────────────────────────────────
const deleteProject = async (req, res) => {
  const project = await findOne('projects', { _id: new ObjectId(req.params.id) });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);
  await global.dbo.collection('projects').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Time Entries ──────────────────────────────────────────────────────────────
const listTimeEntries = async (req, res) => {
  const projectId = new ObjectId(req.params.id);
  const filter = { projectId };
  if (req.query.employeeId) filter.employeeId = new ObjectId(req.query.employeeId);
  const entries = await findMany('project_time_entries', filter, { sort: { date: -1 } });
  const enriched = await Promise.all(entries.map(async e => {
    const emp = await findOne('employees', { _id: e.employeeId }, { projection: { fullName: 1, staffNumber: 1 } });
    return { ...e, employee: emp ?? null };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const addTimeEntry = async (req, res) => {
  if (!validateRequiredFields(req, res, ['hours', 'date'])) return;
  const { hours, date, description, billable, task } = req.body;
  const employeeId = req.user?.employeeId;
  if (!employeeId) return returnFunction(res, 400, false, 'No employee record linked.');
  const doc = {
    projectId:   new ObjectId(req.params.id),
    employeeId:  new ObjectId(employeeId),
    hours:       Number(hours),
    date:        new Date(date),
    description: description || null,
    task:        task        || null,
    billable:    Boolean(billable),
    createdAt:   new Date(),
  };
  const result = await insertOne('project_time_entries', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// ── Project Expenses ──────────────────────────────────────────────────────────
const listProjectExpenses = async (req, res) => {
  const projectId = new ObjectId(req.params.id);
  const expenses = await findMany('project_expenses', { projectId }, { sort: { date: -1 } });
  const enriched = await Promise.all(expenses.map(async e => {
    const emp = await findOne('employees', { _id: e.submittedBy }, { projection: { fullName: 1 } });
    return { ...e, submitter: emp ?? null };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const addProjectExpense = async (req, res) => {
  if (!validateRequiredFields(req, res, ['description', 'amount', 'date'])) return;
  const { description, amount, date, category, vendor, billable } = req.body;
  const doc = {
    projectId:   new ObjectId(req.params.id),
    submittedBy: req.user?._id ?? null,
    description,
    amount:      Number(amount),
    date:        new Date(date),
    category:    category || 'other',
    vendor:      vendor   || null,
    billable:    Boolean(billable),
    createdAt:   new Date(),
  };
  const result = await insertOne('project_expenses', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// ── Budget Summary ────────────────────────────────────────────────────────────
const getProjectBudget = async (req, res) => {
  const projectId = new ObjectId(req.params.id);
  const project = await findOne('projects', { _id: projectId });
  if (!project) return returnFunction(res, 404, false, req.locale.notFound);

  const [expenseTotals, timeTotals] = await Promise.all([
    global.dbo.collection('project_expenses').aggregate([
      { $match: { projectId } },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]).toArray(),
    global.dbo.collection('project_time_entries').aggregate([
      { $match: { projectId } },
      { $group: { _id: null, totalHours: { $sum: '$hours' } } },
    ]).toArray(),
  ]);

  const totalExpenses = expenseTotals.reduce((s, e) => s + e.total, 0);
  const totalHours    = timeTotals[0]?.totalHours ?? 0;
  const remaining     = (project.budget ?? 0) - totalExpenses;
  const utilization   = project.budget ? totalExpenses / project.budget * 100 : 0;

  return returnFunction(res, 200, true, req.locale.success, {
    budget: project.budget ?? 0,
    currency: project.currency,
    spent: totalExpenses,
    remaining,
    utilization: Math.round(utilization * 10) / 10,
    byCategory: expenseTotals,
    totalHours,
  });
};

// ── Add/Remove Member ─────────────────────────────────────────────────────────
const addMember = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId'])) return;
  const { employeeId, role, hourlyRate } = req.body;
  const projectId = new ObjectId(req.params.id);
  const existing = await findOne('project_members', { projectId, employeeId: new ObjectId(employeeId) });
  if (existing) return returnFunction(res, 409, false, 'Member already on project.');
  await insertOne('project_members', {
    projectId, employeeId: new ObjectId(employeeId),
    role: role || 'member', hourlyRate: hourlyRate ? Number(hourlyRate) : null,
    addedAt: new Date(),
  });
  const project = await findOne('projects', { _id: projectId }, { projection: { name: 1 } });
  await createInboxItem({
    recipientId: new ObjectId(employeeId),
    type: 'general',
    subType: 'project_assigned',
    title: `You've been added to project: ${project?.name ?? 'a project'}`,
    subtitle: `You have been assigned as ${role || 'member'}.`,
    referenceId: projectId,
    referenceModel: 'Project',
    priority: 'normal',
    requiresAction: false,
    triggeredBy: req.user?.employeeId ?? null,
  });
  return returnFunction(res, 201, true, 'Member added.');
};

const removeMember = async (req, res) => {
  const projectId  = new ObjectId(req.params.id);
  const employeeId = new ObjectId(req.params.employeeId);
  await global.dbo.collection('project_members').deleteOne({ projectId, employeeId });
  return returnFunction(res, 200, true, 'Member removed.');
};

module.exports = {
  listProjects, createProject, getProject, updateProject, deleteProject,
  listTimeEntries, addTimeEntry,
  listProjectExpenses, addProjectExpense,
  getProjectBudget, addMember, removeMember,
};
