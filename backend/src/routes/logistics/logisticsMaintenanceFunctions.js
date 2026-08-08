// Postgres migration (Phase 8) — logistics_work_orders/logistics_vehicles are Postgres
// now. Parts consumed on a work order are a REAL child table
// (logistics_work_order_parts), not JSONB — addPartUsed did a genuine Mongo $push, this
// migration's own rule for "real per-row append -> child table" (see the migration
// file's header comment). inventory_items/inventory_locations were already fixed in
// Phase 6 (kept as-is below).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
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
  let query = knex('logistics_work_orders');
  if (req.query.vehicleId) query = query.where({ vehicleId: req.query.vehicleId });
  if (req.query.status) query = query.where({ status: req.query.status });

  const [{ count }] = await query.clone().count('* as count');
  const orders = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(orders, Number(count), page, limit));
};

const getWorkOrder = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  const order = await knex('logistics_work_orders').where({ id: req.params.id }).first();
  if (!order) return returnFunction(res, 404, false, req.locale.notFound);
  const partsUsed = await knex('logistics_work_order_parts').where({ workOrderId: order.id });
  return returnFunction(res, 200, true, req.locale.success, { ...order, partsUsed });
};

const createWorkOrder = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['vehicleId', 'type', 'description'])) return;
  if (!TYPES.includes(req.body.type)) return returnFunction(res, 400, false, `type must be one of: ${TYPES.join(', ')}`);
  const vehicle = await knex('logistics_vehicles').where({ id: req.body.vehicleId }).first();
  if (!vehicle) return returnFunction(res, 400, false, 'Vehicle not found.');

  const doc = {
    id: newId(),
    vehicleId: vehicle.id,
    type: req.body.type,
    description: req.body.description.trim(),
    status: 'open',
    scheduledDate: req.body.scheduledDate ? new Date(req.body.scheduledDate) : null,
    completedDate: null,
    serviceBay: req.body.serviceBay || null,
    laborCost: 0,
    otherCost: 0,
    totalCost: 0,
    postedToAccounting: false,
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('logistics_work_orders').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { ...saved, partsUsed: [] });
};

// Records a part consumed by this work order — does not touch stock yet (that happens
// once at completeWorkOrder, same "commit at the point the real-world event finished"
// posture as everything else in this system) — just accumulates the line so the eventual
// parts cost is known ahead of completion.
const addPartUsed = async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  if (level !== 'admin' && level !== 'opsAdmin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['itemId', 'quantity'])) return;
  const order = await knex('logistics_work_orders').where({ id: req.params.id }).first();
  if (!order) return returnFunction(res, 404, false, req.locale.notFound);
  if (order.status === 'completed') return returnFunction(res, 400, false, 'This work order is already completed.');

  const item = await knex('inventory_items').where({ id: req.body.itemId }).first();
  if (!item) return returnFunction(res, 400, false, 'Inventory item not found.');
  if (!req.body.locationId) return returnFunction(res, 400, false, 'locationId is required to know which stock location the part comes from.');

  const [line] = await knex('logistics_work_order_parts').insert({
    workOrderId: order.id, itemId: item.id, itemName: item.name, sku: item.sku,
    locationId: String(req.body.locationId), quantity: Number(req.body.quantity), unitCost: item.avgCost || 0,
  }).returning('*');
  await knex('logistics_work_orders').where({ id: order.id }).update({ updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Part added to work order.', line);
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
  const order = await knex('logistics_work_orders').where({ id: req.params.id }).first();
  if (!order) return returnFunction(res, 404, false, req.locale.notFound);
  if (order.status === 'completed') return returnFunction(res, 400, false, 'This work order is already completed.');

  const partsUsed = await knex('logistics_work_order_parts').where({ workOrderId: order.id });
  const laborCost = req.body.laborCost !== undefined ? Number(req.body.laborCost) : (order.laborCost || 0);
  const otherCost = req.body.otherCost !== undefined ? Number(req.body.otherCost) : (order.otherCost || 0);
  const partsCost = round2(partsUsed.reduce((s, p) => s + p.quantity * p.unitCost, 0));
  const totalCost = round2(partsCost + laborCost + otherCost);

  for (const part of partsUsed) {
    const item = await knex('inventory_items').where({ id: part.itemId }).first();
    if (!item?.isTracked) continue;
    try {
      await createStockMovement({
        itemId: part.itemId, locationId: part.locationId, quantityChange: -Math.abs(part.quantity),
        movementType: 'logistics_maintenance', referenceId: order.id, referenceModel: 'logistics_work_orders',
        unitCost: part.unitCost, performedBy: req.user.id,
        notes: `Work order ${order.id} — ${order.description}`,
      });
    } catch (err) {
      return returnFunction(res, 400, false, `Could not deduct part "${part.itemName}": ${err.message}`);
    }
  }

  await knex('logistics_work_orders').where({ id: order.id }).update({
    status: 'completed', completedDate: new Date(), laborCost, otherCost, totalCost, updatedAt: new Date(),
  });
  await knex('logistics_vehicles').where({ id: order.vehicleId, status: 'maintenance' }).update({ status: 'active', updatedAt: new Date() });

  if (totalCost > 0) {
    const payload = {
      date: new Date(), description: `Vehicle maintenance — work order ${order.id} (${order.description})`,
      source: 'logistics_maintenance', sourceModule: 'logistics',
      referenceId: order.id, referenceModel: 'logistics_work_orders', lines: [],
    };
    try {
      const expenseAcct = await resolveSystemAccount('logistics_expense');
      const apAcct = await resolveSystemAccount('accounts_payable');
      payload.lines = [{ accountId: expenseAcct._id, debit: totalCost }, { accountId: apAcct._id, credit: totalCost }];
      await postJournalEntry({ ...payload, postedBy: req.user._id });
      await knex('logistics_work_orders').where({ id: order.id }).update({ postedToAccounting: true });
    } catch (err) {
      await logPostingFailure({ source: 'logistics_maintenance', sourceModule: 'logistics', referenceId: order.id, referenceModel: 'logistics_work_orders', attemptedPayload: payload, error: err });
    }
  }

  return returnFunction(res, 200, true, 'Work order completed.', { totalCost });
};

module.exports = { listWorkOrders, getWorkOrder, createWorkOrder, addPartUsed, completeWorkOrder };
