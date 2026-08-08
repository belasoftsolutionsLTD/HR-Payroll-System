// Postgres migration (Phase 6) — inventory_lots/inventory_items/inventory_locations/
// inventory_stock_movements are all Postgres now. Mongo's $inc on quantityRemaining
// becomes a real transaction-free knex increment (single-row UPDATE ... SET x = x + $1
// is already atomic at the row level in Postgres, same guarantee $inc gave us in Mongo).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');

// A lot record is scoped to one item + one location + one lot/serial number — receiving
// the same lot number again at the same location tops up quantityRemaining; receiving it
// at a different location (via a transfer) creates a second lot record there. This keeps
// "where is lot X right now" a plain query instead of needing a separate ledger.

async function receiveLotStock({ itemId, locationId, lotNumber, quantity, expiryDate = null, poId = null }) {
  const now = new Date();
  const existing = await knex('inventory_lots').where({ itemId, locationId, lotNumber }).first();
  if (existing) {
    const set = { quantityRemaining: knex.raw('"quantityRemaining" + ?', [quantity]), updatedAt: now };
    if (expiryDate) set.expiryDate = new Date(expiryDate);
    const [updated] = await knex('inventory_lots').where({ id: existing.id }).update(set).returning('*');
    return updated;
  }
  const doc = {
    id: newId(), itemId, locationId, lotNumber,
    quantityRemaining: quantity,
    expiryDate: expiryDate ? new Date(expiryDate) : null,
    poId, receivedAt: now, createdAt: now, updatedAt: now,
  };
  const [saved] = await knex('inventory_lots').insert(doc).returning('*');
  return saved;
}

async function consumeLotStock({ itemId, locationId, lotNumber, quantity }) {
  const lot = await knex('inventory_lots').where({ itemId, locationId, lotNumber }).first();
  if (!lot) throw new Error(`Lot ${lotNumber} not found at this location.`);
  if (lot.quantityRemaining < quantity) throw new Error(`Lot ${lotNumber} only has ${lot.quantityRemaining} remaining.`);
  await knex('inventory_lots').where({ id: lot.id }).update({
    quantityRemaining: knex.raw('"quantityRemaining" - ?', [quantity]),
    updatedAt: new Date(),
  });
  return lot;
}

// Moves quantity from one location's lot record to another's, preserving the lot number
// so traceability isn't broken by an inter-location transfer.
async function transferLotStock({ itemId, lotNumber, fromLocationId, toLocationId, quantity }) {
  const sourceLot = await consumeLotStock({ itemId, locationId: fromLocationId, lotNumber, quantity });
  return receiveLotStock({
    itemId, locationId: toLocationId, lotNumber, quantity,
    expiryDate: sourceLot.expiryDate, poId: sourceLot.poId,
  });
}

const listLotsForItem = async (req, res) => {
  const itemId = req.params.itemId;
  const lots = await knex('inventory_lots').where({ itemId }).orderBy('expiryDate');
  const locIds = [...new Set(lots.map((l) => l.locationId))];
  const locations = locIds.length ? await knex('inventory_locations').whereIn('id', locIds).select('id', 'name') : [];
  const locMap = Object.fromEntries(locations.map((l) => [l.id, l]));
  const now = new Date();
  const enriched = lots.map((l) => ({
    ...l,
    location: locMap[l.locationId] || null,
    isExpired: !!(l.expiryDate && l.expiryDate < now),
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// Forward + backward traceability: given a lot/serial number, every location it has
// sat in and every stock movement that ever touched it.
const traceLot = async (req, res) => {
  const { itemId, lotNumber } = req.query;
  if (!itemId || !lotNumber) return returnFunction(res, 400, false, 'itemId and lotNumber are required.');

  const lots = await knex('inventory_lots').where({ itemId, lotNumber }).orderBy('receivedAt');
  if (!lots.length) return returnFunction(res, 404, false, 'No lot found with that number for this item.');

  const lotIds = lots.map((l) => l.id);
  const movements = await knex('inventory_stock_movements').whereIn('lotId', lotIds).orderBy('createdAt');

  const locIds = [...new Set(lots.map((l) => l.locationId))];
  const locations = await knex('inventory_locations').whereIn('id', locIds).select('id', 'name');
  const locMap = Object.fromEntries(locations.map((l) => [l.id, l]));

  return returnFunction(res, 200, true, req.locale.success, {
    lotNumber,
    lots: lots.map((l) => ({ ...l, location: locMap[l.locationId] || null })),
    movements: movements.map((m) => ({ ...m, location: locMap[m.locationId] || null })),
  });
};

module.exports = { receiveLotStock, consumeLotStock, transferLotStock, listLotsForItem, traceLot };
