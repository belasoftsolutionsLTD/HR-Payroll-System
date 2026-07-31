const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findOne, findMany, updateOne } = require('../../functions/Database/commonDBFunctions');
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
  const pos = await findMany('inventory_purchase_orders', { status: 'pending_payment_approval' }, { sort: { paymentRequestedAt: 1 } });

  const supplierIds = [...new Set(pos.map((p) => String(p.supplierId)))].map((id) => new ObjectId(id));
  const locationIds = [...new Set(pos.map((p) => String(p.locationId)))].map((id) => new ObjectId(id));
  const requesterIds = [...new Set(pos.map((p) => String(p.paymentRequestedBy)).filter(Boolean))].map((id) => new ObjectId(id));
  const [suppliers, locations, requesters] = await Promise.all([
    supplierIds.length ? findMany('inventory_suppliers', { _id: { $in: supplierIds } }, { projection: { name: 1 } }) : [],
    locationIds.length ? findMany('inventory_locations', { _id: { $in: locationIds } }, { projection: { name: 1 } }) : [],
    requesterIds.length ? findMany('users', { _id: { $in: requesterIds } }, { projection: { name: 1 } }) : [],
  ]);
  const supplierMap = Object.fromEntries(suppliers.map((s) => [String(s._id), s.name]));
  const locationMap = Object.fromEntries(locations.map((l) => [String(l._id), l.name]));
  const requesterMap = Object.fromEntries(requesters.map((u) => [String(u._id), u.name]));

  const enriched = pos.map((p) => ({
    ...p,
    supplierName: supplierMap[String(p.supplierId)] || null,
    locationName: locationMap[String(p.locationId)] || null,
    paymentRequestedByName: p.paymentRequestedBy ? requesterMap[String(p.paymentRequestedBy)] || null : null,
    amountDue: round2(p.items.reduce((s, l) => s + l.quantityReceived * l.unitCost, 0)),
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const approvePoPayment = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');

  const po = await findOne('inventory_purchase_orders', { _id: new ObjectId(req.params.id) });
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'pending_payment_approval') return returnFunction(res, 400, false, 'This purchase order has no pending payment request.');
  if (po.paymentRequestedBy && String(po.paymentRequestedBy) === String(req.user._id)) {
    return returnFunction(res, 403, false, 'You cannot approve a payment you requested yourself — ask another Accounting user to review it.');
  }

  // No partial-payment concept exists on a PO, so the amount paid is simply the full
  // received value — the same figure already recognized as a liability across one or
  // more receivePurchaseOrder calls.
  const amountPaid = round2(po.items.reduce((s, l) => s + l.quantityReceived * l.unitCost, 0));
  const payload = {
    date: new Date(), description: `PO payment — ${po.poNumber}${po.paymentReference ? ` (${po.paymentReference})` : ''}`, source: 'inventory_po_payment', sourceModule: 'inventory',
    referenceId: po._id, referenceModel: 'inventory_purchase_orders', department: null, lines: [],
  };
  if (amountPaid > 0) {
    try {
      const location = await findOne('inventory_locations', { _id: po.locationId }, { projection: { department: 1 } });
      payload.department = location?.department || null;
      const apAcct = await resolveSystemAccount('accounts_payable');
      const paymentAcct = await resolveSystemAccount(resolvePaymentSystemKey(po.paymentMethod));
      payload.lines = [{ accountId: apAcct._id, debit: amountPaid }, { accountId: paymentAcct._id, credit: amountPaid }];
      await postJournalEntry({ ...payload, postedBy: req.user._id });
    } catch (err) {
      await logPostingFailure({ source: 'inventory_po_payment', sourceModule: 'inventory', referenceId: po._id, referenceModel: 'inventory_purchase_orders', attemptedPayload: payload, error: err });
      return returnFunction(res, 400, false, `Could not post payment entry: ${err.message}`);
    }
  }

  await updateOne('inventory_purchase_orders', { _id: po._id }, {
    $set: {
      status: 'closed',
      paymentStatus: 'paid',
      closedAt: new Date(),
      paidAt: new Date(),
      paymentApprovedBy: req.user._id,
      paymentApprovedAt: new Date(),
      updatedAt: new Date(),
    },
  });
  return returnFunction(res, 200, true, 'Payment approved and posted.');
};

const rejectPoPayment = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');

  const po = await findOne('inventory_purchase_orders', { _id: new ObjectId(req.params.id) });
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'pending_payment_approval') return returnFunction(res, 400, false, 'This purchase order has no pending payment request.');

  await updateOne('inventory_purchase_orders', { _id: po._id }, {
    $set: {
      status: 'received',
      paymentStatus: 'rejected',
      paymentRejectionReason: req.body.reason || null,
      paymentRejectedBy: req.user._id,
      paymentRejectedAt: new Date(),
      updatedAt: new Date(),
    },
  });
  return returnFunction(res, 200, true, 'Payment request rejected — sent back to Inventory.');
};

module.exports = { listPendingPoPayments, approvePoPayment, rejectPoPayment };
