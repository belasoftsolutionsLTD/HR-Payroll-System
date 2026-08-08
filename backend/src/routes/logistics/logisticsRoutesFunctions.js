// Postgres migration (Phase 8) — logistics_routes/logistics_vehicles/logistics_shipments
// are Postgres now, and route stops are a REAL child table (logistics_route_stops), not
// JSONB — updateStopStatus/uploadProofOfDelivery both did a genuine Mongo arrayFilters
// positional update, the clearest "real per-row addressability" signal this migration
// uses to mean "child table" (see the migration file's own header comment).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { getLogisticsAccessLevel, getLogisticsDepartmentFilter } = require('../../lib/logistics/logisticsAccess');
const { markShipmentDelivered } = require('./logisticsShipmentsFunctions');

const STOP_STATUSES = ['pending', 'delivered', 'failed', 'rescheduled'];
const ROUTE_STATUSES = ['planned', 'in_progress', 'completed'];

// Simple nearest-neighbor stop sequencing — swappable later for a smarter algorithm
// without touching the data model (each stop keeps its own `sequence` number regardless
// of how it was assigned). Falls back to the given input order when stops don't carry
// lat/lng (a plain address-only stop list is explicitly acceptable for this phase).
function sequenceStops(stops) {
  const hasCoords = stops.every((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
  if (!hasCoords || stops.length <= 1) {
    return stops.map((s, i) => ({ ...s, sequence: i + 1 }));
  }
  const remaining = [...stops];
  const ordered = [remaining.shift()];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let nearestIdx = 0;
    let nearestDist = Infinity;
    remaining.forEach((s, i) => {
      const dist = Math.hypot(s.lat - last.lat, s.lng - last.lng);
      if (dist < nearestDist) { nearestDist = dist; nearestIdx = i; }
    });
    ordered.push(remaining.splice(nearestIdx, 1)[0]);
  }
  return ordered.map((s, i) => ({ ...s, sequence: i + 1 }));
}

const listRoutes = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const { page, limit, skip } = getPagination(req.query);
  let query = knex('logistics_routes');
  if (req.query.status) query = query.where({ status: req.query.status });
  if (level === 'driver') {
    query = query.where({ driverId: String(req.user.employeeId) });
  } else {
    const deptFilter = getLogisticsDepartmentFilter(req.user, level);
    if (deptFilter) query = query.where(deptFilter);
  }

  const [{ count }] = await query.clone().count('* as count');
  const routes = await query.clone().orderBy('date', 'desc').limit(limit).offset(skip);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(routes, Number(count), page, limit));
};

const getRoute = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const route = await knex('logistics_routes').where({ id: req.params.id }).first();
  if (!route) return returnFunction(res, 404, false, req.locale.notFound);
  if (level === 'driver' && route.driverId !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'You can only view your own routes.');
  }
  const stops = await knex('logistics_route_stops').where({ routeId: route.id }).orderBy('sequence');
  return returnFunction(res, 200, true, req.locale.success, { ...route, stops });
};

const createRoute = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['vehicleId', 'driverId', 'date', 'stops'])) return;
  if (!Array.isArray(req.body.stops) || !req.body.stops.length) return returnFunction(res, 400, false, 'At least one stop is required.');

  const vehicle = await knex('logistics_vehicles').where({ id: req.body.vehicleId }).first();
  if (!vehicle) return returnFunction(res, 400, false, 'Vehicle not found.');
  const driver = await knex('employees').where({ id: req.body.driverId }).first();
  if (!driver) return returnFunction(res, 400, false, 'Driver (employee) not found.');

  const rawStops = req.body.stops.map((s) => ({
    id: newId(),
    address: s.address,
    lat: typeof s.lat === 'number' ? s.lat : null,
    lng: typeof s.lng === 'number' ? s.lng : null,
    timeWindowStart: s.timeWindowStart || null,
    timeWindowEnd: s.timeWindowEnd || null,
    shipmentId: s.shipmentId || null,
    status: 'pending',
    proofOfDeliveryUrl: null,
    signatureUrl: null,
    notes: null,
    completedAt: null,
  }));
  const stops = sequenceStops(rawStops);

  const routeId = newId();
  const doc = {
    id: routeId,
    vehicleId: vehicle.id,
    driverId: driver.id,
    date: new Date(req.body.date),
    status: 'planned',
    department: req.body.department || null,
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('logistics_routes').insert(doc).returning('*');
  await knex('logistics_route_stops').insert(stops.map((s) => ({ ...s, routeId })));

  // A shipment placed on a route is now "picked up" — it moves off 'pending' the moment
  // it's actually assigned a driver/vehicle, not just when a stop is delivered.
  const shipmentIds = stops.map((s) => s.shipmentId).filter(Boolean);
  if (shipmentIds.length) {
    await knex('logistics_shipments').whereIn('id', shipmentIds).update({ routeId, status: 'picked_up', updatedAt: new Date() });
    for (const stop of stops) {
      if (stop.shipmentId) await knex('logistics_shipments').where({ id: stop.shipmentId }).update({ stopId: stop.id });
    }
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { ...saved, stops });
};

const updateRouteStatus = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!ROUTE_STATUSES.includes(req.body.status)) return returnFunction(res, 400, false, `status must be one of: ${ROUTE_STATUSES.join(', ')}`);
  const updated = await knex('logistics_routes').where({ id: req.params.id }).update({ status: req.body.status, updatedAt: new Date() });
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// The core "driver working their route" action. Delivered/failed/rescheduled are all
// terminal-for-now states a driver sets themselves; when a stop wraps a shipment and is
// marked delivered, this calls the exact same markShipmentDelivered used by the
// dedicated Shipments endpoint — never a second copy of "what does delivered mean."
const updateStopStatus = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!STOP_STATUSES.includes(req.body.status)) return returnFunction(res, 400, false, `status must be one of: ${STOP_STATUSES.join(', ')}`);

  const route = await knex('logistics_routes').where({ id: req.params.id }).first();
  if (!route) return returnFunction(res, 404, false, req.locale.notFound);
  if (level === 'driver' && route.driverId !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'You can only update your own route.');
  }
  const stop = await knex('logistics_route_stops').where({ id: req.params.stopId, routeId: route.id }).first();
  if (!stop) return returnFunction(res, 404, false, 'Stop not found on this route.');

  if (stop.status === 'delivered' && stop.shipmentId) {
    // already-delivered stops shouldn't silently re-run the Inventory completion logic
    return returnFunction(res, 400, false, 'This stop is already marked delivered.');
  }

  if (req.body.status === 'delivered' && stop.shipmentId) {
    try {
      await markShipmentDelivered(stop.shipmentId, req.user.id);
    } catch (err) {
      return returnFunction(res, 400, false, err.message);
    }
  }

  await knex('logistics_route_stops').where({ id: stop.id }).update({
    status: req.body.status,
    notes: req.body.notes || null,
    completedAt: ['delivered', 'failed'].includes(req.body.status) ? new Date() : null,
  });
  await knex('logistics_routes').where({ id: route.id }).update({ updatedAt: new Date() });

  const allStops = await knex('logistics_route_stops').where({ routeId: route.id });
  const allTerminal = allStops.every((s) => ['delivered', 'failed'].includes(s.status));
  if (allTerminal && route.status !== 'completed') {
    await knex('logistics_routes').where({ id: route.id }).update({ status: 'completed', updatedAt: new Date() });
  } else if (route.status === 'planned') {
    await knex('logistics_routes').where({ id: route.id }).update({ status: 'in_progress', updatedAt: new Date() });
  }

  return returnFunction(res, 200, true, 'Stop updated.');
};

// Proof of delivery — reuses the same multer disk-storage pattern as every other upload
// in this codebase (see inventory.js's item-image upload), just parked under a
// logistics-specific filename prefix. `field` is 'photo' or 'signature'.
const uploadProofOfDelivery = async (req, res, field) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!req.file) return returnFunction(res, 400, false, 'No file uploaded.');
  const route = await knex('logistics_routes').where({ id: req.params.id }).first();
  if (!route) return returnFunction(res, 404, false, req.locale.notFound);
  if (level === 'driver' && route.driverId !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'You can only upload proof of delivery for your own route.');
  }
  const stop = await knex('logistics_route_stops').where({ id: req.params.stopId, routeId: route.id }).first();
  if (!stop) return returnFunction(res, 404, false, 'Stop not found on this route.');

  const column = field === 'signature' ? 'signatureUrl' : 'proofOfDeliveryUrl';
  await knex('logistics_route_stops').where({ id: stop.id }).update({ [column]: req.file.path });
  await knex('logistics_routes').where({ id: route.id }).update({ updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Proof of delivery uploaded.', { path: req.file.path });
};

module.exports = { listRoutes, getRoute, createRoute, updateRouteStatus, updateStopStatus, uploadProofOfDelivery, sequenceStops };
