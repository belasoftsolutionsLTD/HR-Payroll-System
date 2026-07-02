const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { decodeToken, getUserData } = require('../../middleware/AuthMiddleware');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, ALL_ROLES } = require('../../constants/roles');
const { login, register, refreshAccessToken, logout, forgotPassword, resetPassword, completeMfaLogin, setupMfa, verifyMfa, disableMfa } = require('./authFunctions');
const { listAccounts, createAccount, updateAccount, adminResetPassword, changeOwnPassword } = require('./accountFunctions');

// 5 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
});

// ── Public ─────────────────────────────────────────────────────────────────────
router.post('/login',           loginLimiter, AsyncHandler(login));
router.post('/register',                      AsyncHandler(register));
router.post('/refresh',                       AsyncHandler(refreshAccessToken));
router.post('/mfa/complete',   loginLimiter,  AsyncHandler(completeMfaLogin));
router.post('/forgot-password', loginLimiter, AsyncHandler(forgotPassword));
router.post('/reset-password',                AsyncHandler(resetPassword));

// ── Authenticated ──────────────────────────────────────────────────────────────
router.post('/logout',     decodeToken, getUserData, AsyncHandler(logout));
router.post('/mfa/setup',  decodeToken, getUserData, AsyncHandler(setupMfa));
router.post('/mfa/verify', decodeToken, getUserData, AsyncHandler(verifyMfa));
router.delete('/mfa',      decodeToken, getUserData, AsyncHandler(disableMfa));

// ── Account management (HR only) ───────────────────────────────────────────────
router.get(
  '/accounts',
  decodeToken, getUserData, allowRoles(HR_ROLES),
  AsyncHandler(listAccounts),
);

router.post(
  '/accounts',
  decodeToken, getUserData, allowRoles(HR_ROLES),
  AsyncHandler(createAccount),
);

router.patch(
  '/accounts/:id',
  decodeToken, getUserData, allowRoles(HR_ROLES),
  AsyncHandler(updateAccount),
);

router.patch(
  '/accounts/:id/reset-password',
  decodeToken, getUserData, allowRoles(HR_ROLES),
  AsyncHandler(adminResetPassword),
);

// ── Self-service (any authenticated role) ─────────────────────────────────────
router.patch(
  '/me/password',
  decodeToken, getUserData, allowRoles(ALL_ROLES),
  AsyncHandler(changeOwnPassword),
);

module.exports = router;
