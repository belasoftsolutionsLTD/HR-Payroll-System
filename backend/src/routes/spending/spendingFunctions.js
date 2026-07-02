const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyUser } = require('../../functions/HR/notifyUser');

// ══════════════════════════════════════════════════════════════════════════════
//  CORPORATE CARDS
// ══════════════════════════════════════════════════════════════════════════════

const listCards = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const cards = await findMany('corporate_cards', filter, { sort: { createdAt: -1 } });
  const enriched = await Promise.all(cards.map(async c => {
    const emp = c.assignedTo
      ? await findOne('employees', { _id: c.assignedTo }, { projection: { fullName: 1, department: 1 } })
      : null;
    const spent = await global.dbo.collection('card_transactions').aggregate([
      { $match: { cardId: c._id, type: 'debit' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).toArray();
    return { ...c, employee: emp, totalSpent: spent[0]?.total ?? 0 };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createCard = async (req, res) => {
  if (!validateRequiredFields(req, res, ['last4', 'cardHolder'])) return;
  const { last4, cardHolder, assignedTo, creditLimit, currency, expiryDate, network } = req.body;
  const doc = {
    last4,
    cardHolder,
    assignedTo:  assignedTo  ? new ObjectId(assignedTo) : null,
    creditLimit: creditLimit ? Number(creditLimit) : null,
    currency:    currency    || 'KES',
    expiryDate:  expiryDate  ? new Date(expiryDate) : null,
    network:     network     || 'visa',
    status:      'active',
    createdAt:   new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('corporate_cards', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateCard = async (req, res) => {
  const card = await findOne('corporate_cards', { _id: new ObjectId(req.params.id) });
  if (!card) return returnFunction(res, 404, false, req.locale.notFound);
  const { status, creditLimit, assignedTo } = req.body;
  const update = { updatedAt: new Date() };
  if (status !== undefined)      update.status      = status;
  if (creditLimit !== undefined)  update.creditLimit  = Number(creditLimit);
  if (assignedTo !== undefined)   update.assignedTo   = assignedTo ? new ObjectId(assignedTo) : null;
  await updateOne('corporate_cards', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Transactions ──────────────────────────────────────────────────────────────
const listTransactions = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.params.cardId) filter.cardId = new ObjectId(req.params.cardId);
  if (req.query.type)    filter.type    = req.query.type;

  const [total, data] = await Promise.all([
    countDocuments('card_transactions', filter),
    findMany('card_transactions', filter, { skip, limit, sort: { date: -1 } }),
  ]);

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

const addTransaction = async (req, res) => {
  if (!validateRequiredFields(req, res, ['amount', 'description', 'date'])) return;
  const { amount, description, date, merchant, category, type } = req.body;
  const doc = {
    cardId:      new ObjectId(req.params.cardId),
    amount:      Number(amount),
    description,
    date:        new Date(date),
    merchant:    merchant  || null,
    category:    category  || 'other',
    type:        type      || 'debit',
    createdAt:   new Date(),
  };
  const result = await insertOne('card_transactions', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// ══════════════════════════════════════════════════════════════════════════════
//  INVOICES
// ══════════════════════════════════════════════════════════════════════════════

const listInvoices = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status)  filter.status = req.query.status;
  if (req.query.type)    filter.type   = req.query.type;
  if (req.query.search) filter.$or = [
    { invoiceNumber: { $regex: req.query.search, $options: 'i' } },
    { vendor: { $regex: req.query.search, $options: 'i' } },
  ];

  const [total, data] = await Promise.all([
    countDocuments('invoices', filter),
    findMany('invoices', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const stats = await global.dbo.collection('invoices').aggregate([
    { $group: {
      _id: '$status',
      total: { $sum: '$amount' },
      count: { $sum: 1 },
    }},
  ]).toArray();

  return returnFunction(res, 200, true, req.locale.success, { ...paginatedResponse(data, total, page, limit), stats });
};

const createInvoice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['vendor', 'amount', 'dueDate'])) return;
  const { vendor, amount, currency, dueDate, description, invoiceNumber, type, projectId, items } = req.body;

  // Duplicate invoice number check
  if (invoiceNumber) {
    const dup = await findOne('invoices', { invoiceNumber });
    if (dup) return returnFunction(res, 409, false, `Invoice number ${invoiceNumber} already exists.`);
  }

  const doc = {
    vendor,
    amount:        Number(amount),
    currency:      currency       || 'KES',
    dueDate:       new Date(dueDate),
    description:   description    || null,
    invoiceNumber: invoiceNumber  || null,
    type:          type           || 'accounts_payable',
    projectId:     projectId      ? new ObjectId(projectId) : null,
    items:         items          || [],
    status:        'pending',
    submittedBy:   req.user?._id  ?? null,
    approvedBy:    null,   approvedAt: null,
    rejectedBy:    null,   rejectedAt: null, rejectionReason: null,
    paidAt:        null,
    createdAt:     new Date(), updatedAt: new Date(),
  };

  const result = await insertOne('invoices', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const approveInvoice = async (req, res) => {
  const inv = await findOne('invoices', { _id: new ObjectId(req.params.id) });
  if (!inv) return returnFunction(res, 404, false, req.locale.notFound);
  if (inv.status !== 'pending') return returnFunction(res, 400, false, 'Invoice is not pending.');
  await updateOne('invoices', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'approved', approvedBy: req.user?._id ?? null, approvedAt: new Date(), updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Invoice approved.');
};

const rejectInvoice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const inv = await findOne('invoices', { _id: new ObjectId(req.params.id) });
  if (!inv) return returnFunction(res, 404, false, req.locale.notFound);
  if (inv.status !== 'pending') return returnFunction(res, 400, false, 'Invoice is not pending.');
  await updateOne('invoices', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'rejected', rejectedBy: req.user?._id ?? null, rejectedAt: new Date(), rejectionReason: req.body.reason, updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Invoice rejected.');
};

const markPaid = async (req, res) => {
  const inv = await findOne('invoices', { _id: new ObjectId(req.params.id) });
  if (!inv) return returnFunction(res, 404, false, req.locale.notFound);
  if (inv.status !== 'approved') return returnFunction(res, 400, false, 'Invoice must be approved before marking paid.');
  const { paymentReference } = req.body;
  await updateOne('invoices', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'paid', paidAt: new Date(), paymentReference: paymentReference || null, updatedAt: new Date() },
  });
  if (inv.type === 'accounts_receivable' && inv.submittedBy) {
    notifyUser(inv.submittedBy, {
      title: 'Invoice Payment Received',
      body: `Invoice${inv.invoiceNumber ? ` #${inv.invoiceNumber}` : ''} from ${inv.vendor} has been marked as paid.${paymentReference ? ` Ref: ${paymentReference}` : ''}`,
      type: 'general',
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, 'Invoice marked as paid.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  PROCUREMENT (Purchase Requests)
// ══════════════════════════════════════════════════════════════════════════════

const listPurchaseRequests = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  const filter = {};
  if (!isHR) filter.requestedBy = req.user?._id ?? null;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.priority) filter.priority = req.query.priority;

  const [total, data] = await Promise.all([
    countDocuments('purchase_requests', filter),
    findMany('purchase_requests', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const enriched = await Promise.all(data.map(async r => {
    const requester = r.requestedBy
      ? await findOne('employees', { _id: r.requestedBy }, { projection: { fullName: 1, department: 1 } })
      : null;
    return { ...r, requester };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const createPurchaseRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'estimatedCost'])) return;
  const { title, description, estimatedCost, currency, priority, vendor, department, items, neededBy } = req.body;
  const doc = {
    title,
    description:   description    || null,
    estimatedCost: Number(estimatedCost),
    currency:      currency       || 'KES',
    priority:      priority       || 'normal',
    vendor:        vendor         || null,
    department:    department     || null,
    items:         items          || [],
    neededBy:      neededBy       ? new Date(neededBy) : null,
    requestedBy:   req.user?._id  ?? null,
    employeeId:    req.user?.employeeId ? new ObjectId(req.user.employeeId) : null,
    status:        'pending',
    approvedBy:    null,   approvedAt: null,
    rejectedBy:    null,   rejectedAt: null, rejectionReason: null,
    createdAt:     new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('purchase_requests', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const approvePurchaseRequest = async (req, res) => {
  const pr = await findOne('purchase_requests', { _id: new ObjectId(req.params.id) });
  if (!pr) return returnFunction(res, 404, false, req.locale.notFound);
  if (pr.status !== 'pending') return returnFunction(res, 400, false, 'Request is not pending.');
  if (pr.requestedByEmployeeId && String(pr.requestedByEmployeeId) === String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'You cannot approve your own purchase request.');
  }
  await updateOne('purchase_requests', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'approved', approvedBy: req.user?._id ?? null, approvedAt: new Date(), updatedAt: new Date() },
  });
  if (pr.requestedBy) {
    notifyUser(pr.requestedBy, {
      title: 'Purchase Request Approved',
      body: `Your purchase request "${pr.title}" has been approved.`,
      type: 'general',
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, 'Purchase request approved.');
};

const rejectPurchaseRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const pr = await findOne('purchase_requests', { _id: new ObjectId(req.params.id) });
  if (!pr) return returnFunction(res, 404, false, req.locale.notFound);
  if (pr.status !== 'pending') return returnFunction(res, 400, false, 'Request is not pending.');
  if (pr.requestedByEmployeeId && String(pr.requestedByEmployeeId) === String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'You cannot reject your own purchase request.');
  }
  await updateOne('purchase_requests', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'rejected', rejectedBy: req.user?._id ?? null, rejectedAt: new Date(), rejectionReason: req.body.reason, updatedAt: new Date() },
  });
  if (pr.requestedBy) {
    notifyUser(pr.requestedBy, {
      title: 'Purchase Request Rejected',
      body: `Your purchase request "${pr.title}" was not approved. Reason: ${req.body.reason}`,
      type: 'general',
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, 'Purchase request rejected.');
};

module.exports = {
  listCards, createCard, updateCard,
  listTransactions, addTransaction,
  listInvoices, createInvoice, approveInvoice, rejectInvoice, markPaid,
  listPurchaseRequests, createPurchaseRequest, approvePurchaseRequest, rejectPurchaseRequest,
};
