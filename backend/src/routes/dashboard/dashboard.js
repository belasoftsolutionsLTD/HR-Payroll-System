const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  getDashboardSummary, getFeedPreview, getUpcomingEvents,
  getCelebrations, getLiveAttendance, getPendingActions,
  getTodaySchedule, getGoalsSummary,
} = require('./dashboardFunctions');

const ALL  = ['super_admin', 'hr_manager', 'department_head', 'staff'];
const HR   = ['super_admin', 'hr_manager'];

router.get('/summary',          allowRoles(ALL), AsyncHandler(getDashboardSummary));
router.get('/feed-preview',     allowRoles(ALL), AsyncHandler(getFeedPreview));
router.get('/upcoming-events',  allowRoles(ALL), AsyncHandler(getUpcomingEvents));
router.get('/celebrations',     allowRoles(ALL), AsyncHandler(getCelebrations));
router.get('/attendance-live',  allowRoles(HR),  AsyncHandler(getLiveAttendance));
router.get('/pending-actions',  allowRoles(ALL), AsyncHandler(getPendingActions));
router.get('/today-schedule',   allowRoles(ALL), AsyncHandler(getTodaySchedule));
router.get('/goals-summary',    allowRoles(ALL), AsyncHandler(getGoalsSummary));

module.exports = router;
