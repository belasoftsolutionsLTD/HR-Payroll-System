// Postgres migration (Phase 7) — crm_companies/crm_contacts/crm_deals are Postgres now.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { getCrmAccessLevel } = require('../../lib/crm/crmAccess');

const listCompanies = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  let query = knex('crm_companies').whereNot({ isActive: false });
  if (req.query.search) query = query.whereILike('name', `%${req.query.search.trim()}%`);

  const [{ count }] = await query.clone().count('* as count');
  const { page, limit, skip } = getPagination(req.query);
  const companies = await query.clone().orderBy('name').limit(limit).offset(skip);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(companies, Number(count), page, limit));
};

const getCompany = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const company = await knex('crm_companies').where({ id: req.params.id }).first();
  if (!company) return returnFunction(res, 404, false, req.locale.notFound);

  const [contacts, deals] = await Promise.all([
    knex('crm_contacts').where({ companyId: company.id }).whereNot({ isActive: false }).select('id', 'firstName', 'lastName', 'email'),
    knex('crm_deals').where({ companyId: company.id }).select('id', 'title', 'value', 'status', 'stageId'),
  ]);
  return returnFunction(res, 200, true, req.locale.success, { ...company, contacts, deals });
};

const createCompany = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['name'])) return;

  const doc = {
    id: newId(),
    name: req.body.name.trim(),
    industry: req.body.industry?.trim() || '',
    customFieldValues: JSON.stringify(req.body.customFieldValues && typeof req.body.customFieldValues === 'object' ? req.body.customFieldValues : {}),
    isActive: true,
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('crm_companies').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateCompany = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.industry !== undefined) update.industry = req.body.industry.trim();
  if (req.body.customFieldValues && typeof req.body.customFieldValues === 'object') update.customFieldValues = JSON.stringify(req.body.customFieldValues);
  await knex('crm_companies').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteCompany = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized.');
  await knex('crm_companies').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = { listCompanies, getCompany, createCompany, updateCompany, deleteCompany };
