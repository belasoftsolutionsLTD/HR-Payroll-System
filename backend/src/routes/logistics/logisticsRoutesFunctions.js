const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, updateMany, countDocuments } = require('../../functions/Database/commonDBFunctions');
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
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (level === 'driver') {
    filter.driverId = req.user.employeeId;
  } else {
    const deptFilter = getLogisticsDepartmentFilter(req.user, level);
    if (deptFilter) Object.assign(filter, deptFilter);
  }

  const [total, routes] = await Promise.all([
    countDocuments('logistics_routes', filter),
    findMany('logistics_routes', filter, { skip, limit, sort: { date: -1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(routes, total, page, limit));
};

const getRoute = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const route = await findOne('logistics_routes', { _id: new ObjectId(req.params.id) });
  if (!route) return returnFunction(res, 404, false, req.locale.notFound);
  if (level === 'driver' && String(route.driverId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'You can only view your own routes.');
  }
  return returnFunction(res, 200, true, req.locale.success, route);
};

const createRoute = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['vehicleId', 'driverId', 'date', 'stops'])) return;
  if (!Array.isArray(req.body.stops) || !req.body.stops.length) return returnFunction(res, 400, false, 'At least one stop is required.');

  const vehicle = await findOne('logistics_vehicles', { _id: new ObjectId(req.body.vehicleId) });
  if (!vehicle) return returnFunction(res, 400, false, 'Vehicle not found.');
  const driver = await findOne('employees', { _id: new ObjectId(req.body.driverId) });
  if (!driver) return returnFunction(res, 400, false, 'Driver (employee) not found.');

  const rawStops = req.body.stops.map((s) => ({
    id: new ObjectId().toString(),
    address: s.address,
    lat: typeof s.lat === 'number' ? s.lat : null,
    lng: typeof s.lng === 'number' ? s.lng : null,
    timeWindowStart: s.timeWindowStart || null,
    timeWindowEnd: s.timeWindowEnd || null,
    shipmentId: s.shipmentId ? new ObjectId(s.shipmentId) : null,
    status: 'pending',
    proofOfDeliveryUrl: null,
    signatureUrl: null,
    notes: null,
    completedAt: null,
  }));
  const stops = sequenceStops(rawStops);

  const doc = {
    vehicleId: vehicle._id,
    driverId: driver._id,
    date: new Date(req.body.date),
    stops,
    status: 'planned',
    department: req.body.department || null,
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('logistics_routes', doc);

  // A shipment placed on a route is now "picked up" — it moves off 'pending' the moment
  // it's actually assigned a driver/vehicle, not just when a stop is delivered.
  const shipmentIds = stops.map((s) => s.shipmentId).filter(Boolean);
  if (shipmentIds.length) {
    await updateMany('logistics_shipments', { _id: { $in: shipmentIds } }, {
      $set: { routeId: result.insertedId, status: 'picked_up', updatedAt: new Date() },
    });
    for (const stop of stops) {
      if (stop.shipmentId) await updateOne('logistics_shipments', { _id: stop.shipmentId }, { $set: { stopId: stop.id } });
    }
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateRouteStatus = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!ROUTE_STATUSES.includes(req.body.status)) return returnFunction(res, 400, false, `status must be one of: ${ROUTE_STATUSES.join(', ')}`);
  const result = await updateOne('logistics_routes', { _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status, updatedAt: new Date() } });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
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

  const route = await findOne('logistics_routes', { _id: new ObjectId(req.params.id) });
  if (!route) return returnFunction(res, 404, false, req.locale.notFound);
  if (level === 'driver' && String(route.driverId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'You can only update your own route.');
  }
  const stop = route.stops.find((s) => s.id === req.params.stopId);
  if (!stop) return returnFunction(res, 404, false, 'Stop not found on this route.');

  if (stop.status === 'delivered' && stop.shipmentId) {
    // already-delivered stops shouldn't silently re-run the Inventory completion logic
    return returnFunction(res, 400, false, 'This stop is already marked delivered.');
  }

  if (req.body.status === 'delivered' && stop.shipmentId) {
    try {
      await markShipmentDelivered(stop.shipmentId, req.user._id);
    } catch (err) {
      return returnFunction(res, 400, false, err.message);
    }
  }

  await updateOne(
    'logistics_routes',
    { _id: route._id },
    {
      $set: {
        'stops.$[stop].status': req.body.status,
        'stops.$[stop].notes': req.body.notes || null,
        'stops.$[stop].completedAt': ['delivered', 'failed'].includes(req.body.status) ? new Date() : null,
        updatedAt: new Date(),
      },
    },
    { arrayFilters: [{ 'stop.id': req.params.stopId }] }
  );

  const refreshed = await findOne('logistics_routes', { _id: route._id });
  const allTerminal = refreshed.stops.every((s) => ['delivered', 'failed'].includes(s.status));
  if (allTerminal && refreshed.status !== 'completed') {
    await updateOne('logistics_routes', { _id: route._id }, { $set: { status: 'completed', updatedAt: new Date() } });
  } else if (refreshed.status === 'planned') {
    await updateOne('logistics_routes', { _id: route._id }, { $set: { status: 'in_progress', updatedAt: new Date() } });
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
  const route = await findOne('logistics_routes', { _id: new ObjectId(req.params.id) });
  if (!route) return returnFunction(res, 404, false, req.locale.notFound);
  if (level === 'driver' && String(route.driverId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'You can only upload proof of delivery for your own route.');
  }
  const stop = route.stops.find((s) => s.id === req.params.stopId);
  if (!stop) return returnFunction(res, 404, false, 'Stop not found on this route.');

  const urlField = field === 'signature' ? 'stops.$[stop].signatureUrl' : 'stops.$[stop].proofOfDeliveryUrl';
  await updateOne(
    'logistics_routes',
    { _id: route._id },
    { $set: { [urlField]: req.file.path, updatedAt: new Date() } },
    { arrayFilters: [{ 'stop.id': req.params.stopId }] }
  );
  return returnFunction(res, 200, true, 'Proof of delivery uploaded.', { path: req.file.path });
};

module.exports = { listRoutes, getRoute, createRoute, updateRouteStatus, updateStopStatus, uploadProofOfDelivery, sequenceStops };
