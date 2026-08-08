// Postgres migration (Phase 8) — corporate_cards/card_transactions/invoices (legacy)/
// purchase_requests/vendors/procurement_policies/purchase_orders/goods_receipts/
// vendor_invoices are all Postgres now. employees has been Postgres since Phase 1.
// The `counters` transactional-upsert pattern replaces the old Mongo
// findOneAndUpdate($inc) for PO/PO-invoice numbering.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { notifyUser, notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR, notifyManager } = require('../inbox/inboxFunctions');
const { buildApprovalChain, findCurrentLevelEntry, canActOnLevel } = require('../../lib/spend/approvalChain');
const { resolvePolicy } = require('../../lib/spend/policyResolver');
const { buildSpendScopeFilter, canAccessRecord } = require('../../lib/spend/orgScope');
const { sendEmail } = require('../../services/emailService');
const { postJournalEntry, resolveSystemAccount } = require('../../lib/accounting/glEngine');
const { resolvePaymentSystemKey, GENERIC_PAYMENT_SYSTEM_KEYS } = require('../../lib/accounting/paymentMethodAccounts');
const { logPostingFailure } = require('../accounting/accountingPostingFailuresFunctions');

const round2 = (n) => Math.round(n * 100) / 100;

// ══════════════════════════════════════════════════════════════════════════════
//  CORPORATE CARDS
// ══════════════════════════════════════════════════════════════════════════════

const listCards = async (req, res) => {
  let query = knex('corporate_cards');
  if (req.query.status) query = query.where({ status: req.query.status });
  const cards = await query.orderBy('createdAt', 'desc');
  const enriched = await Promise.all(cards.map(async (c) => {
    const emp = c.assignedTo
      ? await knex('employees').where({ id: c.assignedTo }).select('fullName', 'department').first()
      : null;
    const [{ total }] = await knex('card_transactions').where({ cardId: c.id, type: 'debit' }).sum('amount as total');
    return { ...c, employee: emp, totalSpent: Number(total) || 0 };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createCard = async (req, res) => {
  if (!validateRequiredFields(req, res, ['last4', 'cardHolder'])) return;
  const { last4, cardHolder, assignedTo, creditLimit, currency, expiryDate, network } = req.body;
  const doc = {
    id: newId(),
    last4,
    cardHolder,
    assignedTo: assignedTo || null,
    creditLimit: creditLimit ? Number(creditLimit) : null,
    currency: currency || 'KES',
    expiryDate: expiryDate ? new Date(expiryDate) : null,
    network: network || 'visa',
    status: 'active',
    createdAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await knex('corporate_cards').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateCard = async (req, res) => {
  const card = await knex('corporate_cards').where({ id: req.params.id }).first();
  if (!card) return returnFunction(res, 404, false, req.locale.notFound);
  const { status, creditLimit, assignedTo } = req.body;
  const update = { updatedAt: new Date() };
  if (status !== undefined) update.status = status;
  if (creditLimit !== undefined) update.creditLimit = Number(creditLimit);
  if (assignedTo !== undefined) update.assignedTo = assignedTo || null;
  await knex('corporate_cards').where({ id: card.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Transactions ──────────────────────────────────────────────────────────────
const listTransactions = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  let query = knex('card_transactions');
  if (req.params.cardId) query = query.where({ cardId: req.params.cardId });
  if (req.query.type) query = query.where({ type: req.query.type });

  const [{ count }] = await query.clone().count('* as count');
  const data = await query.clone().orderBy('date', 'desc').limit(limit).offset(skip);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, Number(count), page, limit));
};

const addTransaction = async (req, res) => {
  if (!validateRequiredFields(req, res, ['amount', 'description', 'date'])) return;
  const { amount, description, date, merchant, category, type } = req.body;
  const doc = {
    id: newId(),
    cardId: req.params.cardId,
    amount: Number(amount),
    description,
    date: new Date(date),
    merchant: merchant || null,
    category: category || 'other',
    type: type || 'debit',
    createdAt: new Date(),
  };
  const [saved] = await knex('card_transactions').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

// ══════════════════════════════════════════════════════════════════════════════
//  INVOICES (legacy AP/AR — preserved)
// ══════════════════════════════════════════════════════════════════════════════

const listInvoices = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  let query = knex('invoices');
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.type) query = query.where({ type: req.query.type });
  if (req.query.search) {
    const q = `%${req.query.search.trim()}%`;
    query = query.where((qb) => qb.whereILike('invoiceNumber', q).orWhereILike('vendor', q));
  }

  const [{ count }] = await query.clone().count('* as count');
  const data = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const stats = await knex('invoices').select('status').sum('amount as total').count('* as count').groupBy('status');

  return returnFunction(res, 200, true, req.locale.success, { ...paginatedResponse(data, Number(count), page, limit), stats });
};

const createInvoice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['vendor', 'amount', 'dueDate'])) return;
  const { vendor, amount, currency, dueDate, description, invoiceNumber, type, projectId } = req.body;

  // Duplicate invoice number check
  if (invoiceNumber) {
    const dup = await knex('invoices').where({ invoiceNumber }).first();
    if (dup) return returnFunction(res, 409, false, `Invoice number ${invoiceNumber} already exists.`);
  }

  const doc = {
    id: newId(),
    vendor,
    amount: Number(amount),
    currency: currency || 'KES',
    dueDate: new Date(dueDate),
    description: description || null,
    invoiceNumber: invoiceNumber || null,
    type: type || 'accounts_payable',
    projectId: projectId || null,
    items: JSON.stringify(req.body.items || []),
    status: 'pending',
    submittedBy: req.user?.id ?? null,
    approvedBy: null, approvedAt: null,
    rejectedBy: null, rejectedAt: null, rejectionReason: null,
    paidAt: null, paymentReference: null,
    createdAt: new Date(), updatedAt: new Date(),
  };

  const [saved] = await knex('invoices').insert(doc).returning('*');

  const inboxPayload = {
    type: 'procurement', subType: 'invoice_submitted',
    title: `Invoice ${invoiceNumber ? `#${invoiceNumber} ` : ''}from ${vendor}`,
    subtitle: `${doc.currency} ${doc.amount.toLocaleString()} — due ${doc.dueDate.toDateString()}`,
    referenceId: saved.id, referenceModel: 'invoices',
    requiresAction: true, triggeredBy: req.user?.id ?? null,
  };
  notifyHR(inboxPayload).catch(() => {});
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'New Invoice Submitted', body: inboxPayload.subtitle, type: 'general',
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const approveInvoice = async (req, res) => {
  const inv = await knex('invoices').where({ id: req.params.id }).first();
  if (!inv) return returnFunction(res, 404, false, req.locale.notFound);
  if (inv.status !== 'pending') return returnFunction(res, 400, false, 'Invoice is not pending.');
  await knex('invoices').where({ id: req.params.id }).update({
    status: 'approved', approvedBy: req.user?.id ?? null, approvedAt: new Date(), updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Invoice approved.');
};

const rejectInvoice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const inv = await knex('invoices').where({ id: req.params.id }).first();
  if (!inv) return returnFunction(res, 404, false, req.locale.notFound);
  if (inv.status !== 'pending') return returnFunction(res, 400, false, 'Invoice is not pending.');
  await knex('invoices').where({ id: req.params.id }).update({
    status: 'rejected', rejectedBy: req.user?.id ?? null, rejectedAt: new Date(), rejectionReason: req.body.reason, updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Invoice rejected.');
};

const markPaid = async (req, res) => {
  const inv = await knex('invoices').where({ id: req.params.id }).first();
  if (!inv) return returnFunction(res, 404, false, req.locale.notFound);
  if (inv.status !== 'approved') return returnFunction(res, 400, false, 'Invoice must be approved before marking paid.');
  const { paymentReference } = req.body;
  await knex('invoices').where({ id: req.params.id }).update({
    status: 'paid', paidAt: new Date(), paymentReference: paymentReference || null, updatedAt: new Date(),
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
// requestedBy = users.id (who clicked submit), employeeId = employees.id (used for
// all org-hierarchy scoping/approval-chain resolution) — both kept since HR tooling
// elsewhere may still look up by requestedBy.

const listPurchaseRequests = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const scope = await buildSpendScopeFilter(req);
  let query = knex('purchase_requests');
  if (scope?.department !== undefined) query = query.where({ department: scope.department });
  else if (scope?.employeeIds) query = query.whereIn('employeeId', scope.employeeIds);
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.priority) query = query.where({ priority: req.query.priority });

  const [{ count }] = await query.clone().count('* as count');
  const data = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const enriched = await Promise.all(data.map(async (r) => {
    const requester = r.employeeId
      ? await knex('employees').where({ id: r.employeeId }).select('fullName', 'department').first()
      : null;
    return { ...r, requester };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getPurchaseRequest = async (req, res) => {
  const pr = await knex('purchase_requests').where({ id: req.params.id }).first();
  if (!pr) return returnFunction(res, 404, false, req.locale.notFound);
  const allowed = await canAccessRecord(req, pr.employeeId, pr.department);
  if (!allowed) return returnFunction(res, 403, false, 'Access denied.');
  const requester = pr.employeeId ? await knex('employees').where({ id: pr.employeeId }).select('fullName', 'department').first() : null;
  return returnFunction(res, 200, true, req.locale.success, { ...pr, requester });
};

const createPurchaseRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'estimatedCost'])) return;
  const { title, description, justification, estimatedCost, currency, priority, vendor, vendorId, items, neededBy } = req.body;

  // req.user.employeeId is a Mongo ObjectId instance (AuthMiddleware.js's backward-
  // compat alias) — String() it before it's inserted as a plain-text FK value below.
  const employeeId = req.user?.employeeId ? String(req.user.employeeId) : null;
  const employee = employeeId ? await knex('employees').where({ id: employeeId }).select('department', 'fullName').first() : null;

  const policy = await resolvePolicy('procurement_policies', {
    employeeId, role: req.user?.role, department: employee?.department,
  }) ?? {};
  const approvalChain = employeeId ? await buildApprovalChain(employeeId, Number(estimatedCost), policy) : [];

  const doc = {
    id: newId(),
    title,
    description: description || null,
    justification: justification || description || null,
    estimatedCost: Number(estimatedCost),
    currency: currency || 'KES',
    priority: priority || 'normal',
    vendor: vendor || null,
    vendorId: vendorId || null,
    department: employee?.department || req.body.department || null,
    items: JSON.stringify(items || []),
    neededBy: neededBy ? new Date(neededBy) : null,
    policyId: policy.id || null,
    approvalChain: JSON.stringify(approvalChain),
    currentApprovalLevel: approvalChain[0]?.level ?? 0,
    requestedBy: req.user?.id ?? null,
    employeeId,
    status: 'pending',
    convertedToPOId: null,
    approvedBy: null, approvedAt: null,
    rejectedBy: null, rejectedAt: null, rejectionReason: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await knex('purchase_requests').insert(doc).returning('*');

  const requesterName = employee?.fullName || req.user?.name || 'An employee';
  const inboxPayload = {
    type: 'procurement', subType: 'purchase_request_submitted',
    title: `Purchase request from ${requesterName}`,
    subtitle: `"${title}" — ${doc.currency} ${doc.estimatedCost.toLocaleString()}`,
    referenceId: saved.id, referenceModel: 'purchase_requests',
    requiresAction: true, triggeredBy: req.user?.id ?? null,
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

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updatePurchaseRequest = async (req, res) => {
  const pr = await knex('purchase_requests').where({ id: req.params.id }).first();
  if (!pr) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['draft', 'pending'].includes(pr.status)) return returnFunction(res, 400, false, 'Cannot edit after approval.');
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(pr.employeeId) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Access denied.');
  const { title, description, justification, priority, items, neededBy, vendorId } = req.body;
  const update = { updatedAt: new Date() };
  if (title !== undefined) update.title = title;
  if (description !== undefined) update.description = description;
  if (justification !== undefined) update.justification = justification;
  if (priority !== undefined) update.priority = priority;
  if (neededBy !== undefined) update.neededBy = neededBy ? new Date(neededBy) : null;
  if (vendorId !== undefined) update.vendorId = vendorId || null;
  if (Array.isArray(items)) {
    update.items = JSON.stringify(items);
    update.estimatedCost = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.estimatedUnitPrice) || 0), 0);
  }
  await knex('purchase_requests').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const approvePurchaseRequest = async (req, res) => {
  const pr = await knex('purchase_requests').where({ id: req.params.id }).first();
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
    update.approvalChain = JSON.stringify(chain);
  }

  if (nextPending) {
    update.currentApprovalLevel = nextPending.level;
  } else {
    update.status = 'approved';
    update.approvedBy = req.user?.id ?? null;
    update.approvedAt = now;
  }

  await knex('purchase_requests').where({ id: req.params.id }).update(update);

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
  const pr = await knex('purchase_requests').where({ id: req.params.id }).first();
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
    status: 'rejected', rejectedBy: req.user?.id ?? null, rejectedAt: now,
    rejectionReason: req.body.reason, updatedAt: now,
  };
  if (levelEntry) {
    update.approvalChain = JSON.stringify(pr.approvalChain.map((a) => a.level === levelEntry.level
      ? { ...a, status: 'rejected', actedAt: now, comment: req.body.reason }
      : a));
  }
  await knex('purchase_requests').where({ id: req.params.id }).update(update);
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
  let query = knex('vendors');
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.category) query = query.where({ category: req.query.category });
  const vendors = await query.orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, vendors);
};

const getVendor = async (req, res) => {
  const vendor = await knex('vendors').where({ id: req.params.id }).first();
  if (!vendor) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, vendor);
};

// Company vendors must prove they're legitimately registered in Kenya before they can
// transact — KRA PIN certificate, certificate of registration/incorporation, and a
// business permit. Individual vendors skip this (no company to verify).
const COMPANY_KYC_DOCS = [
  { field: 'kraPinCertificate', docType: 'KRA PIN Certificate' },
  { field: 'registrationCertificate', docType: 'Certificate of Registration' },
  { field: 'businessPermit', docType: 'Business Permit' },
];

const createVendor = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'category', 'type'])) return;
  const { name, contactName, email, phone, address, category, type, taxId, paymentTerms, bankDetails, notes } = req.body;
  if (!['company', 'individual'].includes(type)) return returnFunction(res, 400, false, 'Vendor type must be "company" or "individual".');

  let documents = [];
  if (type === 'company') {
    const missing = COMPANY_KYC_DOCS.filter((d) => !req.files?.[d.field]?.[0]);
    if (missing.length) {
      return returnFunction(res, 400, false, `Company vendors must provide: ${missing.map((d) => d.docType).join(', ')}.`);
    }
    documents = COMPANY_KYC_DOCS.map((d) => {
      const file = req.files[d.field][0];
      return { docId: newId(), docType: d.docType, fileName: file.originalname, filePath: `/uploads/${file.filename}`, uploadedAt: new Date() };
    });
  }

  const doc = {
    id: newId(),
    name, contactName: contactName || null, email: email || null, phone: phone || null,
    address: address || null, category, type, taxId: taxId || null, paymentTerms: paymentTerms || null,
    bankDetails: bankDetails ? JSON.stringify(bankDetails) : null, documents: JSON.stringify(documents),
    status: 'pending_approval', notes: notes || null,
    approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null, rejectionReason: null,
    createdBy: req.user?.id ?? null, createdAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await knex('vendors').insert(doc).returning('*');
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'New Vendor Pending Approval', body: `${name} has been submitted and is awaiting approval.`, type: 'general',
  }).catch(() => {});
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateVendor = async (req, res) => {
  const vendor = await knex('vendors').where({ id: req.params.id }).first();
  if (!vendor) return returnFunction(res, 404, false, req.locale.notFound);
  const ALLOWED = ['name', 'contactName', 'email', 'phone', 'address', 'category', 'taxId', 'paymentTerms', 'notes', 'status'];
  const update = { updatedAt: new Date() };
  for (const key of ALLOWED) if (req.body[key] !== undefined) update[key] = req.body[key];
  if (req.body.bankDetails !== undefined) update.bankDetails = req.body.bankDetails ? JSON.stringify(req.body.bankDetails) : null;
  await knex('vendors').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const approveVendor = async (req, res) => {
  const vendor = await knex('vendors').where({ id: req.params.id }).first();
  if (!vendor) return returnFunction(res, 404, false, req.locale.notFound);
  if (vendor.status !== 'pending_approval') return returnFunction(res, 400, false, 'This vendor is not pending approval.');
  await knex('vendors').where({ id: vendor.id }).update({
    status: 'active', approvedBy: req.user?.id ?? null, approvedAt: new Date(), updatedAt: new Date(),
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
  const vendor = await knex('vendors').where({ id: req.params.id }).first();
  if (!vendor) return returnFunction(res, 404, false, req.locale.notFound);
  if (vendor.status !== 'pending_approval') return returnFunction(res, 400, false, 'This vendor is not pending approval.');
  await knex('vendors').where({ id: vendor.id }).update({
    status: 'rejected', rejectedBy: req.user?.id ?? null, rejectedAt: new Date(), rejectionReason: req.body.rejectionReason, updatedAt: new Date(),
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
  const vendor = await knex('vendors').where({ id: req.params.id }).first();
  if (!vendor) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('vendors').where({ id: req.params.id }).update({ status: 'inactive', updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  PROCUREMENT POLICIES
// ══════════════════════════════════════════════════════════════════════════════

const listProcurementPolicies = async (req, res) => {
  const policies = await knex('procurement_policies').orderBy('isDefault', 'desc').orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, policies);
};

const getProcurementPolicy = async (req, res) => {
  const policy = await knex('procurement_policies').where({ id: req.params.id }).first();
  if (!policy) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, policy);
};

const createProcurementPolicy = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const { name, appliesTo, approvalChain, requiresQuotationAbove, preferredVendors, isDefault } = req.body;
  if (isDefault) await knex('procurement_policies').update({ isDefault: false });
  const doc = {
    id: newId(),
    name, appliesTo: JSON.stringify(appliesTo || {}), approvalChain: JSON.stringify(approvalChain || []),
    requiresQuotationAbove: requiresQuotationAbove ?? null,
    preferredVendors: (preferredVendors || []).map(String),
    isDefault: Boolean(isDefault), isActive: true,
    createdBy: req.user?.id ?? null, createdAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await knex('procurement_policies').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateProcurementPolicy = async (req, res) => {
  const existing = await knex('procurement_policies').where({ id: req.params.id }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  if (req.body.isDefault) {
    await knex('procurement_policies').whereNot({ id: existing.id }).update({ isDefault: false });
  }
  const ALLOWED = ['name', 'requiresQuotationAbove', 'isDefault', 'isActive'];
  const update = { updatedAt: new Date() };
  for (const key of ALLOWED) if (req.body[key] !== undefined) update[key] = req.body[key];
  if (req.body.appliesTo !== undefined) update.appliesTo = JSON.stringify(req.body.appliesTo);
  if (req.body.approvalChain !== undefined) update.approvalChain = JSON.stringify(req.body.approvalChain);
  if (Array.isArray(req.body.preferredVendors)) update.preferredVendors = req.body.preferredVendors.map(String);
  await knex('procurement_policies').where({ id: existing.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteProcurementPolicy = async (req, res) => {
  const existing = await knex('procurement_policies').where({ id: req.params.id }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  if (existing.isDefault) return returnFunction(res, 400, false, 'Cannot deactivate the default policy — mark another policy as default first.');
  await knex('procurement_policies').where({ id: existing.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  CONVERT PR → PO
// ══════════════════════════════════════════════════════════════════════════════

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
  const seq = await nextCounterSeq(`po_number_${year}`);
  return `PO-${year}-${String(seq).padStart(5, '0')}`;
};

// Short, scannable department code for the invoice-numbering scheme below —
// "Human Resources" -> "HR", "Technology" -> "TEC" — purely cosmetic, not part of the
// uniqueness guarantee (the counter is what makes the number unique).
function departmentCode(deptName) {
  if (!deptName) return 'GEN';
  const words = deptName.trim().split(/\s+/);
  return (words.length === 1 ? words[0].slice(0, 3) : words.map((w) => w[0]).join('').slice(0, 4)).toUpperCase();
}

// Our own internal reference for a vendor invoice tied to a PO — deliberately separate
// from the vendor's own invoice number (which we still capture as-is) so a glance at
// this number alone says "this is a PO invoice, from this department": PO-TEC-2026-00007.
const generatePOInvoiceNumber = async (deptName) => {
  const year = new Date().getFullYear();
  const seq = await nextCounterSeq(`po_invoice_number_${year}`);
  return `PO-${departmentCode(deptName)}-${year}-${String(seq).padStart(5, '0')}`;
};

const convertRequisitionToPO = async (req, res) => {
  const pr = await knex('purchase_requests').where({ id: req.params.id }).first();
  if (!pr) return returnFunction(res, 404, false, req.locale.notFound);
  if (pr.status !== 'approved') return returnFunction(res, 400, false, 'Only approved requests can be converted to a purchase order.');
  if (pr.convertedToPOId) return returnFunction(res, 409, false, 'This request has already been converted.');

  const vendorId = req.body.vendorId || pr.vendorId;
  if (!vendorId) return returnFunction(res, 400, false, 'A vendor is required to create a purchase order.');
  const vendor = await knex('vendors').where({ id: vendorId }).first();
  if (!vendor) return returnFunction(res, 404, false, 'Vendor not found.');

  const poNumber = await generatePONumber();
  const items = (pr.items || []).map((it) => ({
    id: it.id || newId(),
    description: it.description,
    quantity: Number(it.quantity) || 0,
    unitPrice: Number(it.estimatedUnitPrice ?? it.unitPrice) || 0,
    currency: it.currency || pr.currency || 'KES',
    receivedQuantity: 0,
    specifications: it.specifications || null,
  }));
  const totalAmount = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);

  const doc = {
    id: newId(),
    requisitionId: pr.id,
    poNumber,
    vendorId,
    requestedBy: pr.requestedBy,
    departmentId: pr.department || null,
    status: 'draft',
    items: JSON.stringify(items),
    totalAmount,
    currency: pr.currency || 'KES',
    deliveryAddress: req.body.deliveryAddress || '',
    expectedDeliveryDate: req.body.expectedDeliveryDate ? new Date(req.body.expectedDeliveryDate) : null,
    actualDeliveryDate: null,
    paymentTerms: req.body.paymentTerms || vendor.paymentTerms || '',
    notes: req.body.notes || null,
    attachmentUrls: [],
    invoiceId: null,
    createdBy: req.user?.id ?? null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await knex('purchase_orders').insert(doc).returning('*');

  await knex('purchase_requests').where({ id: pr.id }).update({ status: 'converted', convertedToPOId: saved.id, updatedAt: new Date() });

  if (pr.requestedBy) {
    notifyUser(pr.requestedBy, {
      title: 'Purchase Order Created',
      body: `"${pr.title}" has been converted to purchase order ${poNumber}.`,
      type: 'general',
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id, poNumber });
};

// ══════════════════════════════════════════════════════════════════════════════
//  PURCHASE ORDERS
// ══════════════════════════════════════════════════════════════════════════════

const listPurchaseOrders = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  let query = knex('purchase_orders');
  if (!isHR) {
    const employee = req.user?.employeeId
      ? await knex('employees').where({ id: String(req.user.employeeId) }).select('department').first()
      : null;
    query = query.where({ departmentId: employee?.department || '__none__' });
  }
  if (req.query.status) query = query.where({ status: req.query.status });

  const [{ count }] = await query.clone().count('* as count');
  const data = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);
  const enriched = await Promise.all(data.map(async (po) => {
    const vendor = po.vendorId ? await knex('vendors').where({ id: po.vendorId }).select('name', 'category').first() : null;
    return { ...po, vendor };
  }));
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getPurchaseOrder = async (req, res) => {
  const po = await knex('purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && req.user?.role === 'department_head') {
    const employee = req.user?.employeeId ? await knex('employees').where({ id: String(req.user.employeeId) }).select('department').first() : null;
    if (!employee?.department || employee.department !== po.departmentId) return returnFunction(res, 403, false, 'Access denied.');
  } else if (!isHR) {
    return returnFunction(res, 403, false, 'Access denied.');
  }
  const [vendor, requisition] = await Promise.all([
    po.vendorId ? knex('vendors').where({ id: po.vendorId }).first() : null,
    po.requisitionId ? knex('purchase_requests').where({ id: po.requisitionId }).select('title').first() : null,
  ]);
  return returnFunction(res, 200, true, req.locale.success, { ...po, vendor, requisition });
};

const updatePurchaseOrder = async (req, res) => {
  const po = await knex('purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'draft') return returnFunction(res, 400, false, 'Only draft purchase orders can be edited.');
  const { items, deliveryAddress, expectedDeliveryDate, paymentTerms, notes, vendorId } = req.body;
  const update = { updatedAt: new Date() };
  if (Array.isArray(items)) {
    update.items = JSON.stringify(items);
    update.totalAmount = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), 0);
  }
  if (deliveryAddress !== undefined) update.deliveryAddress = deliveryAddress;
  if (expectedDeliveryDate !== undefined) update.expectedDeliveryDate = expectedDeliveryDate ? new Date(expectedDeliveryDate) : null;
  if (paymentTerms !== undefined) update.paymentTerms = paymentTerms;
  if (notes !== undefined) update.notes = notes;
  if (vendorId !== undefined) update.vendorId = vendorId;
  await knex('purchase_orders').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const sendPurchaseOrder = async (req, res) => {
  const po = await knex('purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (po.status !== 'draft') return returnFunction(res, 400, false, 'Only a draft purchase order can be sent.');
  await knex('purchase_orders').where({ id: req.params.id }).update({ status: 'pending', updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Purchase order sent to vendor.');
};

// There is no standalone "acknowledge" action — a vendor acknowledges a PO by sending
// us their invoice for it, which is what actually moves the PO forward (see
// createVendorInvoice, which sets status: 'pendingDelivery').

const cancelPurchaseOrder = async (req, res) => {
  const po = await knex('purchase_orders').where({ id: req.params.id }).first();
  if (!po) return returnFunction(res, 404, false, req.locale.notFound);
  if (['fullyReceived', 'paid'].includes(po.status)) return returnFunction(res, 400, false, 'Cannot cancel a completed purchase order.');
  await knex('purchase_orders').where({ id: req.params.id }).update({ status: 'cancelled', updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Purchase order cancelled.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  GOODS RECEIPTS
// ══════════════════════════════════════════════════════════════════════════════

const listGoodsReceipts = async (req, res) => {
  let query = knex('goods_receipts');
  if (req.query.purchaseOrderId) query = query.where({ purchaseOrderId: req.query.purchaseOrderId });
  const receipts = await query.orderBy('receivedAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, receipts);
};

const getGoodsReceipt = async (req, res) => {
  const receipt = await knex('goods_receipts').where({ id: req.params.id }).first();
  if (!receipt) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, receipt);
};

const createGoodsReceipt = async (req, res) => {
  if (!validateRequiredFields(req, res, ['purchaseOrderId', 'items'])) return;
  const { purchaseOrderId, items, notes } = req.body;
  if (!Array.isArray(items) || !items.length) return returnFunction(res, 400, false, 'Add at least one received item.');

  const po = await knex('purchase_orders').where({ id: purchaseOrderId }).first();
  if (!po) return returnFunction(res, 404, false, 'Purchase order not found.');
  if (!['pendingDelivery', 'partiallyReceived'].includes(po.status)) {
    return returnFunction(res, 400, false, 'This purchase order is not awaiting receipt — a vendor invoice must be recorded first.');
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
    id: newId(),
    purchaseOrderId: po.id,
    receivedBy: req.user?.id ?? null,
    receivedAt: new Date(),
    items: JSON.stringify(receiptItems),
    status,
    notes: notes || null,
    attachmentUrls: [],
    createdAt: new Date(),
  };
  const [saved] = await knex('goods_receipts').insert(doc).returning('*');

  // Update the PO's per-item receivedQuantity and overall status
  const updatedPOItems = po.items.map((poItem) => {
    const received = receiptItems.find((r) => r.poItemId === poItem.id);
    return received ? { ...poItem, receivedQuantity: (poItem.receivedQuantity || 0) + received.receivedQuantity } : poItem;
  });
  const allFullyReceived = updatedPOItems.every((it) => (it.receivedQuantity || 0) >= it.quantity);
  const anyReceived = updatedPOItems.some((it) => (it.receivedQuantity || 0) > 0);
  const poStatus = allFullyReceived ? 'fullyReceived' : anyReceived ? 'partiallyReceived' : po.status;

  await knex('purchase_orders').where({ id: po.id }).update({
    items: JSON.stringify(updatedPOItems), status: poStatus, updatedAt: new Date(),
    ...(allFullyReceived ? { actualDeliveryDate: new Date() } : {}),
  });

  // A damaged/short receipt needs someone to resolve it — nobody was ever told before,
  // so it just sat there until HR happened to open the goods-receipts list.
  if (status === 'disputed') {
    notifyHR({
      type: 'procurement', subType: 'goods_receipt_disputed',
      title: `Goods receipt flagged — PO ${po.poNumber || po.id}`,
      subtitle: notes || 'One or more received items were marked damaged/short.',
      referenceId: saved.id, referenceModel: 'goods_receipts',
      requiresAction: true, triggeredBy: req.user?.id ?? null,
    }).catch(() => {});
  }

  // Acknowledge delivery back to the vendor by email — the counterpart to the
  // invoice-received email sent in createVendorInvoice, closing the loop on both ends.
  const vendor = po.vendorId ? await knex('vendors').where({ id: po.vendorId }).first() : null;
  if (vendor?.email) {
    const lines = receiptItems.map((it) =>
      `<li>${it.description} — received ${it.receivedQuantity}/${it.orderedQuantity}${it.condition !== 'good' ? ` (${it.condition})` : ''}</li>`
    ).join('');
    sendEmail({
      to: vendor.email,
      subject: `Delivery received — PO ${po.poNumber || po.id}`,
      html: `<p>Dear ${vendor.contactName || vendor.name},</p><p>We acknowledge receipt of your delivery against purchase order <strong>${po.poNumber || po.id}</strong>:</p><ul>${lines}</ul>${status === 'disputed' ? '<p>Note: one or more items were flagged on receipt (damaged or short-shipped) — our team will be in touch.</p>' : ''}`,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id, poStatus });
};

// ══════════════════════════════════════════════════════════════════════════════
//  VENDOR INVOICES + 3-WAY MATCH
// ══════════════════════════════════════════════════════════════════════════════

const listVendorInvoices = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  let query = knex('vendor_invoices');
  if (req.query.status) query = query.where({ status: req.query.status });
  const [{ count }] = await query.clone().count('* as count');
  const data = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);
  const enriched = await Promise.all(data.map(async (inv) => {
    const vendor = inv.vendorId ? await knex('vendors').where({ id: inv.vendorId }).select('name').first() : null;
    return { ...inv, vendor };
  }));
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getVendorInvoice = async (req, res) => {
  const invoice = await knex('vendor_invoices').where({ id: req.params.id }).first();
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  const [vendor, po] = await Promise.all([
    invoice.vendorId ? knex('vendors').where({ id: invoice.vendorId }).first() : null,
    invoice.purchaseOrderId ? knex('purchase_orders').where({ id: invoice.purchaseOrderId }).first() : null,
  ]);
  return returnFunction(res, 200, true, req.locale.success, { ...invoice, vendor, purchaseOrder: po });
};

const createVendorInvoice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['purchaseOrderId', 'vendorId', 'invoiceNumber', 'invoiceDate', 'dueDate', 'items'])) return;
  const { purchaseOrderId, vendorId, invoiceNumber, invoiceDate, dueDate, items, currency } = req.body;
  if (!Array.isArray(items) || !items.length) return returnFunction(res, 400, false, 'Add at least one invoice line item.');

  const po = await knex('purchase_orders').where({ id: purchaseOrderId }).first();
  if (!po) return returnFunction(res, 404, false, 'Purchase order not found.');
  // A vendor invoice IS how a PO gets acknowledged in this pipeline — see sendPurchaseOrder
  // (draft -> pending) and this function's status update below (pending -> pendingDelivery).
  if (po.status !== 'pending') {
    return returnFunction(res, 400, false, 'This purchase order is not awaiting a vendor invoice — it must be sent first, and can only receive one invoice.');
  }

  const invoiceItems = items.map((it) => ({
    description: it.description, quantity: Number(it.quantity) || 0,
    unitPrice: Number(it.unitPrice) || 0, totalPrice: (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
  }));
  const totalAmount = invoiceItems.reduce((s, it) => s + it.totalPrice, 0);
  const poInvoiceNumber = await generatePOInvoiceNumber(po.departmentId);

  const doc = {
    id: newId(),
    purchaseOrderId: po.id, vendorId,
    invoiceNumber, poInvoiceNumber, invoiceDate: new Date(invoiceDate), dueDate: new Date(dueDate),
    items: JSON.stringify(invoiceItems), totalAmount, currency: currency || po.currency || 'KES',
    status: 'received', threeWayMatchStatus: 'pending', discrepancyNotes: null,
    fileUrl: req.body.fileUrl || null,
    approvedBy: null, approvedAt: null, paidAt: null, paymentMethod: null, paymentReference: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await knex('vendor_invoices').insert(doc).returning('*');
  await knex('purchase_orders').where({ id: po.id }).update({ invoiceId: saved.id, status: 'pendingDelivery', updatedAt: new Date() });

  // The liability trigger for THIS pipeline — the invoice is recorded before the goods
  // receipt here (opposite ordering from Inventory's own PO system), and posts to the
  // SAME Accounts Payable account Inventory's PO receipts use: two separate, unlinked
  // source systems, one shared ledger account, per the product decision on AP sourcing.
  // Spending's PO pipeline has no perpetual-inventory asset to debit (unrelated to
  // inventory_items/avgCost), so it's booked as Procurement Expense instead.
  {
    const jePayload = {
      date: doc.invoiceDate, description: `Vendor invoice ${invoiceNumber} — ${poInvoiceNumber}`, source: 'spending_vendor_invoice', sourceModule: 'spending',
      referenceId: saved.id, referenceModel: 'vendor_invoices', department: po.departmentId || null, lines: [],
    };
    try {
      const expenseAcct = await resolveSystemAccount('procurement_expense');
      const apAcct = await resolveSystemAccount('accounts_payable');
      jePayload.lines = [{ accountId: expenseAcct._id, debit: round2(totalAmount) }, { accountId: apAcct._id, credit: round2(totalAmount) }];
      await postJournalEntry({ ...jePayload, postedBy: req.user?._id ?? null });
    } catch (err) {
      await logPostingFailure({ source: 'spending_vendor_invoice', sourceModule: 'spending', referenceId: saved.id, referenceModel: 'vendor_invoices', attemptedPayload: jePayload, error: err });
    }
  }

  notifyHR({
    type: 'procurement', subType: 'vendor_invoice_received',
    title: `Vendor invoice received — ${poInvoiceNumber}`,
    subtitle: `${doc.currency} ${totalAmount.toLocaleString()} — needs 3-way match`,
    referenceId: saved.id, referenceModel: 'vendor_invoices',
    requiresAction: true, triggeredBy: req.user?.id ?? null,
  }).catch(() => {});

  // Acknowledge the invoice back to the vendor by email — the counterpart to the
  // delivery-received email sent in createGoodsReceipt.
  const vendor = await knex('vendors').where({ id: vendorId }).first();
  if (vendor?.email) {
    sendEmail({
      to: vendor.email,
      subject: `Invoice received — ${poInvoiceNumber}`,
      html: `<p>Dear ${vendor.contactName || vendor.name},</p><p>We have received your invoice <strong>#${invoiceNumber}</strong> against purchase order <strong>${po.poNumber || po.id}</strong> for ${doc.currency} ${totalAmount.toLocaleString()}, due ${new Date(dueDate).toLocaleDateString()}. Our reference for this invoice is <strong>${poInvoiceNumber}</strong>.</p><p>It is now under review and will be matched against the delivered goods before approval for payment.</p>`,
    }).catch(() => {});
  }

  // The default frontend toast reads this message field directly (apiCallFunction.tsx) —
  // surfacing our auto-generated reference here means the modal needs no bespoke
  // success-detail screen just to show it.
  return returnFunction(res, 201, true, `Invoice recorded — internal reference ${poInvoiceNumber}`, { id: saved.id, poInvoiceNumber });
};

// Three-way match: compare the invoice against the PO (ordered) and the goods receipts
// (actually received) for the same PO. Matches when invoice total equals PO total and
// every line's received quantity covers the invoiced quantity; otherwise flags the
// specific discrepancy so HR can decide to approve anyway or dispute with the vendor.
const matchVendorInvoice = async (req, res) => {
  const invoice = await knex('vendor_invoices').where({ id: req.params.id }).first();
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  const [po, receipts] = await Promise.all([
    knex('purchase_orders').where({ id: invoice.purchaseOrderId }).first(),
    knex('goods_receipts').where({ purchaseOrderId: invoice.purchaseOrderId }),
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
  await knex('vendor_invoices').where({ id: invoice.id }).update({
    threeWayMatchStatus, discrepancyNotes: discrepancies.join(' ') || null,
    status: threeWayMatchStatus === 'matched' ? 'matched' : 'underReview',
    updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, req.locale.success, { threeWayMatchStatus, discrepancies });
};

const approveVendorInvoice = async (req, res) => {
  const invoice = await knex('vendor_invoices').where({ id: req.params.id }).first();
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['received', 'underReview', 'matched'].includes(invoice.status)) return returnFunction(res, 400, false, 'Invoice cannot be approved from its current status.');
  await knex('vendor_invoices').where({ id: invoice.id }).update({
    status: 'approved', approvedBy: req.user?.id ?? null, approvedAt: new Date(), updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Invoice approved.');
};

const disputeVendorInvoice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const invoice = await knex('vendor_invoices').where({ id: req.params.id }).first();
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('vendor_invoices').where({ id: invoice.id }).update({
    status: 'disputed', discrepancyNotes: req.body.reason, updatedAt: new Date(),
  });

  notifyHR({
    type: 'procurement', subType: 'vendor_invoice_disputed',
    title: `Vendor invoice disputed${invoice.invoiceNumber ? ` — #${invoice.invoiceNumber}` : ''}`,
    subtitle: req.body.reason,
    referenceId: invoice.id, referenceModel: 'vendor_invoices',
    requiresAction: true, triggeredBy: req.user?.id ?? null,
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Invoice marked as disputed.');
};

// paymentMethod/paymentReference weren't captured here before — a real gap, since there
// was no way to show how a vendor was actually paid. Extended directly on this handler
// (reusing its own 'approved'-status guard) rather than building a parallel Accounting-
// only payment endpoint that would have to duplicate that guard.
const payVendorInvoice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['paymentMethod', 'paymentReference'])) return;
  if (!Object.keys(GENERIC_PAYMENT_SYSTEM_KEYS).includes(req.body.paymentMethod)) {
    return returnFunction(res, 400, false, `paymentMethod must be one of: ${Object.keys(GENERIC_PAYMENT_SYSTEM_KEYS).join(', ')}`);
  }
  const invoice = await knex('vendor_invoices').where({ id: req.params.id }).first();
  if (!invoice) return returnFunction(res, 404, false, req.locale.notFound);
  if (invoice.status !== 'approved') return returnFunction(res, 400, false, 'Invoice must be approved before it can be paid.');
  await knex('vendor_invoices').where({ id: invoice.id }).update({
    status: 'paid', paidAt: new Date(), paymentMethod: req.body.paymentMethod, paymentReference: req.body.paymentReference, updatedAt: new Date(),
  });
  await knex('purchase_orders').where({ id: invoice.purchaseOrderId }).update({ status: 'paid', updatedAt: new Date() });

  const po = await knex('purchase_orders').where({ id: invoice.purchaseOrderId }).select('departmentId').first();
  const jePayload = {
    date: new Date(), description: `Vendor payment — ${invoice.invoiceNumber} (${req.body.paymentReference})`, source: 'spending_vendor_payment', sourceModule: 'spending',
    referenceId: invoice.id, referenceModel: 'vendor_invoices', department: po?.departmentId || null, lines: [],
  };
  try {
    const apAcct = await resolveSystemAccount('accounts_payable');
    const paymentAcct = await resolveSystemAccount(resolvePaymentSystemKey(req.body.paymentMethod));
    jePayload.lines = [{ accountId: apAcct._id, debit: round2(invoice.totalAmount) }, { accountId: paymentAcct._id, credit: round2(invoice.totalAmount) }];
    await postJournalEntry({ ...jePayload, postedBy: req.user?._id ?? null });
  } catch (err) {
    await logPostingFailure({ source: 'spending_vendor_payment', sourceModule: 'spending', referenceId: invoice.id, referenceModel: 'vendor_invoices', attemptedPayload: jePayload, error: err });
  }

  return returnFunction(res, 200, true, 'Invoice marked as paid.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  PROCUREMENT ANALYTICS (role-scoped)
// ══════════════════════════════════════════════════════════════════════════════

const getProcurementOverview = async (req, res) => {
  const scope = await buildSpendScopeFilter(req);
  let prQuery = knex('purchase_requests').where({ status: 'pending' });
  if (scope?.department !== undefined) prQuery = prQuery.where({ department: scope.department });
  else if (scope?.employeeIds) prQuery = prQuery.whereIn('employeeId', scope.employeeIds);

  const [[{ count: pendingPRs }], [{ count: openPOs }], [{ count: invoicesPendingApproval }], [{ total: totalSpend }]] = await Promise.all([
    prQuery.count('* as count'),
    knex('purchase_orders').count('* as count'),
    knex('vendor_invoices').whereIn('status', ['received', 'underReview', 'matched']).count('* as count'),
    knex('purchase_orders').whereIn('status', ['fullyReceived', 'invoiced', 'paid']).sum('totalAmount as total'),
  ]);
  return returnFunction(res, 200, true, req.locale.success, {
    pendingPRs: Number(pendingPRs), openPOs: Number(openPOs), invoicesPendingApproval: Number(invoicesPendingApproval), totalSpend: Number(totalSpend) || 0,
  });
};

const getProcurementSpend = async (req, res) => {
  const scope = await buildSpendScopeFilter(req);
  let query = knex('purchase_requests').whereNot({ status: 'rejected' });
  if (scope?.employeeIds) query = query.whereIn('employeeId', scope.employeeIds);
  const prs = await query;
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
  const spend = await knex('purchase_orders').select('vendorId').sum('totalAmount as totalSpend').count('* as orderCount')
    .groupBy('vendorId').orderBy('totalSpend', 'desc').limit(20);
  const enriched = await Promise.all(spend.map(async (s) => {
    const vendor = s.vendorId ? await knex('vendors').where({ id: s.vendorId }).select('name', 'category').first() : null;
    return { vendorId: s.vendorId, totalSpend: Number(s.totalSpend) || 0, orderCount: Number(s.orderCount), vendor };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getCycleTimeAnalytics = async (req, res) => {
  const pos = await knex('purchase_orders').whereNotNull('actualDeliveryDate').select('createdAt', 'actualDeliveryDate');
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
  listPurchaseOrders, getPurchaseOrder, updatePurchaseOrder, sendPurchaseOrder, cancelPurchaseOrder,
  listGoodsReceipts, getGoodsReceipt, createGoodsReceipt,
  listVendorInvoices, getVendorInvoice, createVendorInvoice, matchVendorInvoice, approveVendorInvoice, disputeVendorInvoice, payVendorInvoice,
  getProcurementOverview, getProcurementSpend, getVendorAnalytics, getCycleTimeAnalytics,
};
