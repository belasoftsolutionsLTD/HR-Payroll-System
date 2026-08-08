// Postgres migration (Phase 6) — inventory_suppliers/inventory_items are Postgres now.
// linkedItemIds is a text[] column (see phase6 migration) — plain string array, no
// ObjectId wrapping.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { getInventoryAccessLevel } = require('../../lib/inventory/inventoryAccess');

const listSuppliers = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const suppliers = await knex('inventory_suppliers').whereNot({ isActive: false }).orderBy('name');
  if (!suppliers.length) return returnFunction(res, 200, true, req.locale.success, []);

  const itemIds = [...new Set(suppliers.flatMap((s) => s.linkedItemIds || []))];
  const items = itemIds.length ? await knex('inventory_items').whereIn('id', itemIds).select('id', 'sku', 'name') : [];
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));
  const enriched = suppliers.map((s) => ({ ...s, linkedItems: (s.linkedItemIds || []).map((id) => itemMap[id]).filter(Boolean) }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getSupplier = async (req, res) => {
  const supplier = await knex('inventory_suppliers').where({ id: req.params.id }).first();
  if (!supplier) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, supplier);
};

const createSupplier = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const doc = {
    id: newId(),
    name: req.body.name.trim(),
    contactPerson: req.body.contactPerson?.trim() || '',
    phone: req.body.phone?.trim() || '',
    email: req.body.email?.trim() || '',
    address: req.body.address?.trim() || '',
    linkedItemIds: Array.isArray(req.body.linkedItemIds) ? req.body.linkedItemIds.map(String) : [],
    leadTimeDays: Number(req.body.leadTimeDays) || 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('inventory_suppliers').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateSupplier = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.contactPerson !== undefined) update.contactPerson = req.body.contactPerson.trim();
  if (req.body.phone !== undefined) update.phone = req.body.phone.trim();
  if (req.body.email !== undefined) update.email = req.body.email.trim();
  if (req.body.address !== undefined) update.address = req.body.address.trim();
  if (Array.isArray(req.body.linkedItemIds)) update.linkedItemIds = req.body.linkedItemIds.map(String);
  if (req.body.leadTimeDays !== undefined) update.leadTimeDays = Number(req.body.leadTimeDays) || 0;
  await knex('inventory_suppliers').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteSupplier = async (req, res) => {
  await knex('inventory_suppliers').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = { listSuppliers, getSupplier, createSupplier, updateSupplier, deleteSupplier };
