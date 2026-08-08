// Postgres migration (Phase 6) — pos_register_sessions/pos_sales/pos_refunds/
// inventory_locations/users are all Postgres now. pos_sales.payments is a JSONB array
// (see phase6 migration) — closeRegister's Mongo $unwind aggregation becomes a
// jsonb_array_elements() unnest via a raw query; pos_refunds.amount/method are plain
// columns, so that half stays a normal knex .sum().
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { getPosAccessLevel, canSellAtLocation } = require('../../lib/pos/posAccess');

// A register "session" is one cashier's shift at one location — every sale and refund
// they process is stamped with this session's id, which is what makes cash variance at
// close-out computable (see closeRegister) and is also what supplies the sale's
// locationId server-side, so a client can never lie about which location a sale happened at.

const getMyOpenSession = async (userId) => knex('pos_register_sessions').where({ openedBy: userId, status: 'open' }).first();

const getCurrentSession = async (req, res) => {
  const session = await getMyOpenSession(req.user.id);
  if (!session) return returnFunction(res, 200, true, req.locale.success, null);
  const location = await knex('inventory_locations').where({ id: session.locationId }).select('name').first();
  return returnFunction(res, 200, true, req.locale.success, { ...session, location: location || null });
};

const openRegister = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['locationId', 'openingFloat'])) return;

  const existing = await getMyOpenSession(req.user.id);
  if (existing) return returnFunction(res, 400, false, 'You already have an open register session — close it before opening a new one.');

  const allowed = await canSellAtLocation(req.user, level, req.body.locationId);
  if (!allowed) return returnFunction(res, 403, false, 'You are not assigned to this location.');

  const location = await knex('inventory_locations').where({ id: req.body.locationId }).first();
  if (!location) return returnFunction(res, 404, false, 'Location not found.');

  const doc = {
    id: newId(),
    locationId: location.id,
    openedBy: req.user.id,
    openedAt: new Date(),
    openingFloat: Number(req.body.openingFloat) || 0,
    status: 'open',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('pos_register_sessions').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const closeRegister = async (req, res) => {
  const session = await getMyOpenSession(req.user.id);
  if (!session) return returnFunction(res, 400, false, 'You do not have an open register session.');
  if (!validateRequiredFields(req, res, ['closingCount'])) return;

  const [cashInResult, cashOutRow] = await Promise.all([
    knex.raw(
      `select coalesce(sum((elem->>'amount')::numeric), 0) as total
       from pos_sales, jsonb_array_elements(payments) as elem
       where "registerSessionId" = ? and status in ('completed', 'partially_refunded') and elem->>'method' = 'cash'`,
      [session.id]
    ),
    knex('pos_refunds').where({ registerSessionId: session.id, method: 'cash' }).sum('amount as total').first(),
  ]);

  const cashSales = Number(cashInResult.rows[0]?.total) || 0;
  const cashRefunds = Number(cashOutRow?.total) || 0;
  const expectedCash = session.openingFloat + cashSales - cashRefunds;
  const closingCount = Number(req.body.closingCount);
  const variance = Math.round((closingCount - expectedCash) * 100) / 100;

  await knex('pos_register_sessions').where({ id: session.id }).update({
    status: 'closed', closedBy: req.user.id, closedAt: new Date(),
    closingCount, expectedCash, variance, cashSales, cashRefunds, updatedAt: new Date(),
  });

  return returnFunction(res, 200, true, 'Register closed.', { expectedCash, closingCount, variance });
};

const listSessions = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized.');

  let query = knex('pos_register_sessions');
  if (req.query.locationId) query = query.where({ locationId: req.query.locationId });
  if (req.query.status) query = query.where({ status: req.query.status });

  const sessions = await query.orderBy('openedAt', 'desc').limit(100);
  const locIds = [...new Set(sessions.map((s) => s.locationId))];
  const userIds = [...new Set(sessions.flatMap((s) => [s.openedBy, s.closedBy].filter(Boolean)))];
  const [locations, users] = await Promise.all([
    knex('inventory_locations').whereIn('id', locIds).select('id', 'name'),
    knex('users').whereIn('id', userIds).select('id', 'name'),
  ]);
  const locMap = Object.fromEntries(locations.map((l) => [l.id, l]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const enriched = sessions.map((s) => ({
    ...s, location: locMap[s.locationId] || null,
    openedByName: userMap[s.openedBy]?.name || 'Unknown',
    closedByName: s.closedBy ? (userMap[s.closedBy]?.name || 'Unknown') : null,
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

module.exports = { getCurrentSession, openRegister, closeRegister, listSessions, getMyOpenSession };
