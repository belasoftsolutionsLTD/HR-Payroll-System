// Postgres migration (Phase 6) — inventory_items/inventory_locations are Postgres now
// (found while sweeping CRM for Phase 6 — CRM's own tables stay Mongo, unaffected).
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { getStockLevel } = require('../../lib/inventory/inventoryIntegration');
const { getCrmAccessLevel } = require('../../lib/crm/crmAccess');

// Read-only stock visibility for sales reps building a deal or talking to a contact —
// calls Inventory's own getStockLevel per item rather than re-deriving quantities from
// inventory_stock_movements/inventory_stock_levels itself. CRM never writes to either
// collection; a search here is the only touch point with Inventory's data.
const searchStock = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  let query = knex('inventory_items').whereNot({ isActive: false });
  if (req.query.search) {
    const q = `%${req.query.search.trim()}%`;
    query = query.where((qb) => qb.whereILike('name', q).orWhereILike('sku', q).orWhereILike('barcode', q));
  }
  const items = await query.orderBy('name').limit(20);

  const locations = req.query.locationId
    ? [req.query.locationId]
    : (await knex('inventory_locations').whereNot({ isActive: false }).select('id')).map((l) => l.id);

  const withStock = await Promise.all(items.map(async (item) => {
    if (!item.isTracked) return { ...item, stock: null };
    const perLocation = await Promise.all(locations.map((locId) => getStockLevel(item.id, locId)));
    return { ...item, stock: perLocation.reduce((sum, q) => sum + q, 0) };
  }));

  return returnFunction(res, 200, true, req.locale.success, withStock);
};

module.exports = { searchStock };
