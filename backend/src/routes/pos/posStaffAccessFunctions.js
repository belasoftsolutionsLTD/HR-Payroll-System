// Postgres migration (Phase 6) — users has been Postgres since Phase 1; this file was
// still reading/writing it via the Mongo commonDBFunctions helper. posLocationIds is a
// Postgres text[] column (see phase6 migration's ALTER TABLE users) — plain JS string
// array in and out, no ObjectId wrapping needed anymore.
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { STAFF } = require('../../constants/roles');
const { getPosAccessLevel } = require('../../lib/pos/posAccess');

// Which locations a plain "staff" cashier is allowed to sell from — POS's own concept,
// no Inventory equivalent (a cashier isn't necessarily a department manager). Stored as
// users.posLocationIds, same pattern as Inventory's users.isInventoryClerk flag.
const listStaffAccess = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');

  const users = await knex('users').where({ role: STAFF }).select('id', 'name', 'email', 'employeeId', 'posLocationIds');
  return returnFunction(res, 200, true, req.locale.success, users.map((u) => ({ ...u, posLocationIds: u.posLocationIds || [] })));
};

const setStaffLocations = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!Array.isArray(req.body.locationIds)) return returnFunction(res, 400, false, 'locationIds must be an array.');

  await knex('users').where({ id: req.params.userId }).update({
    posLocationIds: req.body.locationIds.map((id) => String(id)),
    updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const getMyAccessLevel = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  // 'level' alone isn't enough to decide whether POS is actually relevant to this user —
  // getPosAccessLevel gives every plain staff account 'staff' as a generic fallback even
  // with zero locations assigned (see posAccess.js). 'relevant' answers "does this
  // person have real standing here" — admin/manager always do; 'staff' only if actually
  // assigned to a location. Callers like the nav sidebar should key off `relevant`, not
  // `level`, to decide whether to show POS at all.
  const relevant = level === 'admin' || level === 'manager'
    ? true
    : level === 'staff'
      ? !!(req.user.posLocationIds && req.user.posLocationIds.length)
      : false;
  return returnFunction(res, 200, true, req.locale.success, { level, relevant });
};

module.exports = { listStaffAccess, setStaffLocations, getMyAccessLevel };
