const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, aggregate } = require('../../functions/Database/commonDBFunctions');
const { getPosAccessLevel, canSellAtLocation } = require('../../lib/pos/posAccess');

// A register "session" is one cashier's shift at one location — every sale and refund
// they process is stamped with this session's _id, which is what makes cash variance at
// close-out computable (see closeRegister) and is also what supplies the sale's
// locationId server-side, so a client can never lie about which location a sale happened at.

const getMyOpenSession = async (userId) => findOne('pos_register_sessions', { openedBy: userId, status: 'open' });

const getCurrentSession = async (req, res) => {
  const session = await getMyOpenSession(req.user._id);
  if (!session) return returnFunction(res, 200, true, req.locale.success, null);
  const location = await findOne('inventory_locations', { _id: session.locationId }, { projection: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, { ...session, location: location || null });
};

const openRegister = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['locationId', 'openingFloat'])) return;

  const existing = await getMyOpenSession(req.user._id);
  if (existing) return returnFunction(res, 400, false, 'You already have an open register session — close it before opening a new one.');

  const allowed = await canSellAtLocation(req.user, level, req.body.locationId);
  if (!allowed) return returnFunction(res, 403, false, 'You are not assigned to this location.');

  const location = await findOne('inventory_locations', { _id: new ObjectId(req.body.locationId) });
  if (!location) return returnFunction(res, 404, false, 'Location not found.');

  const doc = {
    locationId: location._id,
    openedBy: req.user._id,
    openedAt: new Date(),
    openingFloat: Number(req.body.openingFloat) || 0,
    status: 'open',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('pos_register_sessions', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const closeRegister = async (req, res) => {
  const session = await getMyOpenSession(req.user._id);
  if (!session) return returnFunction(res, 400, false, 'You do not have an open register session.');
  if (!validateRequiredFields(req, res, ['closingCount'])) return;

  const [cashIn, cashOut] = await Promise.all([
    aggregate('pos_sales', [
      { $match: { registerSessionId: session._id, status: { $in: ['completed', 'partially_refunded'] } } },
      { $unwind: '$payments' },
      { $match: { 'payments.method': 'cash' } },
      { $group: { _id: null, total: { $sum: '$payments.amount' } } },
    ]),
    aggregate('pos_refunds', [
      { $match: { registerSessionId: session._id, method: 'cash' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const cashSales = cashIn[0]?.total || 0;
  const cashRefunds = cashOut[0]?.total || 0;
  const expectedCash = session.openingFloat + cashSales - cashRefunds;
  const closingCount = Number(req.body.closingCount);
  const variance = Math.round((closingCount - expectedCash) * 100) / 100;

  await updateOne('pos_register_sessions', { _id: session._id }, {
    $set: {
      status: 'closed', closedBy: req.user._id, closedAt: new Date(),
      closingCount, expectedCash, variance, cashSales, cashRefunds, updatedAt: new Date(),
    },
  });

  return returnFunction(res, 200, true, 'Register closed.', { expectedCash, closingCount, variance });
};

const listSessions = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized.');

  const filter = {};
  if (req.query.locationId) filter.locationId = new ObjectId(req.query.locationId);
  if (req.query.status) filter.status = req.query.status;

  const sessions = await findMany('pos_register_sessions', filter, { sort: { openedAt: -1 }, limit: 100 });
  const locIds = [...new Set(sessions.map((s) => String(s.locationId)))].map((id) => new ObjectId(id));
  const userIds = [...new Set(sessions.flatMap((s) => [s.openedBy, s.closedBy].filter(Boolean).map(String)))].map((id) => new ObjectId(id));
  const [locations, users] = await Promise.all([
    findMany('inventory_locations', { _id: { $in: locIds } }, { projection: { name: 1 } }),
    findMany('users', { _id: { $in: userIds } }, { projection: { name: 1 } }),
  ]);
  const locMap = Object.fromEntries(locations.map((l) => [String(l._id), l]));
  const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));

  const enriched = sessions.map((s) => ({
    ...s, location: locMap[String(s.locationId)] || null,
    openedByName: userMap[String(s.openedBy)]?.name || 'Unknown',
    closedByName: s.closedBy ? (userMap[String(s.closedBy)]?.name || 'Unknown') : null,
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

module.exports = { getCurrentSession, openRegister, closeRegister, listSessions, getMyOpenSession };
