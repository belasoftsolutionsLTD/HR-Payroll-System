const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { getCrmAccessLevel } = require('../../lib/crm/crmAccess');

const listCompanies = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  const { page, limit, skip } = getPagination(req.query);
  const filter = { isActive: { $ne: false } };
  if (req.query.search) filter.name = { $regex: req.query.search.trim(), $options: 'i' };

  const [total, companies] = await Promise.all([
    countDocuments('crm_companies', filter),
    findMany('crm_companies', filter, { skip, limit, sort: { name: 1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(companies, total, page, limit));
};

const getCompany = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const company = await findOne('crm_companies', { _id: new ObjectId(req.params.id) });
  if (!company) return returnFunction(res, 404, false, req.locale.notFound);

  const [contacts, deals] = await Promise.all([
    findMany('crm_contacts', { companyId: company._id, isActive: { $ne: false } }, { projection: { firstName: 1, lastName: 1, email: 1 } }),
    findMany('crm_deals', { companyId: company._id }, { projection: { title: 1, value: 1, status: 1, stageId: 1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, { ...company, contacts, deals });
};

const createCompany = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['name'])) return;

  const doc = {
    name: req.body.name.trim(),
    industry: req.body.industry?.trim() || '',
    customFieldValues: req.body.customFieldValues && typeof req.body.customFieldValues === 'object' ? req.body.customFieldValues : {},
    isActive: true,
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('crm_companies', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateCompany = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.industry !== undefined) update.industry = req.body.industry.trim();
  if (req.body.customFieldValues && typeof req.body.customFieldValues === 'object') update.customFieldValues = req.body.customFieldValues;
  await updateOne('crm_companies', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteCompany = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized.');
  await updateOne('crm_companies', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = { listCompanies, getCompany, createCompany, updateCompany, deleteCompany };
