const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { getLogisticsAccessLevel } = require('../../lib/logistics/logisticsAccess');

// Vehicle Types — same shape as Inventory's Categories/Brands: an admin-managed list,
// vehicles store the name as a plain string (not an FK/join), same reasoning ("nothing
// downstream needs to join on it, a string is enough").
const listVehicleTypes = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const types = await findMany('logistics_vehicle_types', { isActive: { $ne: false } }, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, types);
};

const createVehicleType = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can add a vehicle type.');
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await findOne('logistics_vehicle_types', { name: req.body.name.trim() });
  if (existing) return returnFunction(res, 409, false, 'A vehicle type with this name already exists.');
  const doc = { name: req.body.name.trim(), isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne('logistics_vehicle_types', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const deleteVehicleType = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can remove a vehicle type.');
  await updateOne('logistics_vehicle_types', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// Service Bays — same admin-managed named-list pattern as Vehicle Types above.
// Maintenance records store the name as a plain string (see logisticsMaintenanceFunctions.js),
// so this is purely which names are valid to pick from, not a joined entity.
const listServiceBays = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const bays = await findMany('logistics_service_bays', { isActive: { $ne: false } }, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, bays);
};

const createServiceBay = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can add a service bay.');
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await findOne('logistics_service_bays', { name: req.body.name.trim() });
  if (existing) return returnFunction(res, 409, false, 'A service bay with this name already exists.');
  const doc = { name: req.body.name.trim(), isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne('logistics_service_bays', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const deleteServiceBay = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can remove a service bay.');
  await updateOne('logistics_service_bays', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = { listVehicleTypes, createVehicleType, deleteVehicleType, listServiceBays, createServiceBay, deleteServiceBay };
