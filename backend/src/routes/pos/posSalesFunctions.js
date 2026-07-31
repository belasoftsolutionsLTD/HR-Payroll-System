const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { deductStockForSale, returnStockFromSale, getStockLevel } = require('../../lib/inventory/inventoryIntegration');
const { getPosAccessLevel, getScopedPosLocationIds } = require('../../lib/pos/posAccess');
const { getMyOpenSession } = require('./posRegisterFunctions');
const { resolvePromoCode } = require('./posDiscountsFunctions');
const { resolveVoucher } = require('./posVouchersFunctions');
const { generateReceiptPDF } = require('../../services/posReceiptService');
const { postJournalEntry, reverseJournalEntry, resolveSystemAccount } = require('../../lib/accounting/glEngine');
const { logPostingFailure } = require('../accounting/accountingPostingFailuresFunctions');

const round2 = (n) => Math.round(n * 100) / 100;

// Card/M-Pesa settle through a processor rather than landing as physical cash-on-hand,
// so they resolve to their own clearing accounts rather than a shared Cash account.
const POS_PAYMENT_SYSTEM_KEYS = { cash: 'cash', card: 'pos_card_clearing', mpesa: 'pos_mpesa_clearing' };

// Compound entry: payment debits + (voucher expense, if any) balance against Sales
// Revenue + Tax Payable credits, plus a COGS/Inventory Asset sub-pair sourced from the
// stock movements deductStockForSale already created for this sale (never re-derived
// from the item's CURRENT avgCost, which drifts after the fact). Never blocks the sale
// itself — any failure here is queued to gl_posting_failures for admin retry.
async function postSaleJournalEntry(saleDoc, saleId, postedBy) {
  const netSales = round2(saleDoc.subtotal - saleDoc.autoDiscountTotal - saleDoc.lineDiscountTotal - saleDoc.cartDiscountAmount);
  const location = await findOne('inventory_locations', { _id: saleDoc.locationId }, { projection: { department: 1 } });
  const movements = await findMany('inventory_stock_movements', { referenceId: saleId, referenceModel: 'pos_sale', movementType: 'sale' }, {});
  const cogsAmount = round2(movements.reduce((s, m) => s + Math.abs(m.quantityChange) * (m.unitCost || 0), 0));

  const lines = [];
  for (const p of saleDoc.payments) {
    const acct = await resolveSystemAccount(POS_PAYMENT_SYSTEM_KEYS[p.method] || 'cash');
    lines.push({ accountId: acct._id, debit: p.amount });
  }
  if (saleDoc.voucherAmount > 0) {
    const voucherAcct = await resolveSystemAccount('voucher_expense');
    lines.push({ accountId: voucherAcct._id, debit: saleDoc.voucherAmount });
  }
  const revenueAcct = await resolveSystemAccount('sales_revenue');
  lines.push({ accountId: revenueAcct._id, credit: netSales });
  if (saleDoc.taxTotal > 0) {
    const taxAcct = await resolveSystemAccount('tax_payable');
    lines.push({ accountId: taxAcct._id, credit: saleDoc.taxTotal });
  }
  if (cogsAmount > 0) {
    const cogsAcct = await resolveSystemAccount('cogs');
    const invAcct = await resolveSystemAccount('inventory_asset');
    lines.push({ accountId: cogsAcct._id, debit: cogsAmount });
    lines.push({ accountId: invAcct._id, credit: cogsAmount });
  }

  const payload = {
    date: saleDoc.createdAt, description: `POS sale ${saleDoc.saleNumber}`, source: 'pos_sale', sourceModule: 'pos',
    referenceId: saleId, referenceModel: 'pos_sales', lines, department: location?.department || null,
  };
  try {
    await postJournalEntry({ ...payload, postedBy });
  } catch (err) {
    await logPostingFailure({ source: 'pos_sale', sourceModule: 'pos', referenceId: saleId, referenceModel: 'pos_sales', attemptedPayload: payload, error: err });
  }
}

const generateSaleNumber = async () => {
  const year = new Date().getFullYear();
  const result = await global.dbo.collection('counters').findOneAndUpdate(
    { _id: `pos_sale_number_${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return `SALE-${year}-${String(result.seq).padStart(6, '0')}`;
};

// Pure pricing math — no I/O — so the same computation can be unit-tested and reused by
// both createSale and any future "preview total" endpoint the register screen might want.
//
// Calculation order (fixed, must match the frontend's client-side duplicate of this
// math exactly, or totals visibly disagree by cents): per-line auto-discount (from the
// item's own discountType/discountValue) -> per-line manual discount (line.discountAmount,
// stacks additively on top of auto-discount, entered by the cashier) -> cart-level
// discount/promo (allocated pro-rata across lines, since it applies to the whole cart
// but tax is per-item-rate) -> tax, computed per line on what's left after every
// discount so a cart mixing standard/zero-rated/exempt items taxes each line correctly.
function computeSaleTotals(items, cartDiscount) {
  const lines = items.map((line) => {
    const lineSubtotal = round2(line.quantity * line.unitPrice);
    let autoDiscount = 0;
    if (line.discountType === 'percentage') {
      autoDiscount = round2(lineSubtotal * (Number(line.discountValue) || 0) / 100);
    } else if (line.discountType === 'fixed') {
      autoDiscount = round2(Math.min((Number(line.discountValue) || 0) * line.quantity, lineSubtotal));
    }
    const manualDiscount = round2(Math.min(line.discountAmount || 0, Math.max(0, lineSubtotal - autoDiscount)));
    const lineDiscount = round2(Math.min(autoDiscount + manualDiscount, lineSubtotal));
    const lineAfterDiscount = round2(lineSubtotal - lineDiscount);
    return { ...line, lineSubtotal, autoDiscount, manualDiscount, lineDiscount, lineAfterDiscount };
  });

  const subtotal = round2(lines.reduce((s, l) => s + l.lineSubtotal, 0));
  const autoDiscountTotal = round2(lines.reduce((s, l) => s + l.autoDiscount, 0));
  const lineDiscountTotal = round2(lines.reduce((s, l) => s + l.manualDiscount, 0));
  const afterLineDiscounts = round2(subtotal - autoDiscountTotal - lineDiscountTotal);

  let cartDiscountAmount = 0;
  if (cartDiscount?.type === 'percentage') cartDiscountAmount = round2(afterLineDiscounts * (Number(cartDiscount.value) || 0) / 100);
  else if (cartDiscount?.type === 'fixed') cartDiscountAmount = round2(Math.min(Number(cartDiscount.value) || 0, afterLineDiscounts));

  // Cart-level discount is allocated back to each line pro-rata (by its post-line-discount
  // share of the cart) purely so tax can still be computed per line at the item's own rate.
  let taxTotal = 0;
  const pricedLines = lines.map((l) => {
    const cartShare = afterLineDiscounts > 0 ? round2((l.lineAfterDiscount / afterLineDiscounts) * cartDiscountAmount) : 0;
    const lineFinal = Math.max(0, round2(l.lineAfterDiscount - cartShare));
    const lineTax = round2(lineFinal * (Number(l.taxRate) || 0) / 100);
    taxTotal = round2(taxTotal + lineTax);
    // lineTotal keeps its original meaning (post-discount, pre-tax) for the receipt's
    // existing per-line row; lineFinal/lineTax are the new post-cart-discount/tax figures.
    return { ...l, lineTotal: l.lineAfterDiscount, lineFinal, lineTax };
  });

  const total = Math.max(0, round2(afterLineDiscounts - cartDiscountAmount + taxTotal));
  return { lines: pricedLines, subtotal, autoDiscountTotal, lineDiscountTotal, cartDiscountAmount, taxTotal, total };
}

// The checkout path. Every stock effect goes through Inventory's own
// deductStockForSale/returnStockFromSale — nothing here touches inventory_stock_levels
// or inventory_stock_movements directly, per the module's one hard rule.
const createSale = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  const session = await getMyOpenSession(req.user._id);
  if (!session) return returnFunction(res, 400, false, 'Open a register session before starting a sale.');

  const { items, cartDiscount, payments, promoCode, voucherCode, contactId } = req.body;
  if (!Array.isArray(items) || !items.length) return returnFunction(res, 400, false, 'Cart is empty.');
  if (!Array.isArray(payments) || !payments.length) return returnFunction(res, 400, false, 'At least one payment is required.');
  for (const p of payments) {
    if (!['cash', 'card', 'mpesa'].includes(p.method) || !(Number(p.amount) > 0)) {
      return returnFunction(res, 400, false, 'Each payment needs a method (cash/card/mpesa) and a positive amount.');
    }
  }

  const itemIds = items.map((l) => new ObjectId(l.itemId));
  const itemDocs = await findMany('inventory_items', { _id: { $in: itemIds } }, {});
  const itemById = Object.fromEntries(itemDocs.map((i) => [String(i._id), i]));
  for (const line of items) {
    if (!itemById[String(line.itemId)]) return returnFunction(res, 400, false, `Item ${line.itemId} not found.`);
    if (!(Number(line.quantity) > 0)) return returnFunction(res, 400, false, 'Every line needs a positive quantity.');
  }

  // Real-time stock check — a live warning pass BEFORE anything is written. The actual
  // deduction below still has its own authoritative guard (createStockMovement throws
  // on negative balance) to cover the race window between this check and the deduction.
  const shortages = [];
  for (const line of items) {
    const item = itemById[String(line.itemId)];
    if (!item.isTracked) continue;
    const available = await getStockLevel(line.itemId, session.locationId);
    if (available < Number(line.quantity)) shortages.push({ itemId: line.itemId, name: item.name, available, requested: line.quantity });
  }
  if (shortages.length) return returnFunction(res, 409, false, 'Not enough stock for one or more items.', { shortages });

  let resolvedCartDiscount = cartDiscount || null;
  let appliedPromo = null;
  if (promoCode) {
    appliedPromo = await resolvePromoCode(promoCode);
    if (!appliedPromo) return returnFunction(res, 400, false, 'Invalid or expired promo code.');
    resolvedCartDiscount = { type: appliedPromo.discountType, value: appliedPromo.discountValue };
  }

  const pricedItems = items.map((line) => {
    const item = itemById[String(line.itemId)];
    return {
      itemId: new ObjectId(line.itemId),
      sku: item.sku,
      name: item.name,
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPrice ?? item.salePrice ?? 0),
      discountAmount: Number(line.discountAmount) || 0,
      discountType: item.discountType || null,
      discountValue: item.discountValue || 0,
      taxRate: item.taxRate || 0,
    };
  });
  const { lines, subtotal, autoDiscountTotal, lineDiscountTotal, cartDiscountAmount, taxTotal, total: totalBeforeVoucher } = computeSaleTotals(pricedItems, resolvedCartDiscount);

  // A voucher pays for the transaction, not the margin — it's applied AFTER tax (unlike
  // a promo code, which lowers the pre-tax total as a discount). The two can legitimately
  // coexist on one sale: a promo code shrinks what's owed, a voucher then pays some of it.
  let appliedVoucher = null;
  if (voucherCode) {
    appliedVoucher = await resolveVoucher(voucherCode);
    if (!appliedVoucher) return returnFunction(res, 400, false, 'Invalid, expired, or already-redeemed voucher code.');
  }
  const voucherAmount = appliedVoucher ? round2(Math.min(appliedVoucher.value, totalBeforeVoucher)) : 0;
  const total = round2(totalBeforeVoucher - voucherAmount);

  const paymentsTotal = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
  if (Math.abs(paymentsTotal - total) > 0.01) {
    return returnFunction(res, 400, false, `Payments (${paymentsTotal}) must add up to the total (${total}).`);
  }

  const saleNumber = await generateSaleNumber();
  const saleDoc = {
    saleNumber,
    locationId: session.locationId,
    registerSessionId: session._id,
    // Optional — POS itself never requires a customer identity (walk-up retail sales
    // are anonymous by default). When the register screen links a sale to a CRM
    // contact, this is the only field that connects the two modules; CRM reads it
    // read-only via findMany('pos_sales', { contactId }), nothing here writes to CRM.
    contactId: contactId ? new ObjectId(contactId) : null,
    items: lines.map((l) => ({
      itemId: l.itemId, sku: l.sku, name: l.name, quantity: l.quantity,
      unitPrice: l.unitPrice, discountAmount: l.lineDiscount, autoDiscountAmount: l.autoDiscount,
      lineTotal: l.lineTotal, taxRate: l.taxRate, taxAmount: l.lineTax,
      refundedQuantity: 0,
    })),
    cartDiscount: resolvedCartDiscount ? { ...resolvedCartDiscount, amount: cartDiscountAmount } : null,
    promoCode: appliedPromo?.code || null,
    voucherCode: appliedVoucher?.code || null,
    voucherAmount,
    subtotal, autoDiscountTotal, lineDiscountTotal, cartDiscountAmount, taxTotal, total,
    // cashTendered/changeDue are purely informational (what the customer physically
    // handed over vs. what was actually applied to the sale) — they never affect the
    // paymentsTotal === total balance check above, only the receipt record.
    payments: payments.map((p) => {
      const leg = { method: p.method, amount: round2(Number(p.amount)) };
      if (p.method === 'cash' && p.cashTendered !== undefined && p.cashTendered !== null && p.cashTendered !== '') {
        const cashTendered = round2(Number(p.cashTendered));
        leg.cashTendered = cashTendered;
        leg.changeDue = round2(Math.max(0, cashTendered - leg.amount));
      }
      if (p.method === 'mpesa') {
        if (p.phoneNumber) leg.phoneNumber = String(p.phoneNumber).trim();
        if (p.reference) leg.reference = String(p.reference).trim();
      }
      return leg;
    }),
    status: 'completed',
    staffId: req.user._id,
    staffName: req.user.name,
    createdAt: new Date(),
  };
  const result = await insertOne('pos_sales', saleDoc);
  const saleId = result.insertedId;

  // Redeem the voucher now that the sale exists — a sale void does NOT un-redeem it
  // (deliberate, mirrors how promo codes aren't usage-tracked/reversed either), so this
  // is a one-way mark, not part of the rollback path below.
  if (appliedVoucher) {
    await updateOne('pos_vouchers', { _id: appliedVoucher._id }, { $set: { redeemedAt: new Date(), redeemedSaleId: saleId, updatedAt: new Date() } });
  }

  // Deduct stock line by line; if one fails (a genuine race — e.g. two cashiers sold the
  // last unit at the same instant), roll back everything already deducted for THIS sale
  // and mark it failed rather than leaving a half-deducted sale on the books.
  const deducted = [];
  try {
    for (const line of saleDoc.items) {
      const movement = await deductStockForSale(line.itemId, session.locationId, line.quantity, saleId, req.user._id);
      if (movement) deducted.push(line);
    }
  } catch (err) {
    for (const line of deducted) {
      await returnStockFromSale(line.itemId, session.locationId, line.quantity, saleId, req.user._id).catch(() => {});
    }
    await updateOne('pos_sales', { _id: saleId }, { $set: { status: 'failed', failureReason: err.message } });
    return returnFunction(res, 409, false, `Sale could not be completed: ${err.message}`);
  }

  await postSaleJournalEntry(saleDoc, saleId, req.user._id);

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: saleId, ...saleDoc });
};

const getSale = async (req, res) => {
  const sale = await findOne('pos_sales', { _id: new ObjectId(req.params.id) });
  if (!sale) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, sale);
};

const listSales = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scopedLocationIds = await getScopedPosLocationIds(req.user, level);

  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.locationId) filter.locationId = new ObjectId(req.query.locationId);
  else if (scopedLocationIds) filter.locationId = { $in: scopedLocationIds.map((id) => new ObjectId(id)) };
  if (req.query.staffId) filter.staffId = new ObjectId(req.query.staffId);
  if (req.query.contactId) filter.contactId = new ObjectId(req.query.contactId);
  if (req.query.status) filter.status = req.query.status;
  if (req.query.startDate || req.query.endDate) {
    filter.createdAt = {};
    if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
  }
  // Plain staff only ever see their own sales, even within a scoped location.
  if (level === 'staff') filter.staffId = req.user._id;

  const [total, sales] = await Promise.all([
    countDocuments('pos_sales', filter),
    findMany('pos_sales', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(sales, total, page, limit));
};

// Same-calendar-day, manager-or-above only — a full reversal of the sale (every line's
// stock returned, payments left on the record for the audit trail but status flips to
// 'voided'). Staff cannot call this at all; a manager performs it themselves, which is
// this codebase's usual way of expressing "requires manager approval" for an action
// (see Inventory's PO close, Leave's approve step) rather than a separate request queue.
const voidSale = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'Voiding a sale requires manager approval.');

  const sale = await findOne('pos_sales', { _id: new ObjectId(req.params.id) });
  if (!sale) return returnFunction(res, 404, false, req.locale.notFound);
  if (sale.status !== 'completed') return returnFunction(res, 400, false, 'Only a completed sale can be voided.');

  const sameDay = new Date(sale.createdAt).toDateString() === new Date().toDateString();
  if (!sameDay) return returnFunction(res, 400, false, 'A sale can only be voided on the same day it was made — use a refund instead.');

  for (const line of sale.items) {
    await returnStockFromSale(line.itemId, sale.locationId, line.quantity - line.refundedQuantity, sale._id, req.user._id).catch(() => {});
  }
  await updateOne('pos_sales', { _id: sale._id }, {
    $set: { status: 'voided', voidedBy: req.user._id, voidedAt: new Date(), voidReason: req.body.reason || null },
  });

  // Direct reuse of the reversal primitive — no bespoke logic needed. Never blocks the
  // void itself; a missing/already-reversed entry just gets queued for admin attention.
  try {
    const saleEntry = await findOne('gl_journal_entries', { referenceId: sale._id, referenceModel: 'pos_sales', source: 'pos_sale', status: 'posted' });
    if (saleEntry) await reverseJournalEntry(saleEntry._id, { reason: 'Sale voided', postedBy: req.user._id });
  } catch (err) {
    await logPostingFailure({ source: 'pos_sale_void', sourceModule: 'pos', referenceId: sale._id, referenceModel: 'pos_sales', attemptedPayload: {}, error: err });
  }

  return returnFunction(res, 200, true, 'Sale voided and stock restored.');
};

const getReceipt = async (req, res) => {
  const sale = await findOne('pos_sales', { _id: new ObjectId(req.params.id) });
  if (!sale) return returnFunction(res, 404, false, req.locale.notFound);
  const [location, settings] = await Promise.all([
    findOne('inventory_locations', { _id: sale.locationId }, { projection: { name: 1 } }),
    findOne('company_settings', {}),
  ]);
  const pdfBuffer = await generateReceiptPDF(sale, { companyName: settings?.companyName, location, logoPath: settings?.logoPath });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${sale.saleNumber}.pdf"`);
  return res.send(pdfBuffer);
};

module.exports = { computeSaleTotals, createSale, getSale, listSales, voidSale, getReceipt };
