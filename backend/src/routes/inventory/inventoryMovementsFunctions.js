const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments, aggregate } = require('../../functions/Database/commonDBFunctions');
const { getInventoryAccessLevel, getScopedLocationFilter } = require('../../lib/inventory/inventoryAccess');
const { postJournalEntry, resolveSystemAccount } = require('../../lib/accounting/glEngine');
const { logPostingFailure } = require('../accounting/accountingPostingFailuresFunctions');

const round2 = (n) => Math.round(n * 100) / 100;

const MOVEMENT_TYPES = ['receipt', 'sale', 'adjustment', 'transfer_out', 'transfer_in', 'return', 'logistics_maintenance'];

// The single write path for every stock change in the module — PO receiving, transfer
// receipt, manual adjustments, and the future POS `deductStockForSale` hook all funnel
// through this. Nothing else is allowed to touch inventory_stock_levels.quantity
// directly; the movement record inserted here is the permanent, immutable audit trail,
// and the stock_levels doc is purely a materialized cache of "sum of all movements so
// far" kept in lockstep with it (see recomputeStockLevelsFromLedger for the rebuild-
// from-ledger safety net if the two ever need reconciling).
async function createStockMovement({
  itemId, locationId, quantityChange, movementType, referenceId = null, referenceModel = null,
  unitCost = null, lotId = null, performedBy, notes = null,
}) {
  if (!MOVEMENT_TYPES.includes(movementType)) throw new Error(`Invalid movementType: ${movementType}`);
  if (!quantityChange || typeof quantityChange !== 'number') throw new Error('quantityChange must be a non-zero number.');

  const item = await findOne('inventory_items', { _id: itemId });
  if (!item) throw new Error('Item not found.');
  if (!item.isTracked) throw new Error('This item does not track stock quantity.');

  const existingLevel = await findOne('inventory_stock_levels', { itemId, locationId });
  const priorQty = existingLevel?.quantity || 0;
  const balanceAfter = priorQty + quantityChange;
  if (balanceAfter < 0) throw new Error('This movement would take stock below zero at this location.');

  const now = new Date();
  const movementDoc = {
    itemId, locationId, quantityChange, movementType,
    referenceId, referenceModel,
    unitCost: unitCost !== null ? Number(unitCost) : null,
    lotId,
    balanceAfter,
    performedBy,
    notes,
    createdAt: now,
  };
  const result = await insertOne('inventory_stock_movements', movementDoc);

  await updateOne(
    'inventory_stock_levels',
    { itemId, locationId },
    { $inc: { quantity: quantityChange }, $set: { updatedAt: now }, $setOnInsert: { reorderPoint: 0 } },
    { upsert: true }
  );

  // Weighted-average revaluation — inbound movements with a known unit cost only.
  // Averaged across total stock company-wide (not per-location), matching the
  // "Weighted Average as the default, structured for FIFO later" choice in the spec —
  // costingMethod stays on the item doc so a future FIFO item type is a additive change,
  // not a rewrite of this function.
  if (quantityChange > 0 && unitCost !== null && item.costingMethod === 'weighted_average') {
    const allLevels = await findMany('inventory_stock_levels', { itemId }, {});
    const totalQtyBefore = allLevels.reduce((sum, l) => sum + (l.quantity || 0), 0) - quantityChange; // pre-movement total
    const oldAvgCost = item.avgCost || 0;
    const newTotalQty = totalQtyBefore + quantityChange;
    const newAvgCost = newTotalQty > 0
      ? ((totalQtyBefore * oldAvgCost) + (quantityChange * Number(unitCost))) / newTotalQty
      : Number(unitCost);
    await updateOne('inventory_items', { _id: itemId }, { $set: { avgCost: Math.round(newAvgCost * 10000) / 10000, updatedAt: now } });
  }

  return { _id: result.insertedId, ...movementDoc };
}

const listMovements = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopeFilter = await getScopedLocationFilter(req.user, level);

  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.itemId) filter.itemId = new ObjectId(req.query.itemId);
  if (req.query.movementType) filter.movementType = req.query.movementType;
  if (req.query.startDate || req.query.endDate) {
    filter.createdAt = {};
    if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
  }
  if (req.query.locationId) {
    filter.locationId = new ObjectId(req.query.locationId);
  } else if (scopeFilter) {
    const scopedLocations = await findMany('inventory_locations', scopeFilter, { projection: { _id: 1 } });
    filter.locationId = { $in: scopedLocations.map((l) => l._id) };
  }

  const [total, movements] = await Promise.all([
    countDocuments('inventory_stock_movements', filter),
    findMany('inventory_stock_movements', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const itemIds = [...new Set(movements.map((m) => String(m.itemId)))].map((id) => new ObjectId(id));
  const locIds = [...new Set(movements.map((m) => String(m.locationId)))].map((id) => new ObjectId(id));
  const userIds = [...new Set(movements.filter((m) => m.performedBy).map((m) => String(m.performedBy)))].map((id) => new ObjectId(id));
  const [items, locations, users] = await Promise.all([
    findMany('inventory_items', { _id: { $in: itemIds } }, { projection: { sku: 1, name: 1, unitOfMeasure: 1 } }),
    findMany('inventory_locations', { _id: { $in: locIds } }, { projection: { name: 1 } }),
    userIds.length ? findMany('users', { _id: { $in: userIds } }, { projection: { name: 1 } }) : [],
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));
  const locMap = Object.fromEntries(locations.map((l) => [String(l._id), l]));
  const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));

  const enriched = movements.map((m) => ({
    ...m,
    item: itemMap[String(m.itemId)] || null,
    location: locMap[String(m.locationId)] || null,
    performedByName: m.performedBy ? (userMap[String(m.performedBy)]?.name || 'Unknown') : 'System',
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportMovementsCSV = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopeFilter = await getScopedLocationFilter(req.user, level);

  const filter = {};
  if (req.query.itemId) filter.itemId = new ObjectId(req.query.itemId);
  if (req.query.movementType) filter.movementType = req.query.movementType;
  if (req.query.startDate || req.query.endDate) {
    filter.createdAt = {};
    if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
  }
  if (scopeFilter) {
    const scopedLocations = await findMany('inventory_locations', scopeFilter, { projection: { _id: 1 } });
    filter.locationId = { $in: scopedLocations.map((l) => l._id) };
  }

  const movements = await findMany('inventory_stock_movements', filter, { sort: { createdAt: -1 } });
  const itemIds = [...new Set(movements.map((m) => String(m.itemId)))].map((id) => new ObjectId(id));
  const locIds = [...new Set(movements.map((m) => String(m.locationId)))].map((id) => new ObjectId(id));
  const [items, locations] = await Promise.all([
    findMany('inventory_items', { _id: { $in: itemIds } }, { projection: { sku: 1, name: 1 } }),
    findMany('inventory_locations', { _id: { $in: locIds } }, { projection: { name: 1 } }),
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));
  const locMap = Object.fromEntries(locations.map((l) => [String(l._id), l]));

  const header = 'Date,SKU,Item,Location,MovementType,QuantityChange,BalanceAfter,UnitCost,Reference,Notes';
  const rows = movements.map((m) => [
    m.createdAt.toISOString(),
    itemMap[String(m.itemId)]?.sku || '',
    itemMap[String(m.itemId)]?.name || '',
    locMap[String(m.locationId)]?.name || '',
    m.movementType,
    m.quantityChange,
    m.balanceAfter,
    m.unitCost ?? '',
    m.referenceModel ? `${m.referenceModel}:${m.referenceId}` : '',
    m.notes || '',
  ].map(csvEscape).join(','));
  const csv = [header, ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="inventory-movements.csv"');
  return res.send(csv);
};

// Manual stock adjustment (stocktake correction, damage/loss write-off, etc.) — the
// one route where a human directly specifies quantityChange rather than it being
// derived from a PO/transfer/sale.
const createAdjustment = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin' && level !== 'clerk') return returnFunction(res, 403, false, 'Not authorized to adjust stock.');
  const { itemId, locationId, quantityChange, notes } = req.body;
  if (!itemId || !locationId || quantityChange === undefined) {
    return returnFunction(res, 400, false, 'itemId, locationId, and quantityChange are required.');
  }
  try {
    const movement = await createStockMovement({
      itemId: new ObjectId(itemId), locationId: new ObjectId(locationId),
      quantityChange: Number(quantityChange), movementType: 'adjustment',
      performedBy: req.user._id, notes: notes || null,
    });

    // Only a negative adjustment is a real loss (shrinkage/damage) — a positive one is a
    // found-stock correction, not an expense. createAdjustment never captures a unitCost
    // at write time (per design decision), so this values the loss at the item's CURRENT
    // avgCost rather than inventing a historical figure the schema doesn't have.
    if (Number(quantityChange) < 0) {
      const item = await findOne('inventory_items', { _id: new ObjectId(itemId) });
      const shrinkageValue = round2(Math.abs(Number(quantityChange)) * (item?.avgCost || 0));
      if (shrinkageValue > 0) {
        const location = await findOne('inventory_locations', { _id: new ObjectId(locationId) }, { projection: { department: 1 } });
        const payload = {
          date: new Date(), description: `Stock adjustment — ${item?.name || itemId}${notes ? `: ${notes}` : ''}`,
          source: 'inventory_adjustment', sourceModule: 'inventory', referenceId: movement?._id || null,
          referenceModel: 'inventory_stock_movements', department: location?.department || null, lines: [],
        };
        try {
          const shrinkAcct = await resolveSystemAccount('inventory_shrinkage');
          const invAcct = await resolveSystemAccount('inventory_asset');
          payload.lines = [{ accountId: shrinkAcct._id, debit: shrinkageValue }, { accountId: invAcct._id, credit: shrinkageValue }];
          await postJournalEntry({ ...payload, postedBy: req.user._id });
        } catch (err) {
          await logPostingFailure({ source: 'inventory_adjustment', sourceModule: 'inventory', referenceId: movement?._id || null, referenceModel: 'inventory_stock_movements', attemptedPayload: payload, error: err });
        }
      }
    }

    return returnFunction(res, 201, true, req.locale.createdSuccessfully, movement);
  } catch (err) {
    return returnFunction(res, 400, false, err.message);
  }
};

// Safety-net reconciliation — rebuilds inventory_stock_levels.quantity purely from the
// movement ledger, for the (should-be-rare) case a cache and ledger drift apart.
// reorderPoint is preserved since it isn't derived from movements.
const recomputeStockLevelsFromLedger = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');

  const totals = await aggregate('inventory_stock_movements', [
    { $group: { _id: { itemId: '$itemId', locationId: '$locationId' }, quantity: { $sum: '$quantityChange' } } },
  ]);

  let updated = 0;
  for (const t of totals) {
    await updateOne(
      'inventory_stock_levels',
      { itemId: t._id.itemId, locationId: t._id.locationId },
      { $set: { quantity: t.quantity, updatedAt: new Date() }, $setOnInsert: { reorderPoint: 0 } },
      { upsert: true }
    );
    updated++;
  }
  return returnFunction(res, 200, true, `Recomputed ${updated} stock level record(s) from the movement ledger.`);
};

module.exports = {
  createStockMovement, listMovements, exportMovementsCSV, createAdjustment, recomputeStockLevelsFromLedger,
};
