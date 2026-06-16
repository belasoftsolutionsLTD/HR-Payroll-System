const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { findOne, insertOne } = require('../../functions/Database/commonDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');

const login = async (req, res) => {
  const locale = req.locale;

  if (!validateRequiredFields(req, res, ['email', 'password'])) return;

  const { email, password } = req.body;

  const user = await findOne('users', { email: email.toLowerCase().trim() });
  if (!user) return returnFunction(res, 401, false, locale.unauthorized);

  const match = await bcrypt.compare(password, user.password);
  if (!match) return returnFunction(res, 401, false, locale.unauthorized);

  if (user.isActive === false) {
    return returnFunction(res, 403, false, 'Your account has been deactivated. Contact HR.');
  }

  const token = jwt.sign(
    { userId: user._id.toString() },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  const { password: _pw, ...safeUser } = user;
  return returnFunction(res, 200, true, locale.success, { token, user: safeUser });
};

const register = async (req, res) => {
  const locale = req.locale;

  if (!validateRequiredFields(req, res, ['name', 'email', 'password'])) return;

  const { name, email, password } = req.body;
  const role = 'hr_manager';

  const existing = await findOne('users', { email: email.toLowerCase().trim() });
  if (existing) {
    return returnFunction(res, 409, false, 'A user with this email already exists.');
  }

  const hashed = await bcrypt.hash(password, 12);

  const result = await insertOne('users', {
    name,
    email: email.toLowerCase().trim(),
    password: hashed,
    role,
    createdAt: new Date(),
  });

  return returnFunction(res, 201, true, locale.createdSuccessfully, {
    userId: result.insertedId,
  });
};

module.exports = { login, register };
