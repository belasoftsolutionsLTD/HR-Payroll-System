// Postgres migration (Phase 10) — inbox_items is Postgres now. employees/users
// have been Postgres since Phase 1; every referenceModel this file ever
// enriches against is Postgres too now (this was the last module phase).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');

// ── Internal helper — called by other modules when events occur ────────────────
const createInboxItem = async ({
  recipientId,
  type,
  subType,
  title,
  subtitle,
  referenceId,
  referenceModel,
  priority = 'normal',
  requiresAction = true,
  triggeredBy,
  expiresAt,
}) => {
  if (!recipientId || !type || !title) return null;
  const doc = {
    id: newId(),
    recipientId: String(recipientId),
    type,
    subType: subType || type,
    title,
    subtitle: subtitle || '',
    referenceId: referenceId ? String(referenceId) : null,
    referenceModel: referenceModel || null,
    priority,
    requiresAction,
    status: 'unread',
    actionTaken: null,
    actionedAt: null,
    actionedBy: null,
    triggeredBy: triggeredBy ? String(triggeredBy) : null,
    expiresAt: expiresAt || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  try {
    const [saved] = await knex('inbox_items').insert(doc).returning('*');
    return saved;
  } catch {
    return null;
  }
};

// ── Notify all HR users ────────────────────────────────────────────────────────
const notifyHR = async (itemData) => {
  const hrUsers = await knex('users').whereIn('role', ['super_admin', 'hr_manager']).select('id');
  for (const u of hrUsers) {
    await createInboxItem({ ...itemData, recipientId: u.id });
  }
};

// ── Notify employee's manager ──────────────────────────────────────────────────
const notifyManager = async (employeeId, itemData) => {
  if (!employeeId) return;
  const emp = await knex('employees').where({ id: String(employeeId) }).first();
  if (!emp?.managerId) return;
  const mgr = await knex('users').where({ employeeId: emp.managerId }).first();
  if (mgr) await createInboxItem({ ...itemData, recipientId: mgr.id });
};

// ── List inbox items ──────────────────────────────────────────────────────────
const listInbox = async (req, res) => {
  const { tab, type: typeFilter, sort } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  let query = knex('inbox_items').where({ recipientId: req.user.id });

  // Tab filter
  if (tab === 'pending') {
    query = query.where({ requiresAction: true }).whereIn('status', ['unread', 'read']);
  } else if (tab === 'notifications') {
    query = query.where({ requiresAction: false });
  } else if (tab === 'done') {
    query = query.whereIn('status', ['actioned', 'dismissed']);
  }

  if (typeFilter && typeFilter !== 'all') query = query.where({ type: typeFilter });

  const sortDir = sort === 'oldest' ? 'asc' : 'desc';

  const [{ count: total }] = await query.clone().count('* as count');
  const items = await query.clone().orderBy('createdAt', sortDir).limit(limit).offset(skip);

  // Enrich with triggeredBy user info
  const enriched = await Promise.all(items.map(async (item) => {
    let triggeredByUser = null;
    if (item.triggeredBy) {
      const u = await knex('users').where({ id: item.triggeredBy }).first();
      const emp = u?.employeeId ? await knex('employees').where({ id: u.employeeId }).first() : null;
      triggeredByUser = { name: u?.name || '', designation: emp?.designation || '', department: emp?.department || '' };
    }
    return { ...item, triggeredByUser };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(total), page, limit));
};

// ── Get inbox counts ──────────────────────────────────────────────────────────
const getInboxCount = async (req, res) => {
  const [[{ count: unread }], [{ count: pending }]] = await Promise.all([
    knex('inbox_items').where({ recipientId: req.user.id, status: 'unread' }).count('* as count'),
    knex('inbox_items').where({ recipientId: req.user.id, requiresAction: true }).whereIn('status', ['unread', 'read']).count('* as count'),
  ]);
  return returnFunction(res, 200, true, req.locale.success, { unread: Number(unread), pending: Number(pending) });
};

// ── Get single inbox item ─────────────────────────────────────────────────────
const getInboxItem = async (req, res) => {
  const item = await knex('inbox_items').where({ id: req.params.id, recipientId: req.user.id }).first();
  if (!item) return returnFunction(res, 404, false, req.locale.notFound);

  // Auto-mark as read when opened
  if (item.status === 'unread') {
    await knex('inbox_items').where({ id: item.id }).update({ status: 'read', updatedAt: new Date() });
  }

  // Enrich with reference data. referenceModel is a table name picked at write
  // time by whatever module created this item — every one of them is Postgres
  // now (this was the last module phase), so this is always a knex lookup.
  let referenceData = null;
  if (item.referenceId && item.referenceModel) {
    try {
      referenceData = await knex(item.referenceModel).where({ id: item.referenceId }).first();
    } catch {
      referenceData = null; // referenceModel names a table that no longer exists / was renamed
    }

    // Enrich with employee data if available
    if (referenceData?.employeeId) {
      const emp = await knex('employees').where({ id: String(referenceData.employeeId) }).first();
      referenceData = { ...referenceData, employee: emp || null };
    }

    // Leave requests store leaveTypeId/totalDays, but LeaveDetail (frontend) reads
    // ref.leaveType (a name string) and ref.numberOfDays — map the raw doc's fields
    // onto what the detail card actually expects, same idea as enrichRequest() in
    // leaveFunctions.js but scoped to just the two mismatched field names.
    if (item.type === 'leave' && item.referenceModel === 'leave_requests' && referenceData) {
      const leaveType = referenceData.leaveTypeId
        ? await knex('leave_types').where({ id: referenceData.leaveTypeId }).first()
        : null;
      referenceData = { ...referenceData, leaveType: leaveType?.name ?? null, numberOfDays: referenceData.totalDays };
    }
  }

  return returnFunction(res, 200, true, req.locale.success, { ...item, referenceData });
};

// ── Mark item as read ─────────────────────────────────────────────────────────
const markRead = async (req, res) => {
  const item = await knex('inbox_items').where({ id: req.params.id, recipientId: req.user.id }).first();
  if (!item) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('inbox_items').where({ id: item.id }).update({ status: 'read', updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.success);
};

// ── Take action on an inbox item ──────────────────────────────────────────────
const takeAction = async (req, res) => {
  const { action, reason } = req.body;
  if (!action) return returnFunction(res, 400, false, 'Action is required.');

  const item = await knex('inbox_items').where({ id: req.params.id, recipientId: req.user.id }).first();
  if (!item) return returnFunction(res, 404, false, req.locale.notFound);
  if (item.status === 'actioned') return returnFunction(res, 400, false, 'Action already taken.');

  const now = new Date();

  // Perform the actual business action based on type
  if (item.referenceId && item.referenceModel) {
    try {
      if (item.type === 'leave' && item.referenceModel === 'leave_requests') {
        // Delegates to the real leave module (approval chain, balance updates,
        // audit log, employee notification) instead of writing to leave_requests
        // directly — this used to bypass all of that, which was a real bug.
        const { approveLeaveRequest, rejectLeaveRequest } = require('../leave/leaveFunctions');
        const shimReq = { params: { id: String(item.referenceId) }, body: { comment: reason, rejectionReason: reason }, user: req.user, locale: req.locale };
        let shimResult = null;
        const shimRes = { status: () => shimRes, json: (payload) => { shimResult = payload; } };
        if (action === 'approved') await approveLeaveRequest(shimReq, shimRes);
        else await rejectLeaveRequest(shimReq, shimRes);
        if (shimResult && !shimResult.success) return returnFunction(res, 400, false, shimResult.message);
      }

      if (item.type === 'expense' && item.referenceModel === 'expense_claims') {
        // Delegates to the real expense-claims module (approval-chain walking,
        // canActOnLevel authorization, GL posting on reimbursement) instead of writing
        // to expense_claims directly — same fix as the leave-requests/timesheets
        // branches above, for the same reason: the direct write bypassed all of that,
        // including the "cannot approve your own claim" guard.
        const { approveClaim, rejectClaim } = require('../expenses/expenseClaimsFunctions');
        const shimReq = { params: { id: String(item.referenceId) }, body: { comment: reason, reason: reason || '' }, user: req.user, locale: req.locale };
        let shimResult = null;
        const shimRes = { status: () => shimRes, json: (payload) => { shimResult = payload; } };
        if (action === 'approved') await approveClaim(shimReq, shimRes);
        else await rejectClaim(shimReq, shimRes);
        if (shimResult && !shimResult.success) return returnFunction(res, 400, false, shimResult.message);
      }

      if (item.type === 'timesheet' && item.referenceModel === 'timesheets') {
        // Same fix as the leave-requests branch above, for the same reason: this used
        // to write straight to timesheets (with fields — rejectedBy/rejectedAt — the
        // real timesheets schema never even defines) bypassing approveTimesheet/
        // rejectTimesheet's own authorization check entirely.
        const { approveTimesheet, rejectTimesheet } = require('../attendance/attendanceFunctions');
        const shimReq = { params: { id: String(item.referenceId) }, body: { reason }, user: req.user, locale: req.locale };
        let shimResult = null;
        const shimRes = { status: () => shimRes, json: (payload) => { shimResult = payload; } };
        if (action === 'approved') await approveTimesheet(shimReq, shimRes);
        else await rejectTimesheet(shimReq, shimRes);
        if (shimResult && !shimResult.success) return returnFunction(res, 400, false, shimResult.message);
      }
    } catch {
      // Business action failed but still mark inbox item
    }
  }

  await knex('inbox_items').where({ id: item.id }).update({
    status: 'actioned', actionTaken: action, actionedAt: now, actionedBy: req.user.id, updatedAt: now,
  });

  return returnFunction(res, 200, true, 'Action recorded.', { action });
};

// ── Mark all as read ──────────────────────────────────────────────────────────
const markAllRead = async (req, res) => {
  await knex('inbox_items').where({ recipientId: req.user.id, status: 'unread' }).update({ status: 'read', updatedAt: new Date() });
  return returnFunction(res, 200, true, 'All items marked as read.');
};

// ── Dismiss item ──────────────────────────────────────────────────────────────
const dismissItem = async (req, res) => {
  const item = await knex('inbox_items').where({ id: req.params.id, recipientId: req.user.id }).first();
  if (!item) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('inbox_items').where({ id: item.id }).update({ status: 'dismissed', updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Item dismissed.');
};

// ── Bulk actions ──────────────────────────────────────────────────────────────
const bulkAction = async (req, res) => {
  const { ids, action } = req.body;
  if (!ids?.length || !action) return returnFunction(res, 400, false, 'ids and action required.');

  const now = new Date();

  if (action === 'mark_read') {
    await knex('inbox_items').whereIn('id', ids).where({ recipientId: req.user.id }).update({ status: 'read', updatedAt: now });
  } else if (action === 'dismiss') {
    await knex('inbox_items').whereIn('id', ids).where({ recipientId: req.user.id }).update({ status: 'dismissed', updatedAt: now });
  }

  return returnFunction(res, 200, true, 'Bulk action applied.');
};

module.exports = {
  createInboxItem,
  notifyHR,
  notifyManager,
  listInbox,
  getInboxCount,
  getInboxItem,
  markRead,
  takeAction,
  markAllRead,
  dismissItem,
  bulkAction,
};
