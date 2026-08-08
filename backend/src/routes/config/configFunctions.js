const { ObjectId } = require('mongodb'); // still needed for pgMakeList's manual _id aliasing (bypasses pgDBFunctions' own automatic withMongoId)
const path = require('path');
const fs   = require('fs');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
// Postgres migration — departments/branches/job_groups/designations/company_accounts
// have been Postgres since Phase 1; jd_templates/scheduled_events/communication_settings
// are Postgres too now (Phase 10). Everything in this file goes through pgDB.
const pgDB = require('../../functions/Database/pgDBFunctions');
const { notifyStaffByAudience } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

// Mirrors notifyStaffByAudience's own resolution (functions/HR/notifyUser.js) — kept as
// its own pass rather than modifying that shared helper, since other callers of
// notifyStaffByAudience don't necessarily want an email fired too.
const emailStaffByAudience = async (audience, department, trigger, tokens, fallbackSubject, fallbackHtml) => {
  let employeeQuery = pgDB.knex('employees');
  if (audience === 'department' && department) employeeQuery = employeeQuery.where({ department });
  const employees = await employeeQuery.select('id');
  if (!employees.length) return;
  const users = await pgDB.knex('users').whereIn('employeeId', employees.map(e => e.id)).select('email');
  users.filter(u => u.email).forEach(u => sendTemplatedEmail({ trigger, to: u.email, tokens, fallbackSubject, fallbackHtml }).catch(() => {}));
};

// ── Generic CRUD factory (Postgres tables) ────────────────────────────────────

const pgMakeList = (table) => async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const [{ count }, rows] = await Promise.all([
    pgDB.knex(table).count('* as count').first(),
    pgDB.knex(table).orderBy('name', 'asc').offset(skip).limit(limit),
  ]);
  const data = rows.map((r) => ({ ...r, _id: new ObjectId(r.id) }));
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, Number(count), page, limit));
};

const pgMakeCreate = (table, requiredFields) => async (req, res) => {
  if (!validateRequiredFields(req, res, requiredFields)) return;
  const existing = await pgDB.findOne(table, { name: req.body.name });
  if (existing) return returnFunction(res, 409, false, `A ${table.replace(/_/g, ' ')} with this name already exists.`);
  const doc = { ...req.body, createdAt: new Date(), updatedAt: new Date() };
  delete doc._id;
  delete doc.id;
  const result = await pgDB.insertOne(table, doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const pgMakeUpdate = (table) => async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  delete update.id;
  await pgDB.updateOne(table, { id: req.params.id }, update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const pgMakeDelete = (table) => async (req, res) => {
  await pgDB.deleteOne(table, { id: req.params.id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

const pgMakeBulkDelete = (table) => async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return returnFunction(res, 400, false, 'ids must be a non-empty array.');
  }
  const deletedCount = await pgDB.knex(table).whereIn('id', ids).del();
  return returnFunction(res, 200, true, `${deletedCount} deleted.`, { deletedCount });
};

// ── Departments ──────────────────────────────────────────────────────────────
const listDepartments  = pgMakeList('departments');
const createDepartment = pgMakeCreate('departments', ['name']);
const updateDepartment = pgMakeUpdate('departments');
const deleteDepartment = pgMakeDelete('departments');
const bulkDeleteDepartments = pgMakeBulkDelete('departments');

// ── Branches (name + contact info — a company with multiple physical offices) ──
const listBranches  = pgMakeList('branches');
const createBranch  = pgMakeCreate('branches', ['name']);
const updateBranch  = pgMakeUpdate('branches');
const deleteBranch  = pgMakeDelete('branches');

// ── Job Groups (with salary range) ───────────────────────────────────────────
const listJobGroups = pgMakeList('job_groups');

const createJobGroup = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'salaryMin', 'salaryMax'])) return;
  const { name, salaryMin, salaryMax, description } = req.body;
  const min = Number(salaryMin);
  const max = Number(salaryMax);
  if (isNaN(min) || isNaN(max) || min >= max) {
    return returnFunction(res, 400, false, 'salaryMin must be less than salaryMax.');
  }
  const existing = await pgDB.findOne('job_groups', { name });
  if (existing) return returnFunction(res, 409, false, 'A job group with this name already exists.');
  const doc = { name, salaryMin: min, salaryMax: max, description: description || '', createdAt: new Date(), updatedAt: new Date() };
  const result = await pgDB.insertOne('job_groups', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const updateJobGroup = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  delete update.id;
  if (update.salaryMin !== undefined) update.salaryMin = Number(update.salaryMin);
  if (update.salaryMax !== undefined) update.salaryMax = Number(update.salaryMax);
  if (update.salaryMin !== undefined && update.salaryMax !== undefined && update.salaryMin >= update.salaryMax) {
    return returnFunction(res, 400, false, 'salaryMin must be less than salaryMax.');
  }
  await pgDB.updateOne('job_groups', { id: req.params.id }, update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteJobGroup = pgMakeDelete('job_groups');

// ── Designations (linked to departments via designation_departments) ─────────
const listDesignations = async (req, res) => {
  const [designations, links] = await Promise.all([
    pgDB.knex('designations').orderBy('name', 'asc'),
    pgDB.knex('designation_departments'),
  ]);
  const deptIdsByDesignation = {};
  for (const l of links) {
    (deptIdsByDesignation[l.designationId] ??= []).push(l.departmentId);
  }
  const data = designations.map((d) => ({ ...d, _id: new ObjectId(d.id), departmentIds: deptIdsByDesignation[d.id] || [] }));
  return returnFunction(res, 200, true, req.locale.success, data);
};

const createDesignation = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const name = req.body.name.trim();
  const existing = await pgDB.findOne('designations', { name });
  if (existing) return returnFunction(res, 409, false, 'A designation with this name already exists.');
  const departmentIds = Array.isArray(req.body.departmentIds) ? req.body.departmentIds : [];

  const result = await pgDB.insertOne('designations', { name, createdAt: new Date(), updatedAt: new Date() });
  if (departmentIds.length) {
    await pgDB.knex('designation_departments').insert(departmentIds.map((departmentId) => ({ designationId: result.id, departmentId })));
  }
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const updateDesignation = async (req, res) => {
  const { departmentIds, ...rest } = req.body;
  const update = { ...rest, updatedAt: new Date() };
  delete update._id;
  delete update.id;
  if (update.name) update.name = update.name.trim();
  await pgDB.updateOne('designations', { id: req.params.id }, update);

  // Wholesale-replace the join rows — the Postgres equivalent of Mongo's $set on the
  // old embedded departmentIds[] array.
  if (Array.isArray(departmentIds)) {
    await pgDB.knex.transaction(async (trx) => {
      await trx('designation_departments').where({ designationId: req.params.id }).del();
      if (departmentIds.length) {
        await trx('designation_departments').insert(departmentIds.map((departmentId) => ({ designationId: req.params.id, departmentId })));
      }
    });
  }
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteDesignation = pgMakeDelete('designations'); // designation_departments rows cascade via FK ON DELETE CASCADE

// ── JD Templates (reusable job description PDFs) ──────────────────────────────
const listJdTemplates = async (req, res) => {
  const data = await pgDB.knex('jd_templates').orderBy('name', 'asc');
  return returnFunction(res, 200, true, req.locale.success, data);
};

const createJdTemplate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const doc = {
    id: pgDB.newId(),
    name:            req.body.name.trim(),
    description:     req.body.description || '',
    roles:           req.body.roles       || '',
    pdfPath:         req.file ? req.file.path         : null,
    pdfOriginalName: req.file ? req.file.originalname : null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await pgDB.knex('jd_templates').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id });
};

const updateJdTemplate = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name        !== undefined) update.name        = req.body.name.trim();
  if (req.body.description !== undefined) update.description = req.body.description;
  if (req.body.roles       !== undefined) update.roles       = req.body.roles;
  if (req.file) {
    const existing = await pgDB.knex('jd_templates').where({ id: req.params.id }).first();
    if (existing?.pdfPath) fs.unlink(path.resolve(existing.pdfPath), () => {});
    update.pdfPath         = req.file.path;
    update.pdfOriginalName = req.file.originalname;
  }
  await pgDB.knex('jd_templates').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteJdTemplate = async (req, res) => {
  const existing = await pgDB.knex('jd_templates').where({ id: req.params.id }).first();
  if (existing?.pdfPath) fs.unlink(path.resolve(existing.pdfPath), () => {});
  await pgDB.knex('jd_templates').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted.');
};

const serveJdTemplate = async (req, res) => {
  const template = await pgDB.knex('jd_templates').where({ id: req.params.id }).first();
  if (!template?.pdfPath) return returnFunction(res, 404, false, 'No PDF for this template.');
  const filePath = path.resolve(template.pdfPath);
  if (!fs.existsSync(filePath)) return returnFunction(res, 404, false, 'File not found.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${template.pdfOriginalName || template.name + '.pdf'}"`);
  fs.createReadStream(filePath).pipe(res);
};

// ── Company Accounts (payment sources) ───────────────────────────────────────
const listCompanyAccounts  = pgMakeList('company_accounts');
const createCompanyAccount = pgMakeCreate('company_accounts', ['name', 'accountType']);
const updateCompanyAccount = pgMakeUpdate('company_accounts');
const deleteCompanyAccount = pgMakeDelete('company_accounts');

// ── Scheduled Events (Training sessions & Team Building events with dates) ────
const listScheduledEvents = async (req, res) => {
  let query = pgDB.knex('scheduled_events');
  if (req.query.type) query = query.where({ type: req.query.type });
  const upcoming = req.query.upcoming === 'true';
  if (upcoming) query = query.where('scheduledDate', '>=', new Date().toISOString().split('T')[0]);
  const events = await query.orderBy('scheduledDate', 'asc');
  return returnFunction(res, 200, true, req.locale.success, events);
};

const createScheduledEvent = async (req, res) => {
  const { title, type, description, scheduledDate, endDate, location, audience, department } = req.body;
  if (!title || !type || !scheduledDate) return returnFunction(res, 400, false, 'title, type, and scheduledDate are required.');
  const doc = {
    id: pgDB.newId(), title, type, description: description || '', scheduledDate, endDate: endDate || null,
    location: location || '', audience: audience || 'all', department: department || null,
    createdBy: req.user?.name || 'HR', createdAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await pgDB.knex('scheduled_events').insert(doc).returning('*');

  // Fire-and-forget — notify affected staff without blocking the response
  const typeLabel = type === 'team_building' ? 'Team Building' : 'Training';
  const dateLabel = new Date(scheduledDate).toLocaleDateString('en-KE', { dateStyle: 'medium' });
  const bodyText  = location ? `${dateLabel} · ${location}` : dateLabel;
  notifyStaffByAudience(audience || 'all', department || null, {
    title: `${typeLabel}: ${title}`,
    body:  bodyText,
    type:  'general',
  });
  emailStaffByAudience(audience || 'all', department || null, 'scheduledEventCreated',
    { typeLabel, eventTitle: title, bodyText },
    `${typeLabel}: ${title}`, `<p>${bodyText}</p>`).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id });
};

const updateScheduledEvent = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update.id;
  await pgDB.knex('scheduled_events').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteScheduledEvent = async (req, res) => {
  await pgDB.knex('scheduled_events').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// ── Communication Settings ────────────────────────────────────────────────────
const getCommunicationSettings = async (req, res) => {
  const settings = await pgDB.knex('communication_settings').first();
  return returnFunction(res, 200, true, req.locale.success, settings || {});
};

const updateCommunicationSettings = async (req, res) => {
  const ALLOWED = ['emailProvider', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpFrom', 'smsProvider', 'smsApiKey', 'smsFrom', 'notifyOnLeave', 'notifyOnPayroll', 'notifyOnAppraisal'];
  const patch = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  patch.updatedAt = new Date();
  const existing = await pgDB.knex('communication_settings').first();
  if (existing) {
    await pgDB.knex('communication_settings').where({ id: existing.id }).update(patch);
  } else {
    await pgDB.knex('communication_settings').insert({ id: pgDB.newId(), ...patch, createdAt: new Date() });
  }
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

module.exports = {
  listDepartments, createDepartment, updateDepartment, deleteDepartment, bulkDeleteDepartments,
  listBranches, createBranch, updateBranch, deleteBranch,
  listJobGroups,   createJobGroup,   updateJobGroup,   deleteJobGroup,
  getCommunicationSettings, updateCommunicationSettings,
  listDesignations, createDesignation, updateDesignation, deleteDesignation,
  listJdTemplates,  createJdTemplate,  updateJdTemplate,  deleteJdTemplate, serveJdTemplate,
  listCompanyAccounts, createCompanyAccount, updateCompanyAccount, deleteCompanyAccount,
  listScheduledEvents, createScheduledEvent, updateScheduledEvent, deleteScheduledEvent,
};
