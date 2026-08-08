const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
// inventory_transfers/pos_sales are Postgres now (Phase 6) — found while sweeping
// Logistics; logistics_shipments/logistics_routes stay Mongo, Logistics' own phase (8).
const { knex } = require('../../functions/Database/pgDBFunctions');
const { getLogisticsAccessLevel, getLogisticsDepartmentFilter } = require('../../lib/logistics/logisticsAccess');
const { completeInventoryTransfer } = require('../../lib/inventory/inventoryIntegration');

const SOURCE_TYPES = ['pos_sale', 'inventory_transfer', 'standalone'];
const STATUSES = ['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception'];
const TRANSITIONABLE = ['pending', 'picked_up', 'in_transit', 'out_for_delivery']; // delivered/exception have their own dedicated endpoints

const csvEscape = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const listShipments = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (level === 'driver') {
    const routes = await findMany('logistics_routes', { driverId: req.user.employeeId }, { projection: { _id: 1 } });
    filter.routeId = { $in: routes.map((r) => r._id) };
  } else {
    const deptFilter = getLogisticsDepartmentFilter(req.user, level);
    if (deptFilter) Object.assign(filter, deptFilter);
  }

  const [total, shipments] = await Promise.all([
    countDocuments('logistics_shipments', filter),
    findMany('logistics_shipments', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(shipments, total, page, limit));
};

const getShipment = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const shipment = await findOne('logistics_shipments', { _id: new ObjectId(req.params.id) });
  if (!shipment) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, shipment);
};

// Per the Step 0 decision: POS has no delivery concept yet, so a shipment is only ever
// linked to an existing, already-completed source record — never auto-generated from
// inside POS checkout or a transfer request. Ops staff pick the source manually here.
const createShipment = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const sourceType = req.body.sourceType || 'standalone';
  if (!SOURCE_TYPES.includes(sourceType)) return returnFunction(res, 400, false, `sourceType must be one of: ${SOURCE_TYPES.join(', ')}`);

  let sourceId = null;
  if (sourceType === 'inventory_transfer') {
    if (!req.body.sourceId) return returnFunction(res, 400, false, 'sourceId (transfer) is required for sourceType inventory_transfer.');
    const transfer = await knex('inventory_transfers').where({ id: req.body.sourceId }).first();
    if (!transfer) return returnFunction(res, 400, false, 'Inventory transfer not found.');
    if (transfer.status !== 'approved') return returnFunction(res, 400, false, 'Only an approved transfer (ready to be received) can become a shipment.');
    sourceId = transfer.id;
  } else if (sourceType === 'pos_sale') {
    if (!req.body.sourceId) return returnFunction(res, 400, false, 'sourceId (sale) is required for sourceType pos_sale.');
    const sale = await knex('pos_sales').where({ id: req.body.sourceId }).first();
    if (!sale) return returnFunction(res, 400, false, 'POS sale not found.');
    sourceId = sale.id;
  }

  // Optional route/stop assignment — schema has always had these fields, but nothing
  // ever let a caller set them, so every shipment was invisible to a driver's own
  // scoped view (listShipments filters drivers to routeId $in their own routes) and
  // had no way to say *which* delivery run it actually travels on.
  let routeId = null;
  let stopId = null;
  if (req.body.routeId) {
    const route = await findOne('logistics_routes', { _id: new ObjectId(req.body.routeId) });
    if (!route) return returnFunction(res, 400, false, 'Route not found.');
    routeId = route._id;
    if (req.body.stopId) {
      const stop = (route.stops || []).find((s) => s.id === req.body.stopId);
      if (!stop) return returnFunction(res, 400, false, 'That stop does not belong to the selected route.');
      stopId = stop.id;
    }
  }

  const expectedDeliveryDate = req.body.expectedDeliveryDate ? new Date(req.body.expectedDeliveryDate) : null;
  // A shipment "expected" in the past isn't meaningful — same reasoning as blocking
  // past-dated interviews/offers earlier in this batch.
  if (expectedDeliveryDate) {
    const todayStart = new Date(new Date().toDateString());
    if (Number.isNaN(expectedDeliveryDate.getTime()) || expectedDeliveryDate < todayStart) {
      return returnFunction(res, 400, false, 'Expected delivery date cannot be in the past.');
    }
  }

  const doc = {
    sourceType, sourceId,
    status: 'pending',
    routeId, stopId,
    expectedDeliveryDate,
    actualDeliveryDate: null,
    exceptionReason: null, exceptionResolution: null, exceptionResolvedAt: null,
    department: req.body.department || null,
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('logistics_shipments', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateShipmentStatus = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized.');
  if (!TRANSITIONABLE.includes(req.body.status)) {
    return returnFunction(res, 400, false, `status must be one of: ${TRANSITIONABLE.join(', ')} (use the dedicated deliver/exception actions for those).`);
  }
  const result = await updateOne('logistics_shipments', { _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status, updatedAt: new Date() } });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// The one integration-critical function in this file — exported as a plain function (not
// just wrapped in the HTTP handler below) so Routes' updateStopStatus can call it
// directly when a driver marks a stop Delivered, the same "call the function, don't
// duplicate the logic" pattern as completeInventoryTransfer itself.
async function markShipmentDelivered(shipmentId, performedBy) {
  const shipment = await findOne('logistics_shipments', { _id: new ObjectId(shipmentId) });
  if (!shipment) throw new Error('Shipment not found.');
  if (shipment.status === 'delivered') return shipment;

  if (shipment.sourceType === 'inventory_transfer' && shipment.sourceId) {
    await completeInventoryTransfer(shipment.sourceId, performedBy);
  }

  await updateOne('logistics_shipments', { _id: shipment._id }, {
    $set: { status: 'delivered', actualDeliveryDate: new Date(), updatedAt: new Date() },
  });
  return shipment;
}

const markDelivered = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level || level === 'driver') return returnFunction(res, 403, false, 'Not authorized.');
  try {
    await markShipmentDelivered(req.params.id, req.user._id);
  } catch (err) {
    return returnFunction(res, 400, false, err.message);
  }
  return returnFunction(res, 200, true, 'Shipment marked delivered.');
};

const flagException = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const result = await updateOne('logistics_shipments', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'exception', exceptionReason: req.body.reason, updatedAt: new Date() },
  });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, 'Exception flagged.');
};

const resolveException = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const shipment = await findOne('logistics_shipments', { _id: new ObjectId(req.params.id) });
  if (!shipment) return returnFunction(res, 404, false, req.locale.notFound);
  if (shipment.status !== 'exception') return returnFunction(res, 400, false, 'This shipment has no open exception.');
  const backTo = req.body.resumeStatus && TRANSITIONABLE.includes(req.body.resumeStatus) ? req.body.resumeStatus : 'in_transit';
  await updateOne('logistics_shipments', { _id: shipment._id }, {
    $set: { status: backTo, exceptionResolution: req.body.resolution || null, exceptionResolvedAt: new Date(), updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Exception resolved.');
};

// Not a full ML model, per spec — a reasonable estimate from the route's historical
// average delivery time, falling back to the shipment's own expectedDeliveryDate.
const getPredictedETA = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const shipment = await findOne('logistics_shipments', { _id: new ObjectId(req.params.id) });
  if (!shipment) return returnFunction(res, 404, false, req.locale.notFound);

  if (!shipment.routeId) return returnFunction(res, 200, true, req.locale.success, { predictedETA: shipment.expectedDeliveryDate });

  const route = await findOne('logistics_routes', { _id: shipment.routeId });
  const pastDelivered = await findMany('logistics_shipments', {
    routeId: shipment.routeId, status: 'delivered', actualDeliveryDate: { $ne: null }, expectedDeliveryDate: { $ne: null },
  }, {});
  if (!pastDelivered.length || !shipment.expectedDeliveryDate) {
    return returnFunction(res, 200, true, req.locale.success, { predictedETA: shipment.expectedDeliveryDate });
  }
  const avgDelayMs = pastDelivered.reduce((s, p) => s + (new Date(p.actualDeliveryDate) - new Date(p.expectedDeliveryDate)), 0) / pastDelivered.length;
  const predictedETA = new Date(new Date(shipment.expectedDeliveryDate).getTime() + avgDelayMs);
  return returnFunction(res, 200, true, req.locale.success, { predictedETA, basedOnDeliveries: pastDelivered.length, route: route?._id || null });
};

const getDeliveryPerformanceReport = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const match = {};
  if (req.query.startDate || req.query.endDate) {
    match.createdAt = {};
    if (req.query.startDate) match.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate) match.createdAt.$lte = new Date(req.query.endDate);
  }
  const shipments = await findMany('logistics_shipments', match, {});
  const delivered = shipments.filter((s) => s.status === 'delivered');
  const exceptions = shipments.filter((s) => s.status === 'exception' || s.exceptionReason);
  const onTime = delivered.filter((s) => s.expectedDeliveryDate && s.actualDeliveryDate && new Date(s.actualDeliveryDate) <= new Date(s.expectedDeliveryDate));
  const delays = delivered
    .filter((s) => s.expectedDeliveryDate && s.actualDeliveryDate)
    .map((s) => (new Date(s.actualDeliveryDate) - new Date(s.expectedDeliveryDate)) / 3600000);
  const avgDelayHours = delays.length ? Math.round((delays.reduce((a, b) => a + b, 0) / delays.length) * 10) / 10 : 0;

  return returnFunction(res, 200, true, req.locale.success, {
    totalShipments: shipments.length,
    delivered: delivered.length,
    onTimeCount: onTime.length,
    onTimeRate: delivered.length ? Math.round((onTime.length / delivered.length) * 1000) / 10 : 0,
    exceptionCount: exceptions.length,
    exceptionRate: shipments.length ? Math.round((exceptions.length / shipments.length) * 1000) / 10 : 0,
    avgDelayHours,
  });
};

const exportDeliveryPerformanceCSV = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const shipments = await findMany('logistics_shipments', {}, { sort: { createdAt: -1 } });
  const header = 'Shipment,Source Type,Status,Expected Delivery,Actual Delivery,Exception Reason';
  const rows = shipments.map((s) => [
    String(s._id), s.sourceType, s.status,
    s.expectedDeliveryDate ? new Date(s.expectedDeliveryDate).toISOString().split('T')[0] : '',
    s.actualDeliveryDate ? new Date(s.actualDeliveryDate).toISOString().split('T')[0] : '',
    s.exceptionReason || '',
  ].map(csvEscape).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="delivery-performance.csv"');
  return res.send([header, ...rows].join('\n'));
};

module.exports = {
  listShipments, getShipment, createShipment, updateShipmentStatus,
  markShipmentDelivered, markDelivered, flagException, resolveException,
  getPredictedETA, getDeliveryPerformanceReport, exportDeliveryPerformanceCSV,
};
