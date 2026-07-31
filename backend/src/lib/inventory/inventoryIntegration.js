// Integration surface for other modules (POS, CRM, Logistics). Deliberately plain
// functions, not HTTP routes — everything lives in this same backend process, so callers
// `require()` this directly rather than round-tripping through an internal API call.
const { ObjectId } = require('mongodb');
const { findOne, findMany, updateOne } = require('../../functions/Database/commonDBFunctions');
const { createStockMovement } = require('../../routes/inventory/inventoryMovementsFunctions');
const { transferLotStock } = require('../../routes/inventory/inventoryLotsFunctions');
const { notifyUser } = require('../../functions/HR/notifyUser');

// Called by POS at the moment of sale. Uses the item's current weighted-average cost as
// the movement's unitCost (a sale doesn't change valuation, it just realizes it), and
// throws if there isn't enough stock at that location — the caller (POS) should catch
// this and block/flag the sale rather than let stock go negative.
async function deductStockForSale(itemId, locationId, quantity, referenceId, performedBy = null) {
  const item = await findOne('inventory_items', { _id: new ObjectId(itemId) });
  if (!item) throw new Error('Item not found.');
  if (!item.isTracked) return null; // service/non-tracked items have nothing to deduct

  return createStockMovement({
    itemId: new ObjectId(itemId),
    locationId: new ObjectId(locationId),
    quantityChange: -Math.abs(Number(quantity)),
    movementType: 'sale',
    referenceId: referenceId ? new ObjectId(referenceId) : null,
    referenceModel: 'pos_sale',
    unitCost: item.avgCost || 0,
    performedBy: performedBy ? new ObjectId(performedBy) : null,
  });
}

// The reverse of deductStockForSale — called by POS on a void or refund. Same cost
// basis convention (the item's current avgCost, not the original sale price), same
// 'pos_sale' referenceModel so the movement ledger still ties back to the original sale
// even though this is a separate 'return' movement, not an edit of the original one
// (the ledger is immutable — a correction is always a new entry, never a rewrite).
async function returnStockFromSale(itemId, locationId, quantity, referenceId, performedBy = null) {
  const item = await findOne('inventory_items', { _id: new ObjectId(itemId) });
  if (!item) throw new Error('Item not found.');
  if (!item.isTracked) return null;

  return createStockMovement({
    itemId: new ObjectId(itemId),
    locationId: new ObjectId(locationId),
    quantityChange: Math.abs(Number(quantity)),
    movementType: 'return',
    referenceId: referenceId ? new ObjectId(referenceId) : null,
    referenceModel: 'pos_sale',
    unitCost: item.avgCost || 0,
    performedBy: performedBy ? new ObjectId(performedBy) : null,
  });
}

// Read-only live stock lookup for CRM (a sales rep checking "do we have this in stock"
// mid-conversation) and for POS (checking availability before/at checkout). Returns 0
// rather than throwing for a non-tracked/service item or a location with no
// stock_levels row yet, since both mean "nothing to report", not an error.
async function getStockLevel(itemId, locationId) {
  const level = await findOne('inventory_stock_levels', { itemId: new ObjectId(itemId), locationId: new ObjectId(locationId) });
  return level?.quantity || 0;
}

// Extracted from inventoryTransfersFunctions.js's receiveTransfer HTTP handler so
// Logistics can complete a transfer (when a shipment wrapping it is marked Delivered)
// the same way POS deducts stock — by calling a plain function, not by duplicating the
// stock-movement logic or round-tripping through an internal HTTP call. The HTTP handler
// itself now just calls this and stays otherwise unchanged (same status checks, same
// notification, same response shape).
async function completeInventoryTransfer(transferId, performedBy) {
  const transfer = await findOne('inventory_transfers', { _id: new ObjectId(transferId) });
  if (!transfer) throw new Error('Transfer not found.');
  if (transfer.status !== 'approved') throw new Error('Only an approved transfer can be received.');

  const itemDocs = await findMany('inventory_items', { _id: { $in: transfer.items.map((l) => l.itemId) } }, {});
  const itemById = Object.fromEntries(itemDocs.map((i) => [String(i._id), i]));

  for (const line of transfer.items) {
    const item = itemById[String(line.itemId)];
    if (!item?.isTracked) continue;
    const unitCost = item.avgCost || 0;

    await createStockMovement({
      itemId: line.itemId, locationId: transfer.fromLocationId, quantityChange: -line.quantity,
      movementType: 'transfer_out', referenceId: transfer._id, referenceModel: 'transfer',
      unitCost, performedBy,
    });
    await createStockMovement({
      itemId: line.itemId, locationId: transfer.toLocationId, quantityChange: line.quantity,
      movementType: 'transfer_in', referenceId: transfer._id, referenceModel: 'transfer',
      unitCost, performedBy,
    });

    if (item.trackingMode !== 'none' && line.lotNumber) {
      await transferLotStock({
        itemId: line.itemId, lotNumber: line.lotNumber,
        fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId, quantity: line.quantity,
      });
    }
  }

  await updateOne('inventory_transfers', { _id: transfer._id }, {
    $set: { status: 'received', receivedBy: performedBy, receivedAt: new Date(), updatedAt: new Date() },
  });
  notifyUser(transfer.requestedBy, {
    title: 'Transfer received', body: 'Your stock transfer has arrived and been received.',
    type: 'inventory', link: `/inventory/transfers/${transfer._id}`,
  }).catch(() => {});

  return transfer;
}

module.exports = { deductStockForSale, returnStockFromSale, getStockLevel, completeInventoryTransfer };
