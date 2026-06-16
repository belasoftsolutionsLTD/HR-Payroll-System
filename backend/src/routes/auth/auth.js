const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { decodeToken, getUserData } = require('../../middleware/AuthMiddleware');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, ALL_ROLES } = require('../../constants/roles');
const { login, register } = require('./authFunctions');
const { listAccounts, createAccount, updateAccount, adminResetPassword, changeOwnPassword } = require('./accountFunctions');

// ── Public ─────────────────────────────────────────────────────────────────────
router.post('/login', AsyncHandler(login));
router.post('/register', AsyncHandler(register));

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
