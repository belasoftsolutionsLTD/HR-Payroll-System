const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { listNotifications, getNotificationCount, markRead, markAllRead, dismissNotification } = require('./notificationFunctions');

const ALL = ['super_admin', 'hr_manager', 'department_head', 'staff'];

router.get('/count',    allowRoles(ALL), AsyncHandler(getNotificationCount));
router.put('/read-all', allowRoles(ALL), AsyncHandler(markAllRead));
router.get('/',         allowRoles(ALL), AsyncHandler(listNotifications));
router.put('/:id/read', allowRoles(ALL), AsyncHandler(markRead));
router.delete('/:id',   allowRoles(ALL), AsyncHandler(dismissNotification));

module.exports = router;
