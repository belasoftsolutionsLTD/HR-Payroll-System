const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { getInventoryAccessLevel } = require('../../lib/inventory/inventoryAccess');

const listSuppliers = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const filter = { isActive: { $ne: false } };
  const suppliers = await findMany('inventory_suppliers', filter, { sort: { name: 1 } });
  if (!suppliers.length) return returnFunction(res, 200, true, req.locale.success, []);

  const itemIds = [...new Set(suppliers.flatMap((s) => (s.linkedItemIds || []).map(String)))].map((id) => new ObjectId(id));
  const items = itemIds.length
    ? await findMany('inventory_items', { _id: { $in: itemIds } }, { projection: { sku: 1, name: 1 } })
    : [];
  const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));
  const enriched = suppliers.map((s) => ({ ...s, linkedItems: (s.linkedItemIds || []).map((id) => itemMap[String(id)]).filter(Boolean) }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getSupplier = async (req, res) => {
  const supplier = await findOne('inventory_suppliers', { _id: new ObjectId(req.params.id) });
  if (!supplier) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, supplier);
};

const createSupplier = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const doc = {
    name: req.body.name.trim(),
    contactPerson: req.body.contactPerson?.trim() || '',
    phone: req.body.phone?.trim() || '',
    email: req.body.email?.trim() || '',
    address: req.body.address?.trim() || '',
    linkedItemIds: Array.isArray(req.body.linkedItemIds) ? req.body.linkedItemIds.map((id) => new ObjectId(id)) : [],
    leadTimeDays: Number(req.body.leadTimeDays) || 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('inventory_suppliers', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateSupplier = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.contactPerson !== undefined) update.contactPerson = req.body.contactPerson.trim();
  if (req.body.phone !== undefined) update.phone = req.body.phone.trim();
  if (req.body.email !== undefined) update.email = req.body.email.trim();
  if (req.body.address !== undefined) update.address = req.body.address.trim();
  if (Array.isArray(req.body.linkedItemIds)) update.linkedItemIds = req.body.linkedItemIds.map((id) => new ObjectId(id));
  if (req.body.leadTimeDays !== undefined) update.leadTimeDays = Number(req.body.leadTimeDays) || 0;
  await updateOne('inventory_suppliers', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteSupplier = async (req, res) => {
  await updateOne('inventory_suppliers', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = { listSuppliers, getSupplier, createSupplier, updateSupplier, deleteSupplier };
