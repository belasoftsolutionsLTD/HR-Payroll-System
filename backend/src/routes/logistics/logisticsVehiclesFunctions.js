// Postgres migration (Phase 8) — logistics_vehicles is Postgres now; employees has been
// Postgres since Phase 1.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { getLogisticsAccessLevel, getLogisticsDepartmentFilter } = require('../../lib/logistics/logisticsAccess');

const STATUSES = ['active', 'maintenance', 'inactive'];

const listVehicles = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  const { page, limit, skip } = getPagination(req.query);
  let query = knex('logistics_vehicles');
  if (req.query.status) query = query.where({ status: req.query.status });
  // A driver only ever sees their own assigned vehicle — everything else in this file
  // (routes, shipments) already scopes to "your own route" the same way.
  if (level === 'driver') {
    query = query.where({ driverId: String(req.user.employeeId) });
  } else {
    const deptFilter = getLogisticsDepartmentFilter(req.user, level);
    if (deptFilter) query = query.where(deptFilter);
  }

  const [{ count }] = await query.clone().count('* as count');
  const vehicles = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const driverIds = [...new Set(vehicles.map((v) => v.driverId).filter(Boolean))];
  const drivers = driverIds.length ? await knex('employees').whereIn('id', driverIds).select('id', 'fullName') : [];
  const driverMap = Object.fromEntries(drivers.map((d) => [d.id, d.fullName]));
  const enriched = vehicles.map((v) => ({ ...v, driverName: v.driverId ? driverMap[v.driverId] || null : null }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getVehicle = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const vehicle = await knex('logistics_vehicles').where({ id: req.params.id }).first();
  if (!vehicle) return returnFunction(res, 404, false, req.locale.notFound);
  if (level === 'driver' && vehicle.driverId !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'Not authorized.');
  }
  const driver = vehicle.driverId ? await knex('employees').where({ id: vehicle.driverId }).select('fullName', 'phone').first() : null;
  return returnFunction(res, 200, true, req.locale.success, { ...vehicle, driver });
};

// Fleet setup — admin only (super_admin), same split as Accounting's Chart of Accounts
// structural edits vs its transactional bookkeeper access.
const createVehicle = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can add a vehicle.');
  if (!validateRequiredFields(req, res, ['make', 'model', 'licensePlate'])) return;

  const doc = {
    id: newId(),
    make: req.body.make.trim(),
    model: req.body.model.trim(),
    licensePlate: req.body.licensePlate.trim(),
    vin: req.body.vin || null,
    vehicleType: req.body.vehicleType || null,
    driverId: req.body.driverId || null,
    status: 'active',
    currentLocation: req.body.currentLocation || null,
    odometer: Number(req.body.odometer) || 0,
    fuelType: req.body.fuelType || null,
    department: req.body.department || null,
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('logistics_vehicles').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateVehicle = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can edit fleet setup.');
  const vehicle = await knex('logistics_vehicles').where({ id: req.params.id }).first();
  if (!vehicle) return returnFunction(res, 404, false, req.locale.notFound);

  const ALLOWED = ['make', 'model', 'licensePlate', 'vin', 'vehicleType', 'fuelType', 'department'];
  const patch = { updatedAt: new Date() };
  for (const key of ALLOWED) if (req.body[key] !== undefined) patch[key] = req.body[key];
  await knex('logistics_vehicles').where({ id: vehicle.id }).update(patch);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const archiveVehicle = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only a Logistics admin can remove a vehicle.');
  const updated = await knex('logistics_vehicles').where({ id: req.params.id }).update({ status: 'inactive', updatedAt: new Date() });
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Vehicle deactivated.');
};

// Transactional actions (assignment/status/location) — opsAdmin and up, not fleet setup.
const assignDriver = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const vehicle = await knex('logistics_vehicles').where({ id: req.params.id }).first();
  if (!vehicle) return returnFunction(res, 404, false, req.locale.notFound);
  const driverId = req.body.driverId || null;
  if (driverId) {
    const employee = await knex('employees').where({ id: driverId }).select('id').first();
    if (!employee) return returnFunction(res, 400, false, 'Driver must be an existing employee.');
  }
  await knex('logistics_vehicles').where({ id: vehicle.id }).update({ driverId, updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Driver assigned.');
};

const updateVehicleStatus = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!STATUSES.includes(req.body.status)) return returnFunction(res, 400, false, `status must be one of: ${STATUSES.join(', ')}`);
  const updated = await knex('logistics_vehicles').where({ id: req.params.id }).update({ status: req.body.status, updatedAt: new Date() });
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Manual location entry (this phase's placeholder for real telematics — see Step 0 audit).
// A driver may update their own assigned vehicle's location; opsAdmin/admin may update any.
const updateVehicleLocation = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const vehicle = await knex('logistics_vehicles').where({ id: req.params.id }).first();
  if (!vehicle) return returnFunction(res, 404, false, req.locale.notFound);
  if (level === 'driver' && vehicle.driverId !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'You can only update your own vehicle\'s location.');
  }
  if (!validateRequiredFields(req, res, ['currentLocation'])) return;
  await knex('logistics_vehicles').where({ id: vehicle.id }).update({ currentLocation: req.body.currentLocation, locationUpdatedAt: new Date(), updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Location updated.');
};

const getFleetUtilization = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const vehicles = await knex('logistics_vehicles');
  const byStatus = { active: 0, maintenance: 0, inactive: 0 };
  let totalOdometer = 0;
  let assignedCount = 0;
  for (const v of vehicles) {
    byStatus[v.status] = (byStatus[v.status] || 0) + 1;
    totalOdometer += v.odometer || 0;
    if (v.driverId) assignedCount += 1;
  }
  return returnFunction(res, 200, true, req.locale.success, {
    totalVehicles: vehicles.length,
    byStatus,
    assignedCount,
    unassignedCount: vehicles.length - assignedCount,
    totalOdometer,
    avgOdometer: vehicles.length ? Math.round(totalOdometer / vehicles.length) : 0,
  });
};

module.exports = {
  listVehicles, getVehicle, createVehicle, updateVehicle, archiveVehicle,
  assignDriver, updateVehicleStatus, updateVehicleLocation, getFleetUtilization,
};
