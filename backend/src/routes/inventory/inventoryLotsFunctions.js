const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');

// A lot record is scoped to one item + one location + one lot/serial number — receiving
// the same lot number again at the same location tops up quantityRemaining; receiving it
// at a different location (via a transfer) creates a second lot record there. This keeps
// "where is lot X right now" a plain query instead of needing a separate ledger.

async function receiveLotStock({ itemId, locationId, lotNumber, quantity, expiryDate = null, poId = null }) {
  const now = new Date();
  const existing = await findOne('inventory_lots', { itemId, locationId, lotNumber });
  if (existing) {
    await updateOne('inventory_lots', { _id: existing._id }, {
      $inc: { quantityRemaining: quantity },
      $set: { updatedAt: now, ...(expiryDate ? { expiryDate: new Date(expiryDate) } : {}) },
    });
    return { ...existing, quantityRemaining: existing.quantityRemaining + quantity };
  }
  const doc = {
    itemId, locationId, lotNumber,
    quantityRemaining: quantity,
    expiryDate: expiryDate ? new Date(expiryDate) : null,
    poId, receivedAt: now, createdAt: now, updatedAt: now,
  };
  const result = await insertOne('inventory_lots', doc);
  return { _id: result.insertedId, ...doc };
}

async function consumeLotStock({ itemId, locationId, lotNumber, quantity }) {
  const lot = await findOne('inventory_lots', { itemId, locationId, lotNumber });
  if (!lot) throw new Error(`Lot ${lotNumber} not found at this location.`);
  if (lot.quantityRemaining < quantity) throw new Error(`Lot ${lotNumber} only has ${lot.quantityRemaining} remaining.`);
  await updateOne('inventory_lots', { _id: lot._id }, { $inc: { quantityRemaining: -quantity }, $set: { updatedAt: new Date() } });
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
  const itemId = new ObjectId(req.params.itemId);
  const lots = await findMany('inventory_lots', { itemId }, { sort: { expiryDate: 1 } });
  const locIds = [...new Set(lots.map((l) => String(l.locationId)))].map((id) => new ObjectId(id));
  const locations = locIds.length ? await findMany('inventory_locations', { _id: { $in: locIds } }, { projection: { name: 1 } }) : [];
  const locMap = Object.fromEntries(locations.map((l) => [String(l._id), l]));
  const now = new Date();
  const enriched = lots.map((l) => ({
    ...l,
    location: locMap[String(l.locationId)] || null,
    isExpired: !!(l.expiryDate && l.expiryDate < now),
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// Forward + backward traceability: given a lot/serial number, every location it has
// sat in and every stock movement that ever touched it.
const traceLot = async (req, res) => {
  const { itemId, lotNumber } = req.query;
  if (!itemId || !lotNumber) return returnFunction(res, 400, false, 'itemId and lotNumber are required.');

  const lots = await findMany('inventory_lots', { itemId: new ObjectId(itemId), lotNumber }, { sort: { receivedAt: 1 } });
  if (!lots.length) return returnFunction(res, 404, false, 'No lot found with that number for this item.');

  const lotIds = lots.map((l) => l._id);
  const movements = await findMany('inventory_stock_movements', { lotId: { $in: lotIds } }, { sort: { createdAt: 1 } });

  const locIds = [...new Set(lots.map((l) => String(l.locationId)))].map((id) => new ObjectId(id));
  const locations = await findMany('inventory_locations', { _id: { $in: locIds } }, { projection: { name: 1 } });
  const locMap = Object.fromEntries(locations.map((l) => [String(l._id), l]));

  return returnFunction(res, 200, true, req.locale.success, {
    lotNumber,
    lots: lots.map((l) => ({ ...l, location: locMap[String(l.locationId)] || null })),
    movements: movements.map((m) => ({ ...m, location: locMap[String(m.locationId)] || null })),
  });
};

module.exports = { receiveLotStock, consumeLotStock, transferLotStock, listLotsForItem, traceLot };
