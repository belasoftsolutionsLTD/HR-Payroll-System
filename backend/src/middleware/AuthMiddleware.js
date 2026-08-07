const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { findOne } = require('../functions/Database/pgDBFunctions');
const returnFunction = require('../functions/returnFunction');
const AsyncHandler = require('./AsyncHandler');

const decodeToken = AsyncHandler(async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return returnFunction(res, 401, false, (req.locale || {}).unauthorized || 'Unauthorized.');
  }
  const token = authHeader.split(' ')[1];
  try {
    req.tempUser = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return returnFunction(res, 401, false, (req.locale || {}).unauthorized || 'Unauthorized.');
  }
});

// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 1) —
// `users` now lives in Postgres, so this looks up by the plain string id rather than
// wrapping it in a Mongo ObjectId.
const getUserData = AsyncHandler(async (req, res, next) => {
  if (!req.tempUser?.userId) {
    return returnFunction(res, 401, false, (req.locale || {}).unauthorized || 'Unauthorized.');
  }

  const user = await findOne('users', { id: req.tempUser.userId });
  if (!user) {
    return returnFunction(res, 401, false, (req.locale || {}).unauthorized || 'Unauthorized.');
  }

  if (user.isActive === false) {
    return returnFunction(res, 403, false, 'Your account has been deactivated. Contact HR.');
  }

  // Reject a still-time-valid token whose version doesn't match the user's current
  // one — this is what actually revokes access tokens on password change/reset (see
  // _issueTokens in authFunctions.js), since JWTs are otherwise stateless and would
  // keep working until their own expiry regardless of a password change.
  if ((req.tempUser.tokenVersion || 0) !== (user.tokenVersion || 0)) {
    return returnFunction(res, 401, false, 'Session expired. Please log in again.');
  }

  // req.user carries BOTH id shapes during the straddling migration period:
  //  - `id` (plain string) — spread in from the Postgres row as-is, for any
  //    already-migrated (Phase 1+) code querying Postgres via pgDBFunctions.
  //  - `_id` / `employeeId` (real Mongo ObjectId instances, wrapping that exact same
  //    hex string) — for the ~300 call sites across not-yet-migrated modules that
  //    still read req.user._id / req.user.employeeId directly into a Mongo filter or
  //    document field expecting an actual ObjectId, not a string that merely looks
  //    like one. This is only safe because ids were deliberately kept as unchanged
  //    ObjectId-hex strings across the whole migration (see the plan's "IDs stay
  //    as-is" decision) — a Postgres users.id and a Mongo employees._id referencing
  //    the same real employee are still the exact same 24-char string either way.
  req.user = {
    ...user,
    _id: new ObjectId(user.id),
    employeeId: user.employeeId ? new ObjectId(user.employeeId) : null,
  };
  next();
});

module.exports = { decodeToken, getUserData };
