const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { getCrmAccessLevel } = require('../../lib/crm/crmAccess');

// Same field-def-collection pattern as Inventory's item custom fields (name + fieldType
// + options, values stored on the record keyed by this doc's _id) — reused here for
// contacts, companies, AND deals via the `appliesTo` discriminator, configurable by
// super_admin/hr_manager without a code change, per the module spec.

const listCustomFieldDefs = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const filter = { isActive: { $ne: false } };
  if (req.query.appliesTo) filter.appliesTo = req.query.appliesTo;
  const defs = await findMany('crm_custom_field_defs', filter, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, defs);
};

const createCustomFieldDef = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['name', 'fieldType', 'appliesTo'])) return;
  if (!['text', 'number', 'date', 'select'].includes(req.body.fieldType)) {
    return returnFunction(res, 400, false, "fieldType must be 'text', 'number', 'date', or 'select'.");
  }
  if (!['contact', 'company', 'deal'].includes(req.body.appliesTo)) {
    return returnFunction(res, 400, false, "appliesTo must be 'contact', 'company', or 'deal'.");
  }
  const doc = {
    name: req.body.name.trim(),
    fieldType: req.body.fieldType,
    appliesTo: req.body.appliesTo,
    options: req.body.fieldType === 'select' ? (Array.isArray(req.body.options) ? req.body.options.map(String) : []) : [],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('crm_custom_field_defs', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateCustomFieldDef = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (Array.isArray(req.body.options)) update.options = req.body.options.map(String);
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await updateOne('crm_custom_field_defs', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteCustomFieldDef = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  await updateOne('crm_custom_field_defs', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = { listCustomFieldDefs, createCustomFieldDef, updateCustomFieldDef, deleteCustomFieldDef };
