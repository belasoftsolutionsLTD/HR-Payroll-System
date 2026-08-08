// Postgres migration (Phase 7) — ap_bills/gl_accounts are Postgres now.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');
const { postJournalEntry, resolveSystemAccount, round2 } = require('../../lib/accounting/glEngine');
const { resolvePaymentSystemKey, GENERIC_PAYMENT_SYSTEM_KEYS } = require('../../lib/accounting/paymentMethodAccounts');
const { logPostingFailure } = require('./accountingPostingFailuresFunctions');

// Accounting's own manual bill entry — coexists with, but is fully separate from, the
// automatic AP entries Inventory's PO receipts and Spending's vendor invoices post
// (Phases 6/8). All three post to the same shared accounts_payable account, extending
// the product decision on AP sourcing to a third, purely-manual source.

const generateBillNumber = async () => {
  const year = new Date().getFullYear();
  const [row] = await knex('counters')
    .insert({ id: `ap_bill_number_${year}`, seq: 1 })
    .onConflict('id')
    .merge({ seq: knex.raw('"counters"."seq" + 1') })
    .returning('*');
  return `BILL-${year}-${String(row.seq).padStart(6, '0')}`;
};

const listApBills = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const { page, limit, skip } = getPagination(req.query);
  let query = knex('ap_bills');
  if (req.query.status) query = query.where({ status: req.query.status });

  const [{ count }] = await query.clone().count('* as count');
  const bills = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(bills, Number(count), page, limit));
};

const getApBill = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const bill = await knex('ap_bills').where({ id: req.params.id }).first();
  if (!bill) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, bill);
};

const createApBill = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['vendorName', 'items', 'dueDate'])) return;
  if (!Array.isArray(req.body.items) || !req.body.items.length) return returnFunction(res, 400, false, 'At least one line item is required.');

  const items = req.body.items.map((it) => {
    const quantity = Number(it.quantity) || 0;
    const unitPrice = Number(it.unitPrice) || 0;
    return { description: it.description || '', quantity, unitPrice, lineTotal: round2(quantity * unitPrice) };
  });
  const totalAmount = round2(items.reduce((s, l) => s + l.lineTotal, 0));
  const billNumber = await generateBillNumber();

  const doc = {
    id: newId(),
    billNumber,
    vendorName: req.body.vendorName.trim(),
    expenseAccountId: req.body.expenseAccountId || null,
    items: JSON.stringify(items), totalAmount,
    dueDate: new Date(req.body.dueDate),
    scheduledPaymentDate: null,
    status: 'draft',
    approvedBy: null, approvedAt: null, paidAt: null, paymentMethod: null, paymentReference: null,
    createdBy: req.user.id,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await knex('ap_bills').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const approveApBill = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const bill = await knex('ap_bills').where({ id: req.params.id }).first();
  if (!bill) return returnFunction(res, 404, false, req.locale.notFound);
  if (bill.status !== 'draft') return returnFunction(res, 400, false, 'Only a draft bill can be approved.');

  await knex('ap_bills').where({ id: bill.id }).update({ status: 'approved', approvedBy: req.user.id, approvedAt: new Date(), updatedAt: new Date() });

  const payload = {
    date: new Date(), description: `Bill approved — ${bill.billNumber} (${bill.vendorName})`, source: 'ap_bill_approval', sourceModule: 'accounting',
    referenceId: bill.id, referenceModel: 'ap_bills', lines: [],
  };
  try {
    const expenseAcct = bill.expenseAccountId ? await knex('gl_accounts').where({ id: bill.expenseAccountId }).first() : await resolveSystemAccount('other_expense');
    const apAcct = await resolveSystemAccount('accounts_payable');
    payload.lines = [{ accountId: expenseAcct._id || expenseAcct.id, debit: bill.totalAmount }, { accountId: apAcct._id, credit: bill.totalAmount }];
    await postJournalEntry({ ...payload, postedBy: req.user._id });
  } catch (err) {
    await logPostingFailure({ source: 'ap_bill_approval', sourceModule: 'accounting', referenceId: bill.id, referenceModel: 'ap_bills', attemptedPayload: payload, error: err });
  }

  return returnFunction(res, 200, true, 'Bill approved.');
};

// Scheduling is a date/UI concept only — no journal entry, since no money has moved yet.
const scheduleApBill = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['scheduledPaymentDate'])) return;
  const bill = await knex('ap_bills').where({ id: req.params.id }).first();
  if (!bill) return returnFunction(res, 404, false, req.locale.notFound);
  if (bill.status !== 'approved') return returnFunction(res, 400, false, 'Only an approved bill can be scheduled.');
  await knex('ap_bills').where({ id: bill.id }).update({ status: 'scheduled', scheduledPaymentDate: new Date(req.body.scheduledPaymentDate), updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Bill scheduled for payment.');
};

const payApBill = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['paymentMethod', 'paymentReference'])) return;
  if (!Object.keys(GENERIC_PAYMENT_SYSTEM_KEYS).includes(req.body.paymentMethod)) {
    return returnFunction(res, 400, false, `paymentMethod must be one of: ${Object.keys(GENERIC_PAYMENT_SYSTEM_KEYS).join(', ')}`);
  }
  const bill = await knex('ap_bills').where({ id: req.params.id }).first();
  if (!bill) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['approved', 'scheduled'].includes(bill.status)) return returnFunction(res, 400, false, 'Only an approved or scheduled bill can be paid.');

  await knex('ap_bills').where({ id: bill.id }).update({
    status: 'paid', paidAt: new Date(), paymentMethod: req.body.paymentMethod, paymentReference: req.body.paymentReference, updatedAt: new Date(),
  });

  const payload = {
    date: new Date(), description: `Bill payment — ${bill.billNumber} (${req.body.paymentReference})`, source: 'ap_bill_payment', sourceModule: 'accounting',
    referenceId: bill.id, referenceModel: 'ap_bills', lines: [],
  };
  try {
    const apAcct = await resolveSystemAccount('accounts_payable');
    const paymentAcct = await resolveSystemAccount(resolvePaymentSystemKey(req.body.paymentMethod));
    payload.lines = [{ accountId: apAcct._id, debit: bill.totalAmount }, { accountId: paymentAcct._id, credit: bill.totalAmount }];
    await postJournalEntry({ ...payload, postedBy: req.user._id });
  } catch (err) {
    await logPostingFailure({ source: 'ap_bill_payment', sourceModule: 'accounting', referenceId: bill.id, referenceModel: 'ap_bills', attemptedPayload: payload, error: err });
  }

  return returnFunction(res, 200, true, 'Bill paid.');
};

module.exports = { listApBills, getApBill, createApBill, approveApBill, scheduleApBill, payApBill };
