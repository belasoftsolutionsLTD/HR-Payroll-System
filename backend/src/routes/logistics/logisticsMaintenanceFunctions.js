const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
// inventory_items is Postgres now (Phase 6) — found while sweeping Logistics;
// logistics_work_orders/logistics_vehicles stay Mongo, Logistics' own phase (8). Parts
// recorded on a work order now carry plain string itemId/locationId (matching Postgres'
// ids) instead of Mongo ObjectIds, so they pass straight through to createStockMovement
// (also Postgres) at completeWorkOrder time.
const { knex } = require('../../functions/Database/pgDBFunctions');
const { getLogisticsAccessLevel } = require('../../lib/logistics/logisticsAccess');
const { createStockMovement } = require('../inventory/inventoryMovementsFunctions');
const { postJournalEntry, resolveSystemAccount } = require('../../lib/accounting/glEngine');
const { logPostingFailure } = require('../accounting/accountingPostingFailuresFunctions');

const round2 = (n) => Math.round(n * 100) / 100;
const TYPES = ['scheduled', 'unscheduled'];
const STATUSES = ['open', 'in_progress', 'completed'];

const listWorkOrders = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.vehicleId) filter.vehicleId = new ObjectId(req.query.vehicleId);
  if (req.query.status) filter.status = req.query.status;

  const [total, orders] = await Promise.all([
    countDocuments('logistics_work_orders', filter),
    findMany('logistics_work_orders', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(orders, total, page, limit));
};

const getWorkOrder = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const order = await findOne('logistics_work_orders', { _id: new ObjectId(req.params.id) });
  if (!order) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, order);
};

const createWorkOrder = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['vehicleId', 'type', 'description'])) return;
  if (!TYPES.includes(req.body.type)) return returnFunction(res, 400, false, `type must be one of: ${TYPES.join(', ')}`);
  const vehicle = await findOne('logistics_vehicles', { _id: new ObjectId(req.body.vehicleId) });
  if (!vehicle) return returnFunction(res, 400, false, 'Vehicle not found.');

  const doc = {
    vehicleId: vehicle._id,
    type: req.body.type,
    description: req.body.description.trim(),
    status: 'open',
    scheduledDate: req.body.scheduledDate ? new Date(req.body.scheduledDate) : null,
    completedDate: null,
    serviceBay: req.body.serviceBay || null,
    partsUsed: [],
    laborCost: 0,
    otherCost: 0,
    totalCost: 0,
    postedToAccounting: false,
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('logistics_work_orders', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

// Records a part consumed by this work order — does not touch stock yet (that happens
// once at completeWorkOrder, same "commit at the point the real-world event finished"
// posture as everything else in this system) — just accumulates the line so the eventual
// parts cost is known ahead of completion.
const addPartUsed = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['itemId', 'quantity'])) return;
  const order = await findOne('logistics_work_orders', { _id: new ObjectId(req.params.id) });
  if (!order) return returnFunction(res, 404, false, req.locale.notFound);
  if (order.status === 'completed') return returnFunction(res, 400, false, 'This work order is already completed.');

  const item = await knex('inventory_items').where({ id: req.body.itemId }).first();
  if (!item) return returnFunction(res, 400, false, 'Inventory item not found.');
  if (!req.body.locationId) return returnFunction(res, 400, false, 'locationId is required to know which stock location the part comes from.');

  const line = {
    itemId: item.id, itemName: item.name, sku: item.sku,
    locationId: String(req.body.locationId),
    quantity: Number(req.body.quantity),
    unitCost: item.avgCost || 0,
  };
  await updateOne('logistics_work_orders', { _id: order._id }, { $push: { partsUsed: line }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Part added to work order.');
};

// The one place this work order's cost becomes real: parts are deducted from Inventory
// stock (same createStockMovement primitive Inventory's own adjustments use, not a
// parallel parts-inventory system per the spec), and the total cost (parts + labor +
// other) posts as a Logistics Expense liability in Accounting — same non-blocking
// try/catch + gl_posting_failures pattern as every other module's automatic posting.
// Vehicle flips back to 'active' if it was 'maintenance', a small convenience for the
// utilization dashboard, not a hard requirement.
const completeWorkOrder = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const order = await findOne('logistics_work_orders', { _id: new ObjectId(req.params.id) });
  if (!order) return returnFunction(res, 404, false, req.locale.notFound);
  if (order.status === 'completed') return returnFunction(res, 400, false, 'This work order is already completed.');

  const laborCost = req.body.laborCost !== undefined ? Number(req.body.laborCost) : (order.laborCost || 0);
  const otherCost = req.body.otherCost !== undefined ? Number(req.body.otherCost) : (order.otherCost || 0);
  const partsCost = round2(order.partsUsed.reduce((s, p) => s + p.quantity * p.unitCost, 0));
  const totalCost = round2(partsCost + laborCost + otherCost);

  for (const part of order.partsUsed) {
    const item = await knex('inventory_items').where({ id: part.itemId }).first();
    if (!item?.isTracked) continue;
    try {
      await createStockMovement({
        itemId: part.itemId, locationId: part.locationId, quantityChange: -Math.abs(part.quantity),
        movementType: 'logistics_maintenance', referenceId: order._id, referenceModel: 'logistics_work_orders',
        unitCost: part.unitCost, performedBy: req.user._id,
        notes: `Work order ${order._id} — ${order.description}`,
      });
    } catch (err) {
      return returnFunction(res, 400, false, `Could not deduct part "${part.itemName}": ${err.message}`);
    }
  }

  await updateOne('logistics_work_orders', { _id: order._id }, {
    $set: {
      status: 'completed', completedDate: new Date(), laborCost, otherCost, totalCost,
      updatedAt: new Date(),
    },
  });
  await updateOne('logistics_vehicles', { _id: order.vehicleId, status: 'maintenance' }, { $set: { status: 'active', updatedAt: new Date() } });

  if (totalCost > 0) {
    const payload = {
      date: new Date(), description: `Vehicle maintenance — work order ${order._id} (${order.description})`,
      source: 'logistics_maintenance', sourceModule: 'logistics',
      referenceId: order._id, referenceModel: 'logistics_work_orders', lines: [],
    };
    try {
      const expenseAcct = await resolveSystemAccount('logistics_expense');
      const apAcct = await resolveSystemAccount('accounts_payable');
      payload.lines = [{ accountId: expenseAcct._id, debit: totalCost }, { accountId: apAcct._id, credit: totalCost }];
      await postJournalEntry({ ...payload, postedBy: req.user._id });
      await updateOne('logistics_work_orders', { _id: order._id }, { $set: { postedToAccounting: true } });
    } catch (err) {
      await logPostingFailure({ source: 'logistics_maintenance', sourceModule: 'logistics', referenceId: order._id, referenceModel: 'logistics_work_orders', attemptedPayload: payload, error: err });
    }
  }

  return returnFunction(res, 200, true, 'Work order completed.', { totalCost });
};

module.exports = { listWorkOrders, getWorkOrder, createWorkOrder, addPartUsed, completeWorkOrder };
