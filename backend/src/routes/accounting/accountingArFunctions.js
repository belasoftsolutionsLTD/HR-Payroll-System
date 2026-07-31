const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');
const { postJournalEntry, resolveSystemAccount, round2 } = require('../../lib/accounting/glEngine');
const { resolvePaymentSystemKey, GENERIC_PAYMENT_SYSTEM_KEYS } = require('../../lib/accounting/paymentMethodAccounts');
const { logPostingFailure } = require('./accountingPostingFailuresFunctions');

// Fully decoupled from POS — this is for credit-based sales that happen OUTSIDE of POS
// (a B2B customer on 30-day terms, or a service billed after the fact), created manually
// by an Accounting user. POS sales are already fully paid at time of transaction and
// never create an AR invoice (see Phase 3's direct-to-ledger posting instead).

const generateInvoiceNumber = async () => {
  const year = new Date().getFullYear();
  const result = await global.dbo.collection('counters').findOneAndUpdate(
    { _id: `ar_invoice_number_${year}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }
  );
  return `INV-${year}-${String(result.seq).padStart(6, '0')}`;
};

const deriveStatus = (invoice) => {
  if (invoice.status === 'draft') return 'draft';
  if (invoice.balanceDue <= 0) return 'paid';
  if (invoice.amountPaid > 0) return 'partially_paid';
  if (invoice.dueDate && new Date(invoice.dueDate) < new Date()) return 'overdue';
  return 'sent';
};

const listArInvoices = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const [total, invoices] = await Promise.all([
    countDocuments('ar_invoices', filter),
    findMany('ar_invoices', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);
  const enriched = invoices.map((inv) => ({ ...inv, status: deriveStatus(inv) }));
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getArInvoice = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const invoice = await findOne('ar_invoices', { _id: new ObjectId(req.params.id) });
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  const payments = await findMany('ar_payments', { invoiceId: invoice._id }, { sort: { paidAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, { ...invoice, status: deriveStatus(invoice), payments });
};

const createArInvoice = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['customerName', 'items', 'dueDate'])) return;
  if (!Array.isArray(req.body.items) || !req.body.items.length) return returnFunction(res, 400, false, 'At least one line item is required.');

  const items = req.body.items.map((it) => {
    const quantity = Number(it.quantity) || 0;
    const unitPrice = Number(it.unitPrice) || 0;
    const taxRate = Number(it.taxRate) || 0;
    const lineSubtotal = round2(quantity * unitPrice);
    const lineTax = round2(lineSubtotal * taxRate / 100);
    return { description: it.description || '', quantity, unitPrice, taxRate, lineSubtotal, lineTax, lineTotal: round2(lineSubtotal + lineTax) };
  });
  const subtotal = round2(items.reduce((s, l) => s + l.lineSubtotal, 0));
  const taxTotal = round2(items.reduce((s, l) => s + l.lineTax, 0));
  const total = round2(subtotal + taxTotal);
  const invoiceNumber = await generateInvoiceNumber();

  const doc = {
    invoiceNumber,
    customerId: req.body.customerId ? new ObjectId(req.body.customerId) : null,
    customerModel: req.body.customerId ? (req.body.customerModel || 'crm_contacts') : null,
    // Denormalized at creation so a later CRM edit never retroactively changes a posted invoice.
    customerSnapshot: { name: req.body.customerName.trim(), email: req.body.customerEmail?.trim() || null, billingAddress: req.body.billingAddress?.trim() || null },
    items, subtotal, taxTotal, total,
    amountPaid: 0, balanceDue: total,
    dueDate: new Date(req.body.dueDate),
    status: 'draft',
    createdBy: req.user._id,
    createdAt: new Date(), updatedAt: new Date(), sentAt: null, paidAt: null,
  };
  const result = await insertOne('ar_invoices', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

// The invoice only becomes a real receivable/revenue event on the draft->sent
// transition — not at draft save, since a draft might never actually be sent.
const sendArInvoice = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const invoice = await findOne('ar_invoices', { _id: new ObjectId(req.params.id) });
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  if (invoice.status !== 'draft') return returnFunction(res, 400, false, 'Only a draft invoice can be sent.');

  await updateOne('ar_invoices', { _id: invoice._id }, { $set: { status: 'sent', sentAt: new Date(), updatedAt: new Date() } });

  const payload = {
    date: new Date(), description: `AR invoice ${invoice.invoiceNumber} — ${invoice.customerSnapshot.name}`, source: 'ar_invoice', sourceModule: 'accounting',
    referenceId: invoice._id, referenceModel: 'ar_invoices', lines: [],
  };
  try {
    const arAcct = await resolveSystemAccount('accounts_receivable');
    const revenueAcct = await resolveSystemAccount('sales_revenue');
    const lines = [{ accountId: arAcct._id, debit: invoice.total }, { accountId: revenueAcct._id, credit: invoice.subtotal }];
    if (invoice.taxTotal > 0) {
      const taxAcct = await resolveSystemAccount('tax_payable');
      lines.push({ accountId: taxAcct._id, credit: invoice.taxTotal });
    }
    payload.lines = lines;
    await postJournalEntry({ ...payload, postedBy: req.user._id });
  } catch (err) {
    await logPostingFailure({ source: 'ar_invoice', sourceModule: 'accounting', referenceId: invoice._id, referenceModel: 'ar_invoices', attemptedPayload: payload, error: err });
  }

  return returnFunction(res, 200, true, 'Invoice sent.');
};

const recordArPayment = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['amount', 'method'])) return;
  if (!Object.keys(GENERIC_PAYMENT_SYSTEM_KEYS).includes(req.body.method)) {
    return returnFunction(res, 400, false, `method must be one of: ${Object.keys(GENERIC_PAYMENT_SYSTEM_KEYS).join(', ')}`);
  }
  const invoice = await findOne('ar_invoices', { _id: new ObjectId(req.params.id) });
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  if (invoice.status === 'draft') return returnFunction(res, 400, false, 'Send the invoice before recording a payment against it.');
  const amount = round2(Number(req.body.amount));
  if (!(amount > 0) || amount > invoice.balanceDue + 0.01) {
    return returnFunction(res, 400, false, `Payment must be positive and cannot exceed the balance due (${invoice.balanceDue}).`);
  }

  const paymentDoc = { invoiceId: invoice._id, amount, method: req.body.method, reference: req.body.reference || null, paidAt: new Date(), recordedBy: req.user._id, createdAt: new Date() };
  const result = await insertOne('ar_payments', paymentDoc);

  const amountPaid = round2(invoice.amountPaid + amount);
  const balanceDue = round2(invoice.total - amountPaid);
  const status = balanceDue <= 0 ? 'paid' : 'sent';
  await updateOne('ar_invoices', { _id: invoice._id }, {
    $set: { amountPaid, balanceDue, status, updatedAt: new Date(), ...(balanceDue <= 0 ? { paidAt: new Date() } : {}) },
  });

  const payload = {
    date: new Date(), description: `AR payment — ${invoice.invoiceNumber} (${req.body.reference || req.body.method})`, source: 'ar_payment', sourceModule: 'accounting',
    referenceId: result.insertedId, referenceModel: 'ar_payments', lines: [],
  };
  try {
    const paymentAcct = await resolveSystemAccount(resolvePaymentSystemKey(req.body.method));
    const arAcct = await resolveSystemAccount('accounts_receivable');
    payload.lines = [{ accountId: paymentAcct._id, debit: amount }, { accountId: arAcct._id, credit: amount }];
    await postJournalEntry({ ...payload, postedBy: req.user._id });
  } catch (err) {
    await logPostingFailure({ source: 'ar_payment', sourceModule: 'accounting', referenceId: result.insertedId, referenceModel: 'ar_payments', attemptedPayload: payload, error: err });
  }

  return returnFunction(res, 201, true, 'Payment recorded.', { _id: result.insertedId, ...paymentDoc, invoiceStatus: status });
};

module.exports = { listArInvoices, getArInvoice, createArInvoice, sendArInvoice, recordArPayment };
