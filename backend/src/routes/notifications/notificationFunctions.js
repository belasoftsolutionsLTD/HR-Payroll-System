const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');

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

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(items, total, page, limit));
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
