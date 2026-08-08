// Postgres migration (Phase 8) — logistics_vehicle_types/logistics_service_bays are
// Postgres now.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { getLogisticsAccessLevel } = require('../../lib/logistics/logisticsAccess');

// Vehicle Types — same shape as Inventory's Categories/Brands: an admin-managed list,
// vehicles store the name as a plain string (not an FK/join), same reasoning ("nothing
// downstream needs to join on it, a string is enough").
const listVehicleTypes = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const types = await knex('logistics_vehicle_types').whereNot({ isActive: false }).orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, types);
};

const createVehicleType = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can add a vehicle type.');
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await knex('logistics_vehicle_types').where({ name: req.body.name.trim() }).first();
  if (existing) return returnFunction(res, 409, false, 'A vehicle type with this name already exists.');
  const doc = { id: newId(), name: req.body.name.trim(), isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const [saved] = await knex('logistics_vehicle_types').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const deleteVehicleType = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can remove a vehicle type.');
  await knex('logistics_vehicle_types').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// Service Bays — same admin-managed named-list pattern as Vehicle Types above.
// Maintenance records store the name as a plain string (see logisticsMaintenanceFunctions.js),
// so this is purely which names are valid to pick from, not a joined entity.
const listServiceBays = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const bays = await knex('logistics_service_bays').whereNot({ isActive: false }).orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, bays);
};

const createServiceBay = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can add a service bay.');
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await knex('logistics_service_bays').where({ name: req.body.name.trim() }).first();
  if (existing) return returnFunction(res, 409, false, 'A service bay with this name already exists.');
  const doc = { id: newId(), name: req.body.name.trim(), isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const [saved] = await knex('logistics_service_bays').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const deleteServiceBay = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can remove a service bay.');
  await knex('logistics_service_bays').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = { listVehicleTypes, createVehicleType, deleteVehicleType, listServiceBays, createServiceBay, deleteServiceBay };
