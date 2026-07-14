const { ObjectId } = require('mongodb');
const path = require('path');
const fs   = require('fs');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyStaffByAudience } = require('../../functions/HR/notifyUser');

// ── Generic CRUD factory ─────────────────────────────────────────────────────

const makeList = (collection) => async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const [total, data] = await Promise.all([
    countDocuments(collection, {}),
    findMany(collection, {}, { skip, limit, sort: { name: 1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

const makeCreate = (collection, requiredFields) => async (req, res) => {
  if (!validateRequiredFields(req, res, requiredFields)) return;
  const existing = await findOne(collection, { name: req.body.name });
  if (existing) return returnFunction(res, 409, false, `A ${collection.replace(/_/g, ' ')} with this name already exists.`);
  const doc = { ...req.body, createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne(collection, doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const makeUpdate = (collection) => async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  await updateOne(collection, { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const makeDelete = (collection) => async (req, res) => {
  await global.dbo.collection(collection).deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// ── Departments ──────────────────────────────────────────────────────────────
const listDepartments  = makeList('departments');
const createDepartment = makeCreate('departments', ['name']);
const updateDepartment = makeUpdate('departments');
const deleteDepartment = makeDelete('departments');

// ── Job Groups (with salary range) ───────────────────────────────────────────
const listJobGroups = makeList('job_groups');

const createJobGroup = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'salaryMin', 'salaryMax'])) return;
  const { name, salaryMin, salaryMax, description } = req.body;
  const min = Number(salaryMin);
  const max = Number(salaryMax);
  if (isNaN(min) || isNaN(max) || min >= max) {
    return returnFunction(res, 400, false, 'salaryMin must be less than salaryMax.');
  }
  const existing = await findOne('job_groups', { name });
  if (existing) return returnFunction(res, 409, false, 'A job group with this name already exists.');
  const doc = { name, salaryMin: min, salaryMax: max, description: description || '', createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne('job_groups', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateJobGroup = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  if (update.salaryMin !== undefined) update.salaryMin = Number(update.salaryMin);
  if (update.salaryMax !== undefined) update.salaryMax = Number(update.salaryMax);
  if (update.salaryMin !== undefined && update.salaryMax !== undefined && update.salaryMin >= update.salaryMax) {
    return returnFunction(res, 400, false, 'salaryMin must be less than salaryMax.');
  }
  await updateOne('job_groups', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteJobGroup = makeDelete('job_groups');

// ── Allowances (job-group linked, applied automatically during payroll runs —
// see payrollCyclesFunctions.js. Collection name kept as fixed_allowances.) ──
const listFixedAllowances  = makeList('fixed_allowances');
const createFixedAllowance = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'amount'])) return;
  const existing = await findOne('fixed_allowances', { name: req.body.name });
  if (existing) return returnFunction(res, 409, false, 'A fixed allowance with this name already exists.');
  const doc = {
    name: req.body.name,
    amount: Number(req.body.amount),
    description: req.body.description || '',
    isEnabled: req.body.isEnabled !== false,
    isTaxable: req.body.isTaxable !== false,
    appearsOnPayslip: req.body.appearsOnPayslip !== false,
    jobGroupIds: Array.isArray(req.body.jobGroupIds) ? req.body.jobGroupIds : [],
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('fixed_allowances', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};
const updateFixedAllowance = makeUpdate('fixed_allowances');
const deleteFixedAllowance = makeDelete('fixed_allowances');

// ── Deductions ────────────────────────────────────────────────────────────────
const listDeductions = makeList('deduction_types');
const createDeduction = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await findOne('deduction_types', { name: req.body.name });
  if (existing) return returnFunction(res, 409, false, 'A deduction with this name already exists.');
  const doc = {
    name: req.body.name,
    type: req.body.type || 'fixed',       // 'fixed' | 'percentage'
    amount: req.body.amount ? Number(req.body.amount) : null,
    percentage: req.body.percentage ? Number(req.body.percentage) : null,
    isEnabled: req.body.isEnabled !== false,
    description: req.body.description || '',
    jobGroupIds: Array.isArray(req.body.jobGroupIds) ? req.body.jobGroupIds : [],
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('deduction_types', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};
const updateDeduction = makeUpdate('deduction_types');
const deleteDeduction = makeDelete('deduction_types');

// ── Designations (linked to departments) ─────────────────────────────────────
const listDesignations = async (req, res) => {
  const data = await findMany('designations', {}, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, data);
};

const createDesignation = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await findOne('designations', { name: req.body.name.trim() });
  if (existing) return returnFunction(res, 409, false, 'A designation with this name already exists.');
  const doc = {
    name:          req.body.name.trim(),
    departmentIds: Array.isArray(req.body.departmentIds) ? req.body.departmentIds : [],
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('designations', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateDesignation = makeUpdate('designations');
const deleteDesignation = makeDelete('designations');

// ── JD Templates (reusable job description PDFs) ──────────────────────────────
const listJdTemplates = async (req, res) => {
  const data = await findMany('jd_templates', {}, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, data);
};

const createJdTemplate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const doc = {
    name:            req.body.name.trim(),
    description:     req.body.description || '',
    roles:           req.body.roles       || '',
    pdfPath:         req.file ? req.file.path         : null,
    pdfOriginalName: req.file ? req.file.originalname : null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('jd_templates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateJdTemplate = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name        !== undefined) update.name        = req.body.name.trim();
  if (req.body.description !== undefined) update.description = req.body.description;
  if (req.body.roles       !== undefined) update.roles       = req.body.roles;
  if (req.file) {
    const existing = await findOne('jd_templates', { _id: new ObjectId(req.params.id) });
    if (existing?.pdfPath) fs.unlink(path.resolve(existing.pdfPath), () => {});
    update.pdfPath         = req.file.path;
    update.pdfOriginalName = req.file.originalname;
  }
  await updateOne('jd_templates', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteJdTemplate = async (req, res) => {
  const existing = await findOne('jd_templates', { _id: new ObjectId(req.params.id) });
  if (existing?.pdfPath) fs.unlink(path.resolve(existing.pdfPath), () => {});
  await global.dbo.collection('jd_templates').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted.');
};

const serveJdTemplate = async (req, res) => {
  const template = await findOne('jd_templates', { _id: new ObjectId(req.params.id) });
  if (!template?.pdfPath) return returnFunction(res, 404, false, 'No PDF for this template.');
  const filePath = path.resolve(template.pdfPath);
  if (!fs.existsSync(filePath)) return returnFunction(res, 404, false, 'File not found.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${template.pdfOriginalName || template.name + '.pdf'}"`);
  fs.createReadStream(filePath).pipe(res);
};

// ── Company Accounts (payment sources) ───────────────────────────────────────
const listCompanyAccounts  = makeList('company_accounts');
const createCompanyAccount = makeCreate('company_accounts', ['name', 'accountType']);
const updateCompanyAccount = makeUpdate('company_accounts');
const deleteCompanyAccount = makeDelete('company_accounts');

// ── Scheduled Events (Training sessions & Team Building events with dates) ────
const listScheduledEvents = async (req, res) => {
  const filter = {};
  if (req.query.type) filter.type = req.query.type;
  const upcoming = req.query.upcoming === 'true';
  if (upcoming) filter.scheduledDate = { $gte: new Date().toISOString().split('T')[0] };
  const events = await findMany('scheduled_events', filter, { sort: { scheduledDate: 1 } });
  return returnFunction(res, 200, true, req.locale.success, events);
};

const createScheduledEvent = async (req, res) => {
  const { title, type, description, scheduledDate, endDate, location, audience, department } = req.body;
  if (!title || !type || !scheduledDate) return returnFunction(res, 400, false, 'title, type, and scheduledDate are required.');
  const doc = { title, type, description: description || '', scheduledDate, endDate: endDate || null, location: location || '', audience: audience || 'all', department: department || null, createdBy: req.user?.name || 'HR', createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne('scheduled_events', doc);

  // Fire-and-forget — notify affected staff without blocking the response
  const typeLabel = type === 'team_building' ? 'Team Building' : 'Training';
  const dateLabel = new Date(scheduledDate).toLocaleDateString('en-KE', { dateStyle: 'medium' });
  const bodyText  = location ? `${dateLabel} · ${location}` : dateLabel;
  notifyStaffByAudience(audience || 'all', department || null, {
    title: `${typeLabel}: ${title}`,
    body:  bodyText,
    type:  'general',
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateScheduledEvent = makeUpdate('scheduled_events');
const deleteScheduledEvent = makeDelete('scheduled_events');

// ── Communication Settings ────────────────────────────────────────────────────
const getCommunicationSettings = async (req, res) => {
  const settings = await findOne('communication_settings', {});
  return returnFunction(res, 200, true, req.locale.success, settings || {});
};

const updateCommunicationSettings = async (req, res) => {
  const ALLOWED = ['emailProvider', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpFrom', 'smsProvider', 'smsApiKey', 'smsFrom', 'notifyOnLeave', 'notifyOnPayroll', 'notifyOnAppraisal'];
  const patch = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  patch.updatedAt = new Date();
  const existing = await findOne('communication_settings', {});
  if (existing) {
    await updateOne('communication_settings', { _id: existing._id }, { $set: patch });
  } else {
    await insertOne('communication_settings', { ...patch, createdAt: new Date() });
  }
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

module.exports = {
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  listJobGroups,   createJobGroup,   updateJobGroup,   deleteJobGroup,
  listFixedAllowances, createFixedAllowance, updateFixedAllowance, deleteFixedAllowance,
  listDeductions,  createDeduction,  updateDeduction,  deleteDeduction,
  getCommunicationSettings, updateCommunicationSettings,
  listDesignations, createDesignation, updateDesignation, deleteDesignation,
  listJdTemplates,  createJdTemplate,  updateJdTemplate,  deleteJdTemplate, serveJdTemplate,
  listCompanyAccounts, createCompanyAccount, updateCompanyAccount, deleteCompanyAccount,
  listScheduledEvents, createScheduledEvent, updateScheduledEvent, deleteScheduledEvent,
};
