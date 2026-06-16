const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { findMany, findOne, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { sendEmail } = require('../../services/emailService');
const { DEPT_HEAD, STAFF } = require('../../constants/roles');

const COMPANY_NAME = process.env.COMPANY_NAME || 'School ERP';

// ── Helpers ────────────────────────────────────────────────────────────────────
const generatePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const ALLOWED_CREATE_ROLES = [DEPT_HEAD, STAFF];

// ── List all user accounts ─────────────────────────────────────────────────────
const listAccounts = async (req, res) => {
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

  const users = await findMany('users', filter, {
    sort: { createdAt: -1 },
    projection: { password: 0 },
  });
  return returnFunction(res, 200, true, 'OK', users);
};

// ── HR creates an account for staff or dept_head ───────────────────────────────
const createAccount = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'email', 'role'])) return;

  const { name, email, role, employeeId, department } = req.body;

  if (!ALLOWED_CREATE_ROLES.includes(role)) {
    return returnFunction(res, 400, false, `Role must be one of: ${ALLOWED_CREATE_ROLES.join(', ')}`);
  }

  const existing = await findOne('users', { email: email.toLowerCase().trim() });
  if (existing) return returnFunction(res, 409, false, 'A user with this email already exists.');

  // If linking to an employee, verify that employee exists
  let linkedEmployeeId = null;
  if (employeeId) {
    const emp = await findOne('employees', { _id: new ObjectId(employeeId) });
    if (!emp) return returnFunction(res, 404, false, 'Employee not found.');
    linkedEmployeeId = emp._id;
  }

  const rawPassword = generatePassword();
  const hashed = await bcrypt.hash(rawPassword, 12);

  const doc = {
    name: name.trim(),
    email: email.toLowerCase().trim(),
    password: hashed,
    role,
    employeeId: linkedEmployeeId,
    department: department || null,
    mustResetPassword: true,
    isActive: true,
    createdBy: new ObjectId(req.user._id),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('users', doc);

  // Send credentials via email
  sendEmail({
    to: doc.email,
    subject: `Your ${COMPANY_NAME} account is ready`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;">
        <h2>Welcome to ${COMPANY_NAME}</h2>
        <p>Hi <strong>${name}</strong>,</p>
        <p>Your account has been created. Use the credentials below to log in:</p>
        <table style="background:#f5f5f5;padding:16px;border-radius:8px;width:100%;">
          <tr><td><strong>Email:</strong></td><td>${doc.email}</td></tr>
          <tr><td><strong>Password:</strong></td><td style="font-family:monospace;font-size:16px;">${rawPassword}</td></tr>
        </table>
        <p style="color:#e53e3e;font-size:13px;margin-top:12px;">
          You will be prompted to set a new password on your first login.
        </p>
      </div>
    `,
  }).catch((e) => console.error('Credentials email failed:', e.message));

  return returnFunction(res, 201, true, 'Account created. Credentials sent via email.', {
    _id: result.insertedId,
  });
};

// ── Update role / department / active status ───────────────────────────────────
const updateAccount = async (req, res) => {
  const { role, department, isActive, employeeId } = req.body;
  const update = { updatedAt: new Date() };

  if (role) {
    if (!ALLOWED_CREATE_ROLES.includes(role)) {
      return returnFunction(res, 400, false, `Role must be one of: ${ALLOWED_CREATE_ROLES.join(', ')}`);
    }
    update.role = role;
  }
  if (department !== undefined) update.department = department;
  if (isActive !== undefined) update.isActive = Boolean(isActive);
  if (employeeId !== undefined) {
    update.employeeId = employeeId ? new ObjectId(employeeId) : null;
  }

  await updateOne('users', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, 'Account updated.');
};

// ── HR resets a user's password (generates new one, sends email) ───────────────
const adminResetPassword = async (req, res) => {
  const user = await findOne('users', { _id: new ObjectId(req.params.id) }, { projection: { name: 1, email: 1 } });
  if (!user) return returnFunction(res, 404, false, 'User not found.');

  const rawPassword = generatePassword();
  const hashed = await bcrypt.hash(rawPassword, 12);

  await updateOne('users', { _id: user._id }, {
    $set: { password: hashed, mustResetPassword: true, updatedAt: new Date() },
  });

  sendEmail({
    to: user.email,
    subject: `Your ${COMPANY_NAME} password has been reset`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;">
        <h2>Password Reset — ${COMPANY_NAME}</h2>
        <p>Hi <strong>${user.name}</strong>,</p>
        <p>Your password has been reset by an administrator. Your new temporary password is:</p>
        <p style="font-family:monospace;font-size:20px;background:#f5f5f5;padding:12px;border-radius:8px;">${rawPassword}</p>
        <p style="color:#e53e3e;font-size:13px;">Please change this password after logging in.</p>
      </div>
    `,
  }).catch((e) => console.error('Password reset email failed:', e.message));

  return returnFunction(res, 200, true, 'Password reset. New credentials sent via email.');
};

// ── User changes their own password ───────────────────────────────────────────
const changeOwnPassword = async (req, res) => {
  if (!validateRequiredFields(req, res, ['newPassword'])) return;

  const { currentPassword, newPassword } = req.body;
  const user = await findOne('users', { _id: new ObjectId(req.user._id) });
  if (!user) return returnFunction(res, 404, false, 'User not found.');

  // If not first-time reset, require current password
  if (!user.mustResetPassword) {
    if (!currentPassword) return returnFunction(res, 400, false, 'Current password is required.');
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return returnFunction(res, 401, false, 'Current password is incorrect.');
  }

  if (newPassword.length < 6) return returnFunction(res, 400, false, 'Password must be at least 6 characters.');

  const hashed = await bcrypt.hash(newPassword, 12);
  await updateOne('users', { _id: user._id }, {
    $set: { password: hashed, mustResetPassword: false, updatedAt: new Date() },
  });

  return returnFunction(res, 200, true, 'Password updated successfully.');
};

module.exports = { listAccounts, createAccount, updateAccount, adminResetPassword, changeOwnPassword };
