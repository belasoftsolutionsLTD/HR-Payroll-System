const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listPositions, createPosition, updatePosition, deletePosition, patchPositionStatus,
  getDashboard,
  getOrgChart, getAllDocuments,
  getNotifications, markNotificationRead, markAllNotificationsRead,
} = require('./hrFunctions');

const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD } = require('../../constants/roles');

// Positions
router.get('/positions', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(listPositions));
router.post('/positions', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(createPosition));
router.put('/positions/:id', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(updatePosition));
router.patch('/positions/:id/status', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(patchPositionStatus));
router.delete('/positions/:id', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(deletePosition));

// Dashboard
router.get('/dashboard', allowRoles([SUPER_ADMIN, HR_MANAGER, DEPT_HEAD]), AsyncHandler(getDashboard));

// Org Chart
router.get('/org-chart', allowRoles([SUPER_ADMIN, HR_MANAGER, DEPT_HEAD]), AsyncHandler(getOrgChart));

// Documents (cross-employee document listing)
router.get('/documents', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(getAllDocuments));

// Notifications (any authenticated user sees own)
router.get('/notifications', AsyncHandler(getNotifications));
router.patch('/notifications/read-all', AsyncHandler(markAllNotificationsRead));
router.patch('/notifications/:id/read', AsyncHandler(markNotificationRead));

module.exports = router;
