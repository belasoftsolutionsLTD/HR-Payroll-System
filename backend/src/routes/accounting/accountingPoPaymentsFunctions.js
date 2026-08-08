// Postgres migration (Phase 6) — inventory_purchase_orders/inventory_suppliers/
// inventory_locations are Postgres now; `users` has been Postgres since Phase 1. This
// file belongs to Accounting (Phase 7, not yet converted — getAccountingAccessLevel
// still reads employees off the Mongo helper, a pre-existing Phase-1 gap left for that
// phase to fix), but it directly touches inventory_purchase_orders, which Phase 6 just
// migrated — fixed now rather than left broken, same "don't leave a call site broken
// just because its file belongs to a later phase" rule every phase so far has followed.
// gl_accounts/gl_journal_entries (via glEngine) are still Mongo — left untouched.
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');
const { postJournalEntry, resolveSystemAccount } = require('../../lib/accounting/glEngine');
const { resolvePaymentSystemKey } = require('../../lib/accounting/paymentMethodAccounts');
const { logPostingFailure } = require('./accountingPostingFailuresFunctions');

const round2 = (n) => Math.round(n * 100) / 100;

// Purchase orders Inventory has requested payment on but Accounting hasn't released
// yet — separation of duties: Inventory can REQUEST (method, reference, evidence) via
// inventoryPurchaseOrdersFunctions.requestPoPayment, but only Accounting can approve the
// actual AP payment entry, and never the same person who made the request.
const listPendingPoPayments = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const pos = await knex('inventory_purchase_orders').where({ status: 'pending_payment_approval' }).orderBy('paymentRequestedAt', 'asc');

  const supplierIds = [...new Set(pos.map((p) => p.supplierId))];
  const locationIds = [...new Set(pos.map((p) => p.locationId))];
  const requesterIds = [...new Set(pos.map((p) => p.paymentRequestedBy).filter(Boolean))];
  const [suppliers, locations, requesters] = await Promise.all([
    supplierIds.length ? knex('inventory_suppliers').whereIn('id', supplierIds).select('id', 'name') : [],
    locationIds.length ? knex('inventory_locations').whereIn('id', locationIds).select('id', 'name') : [],
    requesterIds.length ? knex('users').whereIn('id', requesterIds).select('id', 'name') : [],
  ]);
  const supplierMap = Object.fromEntries(suppliers.map((s) => [s.id, s.name]));
  const locationMap = Object.fromEntries(locations.map((l) => [l.id, l.name]));
  const requesterMap = Object.fromEntries(requesters.map((u) => [u.id, u.name]));

  const enriched = pos.map((p) => ({
    ...p,
    supplierName: supplierMap[p.supplierId] || null,
    locationName: locationMap[p.locationId] || null,
    paymentRequestedByName: p.paymentRequestedBy ? requesterMap[p.paymentRequestedBy] || null : null,
    amountDue: round2(p.items.reduce((s, l) => s + l.quantityReceived * l.unitCost, 0)),
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const approvePoPayment = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');

  const po = await knex('inventory_purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'pending_payment_approval') return returnFunction(res, 400, false, 'This purchase order has no pending payment request.');
  if (po.paymentRequestedBy && po.paymentRequestedBy === req.user.id) {
    return returnFunction(res, 403, false, 'You cannot approve a payment you requested yourself — ask another Accounting user to review it.');
  }

  // No partial-payment concept exists on a PO, so the amount paid is simply the full
  // received value — the same figure already recognized as a liability across one or
  // more receivePurchaseOrder calls.
  const amountPaid = round2(po.items.reduce((s, l) => s + l.quantityReceived * l.unitCost, 0));
  const payload = {
    date: new Date(), description: `PO payment — ${po.poNumber}${po.paymentReference ? ` (${po.paymentReference})` : ''}`, source: 'inventory_po_payment', sourceModule: 'inventory',
    referenceId: po.id, referenceModel: 'inventory_purchase_orders', department: null, lines: [],
  };
  if (amountPaid > 0) {
    try {
      const location = await knex('inventory_locations').where({ id: po.locationId }).select('department').first();
      payload.department = location?.department || null;
      const apAcct = await resolveSystemAccount('accounts_payable');
      const paymentAcct = await resolveSystemAccount(resolvePaymentSystemKey(po.paymentMethod));
      payload.lines = [{ accountId: apAcct._id, debit: amountPaid }, { accountId: paymentAcct._id, credit: amountPaid }];
      await postJournalEntry({ ...payload, postedBy: req.user._id });
    } catch (err) {
      await logPostingFailure({ source: 'inventory_po_payment', sourceModule: 'inventory', referenceId: po.id, referenceModel: 'inventory_purchase_orders', attemptedPayload: payload, error: err });
      return returnFunction(res, 400, false, `Could not post payment entry: ${err.message}`);
    }
  }

  await knex('inventory_purchase_orders').where({ id: po.id }).update({
    status: 'closed',
    paymentStatus: 'paid',
    closedAt: new Date(),
    paidAt: new Date(),
    paymentApprovedBy: req.user.id,
    paymentApprovedAt: new Date(),
    updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Payment approved and posted.');
};

const rejectPoPayment = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');

  const po = await knex('inventory_purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'pending_payment_approval') return returnFunction(res, 400, false, 'This purchase order has no pending payment request.');

  await knex('inventory_purchase_orders').where({ id: po.id }).update({
    status: 'received',
    paymentStatus: 'rejected',
    paymentRejectionReason: req.body.reason || null,
    paymentRejectedBy: req.user.id,
    paymentRejectedAt: new Date(),
    updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Payment request rejected — sent back to Inventory.');
};

module.exports = { listPendingPoPayments, approvePoPayment, rejectPoPayment };
