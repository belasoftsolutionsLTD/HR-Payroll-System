// Postgres migration (Phase 8) — logistics_shipments/logistics_routes/
// logistics_route_stops are Postgres now. inventory_transfers/pos_sales were already
// fixed in Phase 6 (kept as-is below).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
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
  let query = knex('logistics_shipments');
  if (req.query.status) query = query.where({ status: req.query.status });
  if (level === 'driver') {
    const routes = await knex('logistics_routes').where({ driverId: String(req.user.employeeId) }).select('id');
    query = query.whereIn('routeId', routes.map((r) => r.id));
  } else {
    const deptFilter = getLogisticsDepartmentFilter(req.user, level);
    if (deptFilter) query = query.where(deptFilter);
  }

  const [{ count }] = await query.clone().count('* as count');
  const shipments = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(shipments, Number(count), page, limit));
};

const getShipment = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const shipment = await knex('logistics_shipments').where({ id: req.params.id }).first();
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
    const route = await knex('logistics_routes').where({ id: req.body.routeId }).first();
    if (!route) return returnFunction(res, 400, false, 'Route not found.');
    routeId = route.id;
    if (req.body.stopId) {
      const stop = await knex('logistics_route_stops').where({ id: req.body.stopId, routeId: route.id }).first();
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
    id: newId(),
    sourceType, sourceId,
    status: 'pending',
    routeId, stopId,
    expectedDeliveryDate,
    actualDeliveryDate: null,
    exceptionReason: null, exceptionResolution: null, exceptionResolvedAt: null,
    department: req.body.department || null,
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('logistics_shipments').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateShipmentStatus = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized.');
  if (!TRANSITIONABLE.includes(req.body.status)) {
    return returnFunction(res, 400, false, `status must be one of: ${TRANSITIONABLE.join(', ')} (use the dedicated deliver/exception actions for those).`);
  }
  const updated = await knex('logistics_shipments').where({ id: req.params.id }).update({ status: req.body.status, updatedAt: new Date() });
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// The one integration-critical function in this file — exported as a plain function (not
// just wrapped in the HTTP handler below) so Routes' updateStopStatus can call it
// directly when a driver marks a stop Delivered, the same "call the function, don't
// duplicate the logic" pattern as completeInventoryTransfer itself.
async function markShipmentDelivered(shipmentId, performedBy) {
  const shipment = await knex('logistics_shipments').where({ id: shipmentId }).first();
  if (!shipment) throw new Error('Shipment not found.');
  if (shipment.status === 'delivered') return shipment;

  if (shipment.sourceType === 'inventory_transfer' && shipment.sourceId) {
    await completeInventoryTransfer(shipment.sourceId, performedBy);
  }

  const [updated] = await knex('logistics_shipments').where({ id: shipment.id }).update({
    status: 'delivered', actualDeliveryDate: new Date(), updatedAt: new Date(),
  }).returning('*');
  return updated;
}

const markDelivered = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level || level === 'driver') return returnFunction(res, 403, false, 'Not authorized.');
  try {
    await markShipmentDelivered(req.params.id, req.user.id);
  } catch (err) {
    return returnFunction(res, 400, false, err.message);
  }
  return returnFunction(res, 200, true, 'Shipment marked delivered.');
};

const flagException = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const updated = await knex('logistics_shipments').where({ id: req.params.id }).update({
    status: 'exception', exceptionReason: req.body.reason, updatedAt: new Date(),
  });
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, 'Exception flagged.');
};

const resolveException = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const shipment = await knex('logistics_shipments').where({ id: req.params.id }).first();
  if (!shipment) return returnFunction(res, 404, false, req.locale.notFound);
  if (shipment.status !== 'exception') return returnFunction(res, 400, false, 'This shipment has no open exception.');
  const backTo = req.body.resumeStatus && TRANSITIONABLE.includes(req.body.resumeStatus) ? req.body.resumeStatus : 'in_transit';
  await knex('logistics_shipments').where({ id: shipment.id }).update({
    status: backTo, exceptionResolution: req.body.resolution || null, exceptionResolvedAt: new Date(), updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Exception resolved.');
};

// Not a full ML model, per spec — a reasonable estimate from the route's historical
// average delivery time, falling back to the shipment's own expectedDeliveryDate.
const getPredictedETA = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const shipment = await knex('logistics_shipments').where({ id: req.params.id }).first();
  if (!shipment) return returnFunction(res, 404, false, req.locale.notFound);

  if (!shipment.routeId) return returnFunction(res, 200, true, req.locale.success, { predictedETA: shipment.expectedDeliveryDate });

  const pastDelivered = await knex('logistics_shipments').where({ routeId: shipment.routeId, status: 'delivered' })
    .whereNotNull('actualDeliveryDate').whereNotNull('expectedDeliveryDate');
  if (!pastDelivered.length || !shipment.expectedDeliveryDate) {
    return returnFunction(res, 200, true, req.locale.success, { predictedETA: shipment.expectedDeliveryDate });
  }
  const avgDelayMs = pastDelivered.reduce((s, p) => s + (new Date(p.actualDeliveryDate) - new Date(p.expectedDeliveryDate)), 0) / pastDelivered.length;
  const predictedETA = new Date(new Date(shipment.expectedDeliveryDate).getTime() + avgDelayMs);
  return returnFunction(res, 200, true, req.locale.success, { predictedETA, basedOnDeliveries: pastDelivered.length, route: shipment.routeId });
};

const getDeliveryPerformanceReport = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  let query = knex('logistics_shipments');
  if (req.query.startDate) query = query.where('createdAt', '>=', new Date(req.query.startDate));
  if (req.query.endDate) query = query.where('createdAt', '<=', new Date(req.query.endDate));
  const shipments = await query;
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
  const shipments = await knex('logistics_shipments').orderBy('createdAt', 'desc');
  const header = 'Shipment,Source Type,Status,Expected Delivery,Actual Delivery,Exception Reason';
  const rows = shipments.map((s) => [
    s.id, s.sourceType, s.status,
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
