const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const path = require('path');
const fs   = require('fs');
const { createInboxItem, notifyHR, notifyManager } = require('../inbox/inboxFunctions');
const { notifyEmployee, notifyByRoles, notifyUser } = require('../../functions/HR/notifyUser');
const { buildApprovalChain, findCurrentLevelEntry, canActOnLevel } = require('../../lib/spend/approvalChain');
const { resolvePolicy } = require('../../lib/spend/policyResolver');
const { buildSpendScopeFilter, getDirectReportIds } = require('../../lib/spend/orgScope');

// ── List Claims ───────────────────────────────────────────────────────────────

const listClaims = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const isHR       = ['super_admin','hr_manager'].includes(req.user?.role);
  const isDeptHead = req.user?.role === 'department_head';
  const showAll    = req.query.all === 'true';
  const filter = {};

  if (isHR) {
    // HR sees all — no employeeId filter
  } else if (showAll && isDeptHead) {
    // Dept head on Team Expenses tab: show their whole department
    const deptRecord = req.user?.employeeId
      ? await findOne('employees', { _id: new ObjectId(req.user.employeeId) }, { projection: { department: 1 } })
      : null;
    if (deptRecord?.department) {
      filter.department = deptRecord.department;
    } else {
      return returnFunction(res, 200, true, req.locale.success, { data: [], total: 0, page: 1, totalPages: 0, stats: null });
    }
  } else if (showAll && req.user?.employeeId) {
    // "Team" tab for anyone with direct reports (employees.managerId) — not a role,
    // a relationship. Falls back to own-only if this requester manages no one.
    const reportIds = await getDirectReportIds(new ObjectId(req.user.employeeId));
    filter.employeeId = { $in: [...reportIds, new ObjectId(req.user.employeeId)] };
  } else {
    filter.employeeId = req.user?.employeeId ? new ObjectId(req.user.employeeId) : null;
  }
  if (req.query.status)     filter.status     = req.query.status;
  if (req.query.type)       filter.type       = req.query.type;
  if (req.query.category)   filter.category   = req.query.category;
  if (req.query.employeeId && isHR) filter.employeeId = new ObjectId(req.query.employeeId);

  const [total, data] = await Promise.all([
    countDocuments('expense_claims', filter),
    findMany('expense_claims', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const enriched = await Promise.all(data.map(async c => {
    const emp = await findOne('employees', { _id: c.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    return { ...c, employee: emp ?? null };
  }));

  // Stats (HR only)
  let stats = null;
  if (isHR) {
    const now = new Date(); const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const [pendingCount, pendingTotal, thisMonthApproved, violations] = await Promise.all([
      countDocuments('expense_claims', { status: 'submitted' }),
      global.dbo.collection('expense_claims').aggregate([{ $match: { status: 'submitted' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]).toArray(),
      global.dbo.collection('expense_claims').aggregate([{ $match: { status: 'approved', approvedAt: { $gte: startOfMonth } } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]).toArray(),
      countDocuments('expense_claims', { isPolicyViolation: true }),
    ]);
    stats = {
      pendingCount,
      pendingTotal:   pendingTotal[0]?.total ?? 0,
      approvedCount:  thisMonthApproved[0]?.count ?? 0,
      approvedTotal:  thisMonthApproved[0]?.total ?? 0,
      violations,
    };
  }

  return returnFunction(res, 200, true, req.locale.success, { ...paginatedResponse(enriched, total, page, limit), stats });
};

// ── Get Single ────────────────────────────────────────────────────────────────

const getClaim = async (req, res) => {
  const claim = await findOne('expense_claims', { _id: new ObjectId(req.params.id) });
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  const isHR = ['super_admin','hr_manager'].includes(req.user?.role);
  if (!isHR && String(claim.employeeId) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Access denied.');
  const emp = await findOne('employees', { _id: claim.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
  return returnFunction(res, 200, true, req.locale.success, { ...claim, employee: emp ?? null });
};

// ── Submit Claim (all 3 types) ────────────────────────────────────────────────

const submitClaim = async (req, res) => {
  if (!validateRequiredFields(req, res, ['type'])) return;
  const { type, category, amount, currency, date, description, notes,
          destination, startDate, endDate, fromLocation, toLocation, distanceKm, isRoundTrip,
          projectId, isBillable, items } = req.body;

  if (!['regular','per_diem','mileage','itemized'].includes(type)) return returnFunction(res, 400, false, 'Invalid expense type.');

  const employeeId = req.user?.employeeId;
  if (!employeeId) {
    return returnFunction(res, 400, false, 'Your account is not linked to an employee profile. Ask your HR admin to create an employee record for you and link it to your account.');
  }

  // Resolve the applicable policy for this employee — most specific targeting wins
  // (employeeId > role > department), falling back to the org's default policy.
  const employeeDoc = await findOne('employees', { _id: new ObjectId(employeeId) }, { projection: { department: 1 } });
  const policy = await resolvePolicy('expense_policies', {
    employeeId, role: req.user?.role, department: employeeDoc?.department,
  }) ?? {};

  let finalAmount = Number(amount) || 0;
  let days = 0;
  let lineItems = null;

  if (type === 'per_diem') {
    if (!destination || !startDate || !endDate) return returnFunction(res, 400, false, 'Per diem requires destination, startDate, endDate.');
    days = Math.ceil((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1;
    const rate = policy.perDiemRates?.find(r => r.location?.toLowerCase() === destination?.toLowerCase())?.rate ?? policy.defaultPerDiemRate ?? 3000;
    finalAmount = days * rate;
  }

  if (type === 'mileage') {
    if (!distanceKm) return returnFunction(res, 400, false, 'Mileage requires distanceKm.');
    const km = Number(distanceKm) * (isRoundTrip ? 2 : 1);
    const rate = policy.mileageRate ?? 15;
    finalAmount = km * rate;
  }

  if (type === 'itemized') {
    if (!Array.isArray(items) || !items.length) return returnFunction(res, 400, false, 'Add at least one line item.');
    lineItems = items.map((it) => ({
      id: it.id || new ObjectId().toString(),
      categoryId: it.categoryId || '',
      categoryName: it.categoryName || it.categoryId || 'Other',
      description: it.description || '',
      amount: Number(it.amount) || 0,
      currency: it.currency || currency || 'KES',
      expenseDate: it.expenseDate ? new Date(it.expenseDate) : new Date(),
      receiptFile: it.receiptFile || null,
      merchantName: it.merchantName || null,
      notes: it.notes || null,
      policyViolation: null,
    }));
    finalAmount = lineItems.reduce((s, it) => s + it.amount, 0);

    // Per-item policy violation check against the same categoryLimits used by 'regular'
    for (const it of lineItems) {
      const catLimit = policy.categoryLimits?.find((l) => l.category === it.categoryName || l.category === it.categoryId);
      if (catLimit?.maxPerClaim && it.amount > catLimit.maxPerClaim) {
        it.policyViolation = `Exceeds per-item limit of ${catLimit.maxPerClaim} for ${it.categoryName}.`;
      }
    }
  }

  // Policy violation check (single-item types)
  let isPolicyViolation = false;
  let violationReason   = null;
  if (type === 'regular' && category) {
    const catLimit = policy.categoryLimits?.find(l => l.category === category);
    if (catLimit?.maxPerClaim && finalAmount > catLimit.maxPerClaim) {
      isPolicyViolation = true;
      violationReason   = `Exceeds per-claim limit of ${catLimit.maxPerClaim} for ${category}.`;
    }
  }
  if (type === 'itemized' && lineItems.some((it) => it.policyViolation)) {
    isPolicyViolation = true;
    violationReason = 'One or more line items exceed their category limit.';
  }

  const receiptFile = req.file ? req.file.filename : null;

  // Auto-approve: claims under the policy's configured threshold skip the approval
  // chain entirely (an already-declared policy field that had no effect until now).
  const autoApprove = policy.autoApproveUnder != null && finalAmount <= policy.autoApproveUnder;
  const now = new Date();
  const approvalChain = autoApprove ? [] : await buildApprovalChain(new ObjectId(employeeId), finalAmount, policy);

  const doc = {
    employeeId:       new ObjectId(employeeId),
    department:       employeeDoc?.department || null,
    type,
    category:         category || null,
    amount:           finalAmount,
    currency:         currency || 'KES',
    date:             date      ? new Date(date) : new Date(),
    description:      description || null,
    notes:            notes || null,
    receiptFile,
    destination:      destination   || null,
    startDate:        startDate     ? new Date(startDate)  : null,
    endDate:          endDate       ? new Date(endDate)    : null,
    perDiemDays:      days || null,
    fromLocation:     fromLocation  || null,
    toLocation:       toLocation    || null,
    distanceKm:       distanceKm    ? Number(distanceKm)   : null,
    isRoundTrip:      Boolean(isRoundTrip),
    projectId:        projectId     ? new ObjectId(projectId) : null,
    isBillable:       Boolean(isBillable),
    items:            lineItems,
    isPolicyViolation,
    violationReason,
    policyId:         policy._id || null,
    approvalChain,
    currentApprovalLevel: approvalChain[0]?.level ?? 0,
    status:           autoApprove ? 'approved' : 'submitted',
    approvedBy:       null, approvedAt: autoApprove ? now : null,
    rejectedBy:       null, rejectedAt: null, rejectionReason: null,
    reimbursedAt:     null,
    payrollCycleId:   null,
    createdAt:        now, updatedAt: now,
  };

  const result = await insertOne('expense_claims', doc);

  // Inbox: notify manager that an expense claim was submitted (skip if auto-approved)
  const empForInbox = await findOne('employees', { _id: doc.employeeId }, { projection: { fullName: 1 } });
  const empNameInbox = empForInbox?.fullName || 'An employee';
  if (!autoApprove) {
    const expensePayload = {
      type: 'expense', subType: 'expense_claim',
      title: `Expense claim from ${empNameInbox}`,
      subtitle: `${currency || 'KES'} ${finalAmount.toLocaleString()} · ${category || type} · ${description || ''}`.trim().replace(/·\s*$/, ''),
      referenceId: result.insertedId, referenceModel: 'expense_claims',
      requiresAction: true, triggeredBy: req.user._id,
    };
    await notifyManager(doc.employeeId, expensePayload);
    notifyHR(expensePayload).catch(() => {});
    notifyByRoles(['super_admin', 'hr_manager'], {
      title: `Expense claim from ${empNameInbox}`,
      body: `${currency || 'KES'} ${finalAmount.toLocaleString()} · ${category || type}`,
      type: 'expense',
    }).catch(() => {});
  } else {
    notifyEmployee(doc.employeeId, {
      title: 'Expense Claim Auto-Approved',
      body: `Your claim of ${currency || 'KES'} ${finalAmount.toLocaleString()} was auto-approved (under the policy threshold).`,
      type: 'expense',
    }).catch(() => {});
    // Auto-approval skips the action chain, but HR still needs visibility into money that
    // was committed on their behalf — an FYI inbox item (requiresAction: false) so it shows
    // under the "notifications" tab rather than sitting in "pending" with nothing to action.
    notifyHR({
      type: 'expense', subType: 'expense_claim_auto_approved',
      title: `Expense claim auto-approved for ${empNameInbox}`,
      subtitle: `${currency || 'KES'} ${finalAmount.toLocaleString()} · ${category || type} (under policy threshold, no approval needed)`,
      referenceId: result.insertedId, referenceModel: 'expense_claims',
      requiresAction: false, triggeredBy: req.user._id,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, isPolicyViolation, autoApproved: autoApprove });
};

// ── Update Claim ──────────────────────────────────────────────────────────────

const updateClaim = async (req, res) => {
  const claim = await findOne('expense_claims', { _id: new ObjectId(req.params.id) });
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  if (claim.status !== 'submitted' && claim.status !== 'draft') return returnFunction(res, 400, false, 'Cannot edit after approval.');
  const isHR = ['super_admin','hr_manager'].includes(req.user?.role);
  if (!isHR && String(claim.employeeId) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Access denied.');
  const { amount, description, category, date, notes, items } = req.body;
  const update = { updatedAt: new Date() };
  if (description) update.description = description;
  if (category)    update.category    = category;
  if (date)        update.date        = new Date(date);
  if (notes)       update.notes       = notes;
  if (claim.type === 'itemized' && Array.isArray(items)) {
    update.items = items.map((it) => ({
      id: it.id || new ObjectId().toString(),
      categoryId: it.categoryId || '', categoryName: it.categoryName || it.categoryId || 'Other',
      description: it.description || '', amount: Number(it.amount) || 0,
      currency: it.currency || claim.currency || 'KES',
      expenseDate: it.expenseDate ? new Date(it.expenseDate) : new Date(),
      receiptFile: it.receiptFile || null, merchantName: it.merchantName || null,
      notes: it.notes || null, policyViolation: null,
    }));
    update.amount = update.items.reduce((s, it) => s + it.amount, 0);
  } else if (amount) {
    update.amount = Number(amount);
  }
  await updateOne('expense_claims', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Delete ────────────────────────────────────────────────────────────────────

const deleteClaim = async (req, res) => {
  const claim = await findOne('expense_claims', { _id: new ObjectId(req.params.id) });
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  const isHR = ['super_admin','hr_manager'].includes(req.user?.role);
  if (isHR) return returnFunction(res, 403, false, 'HR cannot delete employee expense claims.');
  if (String(claim.employeeId) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Access denied.');
  if (!['draft','rejected'].includes(claim.status)) return returnFunction(res, 400, false, 'Only draft or rejected claims can be deleted.');
  await global.dbo.collection('expense_claims').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const disputeClaim = async (req, res) => {
  const claim = await findOne('expense_claims', { _id: new ObjectId(req.params.id) });
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  const isHR = ['super_admin','hr_manager'].includes(req.user?.role);
  if (isHR) return returnFunction(res, 403, false, 'HR cannot dispute claims.');
  if (String(claim.employeeId) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Access denied.');
  if (claim.status !== 'rejected') return returnFunction(res, 400, false, 'Only rejected claims can be disputed.');
  await updateOne('expense_claims', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'disputed', disputeReason: req.body.reason || null, disputedAt: new Date(), updatedAt: new Date() },
  });
  const dispEmployee = await findOne('employees', { _id: claim.employeeId }, { projection: { fullName: 1 } });
  const dispName = dispEmployee?.fullName || 'An employee';
  notifyHR({
    type: 'expense', subType: 'expense_dispute',
    title: `Expense dispute from ${dispName}`,
    subtitle: req.body.reason ? `"${req.body.reason}"` : 'No reason provided',
    referenceId: claim._id, referenceModel: 'expense_claims',
    requiresAction: true, triggeredBy: req.user._id,
  }).catch(() => {});
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Expense Claim Disputed',
    body: `${dispName} disputed a rejected claim${req.body.reason ? `: "${req.body.reason}"` : '.'}`,
    type: 'expense',
  }).catch(() => {});
  return returnFunction(res, 200, true, 'Claim dispute submitted.');
};

// ── Approve / Reject — act on the current approval-chain level ──────────────
// "Manager" isn't a role in this app — the resolved chain entry's approverId (an
// employee's managerId, resolved to their user account) is who's actually authorized
// for level 1. HR/super_admin can always override any level; a department_head can
// always act on claims from their own department even if the auto-resolved chain
// didn't specifically name them (e.g. no matching department_head user existed at
// submit time). Claims created before this feature shipped have no approvalChain —
// they fall through to the HR/dept-head-only override path, same as before.

const approveClaim = async (req, res) => {
  const claim = await findOne('expense_claims', { _id: new ObjectId(req.params.id) });
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['submitted', 'disputed'].includes(claim.status)) return returnFunction(res, 400, false, 'Claim is not pending approval.');
  if (claim.employeeId && String(claim.employeeId) === String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'You cannot approve your own expense claim.');
  }

  const levelEntry = findCurrentLevelEntry(claim);
  if (!(await canActOnLevel(req, claim, levelEntry))) {
    return returnFunction(res, 403, false, 'You are not authorized to approve this claim at its current stage.');
  }

  const now = new Date();
  const update = { updatedAt: now };
  let nextPending = null;

  if (levelEntry) {
    const chain = claim.approvalChain.map((a) => a.level === levelEntry.level
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

  await updateOne('expense_claims', { _id: new ObjectId(req.params.id) }, { $set: update });

  if (nextPending) {
    notifyUser(nextPending.approverId, {
      title: 'Expense Claim Awaiting Your Approval',
      body: `A ${claim.currency || 'KES'} ${(claim.amount || 0).toLocaleString()} expense claim has escalated to you for approval.`,
      type: 'expense',
    }).catch(() => {});
  } else if (claim.employeeId) {
    notifyEmployee(claim.employeeId, {
      title: 'Expense Claim Approved',
      body: `Your expense claim${claim.description ? ` "${claim.description}"` : ''} of ${claim.currency || 'KES'} ${(claim.amount || 0).toLocaleString()} has been approved.`,
      type: 'expense',
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, nextPending ? 'Approved — escalated to the next approval level.' : 'Claim approved.');
};

// ── Reject ────────────────────────────────────────────────────────────────────
// Rejection at any level stops the whole claim — unlike approval, it doesn't require
// walking every remaining level.

const rejectClaim = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const claim = await findOne('expense_claims', { _id: new ObjectId(req.params.id) });
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['submitted', 'disputed'].includes(claim.status)) return returnFunction(res, 400, false, 'Claim is not pending approval.');
  if (claim.employeeId && String(claim.employeeId) === String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'You cannot reject your own expense claim.');
  }

  const levelEntry = findCurrentLevelEntry(claim);
  if (!(await canActOnLevel(req, claim, levelEntry))) {
    return returnFunction(res, 403, false, 'You are not authorized to reject this claim at its current stage.');
  }

  const now = new Date();
  const update = {
    status: 'rejected', rejectedBy: req.user?._id ?? null, rejectedAt: now,
    rejectionReason: req.body.reason, updatedAt: now,
  };
  if (levelEntry) {
    update.approvalChain = claim.approvalChain.map((a) => a.level === levelEntry.level
      ? { ...a, status: 'rejected', actedAt: now, comment: req.body.reason }
      : a);
  }
  await updateOne('expense_claims', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (claim.employeeId) {
    notifyEmployee(claim.employeeId, {
      title: 'Expense Claim Rejected',
      body: `Your expense claim${claim.description ? ` "${claim.description}"` : ''} was not approved. Reason: ${req.body.reason}`,
      type: 'expense',
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, 'Claim rejected.');
};

// ── Export CSV ────────────────────────────────────────────────────────────────

const exportClaims = async (req, res) => {
  const data = await findMany('expense_claims', {}, { sort: { createdAt: -1 }, limit: 5000 });
  const enriched = await Promise.all(data.map(async c => {
    const emp = await findOne('employees', { _id: c.employeeId }, { projection: { fullName: 1, staffNumber: 1 } });
    return [
      emp?.staffNumber ?? '', emp?.fullName ?? '', c.type, c.category ?? '', c.amount,
      c.currency, c.date?.toISOString().split('T')[0] ?? '', c.status,
    ].join(',');
  }));
  const csv = ['StaffNo,Name,Type,Category,Amount,Currency,Date,Status', ...enriched].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
  return res.send(csv);
};

// ── Analytics ─────────────────────────────────────────────────────────────────

const getAnalytics = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const start = new Date(year, 0, 1); const end = new Date(year + 1, 0, 1);
  // super_admin/hr: org-wide. department_head: their department only. Anyone with
  // direct reports (employees.managerId): their team only. Everyone else: own data.
  const scope = await buildSpendScopeFilter(req);
  const filter = { ...scope, createdAt: { $gte: start, $lt: end }, status: { $in: ['approved','reimbursed'] } };

  const [byCategory, byMonth, byDept, topSpenders] = await Promise.all([
    global.dbo.collection('expense_claims').aggregate([
      { $match: filter },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]).toArray(),
    global.dbo.collection('expense_claims').aggregate([
      { $match: filter },
      { $group: { _id: { $month: '$date' }, total: { $sum: '$amount' } } },
      { $sort: { '_id': 1 } },
    ]).toArray(),
    global.dbo.collection('expense_claims').aggregate([
      { $match: filter },
      { $lookup: { from: 'employees', localField: 'employeeId', foreignField: '_id', as: 'emp' } },
      { $unwind: { path: '$emp', preserveNullAndEmptyArrays: true } },
      { $group: { _id: '$emp.department', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } }, { $limit: 10 },
    ]).toArray(),
    global.dbo.collection('expense_claims').aggregate([
      { $match: filter },
      { $group: { _id: '$employeeId', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } }, { $limit: 10 },
    ]).toArray(),
  ]);

  const months = Array(12).fill(0);
  byMonth.forEach(m => { if (m._id >= 1 && m._id <= 12) months[m._id - 1] = m.total; });

  const topEnriched = await Promise.all(topSpenders.map(async t => {
    const emp = await findOne('employees', { _id: t._id }, { projection: { fullName: 1, department: 1 } });
    return { ...t, employee: emp ?? null };
  }));

  return returnFunction(res, 200, true, req.locale.success, { byCategory, byMonth: months, byDept, topSpenders: topEnriched });
};

// ── Policy ────────────────────────────────────────────────────────────────────
// GET/PUT /expense-claims/policy (singular) — the original single-policy editor route,
// kept working unchanged: it always reads/writes the org's default policy. New,
// targeted policies (by role/department/employee) live under the plural
// /expense-claims/policies routes below and never touch the default.

const getPolicy = async (req, res) => {
  const policy = await findOne('expense_policies', { isDefault: true }) || await findOne('expense_policies', {});
  return returnFunction(res, 200, true, req.locale.success, policy ?? {});
};

// ── Multi-policy CRUD (targeted policies) ────────────────────────────────────

const listPolicies = async (req, res) => {
  const policies = await findMany('expense_policies', {}, { sort: { isDefault: -1, createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, policies);
};

const getPolicyById = async (req, res) => {
  const policy = await findOne('expense_policies', { _id: new ObjectId(req.params.id) });
  if (!policy) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, policy);
};

const createPolicy = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const { name, description, appliesTo, categories, approvalChain, isDefault,
          perDiemRates, defaultPerDiemRate, mileageRate, categoryLimits, autoApproveUnder,
          hrApprovalThreshold, reimbursementCycle } = req.body;

  if (isDefault) {
    await global.dbo.collection('expense_policies').updateMany({}, { $set: { isDefault: false } });
  }

  const doc = {
    name, description: description || null,
    isDefault: Boolean(isDefault),
    appliesTo: appliesTo || {},
    categories: categories || [],
    approvalChain: approvalChain || [],
    perDiemRates: perDiemRates || [],
    defaultPerDiemRate: defaultPerDiemRate ?? null,
    mileageRate: mileageRate ?? null,
    categoryLimits: categoryLimits || [],
    autoApproveUnder: autoApproveUnder ?? null,
    hrApprovalThreshold: hrApprovalThreshold ?? null,
    reimbursementCycle: reimbursementCycle || 'withNextPayroll',
    isActive: true,
    createdBy: req.user?._id ?? null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('expense_policies', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updatePolicyById = async (req, res) => {
  const existing = await findOne('expense_policies', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  if (req.body.isDefault) {
    await global.dbo.collection('expense_policies').updateMany({ _id: { $ne: existing._id } }, { $set: { isDefault: false } });
  }
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  await updateOne('expense_policies', { _id: existing._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deletePolicyById = async (req, res) => {
  const existing = await findOne('expense_policies', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  if (existing.isDefault) return returnFunction(res, 400, false, 'Cannot deactivate the default policy — mark another policy as default first.');
  await updateOne('expense_policies', { _id: existing._id }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Mark Reimbursed ───────────────────────────────────────────────────────────

const markReimbursed = async (req, res) => {
  const claim = await findOne('expense_claims', { _id: new ObjectId(req.params.id) });
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  if (claim.status !== 'approved') return returnFunction(res, 400, false, 'Only approved claims can be marked as reimbursed.');
  await updateOne('expense_claims', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'reimbursed', reimbursedAt: new Date(), updatedAt: new Date() },
  });
  if (claim.employeeId) {
    notifyEmployee(claim.employeeId, {
      title: 'Expense Claim Reimbursed',
      body: `Your expense claim of ${claim.currency || 'KES'} ${(claim.amount || 0).toLocaleString()} has been reimbursed.`,
      type: 'expense',
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, 'Claim marked as reimbursed.');
};

const updatePolicy = async (req, res) => {
  const existing = await findOne('expense_policies', { isDefault: true }) || await findOne('expense_policies', {});
  const update = { ...req.body, isDefault: true, updatedAt: new Date() };
  delete update._id;
  if (existing) {
    await updateOne('expense_policies', { _id: existing._id }, { $set: update });
  } else {
    await insertOne('expense_policies', { ...update, name: update.name || 'Default Policy', appliesTo: {}, isActive: true, createdBy: req.user?._id ?? null, createdAt: new Date() });
  }
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const calculateDistance = async (req, res) => {
  const { origin, destination } = req.body;
  if (!origin?.trim() || !destination?.trim()) return returnFunction(res, 400, false, 'Origin and destination are required.');
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return returnFunction(res, 503, false, 'Google Maps API key is not configured. Please ask your administrator to add GOOGLE_MAPS_API_KEY to the server environment.');
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&mode=driving&key=${apiKey}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.status !== 'OK') return returnFunction(res, 400, false, `Maps API error: ${data.status}`);
  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== 'OK') return returnFunction(res, 400, false, 'Could not calculate route. Check that both locations are valid.');
  const distanceKm = Math.round(element.distance.value / 100) / 10;
  return returnFunction(res, 200, true, 'Distance calculated.', { distanceKm, distanceText: element.distance.text, durationText: element.duration.text });
};

module.exports = {
  listClaims, getClaim, submitClaim, updateClaim, deleteClaim, disputeClaim, approveClaim, rejectClaim,
  markReimbursed, exportClaims, getAnalytics, getPolicy, updatePolicy, calculateDistance,
  listPolicies, createPolicy, getPolicyById, updatePolicyById, deletePolicyById,
};
