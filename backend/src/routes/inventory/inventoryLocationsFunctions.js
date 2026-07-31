const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { getInventoryAccessLevel, getScopedLocationFilter } = require('../../lib/inventory/inventoryAccess');

// ── Locations ─────────────────────────────────────────────────────────────────

const listLocations = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopeFilter = await getScopedLocationFilter(req.user, level);
  const filter = { isActive: { $ne: false }, ...(scopeFilter || {}) };
  const locations = await findMany('inventory_locations', filter, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, locations);
};

const createLocation = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'type'])) return;
  const doc = {
    name: req.body.name.trim(),
    type: req.body.type, // 'warehouse' | 'store' | 'room' | 'other'
    address: req.body.address?.trim() || '',
    department: req.body.department || null, // links this location to a department for manager/dept_head scoping
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('inventory_locations', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateLocation = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.type !== undefined) update.type = req.body.type;
  if (req.body.address !== undefined) update.address = req.body.address.trim();
  if (req.body.department !== undefined) update.department = req.body.department || null;
  await updateOne('inventory_locations', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteLocation = async (req, res) => {
  await updateOne('inventory_locations', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
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
    const scopedLocations = await findMany('inventory_locations', scopeFilter, { projection: { _id: 1 } });
    locationIds = scopedLocations.map((l) => l._id);
  }

  const filter = {};
  if (req.query.locationId) {
    filter.locationId = new ObjectId(req.query.locationId);
  } else if (locationIds) {
    filter.locationId = { $in: locationIds };
  }
  if (req.query.itemId) filter.itemId = new ObjectId(req.query.itemId);

  const stockLevels = await findMany('inventory_stock_levels', filter, {});
  if (!stockLevels.length) return returnFunction(res, 200, true, req.locale.success, []);

  const itemIds = [...new Set(stockLevels.map((s) => String(s.itemId)))].map((id) => new ObjectId(id));
  const locIds = [...new Set(stockLevels.map((s) => String(s.locationId)))].map((id) => new ObjectId(id));
  const [items, locations] = await Promise.all([
    findMany('inventory_items', { _id: { $in: itemIds } }, { projection: { sku: 1, name: 1, category: 1, unitOfMeasure: 1 } }),
    findMany('inventory_locations', { _id: { $in: locIds } }, { projection: { name: 1, type: 1 } }),
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));
  const locMap = Object.fromEntries(locations.map((l) => [String(l._id), l]));

  const enriched = stockLevels
    .filter((s) => itemMap[String(s.itemId)]) // drop rows for archived items
    .map((s) => ({ ...s, item: itemMap[String(s.itemId)] || null, location: locMap[String(s.locationId)] || null }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// Consolidated total-across-all-locations view for one item — the "total stock" number
// shown on the item detail page, separate from the per-location breakdown above.
const getItemTotalStock = async (req, res) => {
  const itemId = new ObjectId(req.params.itemId);
  const levels = await findMany('inventory_stock_levels', { itemId }, {});
  const totalQuantity = levels.reduce((sum, l) => sum + (l.quantity || 0), 0);
  return returnFunction(res, 200, true, req.locale.success, { itemId, totalQuantity, byLocation: levels });
};

const setReorderPoint = async (req, res) => {
  if (!validateRequiredFields(req, res, ['itemId', 'locationId', 'reorderPoint'])) return;
  const reorderPoint = Number(req.body.reorderPoint);
  if (isNaN(reorderPoint) || reorderPoint < 0) return returnFunction(res, 400, false, 'reorderPoint must be a non-negative number.');

  await updateOne(
    'inventory_stock_levels',
    { itemId: new ObjectId(req.body.itemId), locationId: new ObjectId(req.body.locationId) },
    { $set: { reorderPoint, updatedAt: new Date() }, $setOnInsert: { quantity: 0 } },
    { upsert: true }
  );
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
    const scopedLocations = await findMany('inventory_locations', scopeFilter, { projection: { _id: 1 } });
    locationIds = scopedLocations.map((l) => l._id);
  }

  const filter = { reorderPoint: { $gt: 0 }, $expr: { $lte: ['$quantity', '$reorderPoint'] } };
  if (extraFilters.locationId) filter.locationId = new ObjectId(extraFilters.locationId);
  else if (locationIds) filter.locationId = { $in: locationIds };

  const lowLevels = await findMany('inventory_stock_levels', filter, {});
  if (!lowLevels.length) return [];

  const itemIds = [...new Set(lowLevels.map((s) => String(s.itemId)))].map((id) => new ObjectId(id));
  const locIds = [...new Set(lowLevels.map((s) => String(s.locationId)))].map((id) => new ObjectId(id));
  const [items, locations] = await Promise.all([
    findMany('inventory_items', { _id: { $in: itemIds }, isActive: { $ne: false } }, { projection: { sku: 1, name: 1, unitOfMeasure: 1, category: 1 } }),
    findMany('inventory_locations', { _id: { $in: locIds } }, { projection: { name: 1 } }),
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));
  const locMap = Object.fromEntries(locations.map((l) => [String(l._id), l]));

  return lowLevels
    .filter((s) => itemMap[String(s.itemId)] && (!extraFilters.category || itemMap[String(s.itemId)].category === extraFilters.category))
    .map((s) => ({ ...s, item: itemMap[String(s.itemId)], location: locMap[String(s.locationId)] || null }));
};

const getLowStockReport = async (req, res) => {
  const alerts = await getLowStockLevels(req.user, { locationId: req.query.locationId, category: req.query.category });
  return returnFunction(res, 200, true, req.locale.success, alerts);
};

module.exports = {
  listLocations, createLocation, updateLocation, deleteLocation,
  listStockLevels, getItemTotalStock, setReorderPoint, getLowStockLevels, getLowStockReport,
};
