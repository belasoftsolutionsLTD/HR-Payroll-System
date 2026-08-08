// Postgres migration (Phase 10) — notifications is Postgres now, with its
// recipientId/userId dual key (and the link/navigateTo, read/isRead,
// subtitle/body duplicate pairs) normalized to single columns — see the
// migration file header for the live-data check that made this safe.
// employees/users have been Postgres since Phase 1.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { STAFF } = require('../../constants/roles');

// createNotification/notifyHRNotification (this module's own would-be write
// path) were found to have ZERO callers anywhere in the codebase during this
// phase's investigation — every real notification is written through
// functions/HR/notifyUser.js's notifyUser/notifyEmployee/notifyByRoles/
// notifyStaffByAudience instead. Not reimplemented here; that shared helper
// is the one real write path, now targeting Postgres directly.

// Most notify*() call sites across the codebase (functions/HR/notifyUser.js) never
// pass a `link`, so `navigateTo` is null on most notifications — the bell shows them
// as inert text with nothing to click. Rather than hand-adding a link at every one of
// those call sites (they're spread across nearly every module), this maps a
// notification's `type` to its module's base route as a read-time fallback — "takes
// you to the respective module" is exactly what was asked for, and unlike per-call-site
// links this covers every existing notification immediately, with no backfill
// migration. A per-record deep link (e.g. straight to one leave request) can still be
// set explicitly via `link`/`navigateTo` on individual notify() calls — that always
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
  const navigateTo = item.navigateTo || (role === STAFF ? STAFF_MODULE_ROUTE_BY_TYPE : MODULE_ROUTE_BY_TYPE)[item.type] || null;
  // Frontend/older clients may still read either name of each normalized pair —
  // serve both, computed from the single canonical column, rather than assuming
  // every caller has been updated to the new single-column shape.
  return { ...item, navigateTo, link: navigateTo, read: item.isRead, subtitle: item.body };
};

// ── List notifications ────────────────────────────────────────────────────────
const listNotifications = async (req, res) => {
  let query = knex('notifications').where({ recipientId: req.user.id });
  if (req.query.unread === 'true') query = query.where({ isRead: false });
  if (req.query.type && req.query.type !== 'all') query = query.where({ type: req.query.type });

  const { page, limit, skip } = getPagination(req.query);
  const [{ count: total }] = await query.clone().count('* as count');
  const items = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(items.map((item) => withNavigateFallback(item, req.user.role)), Number(total), page, limit));
};

// ── Get unread count ──────────────────────────────────────────────────────────
const getNotificationCount = async (req, res) => {
  const [{ count }] = await knex('notifications').where({ recipientId: req.user.id, isRead: false }).count('* as count');
  return returnFunction(res, 200, true, req.locale.success, { count: Number(count) });
};

// ── Mark one as read ──────────────────────────────────────────────────────────
const markRead = async (req, res) => {
  await knex('notifications').where({ id: req.params.id, recipientId: req.user.id }).update({ isRead: true, readAt: new Date() });
  return returnFunction(res, 200, true, req.locale.success);
};

// ── Mark all as read ──────────────────────────────────────────────────────────
const markAllRead = async (req, res) => {
  await knex('notifications').where({ recipientId: req.user.id }).update({ isRead: true, readAt: new Date() });
  return returnFunction(res, 200, true, 'All marked as read.');
};

// ── Dismiss notification ──────────────────────────────────────────────────────
const dismissNotification = async (req, res) => {
  await knex('notifications').where({ id: req.params.id, recipientId: req.user.id }).delete();
  return returnFunction(res, 200, true, 'Dismissed.');
};

module.exports = {
  listNotifications,
  getNotificationCount,
  markRead,
  markAllRead,
  dismissNotification,
};
