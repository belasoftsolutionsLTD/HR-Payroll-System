// Postgres migration (Phase 6) — inventory_purchase_orders/inventory_suppliers/
// inventory_locations/inventory_items are Postgres now. The `counters` table stays the
// same transactional-upsert pattern established in Phase 1 (staffNumberGenerator.js),
// not the old Mongo findOneAndUpdate($inc). `company_settings` (used by sendPurchaseOrder
// for PDF branding) is still Mongo — Phase 10 — left untouched.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const { findOne } = require('../../functions/Database/commonDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { createStockMovement } = require('./inventoryMovementsFunctions');
const { receiveLotStock } = require('./inventoryLotsFunctions');
const { sendEmail } = require('../../services/emailService');
const { generatePurchaseOrderPDF } = require('../../services/poService');
const { postJournalEntry, resolveSystemAccount } = require('../../lib/accounting/glEngine');
const { logPostingFailure } = require('../accounting/accountingPostingFailuresFunctions');

const round2 = (n) => Math.round(n * 100) / 100;

const nextCounterSeq = async (key) => {
  const [row] = await knex('counters')
    .insert({ id: key, seq: 1 })
    .onConflict('id')
    .merge({ seq: knex.raw('"counters"."seq" + 1') })
    .returning('*');
  return row.seq;
};

const generatePONumber = async () => {
  const year = new Date().getFullYear();
  const seq = await nextCounterSeq(`inventory_po_number_${year}`);
  return `PO-${year}-${String(seq).padStart(5, '0')}`;
};

// Short, scannable location code for the invoice-numbering scheme below —
// "Main Warehouse" -> "MW" — purely cosmetic, not part of the uniqueness
// guarantee (the counter is what makes the number unique). Inventory POs have
// no department field to key off (unlike Procurement's), so the delivery
// location is the closest scoping concept a PO already has.
function locationCode(name) {
  if (!name) return 'GEN';
  const words = name.trim().split(/\s+/);
  return (words.length === 1 ? words[0].slice(0, 3) : words.map((w) => w[0]).join('').slice(0, 4)).toUpperCase();
}

// Our own internal reference for a supplier invoice logged against a PO —
// deliberately separate from the supplier's own invoice number (still
// captured as-is) so the number alone says "this is a PO invoice, from this
// location": PO-MW-2026-00001.
const generatePOInvoiceNumber = async (locationName) => {
  const year = new Date().getFullYear();
  const seq = await nextCounterSeq(`inventory_po_invoice_number_${year}`);
  return `PO-${locationCode(locationName)}-${year}-${String(seq).padStart(5, '0')}`;
};

const listPurchaseOrders = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  let query = knex('inventory_purchase_orders');
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.supplierId) query = query.where({ supplierId: req.query.supplierId });

  const [{ count }] = await query.clone().count('* as count');
  const pos = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const supplierIds = [...new Set(pos.map((p) => p.supplierId))];
  const suppliers = supplierIds.length
    ? await knex('inventory_suppliers').whereIn('id', supplierIds).select('id', 'name')
    : [];
  const supplierMap = Object.fromEntries(suppliers.map((s) => [s.id, s]));
  const enriched = pos.map((p) => ({ ...p, supplier: supplierMap[p.supplierId] || null }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getPurchaseOrder = async (req, res) => {
  const po = await knex('inventory_purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);

  const [supplier, location, items] = await Promise.all([
    knex('inventory_suppliers').where({ id: po.supplierId }).select('name', 'leadTimeDays').first(),
    knex('inventory_locations').where({ id: po.locationId }).select('name').first(),
    knex('inventory_items').whereIn('id', po.items.map((i) => i.itemId)).select('id', 'sku', 'name', 'unitOfMeasure', 'trackingMode'),
  ]);
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));

  return returnFunction(res, 200, true, req.locale.success, {
    ...po,
    supplier: supplier || null,
    location: location || null,
    items: po.items.map((line) => ({ ...line, item: itemMap[line.itemId] || null })),
  });
};

const createPurchaseOrder = async (req, res) => {
  if (!validateRequiredFields(req, res, ['supplierId', 'locationId', 'items'])) return;
  if (!Array.isArray(req.body.items) || !req.body.items.length) {
    return returnFunction(res, 400, false, 'At least one item line is required.');
  }
  for (const line of req.body.items) {
    if (!line.itemId || !line.quantityOrdered || Number(line.quantityOrdered) <= 0) {
      return returnFunction(res, 400, false, 'Every line needs an itemId and a positive quantityOrdered.');
    }
  }

  const poNumber = await generatePONumber();
  const doc = {
    id: newId(),
    poNumber,
    supplierId: req.body.supplierId,
    locationId: req.body.locationId,
    items: JSON.stringify(req.body.items.map((line) => ({
      itemId: line.itemId,
      quantityOrdered: Number(line.quantityOrdered),
      quantityReceived: 0,
      unitCost: Number(line.unitCost) || 0,
    }))),
    status: 'draft',
    expectedDeliveryDate: req.body.expectedDeliveryDate ? new Date(req.body.expectedDeliveryDate) : null,
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('inventory_purchase_orders').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updatePurchaseOrder = async (req, res) => {
  const po = await knex('inventory_purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'draft') return returnFunction(res, 400, false, 'Only a draft purchase order can be edited.');

  const update = { updatedAt: new Date() };
  if (req.body.supplierId) update.supplierId = req.body.supplierId;
  if (req.body.locationId) update.locationId = req.body.locationId;
  if (req.body.expectedDeliveryDate !== undefined) update.expectedDeliveryDate = req.body.expectedDeliveryDate ? new Date(req.body.expectedDeliveryDate) : null;
  if (Array.isArray(req.body.items) && req.body.items.length) {
    update.items = JSON.stringify(req.body.items.map((line) => ({
      itemId: line.itemId,
      quantityOrdered: Number(line.quantityOrdered),
      quantityReceived: 0,
      unitCost: Number(line.unitCost) || 0,
    })));
  }
  await knex('inventory_purchase_orders').where({ id: po.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const sendPurchaseOrder = async (req, res) => {
  const po = await knex('inventory_purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'draft') return returnFunction(res, 400, false, 'Only a draft purchase order can be sent.');
  await knex('inventory_purchase_orders').where({ id: po.id }).update({ status: 'pending', sentAt: new Date(), updatedAt: new Date() });

  const [supplier, location, itemDocs] = await Promise.all([
    knex('inventory_suppliers').where({ id: po.supplierId }).first(),
    knex('inventory_locations').where({ id: po.locationId }).select('name', 'address').first(),
    knex('inventory_items').whereIn('id', po.items.map((l) => l.itemId)).select('id', 'sku', 'name', 'unitOfMeasure'),
  ]);

  if (supplier?.email) {
    const itemById = Object.fromEntries(itemDocs.map((i) => [i.id, i]));
    const rows = po.items.map((line) => {
      const item = itemById[line.itemId];
      const lineTotal = line.quantityOrdered * line.unitCost;
      return `<tr><td>${item?.name || 'Item'}${item?.sku ? ` (${item.sku})` : ''}</td><td>${line.quantityOrdered} ${item?.unitOfMeasure || ''}</td><td>${line.unitCost.toLocaleString()}</td><td>${lineTotal.toLocaleString()}</td></tr>`;
    }).join('');
    const orderTotal = po.items.reduce((sum, l) => sum + l.quantityOrdered * l.unitCost, 0);

    // The table in the email body is a quick preview — a real PDF is attached so the
    // supplier has something they can actually file/print, not just read on screen.
    const companySettings = await findOne('company_settings', {});
    const branding = { companyName: companySettings?.companyName, logoPath: companySettings?.logoPath };
    let attachments = [];
    try {
      const pdfBuffer = await generatePurchaseOrderPDF(po, supplier, location, itemById, branding);
      attachments = [{ filename: `${po.poNumber}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }];
    } catch (err) {
      console.error(`PO PDF generation failed for ${po.poNumber}:`, err.message);
    }

    sendEmail({
      to: supplier.email,
      subject: `Purchase Order ${po.poNumber}`,
      html: `<p>Dear ${supplier.contactPerson || supplier.name},</p><p>Please find below purchase order <strong>${po.poNumber}</strong>${location?.name ? `, for delivery to <strong>${location.name}</strong>` : ''}${po.expectedDeliveryDate ? `, expected by <strong>${new Date(po.expectedDeliveryDate).toLocaleDateString()}</strong>` : ''} — a PDF copy is attached for your records.</p>${location?.address ? `<p><strong>Delivery address:</strong> ${location.address}</p>` : ''}<table cellpadding="6" style="border-collapse:collapse;width:100%"><thead><tr style="text-align:left;border-bottom:1px solid #ccc"><th>Item</th><th>Qty</th><th>Unit Cost</th><th>Line Total</th></tr></thead><tbody>${rows}</tbody></table><p><strong>Order total: ${orderTotal.toLocaleString()}</strong></p><p>Please confirm receipt and let us know if you have any questions.</p>`,
      attachments,
    }).catch(() => {});
  }

  return returnFunction(res, 200, true, 'Purchase order sent.');
};

// The supplier acknowledges a PO by sending us their invoice for it — logging that
// invoice here is what moves the PO forward, mirroring how it works in practice
// (nothing to receive until they've confirmed what they're billing us for and shipping).
const logSupplierInvoice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['invoiceNumber'])) return;
  const po = await knex('inventory_purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'pending') return returnFunction(res, 400, false, 'Only a pending purchase order can have a supplier invoice logged.');

  const location = await knex('inventory_locations').where({ id: po.locationId }).select('name').first();
  const poInvoiceNumber = await generatePOInvoiceNumber(location?.name);
  const invoiceAmount = req.body.invoiceAmount !== undefined && req.body.invoiceAmount !== '' ? Number(req.body.invoiceAmount) : null;
  const invoiceDueDate = req.body.invoiceDueDate ? new Date(req.body.invoiceDueDate) : null;

  await knex('inventory_purchase_orders').where({ id: po.id }).update({
    status: 'pending_delivery',
    invoiceNumber: req.body.invoiceNumber,
    poInvoiceNumber,
    invoiceReceivedAt: new Date(),
    invoiceAmount, invoiceDueDate,
    updatedAt: new Date(),
  });

  const supplier = await knex('inventory_suppliers').where({ id: po.supplierId }).first();
  if (supplier?.email) {
    sendEmail({
      to: supplier.email,
      subject: `Invoice received — ${poInvoiceNumber}`,
      html: `<p>Dear ${supplier.contactPerson || supplier.name},</p><p>We have received your invoice <strong>#${req.body.invoiceNumber}</strong> against purchase order <strong>${po.poNumber}</strong>${invoiceAmount ? ` for ${invoiceAmount.toLocaleString()}` : ''}${invoiceDueDate ? `, due ${invoiceDueDate.toLocaleDateString()}` : ''}. Our reference for this invoice is <strong>${poInvoiceNumber}</strong>.</p><p>We'll be in touch once the delivery arrives.</p>`,
    }).catch(() => {});
  }

  return returnFunction(res, 200, true, `Invoice logged — internal reference ${poInvoiceNumber}`, { status: 'pending_delivery', poInvoiceNumber });
};

// Receiving (full or partial) is the one action that actually moves stock — it creates
// an immutable 'receipt' movement per line (via createStockMovement, which also
// revalues the item's weighted-average cost) and, for lot/serial-tracked items, a lot
// record. quantityReceived accumulates across multiple partial receipts.
const receivePurchaseOrder = async (req, res) => {
  const po = await knex('inventory_purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['pending_delivery', 'partially_received'].includes(po.status)) {
    return returnFunction(res, 400, false, 'This purchase order is not awaiting receipt — a supplier invoice must be logged first.');
  }
  if (!Array.isArray(req.body.receipts) || !req.body.receipts.length) {
    return returnFunction(res, 400, false, 'receipts array is required — one entry per line being received.');
  }

  const itemDocs = await knex('inventory_items').whereIn('id', po.items.map((l) => l.itemId));
  const itemById = Object.fromEntries(itemDocs.map((i) => [i.id, i]));

  const updatedLines = po.items.map((line) => ({ ...line }));
  const receivedSummary = [];
  let receiptValue = 0; // this call's Σ(qty × unitCost) only — each partial receipt is its own AP liability event
  for (const receipt of req.body.receipts) {
    const lineIdx = updatedLines.findIndex((l) => String(l.itemId) === String(receipt.itemId));
    if (lineIdx === -1) return returnFunction(res, 400, false, `Item ${receipt.itemId} is not on this purchase order.`);
    const line = updatedLines[lineIdx];
    const qty = Number(receipt.quantityReceived);
    if (!qty || qty <= 0) continue;
    if (line.quantityReceived + qty > line.quantityOrdered) {
      return returnFunction(res, 400, false, `Cannot receive more than ordered for item ${receipt.itemId}.`);
    }

    const item = itemById[line.itemId];
    const unitCost = receipt.unitCost !== undefined ? Number(receipt.unitCost) : line.unitCost;

    let lotId = null;
    if (item?.isTracked && item.trackingMode !== 'none' && receipt.lotNumber) {
      const lot = await receiveLotStock({
        itemId: line.itemId, locationId: po.locationId, lotNumber: String(receipt.lotNumber),
        quantity: qty, expiryDate: receipt.expiryDate || null, poId: po.id,
      });
      lotId = lot.id;
    }

    if (item?.isTracked) {
      await createStockMovement({
        itemId: line.itemId, locationId: po.locationId, quantityChange: qty, movementType: 'receipt',
        referenceId: po.id, referenceModel: 'purchase_order', unitCost, lotId, performedBy: req.user.id,
      });
    }

    line.quantityReceived += qty;
    line.unitCost = unitCost;
    receiptValue = round2(receiptValue + qty * unitCost);
    receivedSummary.push(`${item?.name || 'Item'} — ${qty} received`);
  }

  const allReceived = updatedLines.every((l) => l.quantityReceived >= l.quantityOrdered);
  const anyReceived = updatedLines.some((l) => l.quantityReceived > 0);
  const status = allReceived ? 'received' : anyReceived ? 'partially_received' : po.status;

  await knex('inventory_purchase_orders').where({ id: po.id }).update({
    items: JSON.stringify(updatedLines), status, updatedAt: new Date(), ...(allReceived ? { receivedAt: new Date() } : {}),
  });

  // Goods received but not yet paid for = a real liability, recognized right here rather
  // than at logSupplierInvoice (whose invoiceAmount is optional/manually typed and
  // unreliable) — never blocks the receipt itself, queues to gl_posting_failures on error.
  if (receiptValue > 0) {
    const location = await knex('inventory_locations').where({ id: po.locationId }).select('department').first();
    const payload = {
      date: new Date(), description: `Goods received — PO ${po.poNumber}`, source: 'inventory_po_receipt', sourceModule: 'inventory',
      referenceId: po.id, referenceModel: 'inventory_purchase_orders', department: location?.department || null,
      lines: [], // filled below once accounts resolve
    };
    try {
      const invAcct = await resolveSystemAccount('inventory_asset');
      const apAcct = await resolveSystemAccount('accounts_payable');
      payload.lines = [{ accountId: invAcct._id, debit: receiptValue }, { accountId: apAcct._id, credit: receiptValue }];
      await postJournalEntry({ ...payload, postedBy: req.user._id });
    } catch (err) {
      await logPostingFailure({ source: 'inventory_po_receipt', sourceModule: 'inventory', referenceId: po.id, referenceModel: 'inventory_purchase_orders', attemptedPayload: payload, error: err });
    }
  }

  // Acknowledge delivery back to the supplier by email — the counterpart to the
  // invoice-received email sent in logSupplierInvoice, closing the loop on both ends.
  if (receivedSummary.length) {
    const supplier = await knex('inventory_suppliers').where({ id: po.supplierId }).first();
    if (supplier?.email) {
      const lines = receivedSummary.map((s) => `<li>${s}</li>`).join('');
      sendEmail({
        to: supplier.email,
        subject: `Delivery received — ${po.poInvoiceNumber || po.poNumber}`,
        html: `<p>Dear ${supplier.contactPerson || supplier.name},</p><p>We acknowledge receipt of your delivery against purchase order <strong>${po.poNumber}</strong>:</p><ul>${lines}</ul>`,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, allReceived ? 'Purchase order fully received.' : 'Partial receipt recorded.', { status });
};

// Same method list as expense reimbursements (expenseClaimsFunctions.js's
// REIMBURSEMENT_METHODS) — duplicated rather than imported since that constant isn't
// exported from there.
const PAYMENT_METHODS = ['bank_transfer', 'mpesa', 'cash', 'cheque'];

// Closing a PO now doubles as "log the payment" — a payment reference AND a receipt/
// proof-of-payment file are both required in the same request, so there's no way to
// close a PO without leaving traceable evidence it was actually paid (the reason this
// was added: "if a supplier says we didn't pay, how can we prove otherwise").
// Separation of duties: Inventory can only REQUEST a payment (method, reference,
// evidence) — the AP payment journal entry itself, and the final 'closed' status, are
// only ever set by Accounting's approvePoPayment. See accountingPoPaymentsFunctions.js.
const requestPoPayment = async (req, res) => {
  if (!validateRequiredFields(req, res, ['paymentMethod'])) return;
  if (!PAYMENT_METHODS.includes(req.body.paymentMethod)) {
    return returnFunction(res, 400, false, `paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
  const paymentReference = req.body.paymentReference?.trim() || null;
  if (!paymentReference && !req.file) {
    return returnFunction(res, 400, false, 'Provide a payment reference or a proof-of-payment file — at least one is required to request payment.');
  }

  const po = await knex('inventory_purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'received') return returnFunction(res, 400, false, 'Only a fully-received purchase order can have payment requested.');

  await knex('inventory_purchase_orders').where({ id: po.id }).update({
    status: 'pending_payment_approval',
    paymentStatus: 'pending_approval',
    paymentMethod: req.body.paymentMethod,
    paymentReference,
    paymentEvidenceFilename: req.file?.filename || null,
    paymentEvidenceOriginalName: req.file?.originalname || null,
    paymentRequestedBy: req.user.id,
    paymentRequestedAt: new Date(),
    paymentRejectionReason: null,
    updatedAt: new Date(),
  });

  return returnFunction(res, 200, true, 'Payment requested — awaiting Accounting approval.');
};

const deletePurchaseOrder = async (req, res) => {
  const po = await knex('inventory_purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'draft') return returnFunction(res, 400, false, 'Only a draft purchase order can be deleted.');
  await knex('inventory_purchase_orders').where({ id: po.id }).del();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = {
  listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, updatePurchaseOrder,
  sendPurchaseOrder, logSupplierInvoice, receivePurchaseOrder, requestPoPayment, deletePurchaseOrder,
};
