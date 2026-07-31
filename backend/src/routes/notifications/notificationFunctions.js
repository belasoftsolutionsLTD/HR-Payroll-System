const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { STAFF } = require('../../constants/roles');

// ── Internal helper — called by all modules when events occur ─────────────────
const createNotification = async ({
  recipientId,
  type,
  title,
  subtitle,
  referenceId,
  referenceModel,
  navigateTo,
}) => {
  if (!recipientId || !type || !title) return null;
  const doc = {
    recipientId: new ObjectId(recipientId),
    type,
    title,
    subtitle: subtitle || '',
    body: subtitle || '',
    referenceId: referenceId ? new ObjectId(referenceId) : null,
    referenceModel: referenceModel || null,
    navigateTo: navigateTo || null,
    isRead: false,
    read: false,
    readAt: null,
    emailSent: false,
    emailSentAt: null,
    createdAt: new Date(),
  };
  try {
    return await global.dbo.collection('notifications').insertOne(doc);
  } catch {
    return null;
  }
};

// ── Notify all HR users ───────────────────────────────────────────────────────
const notifyHRNotification = async (data) => {
  const hrUsers = await findMany('users', { role: { $in: ['super_admin', 'hr_manager'] } }, { projection: { _id: 1 } });
  for (const u of hrUsers) {
    await createNotification({ ...data, recipientId: u._id });
  }
};

// Most notify*() call sites across the codebase (notifyUser/notifyByRoles/notifyEmployee/
// notifyStaffByAudience in functions/HR/notifyUser.js) never pass a `link`, so `navigateTo`
// is null on most notifications — the bell shows them as inert text with nothing to click.
// Rather than hand-adding a link at every one of those call sites (they're spread across
// nearly every module), this maps a notification's `type` to its module's base route as a
// read-time fallback — "takes you to the respective module" is exactly what was asked for,
// and unlike per-call-site links this covers every existing notification immediately, with
// no backfill migration. A per-record deep link (e.g. straight to one leave request) can
// still be set explicitly via `link`/`navigateTo` on individual notify() calls — that always
// wins over this fallback.
const MODULE_ROUTE_BY_TYPE = {
  announcement:     '/communications',
  attendance_alert: '/attendance',
  expense:          '/expenses',
  leave:            '/leave',
  offboarding:      '/offboarding',
  onboarding:       '/onboarding',
  payroll:          '/payroll',
  recruitment:      '/recruitment',
  task:             '/tasks',
  task_reminder:    '/tasks',
  training:         '/training',
};

// A plain 'staff' account is only ever allowed on /staff-portal plus /my/training,
// /my/onboarding, /my/offboarding, /my/leave (enforced in (hr)/layout.tsx) — every other
// route in MODULE_ROUTE_BY_TYPE above bounces them straight back to /staff-portal on
// arrival. That made the bell look completely inert for staff: click a notification,
// it marks read and "navigates," and you land right back where you started. Everything
// without a real staff-facing route falls back to /staff-portal itself rather than a
// route that will just redirect them again.
const STAFF_MODULE_ROUTE_BY_TYPE = {
  ...MODULE_ROUTE_BY_TYPE,
  announcement:     '/staff-portal',
  attendance_alert: '/staff-portal',
  expense:          '/staff-portal',
  leave:            '/my/leave',
  offboarding:      '/my/offboarding',
  onboarding:       '/my/onboarding',
  payroll:          '/staff-portal',
  recruitment:      '/staff-portal',
  task:             '/staff-portal',
  task_reminder:    '/staff-portal',
  training:         '/my/training',
};

const withNavigateFallback = (item, role) => {
  if (item.navigateTo) return item;
  const map = role === STAFF ? STAFF_MODULE_ROUTE_BY_TYPE : MODULE_ROUTE_BY_TYPE;
  return { ...item, navigateTo: map[item.type] || null };
};

// ── List notifications ────────────────────────────────────────────────────────
const listNotifications = async (req, res) => {
  const filter = {
    $or: [{ recipientId: req.user._id }, { userId: req.user._id }],
  };
  if (req.query.unread === 'true') {
    filter.$and = [{
      $or: [
        { isRead: false },
        { read: false },
        { isRead: { $exists: false }, read: { $exists: false } },
      ],
    }];
  }
  if (req.query.type && req.query.type !== 'all') filter.type = req.query.type;

  const { page, limit, skip } = getPagination(req.query);
  const [total, items] = await Promise.all([
    countDocuments('notifications', filter),
    findMany('notifications', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(items.map((item) => withNavigateFallback(item, req.user.role)), total, page, limit));
};

// ── Get unread count ──────────────────────────────────────────────────────────
const getNotificationCount = async (req, res) => {
  const count = await countDocuments('notifications', {
    $and: [
      { $or: [{ recipientId: req.user._id }, { userId: req.user._id }] },
      {
        $or: [
          { isRead: false },
          { read: false },
          { isRead: { $exists: false }, read: { $exists: false } },
        ],
      },
    ],
  });
  return returnFunction(res, 200, true, req.locale.success, { count });
};

// ── Mark one as read ──────────────────────────────────────────────────────────
const markRead = async (req, res) => {
  await global.dbo.collection('notifications').updateOne(
    { _id: new ObjectId(req.params.id), $or: [{ recipientId: req.user._id }, { userId: req.user._id }] },
    { $set: { isRead: true, read: true, readAt: new Date() } },
  );
  return returnFunction(res, 200, true, req.locale.success);
};

// ── Mark all as read ──────────────────────────────────────────────────────────
const markAllRead = async (req, res) => {
  await global.dbo.collection('notifications').updateMany(
    { $or: [{ recipientId: req.user._id }, { userId: req.user._id }] },
    { $set: { isRead: true, read: true, readAt: new Date() } },
  );
  return returnFunction(res, 200, true, 'All marked as read.');
};

// ── Dismiss notification ──────────────────────────────────────────────────────
const dismissNotification = async (req, res) => {
  await global.dbo.collection('notifications').deleteOne({
    _id: new ObjectId(req.params.id),
    $or: [{ recipientId: req.user._id }, { userId: req.user._id }],
  });
  return returnFunction(res, 200, true, 'Dismissed.');
};

module.exports = {
  createNotification,
  notifyHRNotification,
  listNotifications,
  getNotificationCount,
  markRead,
  markAllRead,
  dismissNotification,
};
