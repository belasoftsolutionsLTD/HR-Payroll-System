const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findOne, findMany, insertOne, updateOne, deleteOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
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
    recipientId: new ObjectId(recipientId),
    type,
    subType: subType || type,
    title,
    subtitle: subtitle || '',
    referenceId: referenceId ? new ObjectId(referenceId) : null,
    referenceModel: referenceModel || null,
    priority,
    requiresAction,
    status: 'unread',
    actionTaken: null,
    actionedAt: null,
    actionedBy: null,
    triggeredBy: triggeredBy ? new ObjectId(triggeredBy) : null,
    expiresAt: expiresAt || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  try {
    return await global.dbo.collection('inbox_items').insertOne(doc);
  } catch {
    return null;
  }
};

// ── Notify all HR users ────────────────────────────────────────────────────────
const notifyHR = async (itemData) => {
  const hrUsers = await findMany('users', { role: { $in: ['super_admin', 'hr_manager'] } }, { projection: { _id: 1 } });
  for (const u of hrUsers) {
    await createInboxItem({ ...itemData, recipientId: u._id });
  }
};

// ── Notify employee's manager ──────────────────────────────────────────────────
const notifyManager = async (employeeId, itemData) => {
  if (!employeeId) return;
  const emp = await findOne('employees', { _id: new ObjectId(employeeId) }, { projection: { managerId: 1 } });
  if (!emp?.managerId) return;
  const mgr = await findOne('users', { employeeId: emp.managerId }, { projection: { _id: 1 } });
  if (mgr) await createInboxItem({ ...itemData, recipientId: mgr._id });
};

// ── List inbox items ──────────────────────────────────────────────────────────
const listInbox = async (req, res) => {
  const { tab, type: typeFilter, sort } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const filter = { recipientId: req.user._id };

  // Tab filter
  if (tab === 'pending') {
    filter.requiresAction = true;
    filter.status = { $in: ['unread', 'read'] };
  } else if (tab === 'notifications') {
    filter.requiresAction = false;
  } else if (tab === 'done') {
    filter.status = { $in: ['actioned', 'dismissed'] };
  }

  if (typeFilter && typeFilter !== 'all') filter.type = typeFilter;

  const sortDir = sort === 'oldest' ? 1 : -1;

  const [total, items] = await Promise.all([
    countDocuments('inbox_items', filter),
    findMany('inbox_items', filter, { skip, limit, sort: { createdAt: sortDir } }),
  ]);

  // Enrich with triggeredBy user info
  const enriched = await Promise.all(items.map(async (item) => {
    let triggeredByUser = null;
    if (item.triggeredBy) {
      const u = await findOne('users', { _id: item.triggeredBy }, { projection: { name: 1 } });
      const emp = u ? await findOne('employees', { _id: item.triggeredBy }, { projection: { fullName: 1, designation: 1, department: 1 } }) : null;
      triggeredByUser = { name: u?.name || '', designation: emp?.designation || '', department: emp?.department || '' };
    }
    return { ...item, triggeredByUser };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

// ── Get inbox counts ──────────────────────────────────────────────────────────
const getInboxCount = async (req, res) => {
  const [unread, pending] = await Promise.all([
    countDocuments('inbox_items', { recipientId: req.user._id, status: 'unread' }),
    countDocuments('inbox_items', { recipientId: req.user._id, requiresAction: true, status: { $in: ['unread', 'read'] } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, { unread, pending });
};

// ── Get single inbox item ─────────────────────────────────────────────────────
const getInboxItem = async (req, res) => {
  const item = await findOne('inbox_items', { _id: new ObjectId(req.params.id), recipientId: req.user._id });
  if (!item) return returnFunction(res, 404, false, req.locale.notFound);

  // Auto-mark as read when opened
  if (item.status === 'unread') {
    await updateOne('inbox_items', { _id: item._id }, { $set: { status: 'read', updatedAt: new Date() } });
  }

  // Enrich with reference data
  let referenceData = null;
  if (item.referenceId && item.referenceModel) {
    referenceData = await findOne(item.referenceModel, { _id: item.referenceId });

    // Enrich with employee data if available
    if (referenceData?.employeeId) {
      const emp = await findOne('employees', { _id: referenceData.employeeId });
      referenceData = { ...referenceData, employee: emp || null };
    }
  }

  return returnFunction(res, 200, true, req.locale.success, { ...item, referenceData });
};

// ── Mark item as read ─────────────────────────────────────────────────────────
const markRead = async (req, res) => {
  const item = await findOne('inbox_items', { _id: new ObjectId(req.params.id), recipientId: req.user._id });
  if (!item) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('inbox_items', { _id: item._id }, { $set: { status: 'read', updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.success);
};

// ── Take action on an inbox item ──────────────────────────────────────────────
const takeAction = async (req, res) => {
  const { action, reason } = req.body;
  if (!action) return returnFunction(res, 400, false, 'Action is required.');

  const item = await findOne('inbox_items', { _id: new ObjectId(req.params.id), recipientId: req.user._id });
  if (!item) return returnFunction(res, 404, false, req.locale.notFound);
  if (item.status === 'actioned') return returnFunction(res, 400, false, 'Action already taken.');

  const now = new Date();

  // Perform the actual business action based on type
  if (item.referenceId && item.referenceModel) {
    try {
      if (item.type === 'leave' && item.referenceModel === 'leave_requests') {
        const update = action === 'approved'
          ? { status: 'approved', approvedBy: req.user._id, approvedAt: now }
          : { status: 'rejected', rejectedBy: req.user._id, rejectedAt: now, rejectionReason: reason || '' };
        await global.dbo.collection('leave_requests').updateOne({ _id: item.referenceId }, { $set: { ...update, updatedAt: now } });

        // Notify employee of outcome
        const leaveReq = await findOne('leave_requests', { _id: item.referenceId });
        if (leaveReq) {
          const empUser = await findOne('users', { employeeId: leaveReq.employeeId });
          if (empUser) {
            await createInboxItem({
              recipientId: empUser._id,
              type: 'general',
              subType: `leave_${action}`,
              title: `Leave request ${action}`,
              subtitle: action === 'approved' ? 'Your leave request has been approved.' : `Your leave request was declined. ${reason || ''}`,
              referenceId: item.referenceId,
              referenceModel: 'leave_requests',
              requiresAction: false,
              triggeredBy: req.user._id,
            });
          }
        }
      }

      if (item.type === 'expense' && item.referenceModel === 'expense_claims') {
        const update = action === 'approved'
          ? { status: 'approved', approvedBy: req.user._id, approvedAt: now }
          : { status: 'rejected', rejectedBy: req.user._id, rejectedAt: now, rejectionReason: reason || '' };
        await global.dbo.collection('expense_claims').updateOne({ _id: item.referenceId }, { $set: { ...update, updatedAt: now } });

        const claim = await findOne('expense_claims', { _id: item.referenceId });
        if (claim) {
          const empUser = await findOne('users', { employeeId: claim.employeeId });
          if (empUser) {
            await createInboxItem({
              recipientId: empUser._id,
              type: 'general',
              subType: `expense_${action}`,
              title: `Expense claim ${action}`,
              subtitle: `Your expense claim has been ${action}.`,
              referenceId: item.referenceId,
              referenceModel: 'expense_claims',
              requiresAction: false,
              triggeredBy: req.user._id,
            });
          }
        }
      }

      if (item.type === 'timesheet' && item.referenceModel === 'timesheets') {
        const update = action === 'approved'
          ? { status: 'approved', approvedBy: req.user._id, approvedAt: now }
          : { status: 'rejected', rejectedBy: req.user._id, rejectedAt: now, rejectionReason: reason || '' };
        await global.dbo.collection('timesheets').updateOne({ _id: item.referenceId }, { $set: { ...update, updatedAt: now } });
      }
    } catch {
      // Business action failed but still mark inbox item
    }
  }

  await updateOne('inbox_items', { _id: item._id }, {
    $set: { status: 'actioned', actionTaken: action, actionedAt: now, actionedBy: req.user._id, updatedAt: now },
  });

  return returnFunction(res, 200, true, 'Action recorded.', { action });
};

// ── Mark all as read ──────────────────────────────────────────────────────────
const markAllRead = async (req, res) => {
  await global.dbo.collection('inbox_items').updateMany(
    { recipientId: req.user._id, status: 'unread' },
    { $set: { status: 'read', updatedAt: new Date() } },
  );
  return returnFunction(res, 200, true, 'All items marked as read.');
};

// ── Dismiss item ──────────────────────────────────────────────────────────────
const dismissItem = async (req, res) => {
  const item = await findOne('inbox_items', { _id: new ObjectId(req.params.id), recipientId: req.user._id });
  if (!item) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('inbox_items', { _id: item._id }, { $set: { status: 'dismissed', updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Item dismissed.');
};

// ── Bulk actions ──────────────────────────────────────────────────────────────
const bulkAction = async (req, res) => {
  const { ids, action } = req.body;
  if (!ids?.length || !action) return returnFunction(res, 400, false, 'ids and action required.');

  const objectIds = ids.map(id => new ObjectId(id));
  const now = new Date();

  if (action === 'mark_read') {
    await global.dbo.collection('inbox_items').updateMany(
      { _id: { $in: objectIds }, recipientId: req.user._id },
      { $set: { status: 'read', updatedAt: now } },
    );
  } else if (action === 'dismiss') {
    await global.dbo.collection('inbox_items').updateMany(
      { _id: { $in: objectIds }, recipientId: req.user._id },
      { $set: { status: 'dismissed', updatedAt: now } },
    );
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
