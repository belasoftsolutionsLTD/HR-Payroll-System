const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { completeInventoryTransfer } = require('../../lib/inventory/inventoryIntegration');
const { getInventoryAccessLevel, getScopedLocationFilter } = require('../../lib/inventory/inventoryAccess');
const { notifyByRoles, notifyUser } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

const emailRequester = async (userId, trigger, tokens, fallbackSubject, fallbackHtml) => {
  const user = await findOne('users', { _id: new ObjectId(userId) }, { projection: { email: 1 } });
  if (!user?.email) return;
  return sendTemplatedEmail({ trigger, to: user.email, tokens, fallbackSubject, fallbackHtml }).catch(() => {});
};

// Attaches *Name fields for whichever of requestedBy/approvedBy/rejectedBy/receivedBy
// are present on a transfer — without this the UI has no way to show who did what.
async function attachActorNames(transfers) {
  const userIds = [...new Set(transfers.flatMap((t) =>
    [t.requestedBy, t.approvedBy, t.rejectedBy, t.receivedBy].filter(Boolean).map(String)
  ))].map((id) => new ObjectId(id));
  const users = userIds.length ? await findMany('users', { _id: { $in: userIds } }, { projection: { name: 1 } }) : [];
  const nameById = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
  return transfers.map((t) => ({
    ...t,
    requestedByName: t.requestedBy ? nameById[String(t.requestedBy)] || null : null,
    approvedByName: t.approvedBy ? nameById[String(t.approvedBy)] || null : null,
    rejectedByName: t.rejectedBy ? nameById[String(t.rejectedBy)] || null : null,
    receivedByName: t.receivedBy ? nameById[String(t.receivedBy)] || null : null,
  }));
}

const listTransfers = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopeFilter = await getScopedLocationFilter(req.user, level);

  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (scopeFilter) {
    const scopedLocations = await findMany('inventory_locations', scopeFilter, { projection: { _id: 1 } });
    const ids = scopedLocations.map((l) => l._id);
    filter.$or = [{ fromLocationId: { $in: ids } }, { toLocationId: { $in: ids } }];
  }

  const [total, transfers] = await Promise.all([
    countDocuments('inventory_transfers', filter),
    findMany('inventory_transfers', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const locIds = [...new Set(transfers.flatMap((t) => [String(t.fromLocationId), String(t.toLocationId)]))].map((id) => new ObjectId(id));
  const locations = locIds.length ? await findMany('inventory_locations', { _id: { $in: locIds } }, { projection: { name: 1 } }) : [];
  const locMap = Object.fromEntries(locations.map((l) => [String(l._id), l]));
  const withLocations = transfers.map((t) => ({ ...t, fromLocation: locMap[String(t.fromLocationId)] || null, toLocation: locMap[String(t.toLocationId)] || null }));
  const enriched = await attachActorNames(withLocations);

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getTransfer = async (req, res) => {
  const transfer = await findOne('inventory_transfers', { _id: new ObjectId(req.params.id) });
  if (!transfer) return returnFunction(res, 404, false, req.locale.notFound);

  const [fromLocation, toLocation, items] = await Promise.all([
    findOne('inventory_locations', { _id: transfer.fromLocationId }, { projection: { name: 1 } }),
    findOne('inventory_locations', { _id: transfer.toLocationId }, { projection: { name: 1 } }),
    findMany('inventory_items', { _id: { $in: transfer.items.map((i) => i.itemId) } }, { projection: { sku: 1, name: 1, unitOfMeasure: 1, trackingMode: 1 } }),
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [String(i._id), i]));
  const [enriched] = await attachActorNames([transfer]);

  return returnFunction(res, 200, true, req.locale.success, {
    ...enriched, fromLocation: fromLocation || null, toLocation: toLocation || null,
    items: transfer.items.map((line) => ({ ...line, item: itemMap[String(line.itemId)] || null })),
  });
};

const requestTransfer = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['fromLocationId', 'toLocationId', 'items'])) return;
  if (req.body.fromLocationId === req.body.toLocationId) {
    return returnFunction(res, 400, false, 'Source and destination location must be different.');
  }
  if (!Array.isArray(req.body.items) || !req.body.items.length) {
    return returnFunction(res, 400, false, 'At least one item line is required.');
  }

  const doc = {
    fromLocationId: new ObjectId(req.body.fromLocationId),
    toLocationId: new ObjectId(req.body.toLocationId),
    items: req.body.items.map((line) => ({
      itemId: new ObjectId(line.itemId),
      quantity: Number(line.quantity),
      lotNumber: line.lotNumber || null,
    })),
    status: 'requested',
    requestNotes: req.body.notes || null,
    requestedBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('inventory_transfers', doc);

  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Stock transfer requested',
    body: `A transfer was requested between locations — review it in Inventory.`,
    type: 'inventory',
    link: `/inventory/transfers/${result.insertedId}`,
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const approveTransfer = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin' && level !== 'clerk') return returnFunction(res, 403, false, 'Not authorized to approve transfers.');
  const transfer = await findOne('inventory_transfers', { _id: new ObjectId(req.params.id) });
  if (!transfer) return returnFunction(res, 404, false, req.locale.notFound);
  if (transfer.status !== 'requested') return returnFunction(res, 400, false, 'Only a requested transfer can be approved.');
  // requestTransfer only requires SOME inventory access, not admin/clerk — a manager-level
  // requester who separately holds admin/clerk elsewhere must not be able to approve their
  // own request.
  if (String(transfer.requestedBy) === String(req.user._id)) {
    return returnFunction(res, 403, false, 'You cannot approve your own transfer request.');
  }
  await updateOne('inventory_transfers', { _id: transfer._id }, { $set: { status: 'approved', approvedBy: req.user._id, approvedAt: new Date(), updatedAt: new Date() } });
  notifyUser(transfer.requestedBy, {
    title: 'Transfer approved', body: 'Your stock transfer request was approved and is ready to be received.',
    type: 'inventory', link: `/inventory/transfers/${transfer._id}`,
  }).catch(() => {});
  emailRequester(transfer.requestedBy, 'inventoryTransferApproved', {}, 'Transfer approved',
    '<p>Your stock transfer request was approved and is ready to be received.</p>');
  return returnFunction(res, 200, true, 'Transfer approved.');
};

const rejectTransfer = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin' && level !== 'clerk') return returnFunction(res, 403, false, 'Not authorized to reject transfers.');
  const transfer = await findOne('inventory_transfers', { _id: new ObjectId(req.params.id) });
  if (!transfer) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['requested', 'approved'].includes(transfer.status)) return returnFunction(res, 400, false, 'This transfer can no longer be rejected.');
  await updateOne('inventory_transfers', { _id: transfer._id }, {
    $set: { status: 'rejected', rejectedBy: req.user._id, rejectionReason: req.body.reason || null, updatedAt: new Date() },
  });
  notifyUser(transfer.requestedBy, {
    title: 'Transfer rejected',
    body: req.body.reason ? `Your stock transfer request was rejected. Reason: ${req.body.reason}` : 'Your stock transfer request was rejected.',
    type: 'inventory', link: `/inventory/transfers/${transfer._id}`,
  }).catch(() => {});
  emailRequester(transfer.requestedBy, 'inventoryTransferRejected', { reason: req.body.reason || '' }, 'Transfer rejected',
    req.body.reason ? `<p>Your stock transfer request was rejected. Reason: ${req.body.reason}</p>` : '<p>Your stock transfer request was rejected.</p>');
  return returnFunction(res, 200, true, 'Transfer rejected.');
};

// The only step that actually moves stock — pairs a transfer_out at the source with a
// transfer_in at the destination for every line, at the item's current weighted-average
// cost (a transfer carries cost basis across, it doesn't revalue anything). The actual
// work lives in completeInventoryTransfer (lib/inventory/inventoryIntegration.js) so
// Logistics can call the exact same logic when a shipment wrapping this transfer is
// marked Delivered, instead of duplicating it.
const receiveTransfer = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin' && level !== 'clerk') return returnFunction(res, 403, false, 'Not authorized to receive transfers.');

  try {
    await completeInventoryTransfer(req.params.id, req.user._id);
  } catch (err) {
    return returnFunction(res, 400, false, err.message);
  }

  return returnFunction(res, 200, true, 'Transfer received — stock updated at both locations.');
};

module.exports = { listTransfers, getTransfer, requestTransfer, approveTransfer, rejectTransfer, receiveTransfer };
