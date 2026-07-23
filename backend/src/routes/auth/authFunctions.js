const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const speakeasy = require('speakeasy');
const QRCode   = require('qrcode');
const { findOne, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { sendEmail } = require('../../services/emailService');

const COMPANY_NAME = process.env.COMPANY_NAME || 'School ERP';

const REFRESH_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS || '30');

const _issueTokens = async (user) => {
  const accessToken = jwt.sign(
    { userId: user._id.toString() },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  const refreshToken = crypto.randomBytes(40).toString('hex');
  const expiresAt    = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

  // Store hashed refresh token against user (one active token per user)
  const hashed = crypto.createHash('sha256').update(refreshToken).digest('hex');
  await updateOne('users', { _id: user._id }, {
    $set: { refreshTokenHash: hashed, refreshTokenExpiresAt: expiresAt, updatedAt: new Date() },
  });

  return { accessToken, refreshToken };
};

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

  // If MFA is enabled, return a short-lived challenge token instead of full access
  if (user.mfaEnabled) {
    const mfaChallenge = jwt.sign(
      { userId: user._id.toString(), mfaPending: true },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    const { password: _pw2 } = user;
    return returnFunction(res, 200, true, 'MFA required.', { mfaRequired: true, mfaChallenge });
  }

  const { accessToken, refreshToken } = await _issueTokens(user);
  const { password: _pw, refreshTokenHash: _rh, mfaSecret: _ms, ...safeUser } = user;
  return returnFunction(res, 200, true, locale.success, { token: accessToken, refreshToken, user: safeUser });
};

const refreshAccessToken = async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return returnFunction(res, 400, false, 'Refresh token is required.');

  const hashed = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const user   = await findOne('users', { refreshTokenHash: hashed });

  if (!user) return returnFunction(res, 401, false, 'Invalid refresh token.');
  if (user.isActive === false) return returnFunction(res, 403, false, 'Account deactivated.');
  if (!user.refreshTokenExpiresAt || new Date(user.refreshTokenExpiresAt) < new Date()) {
    return returnFunction(res, 401, false, 'Refresh token has expired. Please log in again.');
  }

  const { accessToken, refreshToken: newRefreshToken } = await _issueTokens(user);
  return returnFunction(res, 200, true, 'Token refreshed.', { token: accessToken, refreshToken: newRefreshToken });
};

const logout = async (req, res) => {
  // Invalidate refresh token by clearing it
  if (req.user?._id) {
    await updateOne('users', { _id: req.user._id }, {
      $unset: { refreshTokenHash: '', refreshTokenExpiresAt: '' },
    });
  }
  return returnFunction(res, 200, true, 'Logged out successfully.');
};

// Disabled — unauthenticated endpoint that hardcodes hr_manager role. Use POST /auth/accounts instead.
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

// ── MFA: Complete Login Challenge ─────────────────────────────────────────────
const completeMfaLogin = async (req, res) => {
  if (!validateRequiredFields(req, res, ['mfaChallenge', 'code'])) return;
  const { mfaChallenge, code } = req.body;

  let payload;
  try {
    payload = jwt.verify(mfaChallenge, process.env.JWT_SECRET);
  } catch {
    return returnFunction(res, 401, false, 'MFA challenge expired or invalid. Please log in again.');
  }
  if (!payload.mfaPending) return returnFunction(res, 400, false, 'Invalid challenge token.');

  const { ObjectId } = require('mongodb');
  const user = await findOne('users', { _id: new ObjectId(payload.userId) });
  if (!user || !user.mfaEnabled) return returnFunction(res, 401, false, 'Invalid request.');

  const valid = speakeasy.totp.verify({ secret: user.mfaSecret, encoding: 'base32', token: code, window: 1 });
  if (!valid) return returnFunction(res, 401, false, 'Invalid MFA code.');

  const { accessToken, refreshToken } = await _issueTokens(user);
  const { password: _pw, refreshTokenHash: _rh, mfaSecret: _ms, ...safeUser } = user;
  return returnFunction(res, 200, true, 'Login successful.', { token: accessToken, refreshToken, user: safeUser });
};

// ── Forgot Password ───────────────────────────────────────────────────────────
const forgotPassword = async (req, res) => {
  if (!validateRequiredFields(req, res, ['email'])) return;
  const user = await findOne('users', { email: req.body.email.toLowerCase().trim() });

  // Always return 200 to prevent user enumeration
  if (!user) return returnFunction(res, 200, true, 'If that email exists, a reset link has been sent.');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await updateOne('users', { _id: user._id }, {
    $set: { passwordResetToken: tokenHash, passwordResetExpires: expiresAt, updatedAt: new Date() },
  });

  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/en/reset-password?token=${rawToken}`;
  sendEmail({
    to: user.email,
    subject: `${COMPANY_NAME} — Password Reset`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;">
        <h2>Password Reset Request</h2>
        <p>Hi <strong>${user.name || 'there'}</strong>,</p>
        <p>Click the button below to reset your password. This link expires in <strong>1 hour</strong>.</p>
        <p style="margin:24px 0;">
          <a href="${resetUrl}" style="background:#0A1931;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Reset Password</a>
        </p>
        <p style="color:#888;font-size:12px;">If you didn't request this, ignore this email.</p>
      </div>
    `,
  }).catch(() => {});

  return returnFunction(res, 200, true, 'If that email exists, a reset link has been sent.');
};

// ── Reset Password ────────────────────────────────────────────────────────────
const resetPassword = async (req, res) => {
  if (!validateRequiredFields(req, res, ['token', 'newPassword'])) return;

  const { token, newPassword } = req.body;
  if (newPassword.length < 8) return returnFunction(res, 400, false, 'Password must be at least 8 characters.');

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = await findOne('users', {
    passwordResetToken:   tokenHash,
    passwordResetExpires: { $gt: new Date() },
  });

  if (!user) return returnFunction(res, 400, false, 'Reset link is invalid or has expired.');

  const hashed = await bcrypt.hash(newPassword, 12);
  await updateOne('users', { _id: user._id }, {
    $set:   { password: hashed, mustResetPassword: false, updatedAt: new Date() },
    $unset: { passwordResetToken: '', passwordResetExpires: '', refreshTokenHash: '', refreshTokenExpiresAt: '' },
  });

  return returnFunction(res, 200, true, 'Password reset successfully. Please log in.');
};

// ── MFA: Setup (generate secret + QR code) ───────────────────────────────────
const setupMfa = async (req, res) => {
  const user = await findOne('users', { _id: req.user._id });
  if (!user) return returnFunction(res, 404, false, 'User not found.');
  if (user.mfaEnabled) return returnFunction(res, 400, false, 'MFA is already enabled.');

  const secret = speakeasy.generateSecret({ name: `${COMPANY_NAME} (${user.email})`, length: 20 });

  await updateOne('users', { _id: user._id }, {
    $set: { mfaSecret: secret.base32, mfaEnabled: false, updatedAt: new Date() },
  });

  const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);
  return returnFunction(res, 200, true, 'Scan the QR code with your authenticator app, then verify with a code.', {
    qrCode: qrDataUrl,
    manualKey: secret.base32,
  });
};

// ── MFA: Verify + Activate ────────────────────────────────────────────────────
const verifyMfa = async (req, res) => {
  if (!validateRequiredFields(req, res, ['code'])) return;
  const user = await findOne('users', { _id: req.user._id });
  if (!user?.mfaSecret) return returnFunction(res, 400, false, 'MFA setup not started. Call /auth/mfa/setup first.');

  const valid = speakeasy.totp.verify({
    secret:   user.mfaSecret,
    encoding: 'base32',
    token:    req.body.code,
    window:   1,
  });

  if (!valid) return returnFunction(res, 401, false, 'Invalid code. Try again.');

  await updateOne('users', { _id: user._id }, { $set: { mfaEnabled: true, updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'MFA enabled successfully.');
};

// ── MFA: Disable ─────────────────────────────────────────────────────────────
const disableMfa = async (req, res) => {
  if (!validateRequiredFields(req, res, ['code'])) return;
  const user = await findOne('users', { _id: req.user._id });
  if (!user?.mfaEnabled) return returnFunction(res, 400, false, 'MFA is not enabled.');

  const valid = speakeasy.totp.verify({
    secret:   user.mfaSecret,
    encoding: 'base32',
    token:    req.body.code,
    window:   1,
  });
  if (!valid) return returnFunction(res, 401, false, 'Invalid code.');

  await updateOne('users', { _id: user._id }, {
    $set:   { mfaEnabled: false, updatedAt: new Date() },
    $unset: { mfaSecret: '' },
  });
  return returnFunction(res, 200, true, 'MFA disabled.');
};

module.exports = { login, register, refreshAccessToken, logout, forgotPassword, resetPassword, completeMfaLogin, setupMfa, verifyMfa, disableMfa };
