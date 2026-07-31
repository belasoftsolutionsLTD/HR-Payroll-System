const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany } = require('../../functions/Database/commonDBFunctions');
const { getInventoryAccessLevel, getScopedLocationFilter } = require('../../lib/inventory/inventoryAccess');

// Valuation (current stock × weighted-average cost) — admin-only per the module's role
// table, since it's the one report that exposes cost/margin-sensitive figures.
// Valuation is a point-in-time snapshot read off inventory_stock_levels — there's no
// movement-history replay in this schema, so a date-range filter isn't offered here
// (only location/category, which the current snapshot does support). The frontend
// disables the date picker when this report is selected rather than faking support.
const getValuationReport = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Valuation reports are restricted to inventory admins.');

  const stockFilter = { quantity: { $gt: 0 } };
  if (req.query.locationId) stockFilter.locationId = new ObjectId(req.query.locationId);
  const stockLevels = await findMany('inventory_stock_levels', stockFilter, {});
  if (!stockLevels.length) return returnFunction(res, 200, true, req.locale.success, { total: 0, byLocation: [], byItem: [] });

  const itemIds = [...new Set(stockLevels.map((s) => String(s.itemId)))].map((id) => new ObjectId(id));
  const locIds = [...new Set(stockLevels.map((s) => String(s.locationId)))].map((id) => new ObjectId(id));
  const [items, locations] = await Promise.all([
    findMany('inventory_items', { _id: { $in: itemIds } }, { projection: { sku: 1, name: 1, avgCost: 1, category: 1 } }),
    findMany('inventory_locations', { _id: { $in: locIds } }, { projection: { name: 1 } }),
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));
  const locMap = Object.fromEntries(locations.map((l) => [String(l._id), l]));

  let total = 0;
  const byLocationMap = {};
  const byItemMap = {};

  for (const s of stockLevels) {
    const item = itemMap[String(s.itemId)];
    if (!item) continue;
    if (req.query.category && item.category !== req.query.category) continue;
    const value = (s.quantity || 0) * (item.avgCost || 0);
    total += value;

    const locKey = String(s.locationId);
    byLocationMap[locKey] ??= { locationId: s.locationId, location: locMap[locKey] || null, quantity: 0, value: 0 };
    byLocationMap[locKey].quantity += s.quantity || 0;
    byLocationMap[locKey].value += value;

    const itemKey = String(s.itemId);
    byItemMap[itemKey] ??= { itemId: s.itemId, item, quantity: 0, value: 0 };
    byItemMap[itemKey].quantity += s.quantity || 0;
    byItemMap[itemKey].value += value;
  }

  return returnFunction(res, 200, true, req.locale.success, {
    total: Math.round(total * 100) / 100,
    byLocation: Object.values(byLocationMap).map((r) => ({ ...r, value: Math.round(r.value * 100) / 100 })),
    byItem: Object.values(byItemMap).map((r) => ({ ...r, value: Math.round(r.value * 100) / 100 })).sort((a, b) => b.value - a.value),
  });
};

// Current stock rolled up by category — quantities only, no cost, so this is safe for
// the 'manager'/'clerk' access levels too (scoped to their locations where applicable).
const getStockByCategoryReport = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopeFilter = await getScopedLocationFilter(req.user, level);

  let locationIds = null;
  if (scopeFilter) {
    const scopedLocations = await findMany('inventory_locations', scopeFilter, { projection: { _id: 1 } });
    locationIds = scopedLocations.map((l) => l._id);
  }

  // No date-range filter here (or on valuation/low-stock) — inventory_stock_levels is a
  // running current-state snapshot, not an event log, so "as of a past date" would need
  // to replay inventory_stock_movements, which is real scope beyond what was asked.
  const filter = {};
  if (req.query.locationId) filter.locationId = new ObjectId(req.query.locationId);
  else if (locationIds) filter.locationId = { $in: locationIds };
  const stockLevels = await findMany('inventory_stock_levels', filter, {});
  if (!stockLevels.length) return returnFunction(res, 200, true, req.locale.success, []);

  const itemIds = [...new Set(stockLevels.map((s) => String(s.itemId)))].map((id) => new ObjectId(id));
  const items = await findMany('inventory_items', { _id: { $in: itemIds } }, { projection: { category: 1, unitOfMeasure: 1 } });
  const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));

  const byCategory = {};
  for (const s of stockLevels) {
    const item = itemMap[String(s.itemId)];
    if (!item) continue;
    const cat = item.category || 'Uncategorized';
    if (req.query.category && cat !== req.query.category) continue;
    byCategory[cat] ??= { category: cat, quantity: 0, itemCount: new Set() };
    byCategory[cat].quantity += s.quantity || 0;
    byCategory[cat].itemCount.add(String(s.itemId));
  }

  const result = Object.values(byCategory)
    .map((r) => ({ category: r.category, quantity: r.quantity, itemCount: r.itemCount.size }))
    .sort((a, b) => b.quantity - a.quantity);
  return returnFunction(res, 200, true, req.locale.success, result);
};

// Rule-based signals, same approach as the HR Reports module's cross-module insights
// (reportFunctions.js) — plain aggregation/heuristics, no LLM (this codebase has no LLM
// integration anywhere). Each flag is only computed from data the schema actually has;
// where a literal ask ("valuation anomalies") would need history this schema doesn't
// keep (no historical valuation snapshots), a concentration heuristic is used instead
// of inventing a fabricated trend.
const getInventoryInsights = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Insights are restricted to inventory admins.');

  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 86400000);
  const since30 = new Date(now.getTime() - 30 * 86400000);
  const since60 = new Date(now.getTime() - 60 * 86400000);

  // ── Nearing expiry with high remaining quantity ──
  const nearExpiryLots = await findMany('inventory_lots', { expiryDate: { $ne: null, $gte: now, $lte: in30Days }, quantityRemaining: { $gt: 0 } }, {});
  let nearExpiry = [];
  if (nearExpiryLots.length) {
    const itemIds = [...new Set(nearExpiryLots.map((l) => String(l.itemId)))].map((id) => new ObjectId(id));
    const allLotsForItems = await findMany('inventory_lots', { itemId: { $in: itemIds } }, { projection: { itemId: 1, quantityRemaining: 1 } });
    const avgByItem = {};
    for (const l of allLotsForItems) {
      const k = String(l.itemId);
      avgByItem[k] ??= { sum: 0, count: 0 };
      avgByItem[k].sum += l.quantityRemaining || 0;
      avgByItem[k].count += 1;
    }
    const items = await findMany('inventory_items', { _id: { $in: itemIds } }, { projection: { sku: 1, name: 1 } });
    const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));
    nearExpiry = nearExpiryLots
      .filter((l) => {
        const avg = avgByItem[String(l.itemId)];
        return avg && avg.count > 0 && l.quantityRemaining >= (avg.sum / avg.count);
      })
      .map((l) => ({
        itemId: l.itemId, item: itemMap[String(l.itemId)] || null, lotNumber: l.lotNumber,
        quantityRemaining: l.quantityRemaining, expiryDate: l.expiryDate,
        daysUntilExpiry: Math.ceil((new Date(l.expiryDate) - now) / 86400000),
      }))
      .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  }

  // ── Declining 30-day sale velocity per item ──
  const [recentSales, priorSales] = await Promise.all([
    findMany('inventory_stock_movements', { movementType: 'sale', createdAt: { $gte: since30 } }, { projection: { itemId: 1, quantityChange: 1 } }),
    findMany('inventory_stock_movements', { movementType: 'sale', createdAt: { $gte: since60, $lt: since30 } }, { projection: { itemId: 1, quantityChange: 1 } }),
  ]);
  const sumByItem = (rows) => {
    const m = {};
    for (const r of rows) { const k = String(r.itemId); m[k] = (m[k] || 0) + Math.abs(r.quantityChange || 0); }
    return m;
  };
  const recentByItem = sumByItem(recentSales);
  const priorByItem = sumByItem(priorSales);
  const decliningItemIds = Object.keys(priorByItem).filter((k) => priorByItem[k] > 0 && (recentByItem[k] || 0) < priorByItem[k] * 0.5);
  let decliningVelocity = [];
  if (decliningItemIds.length) {
    const items = await findMany('inventory_items', { _id: { $in: decliningItemIds.map((id) => new ObjectId(id)) } }, { projection: { sku: 1, name: 1 } });
    const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));
    decliningVelocity = decliningItemIds
      .filter((k) => itemMap[k])
      .map((k) => ({
        itemId: k, item: itemMap[k],
        priorPeriodSales: priorByItem[k], recentPeriodSales: recentByItem[k] || 0,
        percentDrop: Math.round((1 - (recentByItem[k] || 0) / priorByItem[k]) * 100),
      }))
      .sort((a, b) => b.percentDrop - a.percentDrop)
      .slice(0, 10);
  }

  // ── Valuation concentration (no historical snapshot exists to diff a real "swing"
  // against, so this flags categories that make up a disproportionate share of total
  // value today, rather than fabricating a week-over-week trend) ──
  const stockLevels = await findMany('inventory_stock_levels', { quantity: { $gt: 0 } }, {});
  let valuationConcentration = [];
  if (stockLevels.length) {
    const itemIds = [...new Set(stockLevels.map((s) => String(s.itemId)))].map((id) => new ObjectId(id));
    const items = await findMany('inventory_items', { _id: { $in: itemIds } }, { projection: { avgCost: 1, category: 1 } });
    const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));
    const byCategory = {};
    let total = 0;
    for (const s of stockLevels) {
      const item = itemMap[String(s.itemId)];
      if (!item) continue;
      const value = (s.quantity || 0) * (item.avgCost || 0);
      total += value;
      const cat = item.category || 'Uncategorized';
      byCategory[cat] = (byCategory[cat] || 0) + value;
    }
    if (total > 0) {
      valuationConcentration = Object.entries(byCategory)
        .map(([category, value]) => ({ category, value: Math.round(value * 100) / 100, percentOfTotal: Math.round((value / total) * 1000) / 10 }))
        .filter((r) => r.percentOfTotal >= 40)
        .sort((a, b) => b.percentOfTotal - a.percentOfTotal);
    }
  }

  return returnFunction(res, 200, true, req.locale.success, { nearExpiry, decliningVelocity, valuationConcentration });
};

module.exports = { getValuationReport, getStockByCategoryReport, getInventoryInsights };
