// Postgres migration (Phase 6) — inventory_locations/inventory_items are Postgres now.
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { getStockLevel } = require('../../lib/inventory/inventoryIntegration');
const { getPosAccessLevel, getScopedPosLocationIds, canSellAtLocation } = require('../../lib/pos/posAccess');

// POS's read-only view into Inventory's data (locations, items, live stock) — all
// scoped by POS's OWN access level, never Inventory's. Those are two independent
// access systems: a cashier can be assigned to sell at a location via
// users.posLocationIds while having zero Inventory access (no isInventoryClerk flag,
// not a manager) — calling Inventory's own gated GET /inventory/locations,
// /inventory/items, or /inventory/stock-levels on their behalf would 403 and silently
// leave the register screen empty. Every POS location/item/stock picker calls the
// endpoints in this file instead (mirrors CRM's crmInventoryFunctions.js pattern).
const listLocations = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  const scoped = await getScopedPosLocationIds(req.user, level);
  let query = knex('inventory_locations').whereNot({ isActive: false });
  if (scoped) query = query.whereIn('id', scoped);

  const locations = await query.orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, locations);
};

// Live stock for the register screen's cart/search — same reasoning as listLocations
// above: calls Inventory's plain getStockLevel() function per item rather than the
// gated GET /inventory/stock-levels route, so a POS-only cashier with no Inventory
// access still sees real-time availability while checking out.
const listStockLevelsForLocation = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!req.query.locationId) return returnFunction(res, 400, false, 'locationId is required.');
  if (!(await canSellAtLocation(req.user, level, req.query.locationId))) {
    return returnFunction(res, 403, false, 'You are not assigned to this location.');
  }

  const locationId = req.query.locationId;
  const items = await knex('inventory_items').whereNot({ isActive: false }).where({ isTracked: true })
    .select('id', 'sku', 'name', 'category', 'unitOfMeasure');

  const stockLevels = await Promise.all(items.map(async (item) => ({
    itemId: item.id,
    locationId,
    quantity: await getStockLevel(item.id, locationId),
    item: { sku: item.sku, name: item.name, category: item.category, unitOfMeasure: item.unitOfMeasure },
  })));

  return returnFunction(res, 200, true, req.locale.success, stockLevels);
};

// Item catalog search for the register's search box — same reasoning again: reads
// inventory_items directly rather than going through Inventory's gated GET
// /inventory/items, whose access check would block a POS-only cashier entirely.
const listSellableItems = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  let query = knex('inventory_items').whereNot({ isActive: false });
  if (req.query.search) {
    const q = `%${req.query.search.trim()}%`;
    query = query.where((qb) => qb.whereILike('name', q).orWhereILike('sku', q).orWhereILike('barcode', q).orWhereILike('brand', q));
  }
  const items = await query.orderBy('name').limit(50);
  return returnFunction(res, 200, true, req.locale.success, items);
};

module.exports = { listLocations, listStockLevelsForLocation, listSellableItems };
