const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyUser, notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR, notifyManager } = require('../inbox/inboxFunctions');
const { buildApprovalChain, findCurrentLevelEntry, canActOnLevel } = require('../../lib/spend/approvalChain');
const { resolvePolicy } = require('../../lib/spend/policyResolver');
const { buildSpendScopeFilter, canAccessRecord } = require('../../lib/spend/orgScope');
const { sendEmail } = require('../../services/emailService');

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

  const inboxPayload = {
    type: 'procurement', subType: 'invoice_submitted',
    title: `Invoice ${invoiceNumber ? `#${invoiceNumber} ` : ''}from ${vendor}`,
    subtitle: `${doc.currency} ${doc.amount.toLocaleString()} — due ${doc.dueDate.toDateString()}`,
    referenceId: result.insertedId, referenceModel: 'invoices',
    requiresAction: true, triggeredBy: req.user?._id ?? null,
  };
  notifyHR(inboxPayload).catch(() => {});
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'New Invoice Submitted', body: inboxPayload.subtitle, type: 'general',
  }).catch(() => {});

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
// requestedBy = users._id (who clicked submit), employeeId = employees._id (used for
// all org-hierarchy scoping/approval-chain resolution) — both kept since HR tooling
// elsewhere may still look up by requestedBy.

const listPurchaseRequests = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const scope = await buildSpendScopeFilter(req);
  const filter = { ...scope };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.priority) filter.priority = req.query.priority;

  const [total, data] = await Promise.all([
    countDocuments('purchase_requests', filter),
    findMany('purchase_requests', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const enriched = await Promise.all(data.map(async r => {
    const requester = r.employeeId
      ? await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1, department: 1 } })
      : null;
    return { ...r, requester };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getPurchaseRequest = async (req, res) => {
  const pr = await findOne('purchase_requests', { _id: new ObjectId(req.params.id) });
  if (!pr) return returnFunction(res, 404, false, req.locale.notFound);
  const allowed = await canAccessRecord(req, pr.employeeId, pr.department);
  if (!allowed) return returnFunction(res, 403, false, 'Access denied.');
  const requester = pr.employeeId ? await findOne('employees', { _id: pr.employeeId }, { projection: { fullName: 1, department: 1 } }) : null;
  return returnFunction(res, 200, true, req.locale.success, { ...pr, requester });
};

const createPurchaseRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'estimatedCost'])) return;
  const { title, description, justification, estimatedCost, currency, priority, vendor, vendorId, items, neededBy } = req.body;

  const employeeId = req.user?.employeeId ? new ObjectId(req.user.employeeId) : null;
  const employee = employeeId ? await findOne('employees', { _id: employeeId }, { projection: { department: 1, fullName: 1 } }) : null;

  const policy = await resolvePolicy('procurement_policies', {
    employeeId, role: req.user?.role, department: employee?.department,
  }) ?? {};
  const approvalChain = employeeId ? await buildApprovalChain(employeeId, Number(estimatedCost), policy) : [];

  const doc = {
    title,
    description:   description    || null,
    justification: justification  || description || null,
    estimatedCost: Number(estimatedCost),
    currency:      currency       || 'KES',
    priority:      priority       || 'normal',
    vendor:        vendor         || null,
    vendorId:      vendorId       ? new ObjectId(vendorId) : null,
    department:    employee?.department || req.body.department || null,
    items:         items          || [],
    neededBy:      neededBy       ? new Date(neededBy) : null,
    policyId:      policy._id     || null,
    approvalChain,
    currentApprovalLevel: approvalChain[0]?.level ?? 0,
    requestedBy:   req.user?._id  ?? null,
    employeeId,
    status:        'pending',
    convertedToPOId: null,
    approvedBy:    null,   approvedAt: null,
    rejectedBy:    null,   rejectedAt: null, rejectionReason: null,
    createdAt:     new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('purchase_requests', doc);

  const requesterName = employee?.fullName || req.user?.name || 'An employee';
  const inboxPayload = {
    type: 'procurement', subType: 'purchase_request_submitted',
    title: `Purchase request from ${requesterName}`,
    subtitle: `"${title}" — ${doc.currency} ${doc.estimatedCost.toLocaleString()}`,
    referenceId: result.insertedId, referenceModel: 'purchase_requests',
    requiresAction: true, triggeredBy: req.user?._id ?? null,
  };
  // Inbox — this is what HR/admin actually check for actionable items (distinct from
  // the bell-icon notifications below, which this handler already sent but the Inbox
  // never received, so approvers had no reliable way to see a new request).
  if (employeeId) notifyManager(employeeId, inboxPayload).catch(() => {});
  notifyHR(inboxPayload).catch(() => {});

  if (approvalChain[0]) {
    notifyUser(approvalChain[0].approverId, {
      title: 'Purchase Request Awaiting Approval',
      body: `"${title}" — ${doc.currency} ${doc.estimatedCost.toLocaleString()} — needs your approval.`,
      type: 'general',
    }).catch(() => {});
  }
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'New Purchase Request',
    body: `"${title}" — ${doc.currency} ${doc.estimatedCost.toLocaleString()}`,
    type: 'general',
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updatePurchaseRequest = async (req, res) => {
  const pr = await findOne('purchase_requests', { _id: new ObjectId(req.params.id) });
  if (!pr) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['draft', 'pending'].includes(pr.status)) return returnFunction(res, 400, false, 'Cannot edit after approval.');
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(pr.employeeId) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Access denied.');
  const { title, description, justification, priority, items, neededBy, vendorId } = req.body;
  const update = { updatedAt: new Date() };
  if (title !== undefined)       update.title = title;
  if (description !== undefined) update.description = description;
  if (justification !== undefined) update.justification = justification;
  if (priority !== undefined)    update.priority = priority;
  if (neededBy !== undefined)    update.neededBy = neededBy ? new Date(neededBy) : null;
  if (vendorId !== undefined)    update.vendorId = vendorId ? new ObjectId(vendorId) : null;
  if (Array.isArray(items)) {
    update.items = items;
    update.estimatedCost = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.estimatedUnitPrice) || 0), 0);
  }
  await updateOne('purchase_requests', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const approvePurchaseRequest = async (req, res) => {
  const pr = await findOne('purchase_requests', { _id: new ObjectId(req.params.id) });
  if (!pr) return returnFunction(res, 404, false, req.locale.notFound);
  if (pr.status !== 'pending') return returnFunction(res, 400, false, 'Request is not pending.');
  if (pr.employeeId && String(pr.employeeId) === String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'You cannot approve your own purchase request.');
  }

  const levelEntry = findCurrentLevelEntry(pr);
  if (!(await canActOnLevel(req, pr, levelEntry))) {
    return returnFunction(res, 403, false, 'You are not authorized to approve this request at its current stage.');
  }

  const now = new Date();
  const update = { updatedAt: now };
  let nextPending = null;

  if (levelEntry) {
    const chain = pr.approvalChain.map((a) => a.level === levelEntry.level
      ? { ...a, status: 'approved', actedAt: now, comment: req.body?.comment || null }
      : a);
    nextPending = chain.find((a) => a.status === 'pending' && a.level > levelEntry.level) || null;
    update.approvalChain = chain;
  }

  if (nextPending) {
    update.currentApprovalLevel = nextPending.level;
  } else {
    update.status = 'approved';
    update.approvedBy = req.user?._id ?? null;
    update.approvedAt = now;
  }

  await updateOne('purchase_requests', { _id: new ObjectId(req.params.id) }, { $set: update });

  if (nextPending) {
    notifyUser(nextPending.approverId, {
      title: 'Purchase Request Awaiting Your Approval',
      body: `"${pr.title}" has escalated to you for approval.`,
      type: 'general',
    }).catch(() => {});
  } else if (pr.requestedBy) {
    notifyUser(pr.requestedBy, {
      title: 'Purchase Request Approved',
      body: `Your purchase request "${pr.title}" has been approved.`,
      type: 'general',
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, nextPending ? 'Approved — escalated to the next approval level.' : 'Purchase request approved.');
};

const rejectPurchaseRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const pr = await findOne('purchase_requests', { _id: new ObjectId(req.params.id) });
  if (!pr) return returnFunction(res, 404, false, req.locale.notFound);
  if (pr.status !== 'pending') return returnFunction(res, 400, false, 'Request is not pending.');
  if (pr.employeeId && String(pr.employeeId) === String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'You cannot reject your own purchase request.');
  }

  const levelEntry = findCurrentLevelEntry(pr);
  if (!(await canActOnLevel(req, pr, levelEntry))) {
    return returnFunction(res, 403, false, 'You are not authorized to reject this request at its current stage.');
  }

  const now = new Date();
  const update = {
    status: 'rejected', rejectedBy: req.user?._id ?? null, rejectedAt: now,
    rejectionReason: req.body.reason, updatedAt: now,
  };
  if (levelEntry) {
    update.approvalChain = pr.approvalChain.map((a) => a.level === levelEntry.level
      ? { ...a, status: 'rejected', actedAt: now, comment: req.body.reason }
      : a);
  }
  await updateOne('purchase_requests', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (pr.requestedBy) {
    notifyUser(pr.requestedBy, {
      title: 'Purchase Request Rejected',
      body: `Your purchase request "${pr.title}" was not approved. Reason: ${req.body.reason}`,
      type: 'general',
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, 'Purchase request rejected.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  VENDORS
// ══════════════════════════════════════════════════════════════════════════════

const listVendors = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  const vendors = await findMany('vendors', filter, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, vendors);
};

const getVendor = async (req, res) => {
  const vendor = await findOne('vendors', { _id: new ObjectId(req.params.id) });
  if (!vendor) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, vendor);
};

// Company vendors must prove they're legitimately registered in Kenya before they can
// transact — KRA PIN certificate, certificate of registration/incorporation, and a
// business permit. Individual vendors skip this (no company to verify).
const COMPANY_KYC_DOCS = [
  { field: 'kraPinCertificate',    docType: 'KRA PIN Certificate' },
  { field: 'registrationCertificate', docType: 'Certificate of Registration' },
  { field: 'businessPermit',       docType: 'Business Permit' },
];

const createVendor = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'category', 'type'])) return;
  const { name, contactName, email, phone, address, category, type, taxId, paymentTerms, bankDetails, notes } = req.body;
  if (!['company', 'individual'].includes(type)) return returnFunction(res, 400, false, 'Vendor type must be "company" or "individual".');

  let documents = [];
  if (type === 'company') {
    const missing = COMPANY_KYC_DOCS.filter(d => !req.files?.[d.field]?.[0]);
    if (missing.length) {
      return returnFunction(res, 400, false, `Company vendors must provide: ${missing.map(d => d.docType).join(', ')}.`);
    }
    documents = COMPANY_KYC_DOCS.map(d => {
      const file = req.files[d.field][0];
      return { docId: new ObjectId(), docType: d.docType, fileName: file.originalname, filePath: `/uploads/${file.filename}`, uploadedAt: new Date() };
    });
  }

  const doc = {
    name, contactName: contactName || null, email: email || null, phone: phone || null,
    address: address || null, category, type, taxId: taxId || null, paymentTerms: paymentTerms || null,
    bankDetails: bankDetails || null, documents, status: 'pending_approval', notes: notes || null,
    approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null, rejectionReason: null,
    createdBy: req.user?._id ?? null, createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('vendors', doc);
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'New Vendor Pending Approval', body: `${name} has been submitted and is awaiting approval.`, type: 'general',
  }).catch(() => {});
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateVendor = async (req, res) => {
  const vendor = await findOne('vendors', { _id: new ObjectId(req.params.id) });
  if (!vendor) return returnFunction(res, 404, false, req.locale.notFound);
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  await updateOne('vendors', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const approveVendor = async (req, res) => {
  const vendor = await findOne('vendors', { _id: new ObjectId(req.params.id) });
  if (!vendor) return returnFunction(res, 404, false, req.locale.notFound);
  if (vendor.status !== 'pending_approval') return returnFunction(res, 400, false, 'This vendor is not pending approval.');
  await updateOne('vendors', { _id: vendor._id }, {
    $set: { status: 'active', approvedBy: req.user?._id ?? null, approvedAt: new Date(), updatedAt: new Date() },
  });
  if (vendor.email) {
    sendEmail({
      to: vendor.email,
      subject: `${vendor.name} — Vendor Application Approved`,
      html: `<p>Dear ${vendor.contactName || vendor.name},</p><p>Your vendor application has been <strong>approved</strong>. You are now registered as an active vendor.</p>`,
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, 'Vendor approved.');
};

const rejectVendor = async (req, res) => {
  if (!validateRequiredFields(req, res, ['rejectionReason'])) return;
  const vendor = await findOne('vendors', { _id: new ObjectId(req.params.id) });
  if (!vendor) return returnFunction(res, 404, false, req.locale.notFound);
  if (vendor.status !== 'pending_approval') return returnFunction(res, 400, false, 'This vendor is not pending approval.');
  await updateOne('vendors', { _id: vendor._id }, {
    $set: { status: 'rejected', rejectedBy: req.user?._id ?? null, rejectedAt: new Date(), rejectionReason: req.body.rejectionReason, updatedAt: new Date() },
  });
  if (vendor.email) {
    sendEmail({
      to: vendor.email,
      subject: `${vendor.name} — Vendor Application Update`,
      html: `<p>Dear ${vendor.contactName || vendor.name},</p><p>Your vendor application has been <strong>rejected</strong>.</p><p>Reason: ${req.body.rejectionReason}</p>`,
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, 'Vendor rejected.');
};

// Only super_admin can hard-remove a vendor from the directory (rejectPurchaseRequest-
// style guard) — hr_manager can only deactivate/blacklist via updateVendor's status field.
const deleteVendor = async (req, res) => {
  if (req.user?.role !== 'super_admin') return returnFunction(res, 403, false, 'Only a super admin can remove a vendor.');
  const vendor = await findOne('vendors', { _id: new ObjectId(req.params.id) });
  if (!vendor) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('vendors', { _id: new ObjectId(req.params.id) }, { $set: { status: 'inactive', updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  PROCUREMENT POLICIES
// ══════════════════════════════════════════════════════════════════════════════

const listProcurementPolicies = async (req, res) => {
  const policies = await findMany('procurement_policies', {}, { sort: { isDefault: -1, createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, policies);
};

const getProcurementPolicy = async (req, res) => {
  const policy = await findOne('procurement_policies', { _id: new ObjectId(req.params.id) });
  if (!policy) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, policy);
};

const createProcurementPolicy = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const { name, appliesTo, approvalChain, requiresQuotationAbove, preferredVendors, isDefault } = req.body;
  if (isDefault) await global.dbo.collection('procurement_policies').updateMany({}, { $set: { isDefault: false } });
  const doc = {
    name, appliesTo: appliesTo || {}, approvalChain: approvalChain || [],
    requiresQuotationAbove: requiresQuotationAbove ?? null,
    preferredVendors: (preferredVendors || []).map((id) => new ObjectId(id)),
    isDefault: Boolean(isDefault), isActive: true,
    createdBy: req.user?._id ?? null, createdAt: new Date(),
  };
  const result = await insertOne('procurement_policies', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateProcurementPolicy = async (req, res) => {
  const existing = await findOne('procurement_policies', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  if (req.body.isDefault) {
    await global.dbo.collection('procurement_policies').updateMany({ _id: { $ne: existing._id } }, { $set: { isDefault: false } });
  }
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  await updateOne('procurement_policies', { _id: existing._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteProcurementPolicy = async (req, res) => {
  const existing = await findOne('procurement_policies', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  if (existing.isDefault) return returnFunction(res, 400, false, 'Cannot deactivate the default policy — mark another policy as default first.');
  await updateOne('procurement_policies', { _id: existing._id }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  CONVERT PR → PO
// ══════════════════════════════════════════════════════════════════════════════

const generatePONumber = async () => {
  const year = new Date().getFullYear();
  const counterName = `po_number_${year}`;
  const result = await global.dbo.collection('counters').findOneAndUpdate(
    { _id: counterName }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }
  );
  return `PO-${year}-${String(result.seq).padStart(5, '0')}`;
};

const convertRequisitionToPO = async (req, res) => {
  const pr = await findOne('purchase_requests', { _id: new ObjectId(req.params.id) });
  if (!pr) return returnFunction(res, 404, false, req.locale.notFound);
  if (pr.status !== 'approved') return returnFunction(res, 400, false, 'Only approved requests can be converted to a purchase order.');
  if (pr.convertedToPOId) return returnFunction(res, 409, false, 'This request has already been converted.');

  const vendorId = req.body.vendorId || pr.vendorId;
  if (!vendorId) return returnFunction(res, 400, false, 'A vendor is required to create a purchase order.');
  const vendor = await findOne('vendors', { _id: new ObjectId(vendorId) });
  if (!vendor) return returnFunction(res, 404, false, 'Vendor not found.');

  const poNumber = await generatePONumber();
  const items = (pr.items || []).map((it) => ({
    id: it.id || new ObjectId().toString(),
    description: it.description,
    quantity: Number(it.quantity) || 0,
    unitPrice: Number(it.estimatedUnitPrice ?? it.unitPrice) || 0,
    currency: it.currency || pr.currency || 'KES',
    receivedQuantity: 0,
    specifications: it.specifications || null,
  }));
  const totalAmount = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);

  const doc = {
    requisitionId: pr._id,
    poNumber,
    vendorId: new ObjectId(vendorId),
    requestedBy: pr.requestedBy,
    departmentId: pr.department || null,
    status: 'draft',
    items,
    totalAmount,
    currency: pr.currency || 'KES',
    deliveryAddress: req.body.deliveryAddress || '',
    expectedDeliveryDate: req.body.expectedDeliveryDate ? new Date(req.body.expectedDeliveryDate) : null,
    actualDeliveryDate: null,
    paymentTerms: req.body.paymentTerms || vendor.paymentTerms || '',
    notes: req.body.notes || null,
    attachmentUrls: [],
    invoiceId: null,
    createdBy: req.user?._id ?? null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('purchase_orders', doc);

  await updateOne('purchase_requests', { _id: pr._id }, {
    $set: { status: 'converted', convertedToPOId: result.insertedId, updatedAt: new Date() },
  });

  if (pr.requestedBy) {
    notifyUser(pr.requestedBy, {
      title: 'Purchase Order Created',
      body: `"${pr.title}" has been converted to purchase order ${poNumber}.`,
      type: 'general',
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, poNumber });
};

// ══════════════════════════════════════════════════════════════════════════════
//  PURCHASE ORDERS
// ══════════════════════════════════════════════════════════════════════════════

const listPurchaseOrders = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  const filter = {};
  if (!isHR) {
    const employee = req.user?.employeeId
      ? await findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1 } })
      : null;
    filter.departmentId = employee?.department || '__none__';
  }
  if (req.query.status) filter.status = req.query.status;

  const [total, data] = await Promise.all([
    countDocuments('purchase_orders', filter),
    findMany('purchase_orders', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);
  const enriched = await Promise.all(data.map(async (po) => {
    const vendor = po.vendorId ? await findOne('vendors', { _id: po.vendorId }, { projection: { name: 1, category: 1 } }) : null;
    return { ...po, vendor };
  }));
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getPurchaseOrder = async (req, res) => {
  const po = await findOne('purchase_orders', { _id: new ObjectId(req.params.id) });
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && req.user?.role === 'department_head') {
    const employee = req.user?.employeeId ? await findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1 } }) : null;
    if (!employee?.department || employee.department !== po.departmentId) return returnFunction(res, 403, false, 'Access denied.');
  } else if (!isHR) {
    return returnFunction(res, 403, false, 'Access denied.');
  }
  const [vendor, requisition] = await Promise.all([
    po.vendorId ? findOne('vendors', { _id: po.vendorId }) : null,
    po.requisitionId ? findOne('purchase_requests', { _id: po.requisitionId }, { projection: { title: 1 } }) : null,
  ]);
  return returnFunction(res, 200, true, req.locale.success, { ...po, vendor, requisition });
};

const updatePurchaseOrder = async (req, res) => {
  const po = await findOne('purchase_orders', { _id: new ObjectId(req.params.id) });
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['draft'].includes(po.status)) return returnFunction(res, 400, false, 'Only draft purchase orders can be edited.');
  const { items, deliveryAddress, expectedDeliveryDate, paymentTerms, notes, vendorId } = req.body;
  const update = { updatedAt: new Date() };
  if (Array.isArray(items)) {
    update.items = items;
    update.totalAmount = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), 0);
  }
  if (deliveryAddress !== undefined) update.deliveryAddress = deliveryAddress;
  if (expectedDeliveryDate !== undefined) update.expectedDeliveryDate = expectedDeliveryDate ? new Date(expectedDeliveryDate) : null;
  if (paymentTerms !== undefined) update.paymentTerms = paymentTerms;
  if (notes !== undefined) update.notes = notes;
  if (vendorId !== undefined) update.vendorId = new ObjectId(vendorId);
  await updateOne('purchase_orders', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const sendPurchaseOrder = async (req, res) => {
  const po = await findOne('purchase_orders', { _id: new ObjectId(req.params.id) });
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'draft') return returnFunction(res, 400, false, 'Only a draft purchase order can be sent.');
  await updateOne('purchase_orders', { _id: new ObjectId(req.params.id) }, { $set: { status: 'sent', updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Purchase order sent to vendor.');
};

const acknowledgePurchaseOrder = async (req, res) => {
  const po = await findOne('purchase_orders', { _id: new ObjectId(req.params.id) });
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'sent') return returnFunction(res, 400, false, 'Only a sent purchase order can be acknowledged.');
  await updateOne('purchase_orders', { _id: new ObjectId(req.params.id) }, { $set: { status: 'acknowledged', updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Purchase order acknowledged.');
};

const cancelPurchaseOrder = async (req, res) => {
  const po = await findOne('purchase_orders', { _id: new ObjectId(req.params.id) });
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (['fullyReceived', 'paid'].includes(po.status)) return returnFunction(res, 400, false, 'Cannot cancel a completed purchase order.');
  await updateOne('purchase_orders', { _id: new ObjectId(req.params.id) }, { $set: { status: 'cancelled', updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Purchase order cancelled.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  GOODS RECEIPTS
// ══════════════════════════════════════════════════════════════════════════════

const listGoodsReceipts = async (req, res) => {
  const filter = {};
  if (req.query.purchaseOrderId) filter.purchaseOrderId = new ObjectId(req.query.purchaseOrderId);
  const receipts = await findMany('goods_receipts', filter, { sort: { receivedAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, receipts);
};

const getGoodsReceipt = async (req, res) => {
  const receipt = await findOne('goods_receipts', { _id: new ObjectId(req.params.id) });
  if (!receipt) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, receipt);
};

const createGoodsReceipt = async (req, res) => {
  if (!validateRequiredFields(req, res, ['purchaseOrderId', 'items'])) return;
  const { purchaseOrderId, items, notes } = req.body;
  if (!Array.isArray(items) || !items.length) return returnFunction(res, 400, false, 'Add at least one received item.');

  const po = await findOne('purchase_orders', { _id: new ObjectId(purchaseOrderId) });
  if (!po) return returnFunction(res, 404, false, 'Purchase order not found.');
  if (!['sent', 'acknowledged', 'partiallyReceived'].includes(po.status)) {
    return returnFunction(res, 400, false, 'This purchase order is not awaiting receipt.');
  }

  const receiptItems = items.map((it) => {
    const poItem = po.items.find((p) => p.id === it.poItemId);
    return {
      poItemId: it.poItemId,
      description: poItem?.description || '',
      orderedQuantity: poItem?.quantity || 0,
      receivedQuantity: Number(it.receivedQuantity) || 0,
      condition: it.condition || 'good',
      notes: it.notes || null,
    };
  });
  const anyDamaged = receiptItems.some((it) => it.condition !== 'good');
  const fullyReceived = receiptItems.every((it) => it.receivedQuantity >= it.orderedQuantity);
  const status = anyDamaged ? 'disputed' : fullyReceived ? 'complete' : 'partial';

  const doc = {
    purchaseOrderId: po._id,
    receivedBy: req.user?._id ?? null,
    receivedAt: new Date(),
    items: receiptItems,
    status,
    notes: notes || null,
    attachmentUrls: [],
    createdAt: new Date(),
  };
  const result = await insertOne('goods_receipts', doc);

  // Update the PO's per-item receivedQuantity and overall status
  const updatedPOItems = po.items.map((poItem) => {
    const received = receiptItems.find((r) => r.poItemId === poItem.id);
    return received ? { ...poItem, receivedQuantity: (poItem.receivedQuantity || 0) + received.receivedQuantity } : poItem;
  });
  const allFullyReceived = updatedPOItems.every((it) => (it.receivedQuantity || 0) >= it.quantity);
  const anyReceived = updatedPOItems.some((it) => (it.receivedQuantity || 0) > 0);
  const poStatus = allFullyReceived ? 'fullyReceived' : anyReceived ? 'partiallyReceived' : po.status;

  await updateOne('purchase_orders', { _id: po._id }, {
    $set: {
      items: updatedPOItems, status: poStatus, updatedAt: new Date(),
      ...(allFullyReceived ? { actualDeliveryDate: new Date() } : {}),
    },
  });

  // A damaged/short receipt needs someone to resolve it — nobody was ever told before,
  // so it just sat there until HR happened to open the goods-receipts list.
  if (status === 'disputed') {
    notifyHR({
      type: 'procurement', subType: 'goods_receipt_disputed',
      title: `Goods receipt flagged — PO ${po.poNumber || po._id}`,
      subtitle: notes || 'One or more received items were marked damaged/short.',
      referenceId: result.insertedId, referenceModel: 'goods_receipts',
      requiresAction: true, triggeredBy: req.user?._id ?? null,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, poStatus });
};

// ══════════════════════════════════════════════════════════════════════════════
//  VENDOR INVOICES + 3-WAY MATCH
// ══════════════════════════════════════════════════════════════════════════════

const listVendorInvoices = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const [total, data] = await Promise.all([
    countDocuments('vendor_invoices', filter),
    findMany('vendor_invoices', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);
  const enriched = await Promise.all(data.map(async (inv) => {
    const vendor = inv.vendorId ? await findOne('vendors', { _id: inv.vendorId }, { projection: { name: 1 } }) : null;
    return { ...inv, vendor };
  }));
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getVendorInvoice = async (req, res) => {
  const invoice = await findOne('vendor_invoices', { _id: new ObjectId(req.params.id) });
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  const [vendor, po] = await Promise.all([
    invoice.vendorId ? findOne('vendors', { _id: invoice.vendorId }) : null,
    invoice.purchaseOrderId ? findOne('purchase_orders', { _id: invoice.purchaseOrderId }) : null,
  ]);
  return returnFunction(res, 200, true, req.locale.success, { ...invoice, vendor, purchaseOrder: po });
};

const createVendorInvoice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['purchaseOrderId', 'vendorId', 'invoiceNumber', 'invoiceDate', 'dueDate', 'items'])) return;
  const { purchaseOrderId, vendorId, invoiceNumber, invoiceDate, dueDate, items, currency } = req.body;
  if (!Array.isArray(items) || !items.length) return returnFunction(res, 400, false, 'Add at least one invoice line item.');

  const po = await findOne('purchase_orders', { _id: new ObjectId(purchaseOrderId) });
  if (!po) return returnFunction(res, 404, false, 'Purchase order not found.');

  const invoiceItems = items.map((it) => ({
    description: it.description, quantity: Number(it.quantity) || 0,
    unitPrice: Number(it.unitPrice) || 0, totalPrice: (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
  }));
  const totalAmount = invoiceItems.reduce((s, it) => s + it.totalPrice, 0);

  const doc = {
    purchaseOrderId: po._id, vendorId: new ObjectId(vendorId),
    invoiceNumber, invoiceDate: new Date(invoiceDate), dueDate: new Date(dueDate),
    items: invoiceItems, totalAmount, currency: currency || po.currency || 'KES',
    status: 'received', threeWayMatchStatus: 'pending', discrepancyNotes: null,
    fileUrl: req.body.fileUrl || null,
    approvedBy: null, approvedAt: null, paidAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('vendor_invoices', doc);
  await updateOne('purchase_orders', { _id: po._id }, { $set: { invoiceId: result.insertedId, updatedAt: new Date() } });

  notifyHR({
    type: 'procurement', subType: 'vendor_invoice_received',
    title: `Vendor invoice received — #${invoiceNumber}`,
    subtitle: `${doc.currency} ${totalAmount.toLocaleString()} — needs 3-way match`,
    referenceId: result.insertedId, referenceModel: 'vendor_invoices',
    requiresAction: true, triggeredBy: req.user?._id ?? null,
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// Three-way match: compare the invoice against the PO (ordered) and the goods receipts
// (actually received) for the same PO. Matches when invoice total equals PO total and
// every line's received quantity covers the invoiced quantity; otherwise flags the
// specific discrepancy so HR can decide to approve anyway or dispute with the vendor.
const matchVendorInvoice = async (req, res) => {
  const invoice = await findOne('vendor_invoices', { _id: new ObjectId(req.params.id) });
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  const [po, receipts] = await Promise.all([
    findOne('purchase_orders', { _id: invoice.purchaseOrderId }),
    findMany('goods_receipts', { purchaseOrderId: invoice.purchaseOrderId }, {}),
  ]);
  if (!po) return returnFunction(res, 404, false, 'Purchase order not found.');

  const discrepancies = [];
  if (Math.abs(invoice.totalAmount - po.totalAmount) > 0.01) {
    discrepancies.push(`Invoice total (${invoice.totalAmount}) does not match PO total (${po.totalAmount}).`);
  }
  const totalReceivedByItem = {};
  for (const r of receipts) {
    for (const it of r.items) {
      totalReceivedByItem[it.poItemId] = (totalReceivedByItem[it.poItemId] || 0) + it.receivedQuantity;
    }
  }
  for (const poItem of po.items) {
    const received = totalReceivedByItem[poItem.id] || 0;
    if (received < poItem.quantity) {
      discrepancies.push(`"${poItem.description}": only ${received}/${poItem.quantity} received so far.`);
    }
  }

  const threeWayMatchStatus = discrepancies.length ? 'discrepancy' : 'matched';
  await updateOne('vendor_invoices', { _id: invoice._id }, {
    $set: {
      threeWayMatchStatus, discrepancyNotes: discrepancies.join(' ') || null,
      status: threeWayMatchStatus === 'matched' ? 'matched' : 'underReview',
      updatedAt: new Date(),
    },
  });
  return returnFunction(res, 200, true, req.locale.success, { threeWayMatchStatus, discrepancies });
};

const approveVendorInvoice = async (req, res) => {
  const invoice = await findOne('vendor_invoices', { _id: new ObjectId(req.params.id) });
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['received', 'underReview', 'matched'].includes(invoice.status)) return returnFunction(res, 400, false, 'Invoice cannot be approved from its current status.');
  await updateOne('vendor_invoices', { _id: invoice._id }, {
    $set: { status: 'approved', approvedBy: req.user?._id ?? null, approvedAt: new Date(), updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Invoice approved.');
};

const disputeVendorInvoice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const invoice = await findOne('vendor_invoices', { _id: new ObjectId(req.params.id) });
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('vendor_invoices', { _id: invoice._id }, {
    $set: { status: 'disputed', discrepancyNotes: req.body.reason, updatedAt: new Date() },
  });

  notifyHR({
    type: 'procurement', subType: 'vendor_invoice_disputed',
    title: `Vendor invoice disputed${invoice.invoiceNumber ? ` — #${invoice.invoiceNumber}` : ''}`,
    subtitle: req.body.reason,
    referenceId: invoice._id, referenceModel: 'vendor_invoices',
    requiresAction: true, triggeredBy: req.user?._id ?? null,
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Invoice marked as disputed.');
};

const payVendorInvoice = async (req, res) => {
  const invoice = await findOne('vendor_invoices', { _id: new ObjectId(req.params.id) });
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  if (invoice.status !== 'approved') return returnFunction(res, 400, false, 'Invoice must be approved before it can be paid.');
  await updateOne('vendor_invoices', { _id: invoice._id }, { $set: { status: 'paid', paidAt: new Date(), updatedAt: new Date() } });
  await updateOne('purchase_orders', { _id: invoice.purchaseOrderId }, { $set: { status: 'paid', updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Invoice marked as paid.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  PROCUREMENT ANALYTICS (role-scoped)
// ══════════════════════════════════════════════════════════════════════════════

const getProcurementOverview = async (req, res) => {
  const scope = await buildSpendScopeFilter(req);
  const [pendingPRs, openPOs, invoicesPendingApproval, totalSpendAgg] = await Promise.all([
    countDocuments('purchase_requests', { ...scope, status: 'pending' }),
    countDocuments('purchase_orders', {}),
    countDocuments('vendor_invoices', { status: { $in: ['received', 'underReview', 'matched'] } }),
    global.dbo.collection('purchase_orders').aggregate([
      { $match: { status: { $in: ['fullyReceived', 'invoiced', 'paid'] } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]).toArray(),
  ]);
  return returnFunction(res, 200, true, req.locale.success, {
    pendingPRs, openPOs, invoicesPendingApproval, totalSpend: totalSpendAgg[0]?.total ?? 0,
  });
};

const getProcurementSpend = async (req, res) => {
  const scope = await buildSpendScopeFilter(req);
  const employeeFilter = scope.employeeId ? { employeeId: scope.employeeId } : {};
  const prs = await findMany('purchase_requests', { ...employeeFilter, status: { $ne: 'rejected' } }, {});
  const byDept = {};
  for (const pr of prs) {
    const dept = pr.department || 'Unassigned';
    byDept[dept] = (byDept[dept] || 0) + (pr.estimatedCost || 0);
  }
  return returnFunction(res, 200, true, req.locale.success, {
    byDepartment: Object.entries(byDept).map(([department, total]) => ({ department, total })),
  });
};

const getVendorAnalytics = async (req, res) => {
  const spend = await global.dbo.collection('purchase_orders').aggregate([
    { $group: { _id: '$vendorId', totalSpend: { $sum: '$totalAmount' }, orderCount: { $sum: 1 } } },
    { $sort: { totalSpend: -1 } }, { $limit: 20 },
  ]).toArray();
  const enriched = await Promise.all(spend.map(async (s) => {
    const vendor = s._id ? await findOne('vendors', { _id: s._id }, { projection: { name: 1, category: 1 } }) : null;
    return { ...s, vendor };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getCycleTimeAnalytics = async (req, res) => {
  const pos = await findMany('purchase_orders', { actualDeliveryDate: { $ne: null } }, { projection: { createdAt: 1, actualDeliveryDate: 1 } });
  const days = pos.map((po) => (new Date(po.actualDeliveryDate) - new Date(po.createdAt)) / 86400000).filter((d) => d >= 0);
  const avgCycleTimeDays = days.length ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : null;
  return returnFunction(res, 200, true, req.locale.success, { avgCycleTimeDays, sampleSize: days.length });
};

module.exports = {
  listCards, createCard, updateCard,
  listTransactions, addTransaction,
  listInvoices, createInvoice, approveInvoice, rejectInvoice, markPaid,
  listPurchaseRequests, getPurchaseRequest, createPurchaseRequest, updatePurchaseRequest,
  approvePurchaseRequest, rejectPurchaseRequest,
  listVendors, getVendor, createVendor, updateVendor, deleteVendor, approveVendor, rejectVendor,
  listProcurementPolicies, getProcurementPolicy, createProcurementPolicy, updateProcurementPolicy, deleteProcurementPolicy,
  convertRequisitionToPO,
  listPurchaseOrders, getPurchaseOrder, updatePurchaseOrder, sendPurchaseOrder, acknowledgePurchaseOrder, cancelPurchaseOrder,
  listGoodsReceipts, getGoodsReceipt, createGoodsReceipt,
  listVendorInvoices, getVendorInvoice, createVendorInvoice, matchVendorInvoice, approveVendorInvoice, disputeVendorInvoice, payVendorInvoice,
  getProcurementOverview, getProcurementSpend, getVendorAnalytics, getCycleTimeAnalytics,
};
