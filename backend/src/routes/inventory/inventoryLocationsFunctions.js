// Postgres migration (Phase 6) — inventory_locations/inventory_stock_levels/
// inventory_items are now Postgres. Two Mongo-only patterns needed real translation:
// setReorderPoint's $setOnInsert+upsert → knex .insert().onConflict().merge() against
// the new UNIQUE(locationId, itemId) constraint; getLowStockLevels' $expr quantity<=
// reorderPoint comparison → a raw SQL column-to-column comparison (Knex has no
// column-vs-column .where() shorthand for this).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { getInventoryAccessLevel, getScopedLocationFilter } = require('../../lib/inventory/inventoryAccess');

// ── Locations ─────────────────────────────────────────────────────────────────

const listLocations = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopeFilter = await getScopedLocationFilter(req.user, level);
  let query = knex('inventory_locations').whereNot({ isActive: false });
  if (scopeFilter) query = query.where(scopeFilter);
  const locations = await query.orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, locations);
};

const createLocation = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'type'])) return;
  const doc = {
    id: newId(),
    name: req.body.name.trim(),
    type: req.body.type, // 'warehouse' | 'store' | 'room' | 'other'
    address: req.body.address?.trim() || '',
    department: req.body.department || null, // links this location to a department for manager/dept_head scoping
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('inventory_locations').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateLocation = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.type !== undefined) update.type = req.body.type;
  if (req.body.address !== undefined) update.address = req.body.address.trim();
  if (req.body.department !== undefined) update.department = req.body.department || null;
  await knex('inventory_locations').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteLocation = async (req, res) => {
  await knex('inventory_locations').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// ── Stock levels (the materialized read-cache — see inventoryMovementsFunctions for
// the ledger that actually derives these numbers) ───────────────────────────────

const listStockLevels = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopeFilter = await getScopedLocationFilter(req.user, level);

  let locationIds = null;
  if (scopeFilter) {
    const scopedLocations = await knex('inventory_locations').where(scopeFilter).select('id');
    locationIds = scopedLocations.map((l) => l.id);
  }

  let query = knex('inventory_stock_levels');
  if (req.query.locationId) {
    query = query.where({ locationId: req.query.locationId });
  } else if (locationIds) {
    query = query.whereIn('locationId', locationIds);
  }
  if (req.query.itemId) query = query.where({ itemId: req.query.itemId });

  const stockLevels = await query;
  if (!stockLevels.length) return returnFunction(res, 200, true, req.locale.success, []);

  const itemIds = [...new Set(stockLevels.map((s) => s.itemId))];
  const locIds = [...new Set(stockLevels.map((s) => s.locationId))];
  const [items, locations] = await Promise.all([
    knex('inventory_items').whereIn('id', itemIds).select('id', 'sku', 'name', 'category', 'unitOfMeasure'),
    knex('inventory_locations').whereIn('id', locIds).select('id', 'name', 'type'),
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));
  const locMap = Object.fromEntries(locations.map((l) => [l.id, l]));

  const enriched = stockLevels
    .filter((s) => itemMap[s.itemId]) // drop rows for archived items
    .map((s) => ({ ...s, item: itemMap[s.itemId] || null, location: locMap[s.locationId] || null }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// Consolidated total-across-all-locations view for one item — the "total stock" number
// shown on the item detail page, separate from the per-location breakdown above.
const getItemTotalStock = async (req, res) => {
  const itemId = req.params.itemId;
  const levels = await knex('inventory_stock_levels').where({ itemId });
  const totalQuantity = levels.reduce((sum, l) => sum + (l.quantity || 0), 0);
  return returnFunction(res, 200, true, req.locale.success, { itemId, totalQuantity, byLocation: levels });
};

const setReorderPoint = async (req, res) => {
  if (!validateRequiredFields(req, res, ['itemId', 'locationId', 'reorderPoint'])) return;
  const reorderPoint = Number(req.body.reorderPoint);
  if (isNaN(reorderPoint) || reorderPoint < 0) return returnFunction(res, 400, false, 'reorderPoint must be a non-negative number.');

  const updatedAt = new Date();
  await knex('inventory_stock_levels')
    .insert({ id: newId(), itemId: req.body.itemId, locationId: req.body.locationId, quantity: 0, reorderPoint, updatedAt })
    .onConflict(['locationId', 'itemId'])
    .merge({ reorderPoint, updatedAt }); // merge deliberately omits `quantity` — preserves the existing ledger-derived value on conflict, only $setOnInsert's it to 0 for a brand-new row
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Items currently at/below their configured reorder point — the dashboard widget and
// the cron alert (see lib/tasks/cronTasks.js) both read from this same function.
// extraFilters (locationId/category) is only used by the Reports tab's own filter bar —
// the dashboard widget and cron alert call this with no extraFilters, unaffected.
const getLowStockLevels = async (userForScope, extraFilters = {}) => {
  const level = userForScope ? await getInventoryAccessLevel(userForScope) : 'admin';
  const scopeFilter = userForScope ? await getScopedLocationFilter(userForScope, level) : null;

  let locationIds = null;
  if (scopeFilter) {
    const scopedLocations = await knex('inventory_locations').where(scopeFilter).select('id');
    locationIds = scopedLocations.map((l) => l.id);
  }

  let query = knex('inventory_stock_levels').where('reorderPoint', '>', 0).whereRaw('"quantity" <= "reorderPoint"');
  if (extraFilters.locationId) query = query.where({ locationId: extraFilters.locationId });
  else if (locationIds) query = query.whereIn('locationId', locationIds);

  const lowLevels = await query;
  if (!lowLevels.length) return [];

  const itemIds = [...new Set(lowLevels.map((s) => s.itemId))];
  const locIds = [...new Set(lowLevels.map((s) => s.locationId))];
  const [items, locations] = await Promise.all([
    knex('inventory_items').whereIn('id', itemIds).whereNot({ isActive: false }).select('id', 'sku', 'name', 'unitOfMeasure', 'category'),
    knex('inventory_locations').whereIn('id', locIds).select('id', 'name'),
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));
  const locMap = Object.fromEntries(locations.map((l) => [l.id, l]));

  return lowLevels
    .filter((s) => itemMap[s.itemId] && (!extraFilters.category || itemMap[s.itemId].category === extraFilters.category))
    .map((s) => ({ ...s, item: itemMap[s.itemId], location: locMap[s.locationId] || null }));
};

const getLowStockReport = async (req, res) => {
  const alerts = await getLowStockLevels(req.user, { locationId: req.query.locationId, category: req.query.category });
  return returnFunction(res, 200, true, req.locale.success, alerts);
};

module.exports = {
  listLocations, createLocation, updateLocation, deleteLocation,
  listStockLevels, getItemTotalStock, setReorderPoint, getLowStockLevels, getLowStockReport,
};
