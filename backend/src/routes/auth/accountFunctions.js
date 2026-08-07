const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 1) —
// `users` and `employees` now live in Postgres. `knex` is used directly for the one
// query beyond pgDBFunctions' plain-equality shim (an atomic tokenVersion increment).
const { findMany, findOne, insertOne, updateOne, knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { sendEmail } = require('../../services/emailService');
const { HR_MANAGER, DEPT_HEAD, STAFF } = require('../../constants/roles');
const { evaluateRulesForUser } = require('../../lib/training/autoEnrollment');

const COMPANY_NAME = process.env.COMPANY_NAME || 'Workfola';

// ── Helpers ────────────────────────────────────────────────────────────────────
const generatePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

// training/autoEnrollment.js and other not-yet-migrated Mongo modules still expect a
// real Mongo ObjectId on `_id` (it gets written straight into Mongo-side documents like
// enrollments.employeeId) — this wraps a Postgres users row for that handoff. Safe only
// because ids were deliberately kept as unchanged ObjectId-hex strings across the whole
// migration (see the plan's "IDs stay as-is" decision).
const withMongoId = (userRow) => ({ ...userRow, _id: new ObjectId(userRow.id) });

const ALLOWED_CREATE_ROLES = [HR_MANAGER, DEPT_HEAD, STAFF];

// ── List all user accounts ─────────────────────────────────────────────────────
const listAccounts = async (req, res) => {
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

  const users = await findMany('users', filter, { orderBy: { column: 'createdAt', order: 'desc' } });
  const safeUsers = users.map(({ password, ...rest }) => rest);
  return returnFunction(res, 200, true, 'OK', safeUsers);
};

// ── HR creates an account for staff or dept_head ───────────────────────────────
const createAccount = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'email', 'role'])) return;

  const { name, email, role, employeeId, department } = req.body;

  if (!ALLOWED_CREATE_ROLES.includes(role)) {
    return returnFunction(res, 400, false, `Role must be one of: ${ALLOWED_CREATE_ROLES.join(', ')}`);
  }

  // Staff/dept-head accounts exist to BE a self-service portal for a real employee —
  // one with no employee record can log in but has nothing to see (leave balance,
  // payslips, profile all come from the employee doc). HR managers are a pure
  // operator role and legitimately don't need one.
  if ([STAFF, DEPT_HEAD].includes(role) && !employeeId) {
    return returnFunction(res, 400, false, 'Link this account to an employee record — Staff and Department Head accounts need one to show any personal data.');
  }

  const existing = await findOne('users', { email: email.toLowerCase().trim() });
  if (existing) return returnFunction(res, 409, false, 'A user with this email already exists.');

  // If linking to an employee, verify that employee exists
  let linkedEmployeeId = null;
  if (employeeId) {
    const emp = await findOne('employees', { id: employeeId });
    if (!emp) return returnFunction(res, 404, false, 'Employee not found.');
    linkedEmployeeId = emp.id;
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
    createdBy: req.user.id,
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
    bypassUnsubscribe: true,
  }).catch((e) => console.error('Credentials email failed:', e.message));

  // Training auto-enrollment — a new account is the point at which someone becomes
  // trainable (has a role/department to target and can log in to take courses).
  evaluateRulesForUser('onHire', withMongoId(result)).catch(() => {});

  return returnFunction(res, 201, true, 'Account created. Credentials sent via email.', {
    _id: result.id,
  });
};

// ── Update role / department / active status ───────────────────────────────────
const updateAccount = async (req, res) => {
  const { role, department, isActive, employeeId } = req.body;
  const update = { updatedAt: new Date() };

  const before = await findOne('users', { id: req.params.id });

  if (role) {
    if (!ALLOWED_CREATE_ROLES.includes(role)) {
      return returnFunction(res, 400, false, `Role must be one of: ${ALLOWED_CREATE_ROLES.join(', ')}`);
    }
    update.role = role;
  }
  if (department !== undefined) update.department = department;
  if (isActive !== undefined) update.isActive = Boolean(isActive);
  if (employeeId !== undefined) {
    update.employeeId = employeeId || null;
  }

  // Deactivating an account must kill all active sessions immediately
  if (isActive === false || isActive === 'false') {
    update.refreshTokenHash = null;
    update.refreshTokenExpiresAt = null;
  }

  await updateOne('users', { id: req.params.id }, update);

  // Training auto-enrollment on role/department change
  if (before) {
    const roleChanged = role && role !== before.role;
    const deptChanged = department !== undefined && department !== before.department;
    if (roleChanged || deptChanged) {
      const after = await findOne('users', { id: req.params.id });
      if (roleChanged) evaluateRulesForUser('onRoleChange', withMongoId(after)).catch(() => {});
      if (deptChanged) evaluateRulesForUser('onDepartmentChange', withMongoId(after)).catch(() => {});
    }
  }
  return returnFunction(res, 200, true, 'Account updated.');
};

// ── HR resets a user's password (generates new one, sends email) ───────────────
const adminResetPassword = async (req, res) => {
  const user = await findOne('users', { id: req.params.id });
  if (!user) return returnFunction(res, 404, false, 'User not found.');

  const rawPassword = generatePassword();
  const hashed = await bcrypt.hash(rawPassword, 12);

  await knex('users').where({ id: user.id }).update({
    password: hashed, mustResetPassword: true, updatedAt: new Date(),
    refreshTokenHash: null, refreshTokenExpiresAt: null,
    // Revokes any access token already issued to this account — see the tokenVersion
    // check in AuthMiddleware.js. Without this, an admin-forced password reset (e.g.
    // because the account was thought to be compromised) wouldn't actually kick out
    // whoever's currently using it until their token's own natural expiry.
    tokenVersion: knex.raw('"tokenVersion" + 1'),
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
    bypassUnsubscribe: true,
  }).catch((e) => console.error('Password reset email failed:', e.message));

  return returnFunction(res, 200, true, 'Password reset. New credentials sent via email.');
};

// ── User changes their own password ───────────────────────────────────────────
const changeOwnPassword = async (req, res) => {
  if (!validateRequiredFields(req, res, ['newPassword'])) return;

  // Trimmed — a temp/reset password pasted from an emailed credentials message
  // routinely picks up a stray leading/trailing space from the mail client, which
  // otherwise surfaces as a confusing "Current password is incorrect."
  const currentPassword = String(req.body.currentPassword || '').trim();
  const newPassword = String(req.body.newPassword || '').trim();
  const user = await findOne('users', { id: req.user.id });
  if (!user) return returnFunction(res, 404, false, 'User not found.');

  // If not first-time reset, require current password
  if (!user.mustResetPassword) {
    if (!currentPassword) return returnFunction(res, 400, false, 'Current password is required.');
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return returnFunction(res, 401, false, 'Current password is incorrect.');
  }

  if (newPassword.length < 6) return returnFunction(res, 400, false, 'Password must be at least 6 characters.');

  const hashed = await bcrypt.hash(newPassword, 12);
  await knex('users').where({ id: user.id }).update({
    password: hashed, mustResetPassword: false, updatedAt: new Date(),
    // Invalidate all existing sessions — forces re-login on all devices. tokenVersion
    // is what makes this actually true for a still-time-valid access token too, not
    // just future refreshes (see AuthMiddleware.js).
    refreshTokenHash: null, refreshTokenExpiresAt: null,
    tokenVersion: knex.raw('"tokenVersion" + 1'),
  });

  return returnFunction(res, 200, true, 'Password updated successfully.');
};

module.exports = { listAccounts, createAccount, updateAccount, adminResetPassword, changeOwnPassword };
