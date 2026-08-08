// Postgres migration (Phase 6) — inventory_items/inventory_stock_levels/
// inventory_stock_movements/inventory_locations are all Postgres now. Accounting
// (gl_accounts/gl_journal_entries) is still Mongo — Phase 7, not touched here — so
// glEngine's postJournalEntry/resolveSystemAccount calls are left exactly as they were;
// they never assumed anything about inventory's storage engine to begin with
// (referenceId is stored as an opaque string, never ObjectId-cast).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
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

  const item = await knex('inventory_items').where({ id: itemId }).first();
  if (!item) throw new Error('Item not found.');
  if (!item.isTracked) throw new Error('This item does not track stock quantity.');

  const existingLevel = await knex('inventory_stock_levels').where({ itemId, locationId }).first();
  const priorQty = existingLevel?.quantity || 0;
  const balanceAfter = priorQty + quantityChange;
  if (balanceAfter < 0) throw new Error('This movement would take stock below zero at this location.');

  const now = new Date();
  const movementDoc = {
    id: newId(),
    itemId, locationId, quantityChange, movementType,
    referenceId, referenceModel,
    unitCost: unitCost !== null ? Number(unitCost) : null,
    lotId,
    balanceAfter,
    performedBy,
    notes,
    createdAt: now,
  };
  const [saved] = await knex('inventory_stock_movements').insert(movementDoc).returning('*');

  await knex('inventory_stock_levels')
    .insert({ id: newId(), itemId, locationId, quantity: quantityChange, reorderPoint: 0, updatedAt: now })
    .onConflict(['itemId', 'locationId'])
    .merge({ quantity: knex.raw('"inventory_stock_levels"."quantity" + ?', [quantityChange]), updatedAt: now });

  // Weighted-average revaluation — inbound movements with a known unit cost only.
  // Averaged across total stock company-wide (not per-location), matching the
  // "Weighted Average as the default, structured for FIFO later" choice in the spec —
  // costingMethod stays on the item doc so a future FIFO item type is a additive change,
  // not a rewrite of this function.
  if (quantityChange > 0 && unitCost !== null && item.costingMethod === 'weighted_average') {
    const allLevels = await knex('inventory_stock_levels').where({ itemId });
    const totalQtyBefore = allLevels.reduce((sum, l) => sum + (l.quantity || 0), 0) - quantityChange; // pre-movement total
    const oldAvgCost = item.avgCost || 0;
    const newTotalQty = totalQtyBefore + quantityChange;
    const newAvgCost = newTotalQty > 0
      ? ((totalQtyBefore * oldAvgCost) + (quantityChange * Number(unitCost))) / newTotalQty
      : Number(unitCost);
    await knex('inventory_items').where({ id: itemId }).update({ avgCost: Math.round(newAvgCost * 10000) / 10000, updatedAt: now });
  }

  return saved;
}

const listMovements = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopeFilter = await getScopedLocationFilter(req.user, level);

  const { page, limit, skip } = getPagination(req.query);
  let query = knex('inventory_stock_movements');
  if (req.query.itemId) query = query.where({ itemId: req.query.itemId });
  if (req.query.movementType) query = query.where({ movementType: req.query.movementType });
  if (req.query.startDate) query = query.where('createdAt', '>=', new Date(req.query.startDate));
  if (req.query.endDate) query = query.where('createdAt', '<=', new Date(req.query.endDate));
  if (req.query.locationId) {
    query = query.where({ locationId: req.query.locationId });
  } else if (scopeFilter) {
    const scopedLocations = await knex('inventory_locations').where(scopeFilter).select('id');
    query = query.whereIn('locationId', scopedLocations.map((l) => l.id));
  }

  const [{ count }] = await query.clone().count('* as count');
  const movements = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const itemIds = [...new Set(movements.map((m) => m.itemId))];
  const locIds = [...new Set(movements.map((m) => m.locationId))];
  const userIds = [...new Set(movements.filter((m) => m.performedBy).map((m) => m.performedBy))];
  const [items, locations, users] = await Promise.all([
    knex('inventory_items').whereIn('id', itemIds).select('id', 'sku', 'name', 'unitOfMeasure'),
    knex('inventory_locations').whereIn('id', locIds).select('id', 'name'),
    userIds.length ? knex('users').whereIn('id', userIds).select('id', 'name') : [],
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));
  const locMap = Object.fromEntries(locations.map((l) => [l.id, l]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const enriched = movements.map((m) => ({
    ...m,
    item: itemMap[m.itemId] || null,
    location: locMap[m.locationId] || null,
    performedByName: m.performedBy ? (userMap[m.performedBy]?.name || 'Unknown') : 'System',
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportMovementsCSV = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopeFilter = await getScopedLocationFilter(req.user, level);

  let query = knex('inventory_stock_movements');
  if (req.query.itemId) query = query.where({ itemId: req.query.itemId });
  if (req.query.movementType) query = query.where({ movementType: req.query.movementType });
  if (req.query.startDate) query = query.where('createdAt', '>=', new Date(req.query.startDate));
  if (req.query.endDate) query = query.where('createdAt', '<=', new Date(req.query.endDate));
  if (scopeFilter) {
    const scopedLocations = await knex('inventory_locations').where(scopeFilter).select('id');
    query = query.whereIn('locationId', scopedLocations.map((l) => l.id));
  }

  const movements = await query.orderBy('createdAt', 'desc');
  const itemIds = [...new Set(movements.map((m) => m.itemId))];
  const locIds = [...new Set(movements.map((m) => m.locationId))];
  const [items, locations] = await Promise.all([
    knex('inventory_items').whereIn('id', itemIds).select('id', 'sku', 'name'),
    knex('inventory_locations').whereIn('id', locIds).select('id', 'name'),
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));
  const locMap = Object.fromEntries(locations.map((l) => [l.id, l]));

  const header = 'Date,SKU,Item,Location,MovementType,QuantityChange,BalanceAfter,UnitCost,Reference,Notes';
  const rows = movements.map((m) => [
    m.createdAt.toISOString(),
    itemMap[m.itemId]?.sku || '',
    itemMap[m.itemId]?.name || '',
    locMap[m.locationId]?.name || '',
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
      itemId, locationId,
      quantityChange: Number(quantityChange), movementType: 'adjustment',
      performedBy: req.user.id, notes: notes || null,
    });

    // Only a negative adjustment is a real loss (shrinkage/damage) — a positive one is a
    // found-stock correction, not an expense. createAdjustment never captures a unitCost
    // at write time (per design decision), so this values the loss at the item's CURRENT
    // avgCost rather than inventing a historical figure the schema doesn't have.
    if (Number(quantityChange) < 0) {
      const item = await knex('inventory_items').where({ id: itemId }).first();
      const shrinkageValue = round2(Math.abs(Number(quantityChange)) * (item?.avgCost || 0));
      if (shrinkageValue > 0) {
        const location = await knex('inventory_locations').where({ id: locationId }).select('department').first();
        const payload = {
          date: new Date(), description: `Stock adjustment — ${item?.name || itemId}${notes ? `: ${notes}` : ''}`,
          source: 'inventory_adjustment', sourceModule: 'inventory', referenceId: movement?.id || null,
          referenceModel: 'inventory_stock_movements', department: location?.department || null, lines: [],
        };
        try {
          const shrinkAcct = await resolveSystemAccount('inventory_shrinkage');
          const invAcct = await resolveSystemAccount('inventory_asset');
          payload.lines = [{ accountId: shrinkAcct._id, debit: shrinkageValue }, { accountId: invAcct._id, credit: shrinkageValue }];
          await postJournalEntry({ ...payload, postedBy: req.user._id });
        } catch (err) {
          await logPostingFailure({ source: 'inventory_adjustment', sourceModule: 'inventory', referenceId: movement?.id || null, referenceModel: 'inventory_stock_movements', attemptedPayload: payload, error: err });
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

  const totals = await knex('inventory_stock_movements')
    .select('itemId', 'locationId')
    .sum('quantityChange as quantity')
    .groupBy('itemId', 'locationId');

  const now = new Date();
  let updated = 0;
  for (const t of totals) {
    await knex('inventory_stock_levels')
      .insert({ id: newId(), itemId: t.itemId, locationId: t.locationId, quantity: t.quantity, reorderPoint: 0, updatedAt: now })
      .onConflict(['itemId', 'locationId'])
      .merge({ quantity: t.quantity, updatedAt: now });
    updated++;
  }
  return returnFunction(res, 200, true, `Recomputed ${updated} stock level record(s) from the movement ledger.`);
};

module.exports = {
  createStockMovement, listMovements, exportMovementsCSV, createAdjustment, recomputeStockLevelsFromLedger,
};
