// Postgres migration (Phase 8) — expense_claims/expense_policies are Postgres now.
// employees/users have been Postgres since Phase 1; gl_accounts since Phase 7.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { createInboxItem, notifyHR, notifyManager } = require('../inbox/inboxFunctions');
const { notifyEmployee, notifyByRoles, notifyUser } = require('../../functions/HR/notifyUser');
const { buildApprovalChain, findCurrentLevelEntry, canActOnLevel } = require('../../lib/spend/approvalChain');
const { resolvePolicy } = require('../../lib/spend/policyResolver');
const { buildSpendScopeFilter, getDirectReportIds } = require('../../lib/spend/orgScope');
const { sendEmail } = require('../../services/emailService');
const { postJournalEntry, resolveSystemAccount } = require('../../lib/accounting/glEngine');
const { resolvePaymentSystemKey } = require('../../lib/accounting/paymentMethodAccounts');
const { logPostingFailure } = require('../accounting/accountingPostingFailuresFunctions');

const REIMBURSEMENT_METHODS = ['bank_transfer', 'mpesa', 'cash', 'cheque'];
const COMPANY_NAME = process.env.COMPANY_NAME || 'School ERP';

// ── List Claims ───────────────────────────────────────────────────────────────

const listClaims = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const isHR       = ['super_admin', 'hr_manager'].includes(req.user?.role);
  const isDeptHead = req.user?.role === 'department_head';
  const showAll    = req.query.all === 'true';
  let query = knex('expense_claims');

  if (isHR) {
    // HR sees all — no employeeId filter
  } else if (showAll && isDeptHead) {
    // Dept head on Team Expenses tab: show their whole department
    const deptRecord = req.user?.employeeId
      ? await knex('employees').where({ id: String(req.user.employeeId) }).select('department').first()
      : null;
    if (deptRecord?.department) {
      query = query.where({ department: deptRecord.department });
    } else {
      return returnFunction(res, 200, true, req.locale.success, { data: [], total: 0, page: 1, totalPages: 0, stats: null });
    }
  } else if (showAll && req.user?.employeeId) {
    // "Team" tab for anyone with direct reports (employees.managerId) — not a role,
    // a relationship. Falls back to own-only if this requester manages no one.
    const myId = String(req.user.employeeId);
    const reportIds = await getDirectReportIds(myId);
    query = query.whereIn('employeeId', [...reportIds, myId]);
  } else {
    query = query.where({ employeeId: req.user?.employeeId ? String(req.user.employeeId) : '__none__' });
  }
  if (req.query.status)   query = query.where({ status: req.query.status });
  if (req.query.type)     query = query.where({ type: req.query.type });
  if (req.query.category) query = query.where({ category: req.query.category });
  if (req.query.employeeId && isHR) query = query.where({ employeeId: req.query.employeeId });

  const [{ count }] = await query.clone().count('* as count');
  const data = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const enriched = await Promise.all(data.map(async (c) => {
    const emp = await knex('employees').where({ id: c.employeeId }).select('fullName', 'staffNumber', 'department').first();
    return { ...c, employee: emp ?? null };
  }));

  // Stats (HR only)
  let stats = null;
  if (isHR) {
    const now = new Date(); const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const [[{ count: pendingCount }], [{ total: pendingTotal }], [{ total: approvedTotal, count: approvedCount }], [{ count: violations }]] = await Promise.all([
      knex('expense_claims').where({ status: 'submitted' }).count('* as count'),
      knex('expense_claims').where({ status: 'submitted' }).sum('amount as total'),
      knex('expense_claims').where({ status: 'approved' }).where('approvedAt', '>=', startOfMonth).sum('amount as total').count('* as count'),
      knex('expense_claims').where({ isPolicyViolation: true }).count('* as count'),
    ]);
    stats = {
      pendingCount: Number(pendingCount),
      pendingTotal: Number(pendingTotal) || 0,
      approvedCount: Number(approvedCount),
      approvedTotal: Number(approvedTotal) || 0,
      violations: Number(violations),
    };
  }

  return returnFunction(res, 200, true, req.locale.success, { ...paginatedResponse(enriched, Number(count), page, limit), stats });
};

// ── Get Single ────────────────────────────────────────────────────────────────

const getClaim = async (req, res) => {
  const claim = await knex('expense_claims').where({ id: req.params.id }).first();
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(claim.employeeId) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Access denied.');
  const emp = await knex('employees').where({ id: claim.employeeId }).select('fullName', 'staffNumber', 'department').first();
  return returnFunction(res, 200, true, req.locale.success, { ...claim, employee: emp ?? null });
};

// ── Submit Claim (all 4 types) ────────────────────────────────────────────────

const submitClaim = async (req, res) => {
  if (!validateRequiredFields(req, res, ['type'])) return;
  const { type, category, amount, currency, date, description, notes,
          destination, startDate, endDate, fromLocation, toLocation, distanceKm, isRoundTrip,
          projectId, isBillable, items } = req.body;

  if (!['regular', 'per_diem', 'mileage', 'itemized'].includes(type)) return returnFunction(res, 400, false, 'Invalid expense type.');

  // req.user.employeeId is a Mongo ObjectId instance (AuthMiddleware.js's backward-
  // compat alias) — String() it before it's inserted as a plain-text FK value below.
  const employeeId = req.user?.employeeId ? String(req.user.employeeId) : null;
  if (!employeeId) {
    return returnFunction(res, 400, false, 'Your account is not linked to an employee profile. Ask your HR admin to create an employee record for you and link it to your account.');
  }

  // Resolve the applicable policy for this employee — most specific targeting wins
  // (employeeId > role > department), falling back to the org's default policy.
  const employeeDoc = await knex('employees').where({ id: employeeId }).select('department').first();
  const policy = await resolvePolicy('expense_policies', {
    employeeId, role: req.user?.role, department: employeeDoc?.department,
  }) ?? {};

  let finalAmount = Number(amount) || 0;
  let days = 0;
  let lineItems = null;

  if (type === 'per_diem') {
    if (!destination || !startDate || !endDate) return returnFunction(res, 400, false, 'Per diem requires destination, startDate, endDate.');
    days = Math.ceil((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1;
    const rate = policy.perDiemRates?.find((r) => r.location?.toLowerCase() === destination?.toLowerCase())?.rate ?? policy.defaultPerDiemRate ?? 3000;
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
      id: it.id || newId(),
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
  let violationReason = null;
  if (type === 'regular' && category) {
    const catLimit = policy.categoryLimits?.find((l) => l.category === category);
    if (catLimit?.maxPerClaim && finalAmount > catLimit.maxPerClaim) {
      isPolicyViolation = true;
      violationReason = `Exceeds per-claim limit of ${catLimit.maxPerClaim} for ${category}.`;
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
  const approvalChain = autoApprove ? [] : await buildApprovalChain(employeeId, finalAmount, policy);

  const doc = {
    id: newId(),
    employeeId,
    department: employeeDoc?.department || null,
    type,
    category: category || null,
    amount: finalAmount,
    currency: currency || 'KES',
    date: date ? new Date(date) : new Date(),
    description: description || null,
    notes: notes || null,
    receiptFile,
    destination: destination || null,
    startDate: startDate ? new Date(startDate) : null,
    endDate: endDate ? new Date(endDate) : null,
    perDiemDays: days || null,
    fromLocation: fromLocation || null,
    toLocation: toLocation || null,
    distanceKm: distanceKm ? Number(distanceKm) : null,
    isRoundTrip: Boolean(isRoundTrip),
    projectId: projectId || null,
    isBillable: Boolean(isBillable),
    items: JSON.stringify(lineItems),
    isPolicyViolation,
    violationReason,
    policyId: policy.id || null,
    approvalChain: JSON.stringify(approvalChain),
    currentApprovalLevel: approvalChain[0]?.level ?? 0,
    status: autoApprove ? 'approved' : 'submitted',
    approvedBy: null, approvedAt: autoApprove ? now : null,
    rejectedBy: null, rejectedAt: null, rejectionReason: null,
    reimbursedAt: null,
    payrollCycleId: null,
    createdAt: now, updatedAt: now,
  };

  const [saved] = await knex('expense_claims').insert(doc).returning('*');

  // Inbox: notify manager that an expense claim was submitted (skip if auto-approved)
  const empForInbox = await knex('employees').where({ id: doc.employeeId }).select('fullName').first();
  const empNameInbox = empForInbox?.fullName || 'An employee';
  if (!autoApprove) {
    const expensePayload = {
      type: 'expense', subType: 'expense_claim',
      title: `Expense claim from ${empNameInbox}`,
      subtitle: `${currency || 'KES'} ${finalAmount.toLocaleString()} · ${category || type} · ${description || ''}`.trim().replace(/·\s*$/, ''),
      referenceId: saved.id, referenceModel: 'expense_claims',
      requiresAction: true, triggeredBy: req.user?.id ?? null,
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
      referenceId: saved.id, referenceModel: 'expense_claims',
      requiresAction: false, triggeredBy: req.user?.id ?? null,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id, isPolicyViolation, autoApproved: autoApprove });
};

// ── Update Claim ──────────────────────────────────────────────────────────────

const updateClaim = async (req, res) => {
  const claim = await knex('expense_claims').where({ id: req.params.id }).first();
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  if (claim.status !== 'submitted' && claim.status !== 'draft') return returnFunction(res, 400, false, 'Cannot edit after approval.');
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(claim.employeeId) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Access denied.');
  const { amount, description, category, date, notes, items } = req.body;
  const update = { updatedAt: new Date() };
  if (description) update.description = description;
  if (category)    update.category = category;
  if (date)        update.date = new Date(date);
  if (notes)       update.notes = notes;
  if (claim.type === 'itemized' && Array.isArray(items)) {
    const newItems = items.map((it) => ({
      id: it.id || newId(),
      categoryId: it.categoryId || '', categoryName: it.categoryName || it.categoryId || 'Other',
      description: it.description || '', amount: Number(it.amount) || 0,
      currency: it.currency || claim.currency || 'KES',
      expenseDate: it.expenseDate ? new Date(it.expenseDate) : new Date(),
      receiptFile: it.receiptFile || null, merchantName: it.merchantName || null,
      notes: it.notes || null, policyViolation: null,
    }));
    update.items = JSON.stringify(newItems);
    update.amount = newItems.reduce((s, it) => s + it.amount, 0);
  } else if (amount) {
    update.amount = Number(amount);
  }
  await knex('expense_claims').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Delete ────────────────────────────────────────────────────────────────────

const deleteClaim = async (req, res) => {
  const claim = await knex('expense_claims').where({ id: req.params.id }).first();
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (isHR) return returnFunction(res, 403, false, 'HR cannot delete employee expense claims.');
  if (String(claim.employeeId) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Access denied.');
  if (!['draft', 'rejected'].includes(claim.status)) return returnFunction(res, 400, false, 'Only draft or rejected claims can be deleted.');
  await knex('expense_claims').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const disputeClaim = async (req, res) => {
  const claim = await knex('expense_claims').where({ id: req.params.id }).first();
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (isHR) return returnFunction(res, 403, false, 'HR cannot dispute claims.');
  if (String(claim.employeeId) !== String(req.user?.employeeId)) return returnFunction(res, 403, false, 'Access denied.');
  if (claim.status !== 'rejected') return returnFunction(res, 400, false, 'Only rejected claims can be disputed.');
  await knex('expense_claims').where({ id: req.params.id }).update({
    status: 'disputed', disputeReason: req.body.reason || null, disputedAt: new Date(), updatedAt: new Date(),
  });
  const dispEmployee = await knex('employees').where({ id: claim.employeeId }).select('fullName').first();
  const dispName = dispEmployee?.fullName || 'An employee';
  notifyHR({
    type: 'expense', subType: 'expense_dispute',
    title: `Expense dispute from ${dispName}`,
    subtitle: req.body.reason ? `"${req.body.reason}"` : 'No reason provided',
    referenceId: claim.id, referenceModel: 'expense_claims',
    requiresAction: true, triggeredBy: req.user?.id ?? null,
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
  const claim = await knex('expense_claims').where({ id: req.params.id }).first();
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
    update.approvalChain = JSON.stringify(chain);
  }

  if (nextPending) {
    update.currentApprovalLevel = nextPending.level;
  } else {
    update.status = 'approved';
    update.approvedBy = req.user?.id ?? null;
    update.approvedAt = now;
  }

  await knex('expense_claims').where({ id: req.params.id }).update(update);

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
  const claim = await knex('expense_claims').where({ id: req.params.id }).first();
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
    status: 'rejected', rejectedBy: req.user?.id ?? null, rejectedAt: now,
    rejectionReason: req.body.reason, updatedAt: now,
  };
  if (levelEntry) {
    update.approvalChain = JSON.stringify(claim.approvalChain.map((a) => a.level === levelEntry.level
      ? { ...a, status: 'rejected', actedAt: now, comment: req.body.reason }
      : a));
  }
  await knex('expense_claims').where({ id: req.params.id }).update(update);
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
  const data = await knex('expense_claims').orderBy('createdAt', 'desc').limit(5000);
  const enriched = await Promise.all(data.map(async (c) => {
    const emp = await knex('employees').where({ id: c.employeeId }).select('fullName', 'staffNumber').first();
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
  const applyScope = (q) => {
    if (scope?.department !== undefined) return q.where({ department: scope.department });
    if (scope?.employeeIds) return q.whereIn('employeeId', scope.employeeIds);
    return q;
  };
  const baseFilter = (q) => applyScope(q.where('createdAt', '>=', start).where('createdAt', '<', end).whereIn('status', ['approved', 'reimbursed']));

  const [byCategory, byMonthRows, byDeptRows, topSpendersRows] = await Promise.all([
    baseFilter(knex('expense_claims')).select('category').sum('amount as total').count('* as count').groupBy('category').orderBy('total', 'desc'),
    baseFilter(knex('expense_claims')).select(knex.raw('EXTRACT(MONTH FROM "date") as month')).sum('amount as total').groupBy(knex.raw('EXTRACT(MONTH FROM "date")')).orderBy('month'),
    baseFilter(knex('expense_claims')).select('department').sum('amount as total').groupBy('department').orderBy('total', 'desc').limit(10),
    baseFilter(knex('expense_claims')).select('employeeId').sum('amount as total').count('* as count').groupBy('employeeId').orderBy('total', 'desc').limit(10),
  ]);

  const months = Array(12).fill(0);
  byMonthRows.forEach((m) => { const idx = Number(m.month); if (idx >= 1 && idx <= 12) months[idx - 1] = Number(m.total) || 0; });

  const byDept = byDeptRows.map((d) => ({ _id: d.department, total: Number(d.total) || 0 }));
  const byCategoryOut = byCategory.map((c) => ({ _id: c.category, total: Number(c.total) || 0, count: Number(c.count) }));

  const topEnriched = await Promise.all(topSpendersRows.map(async (t) => {
    const emp = await knex('employees').where({ id: t.employeeId }).select('fullName', 'department').first();
    return { _id: t.employeeId, total: Number(t.total) || 0, count: Number(t.count), employee: emp ?? null };
  }));

  return returnFunction(res, 200, true, req.locale.success, { byCategory: byCategoryOut, byMonth: months, byDept, topSpenders: topEnriched });
};

// ── Policy ────────────────────────────────────────────────────────────────────
// GET/PUT /expense-claims/policy (singular) — the original single-policy editor route,
// kept working unchanged: it always reads/writes the org's default policy. New,
// targeted policies (by role/department/employee) live under the plural
// /expense-claims/policies routes below and never touch the default.

const getPolicy = async (req, res) => {
  const policy = await knex('expense_policies').where({ isDefault: true }).first() || await knex('expense_policies').first();
  return returnFunction(res, 200, true, req.locale.success, policy ?? {});
};

// ── Multi-policy CRUD (targeted policies) ────────────────────────────────────

const listPolicies = async (req, res) => {
  const policies = await knex('expense_policies').orderBy('isDefault', 'desc').orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, policies);
};

const getPolicyById = async (req, res) => {
  const policy = await knex('expense_policies').where({ id: req.params.id }).first();
  if (!policy) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, policy);
};

const createPolicy = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const { name, description, appliesTo, categories, approvalChain, isDefault,
          perDiemRates, defaultPerDiemRate, mileageRate, categoryLimits, autoApproveUnder,
          hrApprovalThreshold, reimbursementCycle } = req.body;

  if (isDefault) {
    await knex('expense_policies').update({ isDefault: false });
  }

  const doc = {
    id: newId(),
    name, description: description || null,
    isDefault: Boolean(isDefault),
    appliesTo: JSON.stringify(appliesTo || {}),
    categories: JSON.stringify(categories || []),
    approvalChain: JSON.stringify(approvalChain || []),
    perDiemRates: JSON.stringify(perDiemRates || []),
    defaultPerDiemRate: defaultPerDiemRate ?? null,
    mileageRate: mileageRate ?? null,
    categoryLimits: JSON.stringify(categoryLimits || []),
    autoApproveUnder: autoApproveUnder ?? null,
    hrApprovalThreshold: hrApprovalThreshold ?? null,
    reimbursementCycle: reimbursementCycle || 'withNextPayroll',
    isActive: true,
    createdBy: req.user?.id ?? null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const [saved] = await knex('expense_policies').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id });
};

const updatePolicyById = async (req, res) => {
  const existing = await knex('expense_policies').where({ id: req.params.id }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  if (req.body.isDefault) {
    await knex('expense_policies').whereNot({ id: existing.id }).update({ isDefault: false });
  }
  const JSONB_FIELDS = ['appliesTo', 'categories', 'approvalChain', 'perDiemRates', 'categoryLimits'];
  const update = { updatedAt: new Date() };
  for (const [key, val] of Object.entries(req.body)) {
    if (key === 'id') continue;
    update[key] = JSONB_FIELDS.includes(key) ? JSON.stringify(val) : val;
  }
  await knex('expense_policies').where({ id: existing.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deletePolicyById = async (req, res) => {
  const existing = await knex('expense_policies').where({ id: req.params.id }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  if (existing.isDefault) return returnFunction(res, 400, false, 'Cannot deactivate the default policy — mark another policy as default first.');
  await knex('expense_policies').where({ id: existing.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Mark Reimbursed ───────────────────────────────────────────────────────────

const markReimbursed = async (req, res) => {
  if (!validateRequiredFields(req, res, ['paymentMethod'])) return;
  if (!REIMBURSEMENT_METHODS.includes(req.body.paymentMethod)) {
    return returnFunction(res, 400, false, `paymentMethod must be one of: ${REIMBURSEMENT_METHODS.join(', ')}`);
  }
  const claim = await knex('expense_claims').where({ id: req.params.id }).first();
  if (!claim) return returnFunction(res, 404, false, req.locale.notFound);
  if (claim.status !== 'approved') return returnFunction(res, 400, false, 'Only approved claims can be marked as reimbursed.');

  const now = new Date();
  await knex('expense_claims').where({ id: req.params.id }).update({
    status: 'reimbursed',
    reimbursedAt: now,
    reimbursedBy: req.user?.id ?? null,
    reimbursementMethod: req.body.paymentMethod,
    reimbursementReference: req.body.reference || null,
    reimbursementEvidenceFilename: req.file?.filename ?? null,
    reimbursementEvidenceOriginalName: req.file?.originalname ?? null,
    updatedAt: now,
  });

  // A claim pulled into a payroll cycle already has its amount inside that cycle's
  // Salary Expense line (payroll_results.expenseReimbursements) — posting a second entry
  // here would double-book it. Only claims reimbursed OUTSIDE of payroll post their own.
  if (!claim.payrollCycleId) {
    const payload = {
      date: new Date(), description: `Expense reimbursement — ${claim.category || 'expense'} (${req.body.paymentMethod})`,
      source: 'expense_reimbursement', sourceModule: 'expenses', referenceId: claim.id, referenceModel: 'expense_claims',
      department: claim.department || null, lines: [],
    };
    try {
      const categoryAcct = await knex('gl_accounts').whereRaw('? = ANY("linkedExpenseCategories")', [claim.category]).whereNot({ isActive: false }).first();
      const expenseAcct = categoryAcct || await resolveSystemAccount('other_expense');
      const paymentAcct = await resolveSystemAccount(resolvePaymentSystemKey(req.body.paymentMethod));
      // categoryAcct (fetched directly via knex, not through glEngine) only ever carries
      // the plain Postgres `id`, not the Mongo-alias `_id` resolveSystemAccount's results
      // have — fall back to `.id` so this works either way.
      payload.lines = [{ accountId: expenseAcct._id || expenseAcct.id, debit: claim.amount || 0 }, { accountId: paymentAcct._id, credit: claim.amount || 0 }];
      if (claim.amount > 0) await postJournalEntry({ ...payload, postedBy: req.user?.id ?? null });
    } catch (err) {
      await logPostingFailure({ source: 'expense_reimbursement', sourceModule: 'expenses', referenceId: claim.id, referenceModel: 'expense_claims', attemptedPayload: payload, error: err });
    }
  }

  const amountLabel = `${claim.currency || 'KES'} ${(claim.amount || 0).toLocaleString()}`;
  if (claim.employeeId) {
    notifyEmployee(claim.employeeId, {
      title: 'Expense Claim Reimbursed',
      body: `Your expense claim of ${amountLabel} has been reimbursed.`,
      type: 'expense',
    }).catch(() => {});

    // In-app notification alone is easy to miss — reimbursement is money actually
    // moving, so it gets an email too, same as payroll's payslip-generated flow.
    const claimant = await knex('users').where({ employeeId: claim.employeeId }).select('email', 'name').first();
    if (claimant?.email) {
      const methodLabel = req.body.paymentMethod.replace('_', ' ');
      sendEmail({
        to: claimant.email,
        subject: `Your expense claim has been reimbursed`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:auto;">
            <h2>Expense Reimbursed</h2>
            <p>Hi <strong>${claimant.name || 'there'}</strong>,</p>
            <p>Your expense claim of <strong>${amountLabel}</strong> has been reimbursed via <strong>${methodLabel}</strong>${req.body.reference ? ` (ref: ${req.body.reference})` : ''}.</p>
            <p>Regards,<br/>${COMPANY_NAME}</p>
          </div>
        `,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, 'Claim marked as reimbursed.');
};

const updatePolicy = async (req, res) => {
  const existing = await knex('expense_policies').where({ isDefault: true }).first() || await knex('expense_policies').first();
  const JSONB_FIELDS = ['appliesTo', 'categories', 'approvalChain', 'perDiemRates', 'categoryLimits'];
  const rawUpdate = { ...req.body, isDefault: true, updatedAt: new Date() };
  delete rawUpdate.id;
  const update = {};
  for (const [key, val] of Object.entries(rawUpdate)) {
    update[key] = JSONB_FIELDS.includes(key) ? JSON.stringify(val) : val;
  }
  if (existing) {
    await knex('expense_policies').where({ id: existing.id }).update(update);
  } else {
    await knex('expense_policies').insert({
      id: newId(), ...update, name: update.name || 'Default Policy',
      appliesTo: update.appliesTo ?? JSON.stringify({}), isActive: true,
      createdBy: req.user?.id ?? null, createdAt: new Date(),
    });
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
