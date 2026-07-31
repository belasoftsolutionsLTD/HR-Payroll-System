const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany } = require('../../functions/Database/commonDBFunctions');
const { getStockLevel } = require('../../lib/inventory/inventoryIntegration');
const { getCrmAccessLevel } = require('../../lib/crm/crmAccess');

// Read-only stock visibility for sales reps building a deal or talking to a contact —
// calls Inventory's own getStockLevel per item rather than re-deriving quantities from
// inventory_stock_movements/inventory_stock_levels itself. CRM never writes to either
// collection; a search here is the only touch point with Inventory's data.
const searchStock = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  const filter = { isActive: { $ne: false } };
  if (req.query.search) {
    const q = req.query.search.trim();
    filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { sku: { $regex: q, $options: 'i' } },
      { barcode: { $regex: q, $options: 'i' } },
    ];
  }
  const items = await findMany('inventory_items', filter, { limit: 20, sort: { name: 1 } });

  const locations = req.query.locationId
    ? [new ObjectId(req.query.locationId)]
    : (await findMany('inventory_locations', { isActive: { $ne: false } }, { projection: { _id: 1 } })).map((l) => l._id);

  const withStock = await Promise.all(items.map(async (item) => {
    if (!item.isTracked) return { ...item, stock: null };
    const perLocation = await Promise.all(locations.map((locId) => getStockLevel(item._id, locId)));
    return { ...item, stock: perLocation.reduce((sum, q) => sum + q, 0) };
  }));

  return returnFunction(res, 200, true, req.locale.success, withStock);
};

module.exports = { searchStock };
