const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { findOne } = require('../functions/Database/commonDBFunctions');
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

const getUserData = AsyncHandler(async (req, res, next) => {
  if (!req.tempUser?.userId) {
    return returnFunction(res, 401, false, (req.locale || {}).unauthorized || 'Unauthorized.');
  }

  const user = await findOne('users', { _id: new ObjectId(req.tempUser.userId) });
  if (!user) {
    return returnFunction(res, 401, false, (req.locale || {}).unauthorized || 'Unauthorized.');
  }

  if (user.isActive === false) {
    return returnFunction(res, 403, false, 'Your account has been deactivated. Contact HR.');
  }

  // Attach full user including employeeId and mustResetPassword for downstream middleware
  req.user = {
    ...user,
    employeeId: user.employeeId ? new ObjectId(user.employeeId) : null,
  };
  next();
});

module.exports = { decodeToken, getUserData };
