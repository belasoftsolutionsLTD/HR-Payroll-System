const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  getOrgChart, getAllDocuments,
} = require('./hrFunctions');

const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD } = require('../../constants/roles');

// Job requisitions now live in the recruitment module — see /api/recruitment/requisitions

// Org Chart
router.get('/org-chart', allowRoles([SUPER_ADMIN, HR_MANAGER, DEPT_HEAD]), AsyncHandler(getOrgChart));

// Documents (cross-employee document listing)
router.get('/documents', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(getAllDocuments));

// Notifications routes (getNotifications/markNotificationRead/markAllNotificationsRead)
// were removed in the Phase 10 cross-cutting sweep — dead Mongo code with zero frontend
// callers (see hrFunctions.js's header note). The live notification system is
// /api/notifications + /api/inbox.

module.exports = router;
