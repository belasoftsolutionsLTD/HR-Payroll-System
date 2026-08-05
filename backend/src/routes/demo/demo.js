const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { decodeToken, getUserData } = require('../../middleware/AuthMiddleware');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { authLimiter } = require('../../middleware/RateLimitMiddleware');
const { GUEST } = require('../../constants/roles');
const { demoLogin, getDemoPipeline } = require('./demoFunctions');

// Public — issues a short-lived guest token, no credentials required.
router.post('/login', authLimiter, AsyncHandler(demoLogin));

// Guest-only from here on. GUEST is deliberately absent from every other allowRoles()
// list in the app, so this token is useless anywhere outside /api/demo.
router.get('/pipeline', decodeToken, getUserData, allowRoles([GUEST]), AsyncHandler(getDemoPipeline));

module.exports = router;
