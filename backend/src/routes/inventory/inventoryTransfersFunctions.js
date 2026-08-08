// Postgres migration (Phase 6) — inventory_transfers/inventory_locations/
// inventory_items are Postgres now; `users` has been Postgres since Phase 1
// (emailRequester's lookup was still on the Mongo helper — found while sweeping).
// items is a JSONB column (whole-replaced), no per-line updates needed.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { completeInventoryTransfer } = require('../../lib/inventory/inventoryIntegration');
const { getInventoryAccessLevel, getScopedLocationFilter } = require('../../lib/inventory/inventoryAccess');
const { notifyByRoles, notifyUser } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

const emailRequester = async (userId, trigger, tokens, fallbackSubject, fallbackHtml) => {
  const user = await knex('users').where({ id: userId }).select('email').first();
  if (!user?.email) return;
  return sendTemplatedEmail({ trigger, to: user.email, tokens, fallbackSubject, fallbackHtml }).catch(() => {});
};

// Attaches *Name fields for whichever of requestedBy/approvedBy/rejectedBy/receivedBy
// are present on a transfer — without this the UI has no way to show who did what.
async function attachActorNames(transfers) {
  const userIds = [...new Set(transfers.flatMap((t) =>
    [t.requestedBy, t.approvedBy, t.rejectedBy, t.receivedBy].filter(Boolean)
  ))];
  const users = userIds.length ? await knex('users').whereIn('id', userIds).select('id', 'name') : [];
  const nameById = Object.fromEntries(users.map((u) => [u.id, u.name]));
  return transfers.map((t) => ({
    ...t,
    requestedByName: t.requestedBy ? nameById[t.requestedBy] || null : null,
    approvedByName: t.approvedBy ? nameById[t.approvedBy] || null : null,
    rejectedByName: t.rejectedBy ? nameById[t.rejectedBy] || null : null,
    receivedByName: t.receivedBy ? nameById[t.receivedBy] || null : null,
  }));
}

const listTransfers = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopeFilter = await getScopedLocationFilter(req.user, level);

  const { page, limit, skip } = getPagination(req.query);
  let query = knex('inventory_transfers');
  if (req.query.status) query = query.where({ status: req.query.status });
  if (scopeFilter) {
    const scopedLocations = await knex('inventory_locations').where(scopeFilter).select('id');
    const ids = scopedLocations.map((l) => l.id);
    query = query.where((qb) => qb.whereIn('fromLocationId', ids).orWhereIn('toLocationId', ids));
  }

  const [{ count }] = await query.clone().count('* as count');
  const transfers = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const locIds = [...new Set(transfers.flatMap((t) => [t.fromLocationId, t.toLocationId]))];
  const locations = locIds.length ? await knex('inventory_locations').whereIn('id', locIds).select('id', 'name') : [];
  const locMap = Object.fromEntries(locations.map((l) => [l.id, l]));
  const withLocations = transfers.map((t) => ({ ...t, fromLocation: locMap[t.fromLocationId] || null, toLocation: locMap[t.toLocationId] || null }));
  const enriched = await attachActorNames(withLocations);

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getTransfer = async (req, res) => {
  const transfer = await knex('inventory_transfers').where({ id: req.params.id }).first();
  if (!transfer) return returnFunction(res, 404, false, req.locale.notFound);

  const [fromLocation, toLocation, items] = await Promise.all([
    knex('inventory_locations').where({ id: transfer.fromLocationId }).select('name').first(),
    knex('inventory_locations').where({ id: transfer.toLocationId }).select('name').first(),
    knex('inventory_items').whereIn('id', transfer.items.map((i) => i.itemId)).select('id', 'sku', 'name', 'unitOfMeasure', 'trackingMode'),
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));
  const [enriched] = await attachActorNames([transfer]);

  return returnFunction(res, 200, true, req.locale.success, {
    ...enriched, fromLocation: fromLocation || null, toLocation: toLocation || null,
    items: transfer.items.map((line) => ({ ...line, item: itemMap[line.itemId] || null })),
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
    id: newId(),
    fromLocationId: req.body.fromLocationId,
    toLocationId: req.body.toLocationId,
    items: JSON.stringify(req.body.items.map((line) => ({
      itemId: line.itemId,
      quantity: Number(line.quantity),
      lotNumber: line.lotNumber || null,
    }))),
    status: 'requested',
    requestNotes: req.body.notes || null,
    requestedBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('inventory_transfers').insert(doc).returning('*');

  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Stock transfer requested',
    body: `A transfer was requested between locations — review it in Inventory.`,
    type: 'inventory',
    link: `/inventory/transfers/${saved.id}`,
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const approveTransfer = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin' && level !== 'clerk') return returnFunction(res, 403, false, 'Not authorized to approve transfers.');
  const transfer = await knex('inventory_transfers').where({ id: req.params.id }).first();
  if (!transfer) return returnFunction(res, 404, false, req.locale.notFound);
  if (transfer.status !== 'requested') return returnFunction(res, 400, false, 'Only a requested transfer can be approved.');
  // requestTransfer only requires SOME inventory access, not admin/clerk — a manager-level
  // requester who separately holds admin/clerk elsewhere must not be able to approve their
  // own request.
  if (transfer.requestedBy === req.user.id) {
    return returnFunction(res, 403, false, 'You cannot approve your own transfer request.');
  }
  await knex('inventory_transfers').where({ id: transfer.id }).update({ status: 'approved', approvedBy: req.user.id, approvedAt: new Date(), updatedAt: new Date() });
  notifyUser(transfer.requestedBy, {
    title: 'Transfer approved', body: 'Your stock transfer request was approved and is ready to be received.',
    type: 'inventory', link: `/inventory/transfers/${transfer.id}`,
  }).catch(() => {});
  emailRequester(transfer.requestedBy, 'inventoryTransferApproved', {}, 'Transfer approved',
    '<p>Your stock transfer request was approved and is ready to be received.</p>');
  return returnFunction(res, 200, true, 'Transfer approved.');
};

const rejectTransfer = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin' && level !== 'clerk') return returnFunction(res, 403, false, 'Not authorized to reject transfers.');
  const transfer = await knex('inventory_transfers').where({ id: req.params.id }).first();
  if (!transfer) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['requested', 'approved'].includes(transfer.status)) return returnFunction(res, 400, false, 'This transfer can no longer be rejected.');
  await knex('inventory_transfers').where({ id: transfer.id }).update({
    status: 'rejected', rejectedBy: req.user.id, rejectionReason: req.body.reason || null, updatedAt: new Date(),
  });
  notifyUser(transfer.requestedBy, {
    title: 'Transfer rejected',
    body: req.body.reason ? `Your stock transfer request was rejected. Reason: ${req.body.reason}` : 'Your stock transfer request was rejected.',
    type: 'inventory', link: `/inventory/transfers/${transfer.id}`,
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
    await completeInventoryTransfer(req.params.id, req.user.id);
  } catch (err) {
    return returnFunction(res, 400, false, err.message);
  }

  return returnFunction(res, 200, true, 'Transfer received — stock updated at both locations.');
};

module.exports = { listTransfers, getTransfer, requestTransfer, approveTransfer, rejectTransfer, receiveTransfer };
