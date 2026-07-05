const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { scopeBodyToSelf } = require('../../middleware/ScopeMiddleware');
const {
  getLeaveBalances, listLeaveRequests, createLeaveRequest,
  approveLeaveRequest, rejectLeaveRequest, deleteLeaveRequest,
  revokeLeaveRequest, resolveDispute, getLeaveCalendar, getLeaveConflicts,
  getMyBalances, getCalendarEntries, getTodayAbsences, getUpcomingLeaves,
  cancelLeaveRequest, getLeaveRequest, exportLeaveRequests, adjustLeaveBalance,
  listPolicies, createPolicy, getPolicy, updatePolicy, deletePolicy, setDefaultPolicy,
  listHolidays, addHoliday, deleteHoliday, getLeaveAnalytics,
  runLeaveAccrual,
  listBlackouts, addBlackout, deleteBlackout,
  getLeaveConfig, updateLeaveConfig,
  runYearEndCarryForward,
} = require('./leaveFunctions');

const ALL  = ['super_admin', 'hr_manager', 'department_head', 'staff'];
const MGMT = ['super_admin', 'hr_manager', 'department_head'];
const HR   = ['super_admin', 'hr_manager'];

// ── Specific named routes BEFORE any /:param catch-alls ──────────────────────

// Balances
router.get('/balances/me',               allowRoles(ALL),  AsyncHandler(getMyBalances));
router.post('/balances/adjust',          allowRoles(HR),   AsyncHandler(adjustLeaveBalance));
router.get('/balances/:employeeId',      allowRoles(MGMT), AsyncHandler(getLeaveBalances));

// Requests — named sub-routes first
router.get('/requests/export',           allowRoles(MGMT), AsyncHandler(exportLeaveRequests));
router.get('/requests',                  allowRoles(ALL),  AsyncHandler(listLeaveRequests));
router.post('/requests',                 allowRoles(ALL),  scopeBodyToSelf, AsyncHandler(createLeaveRequest));
router.get('/requests/:id',              allowRoles(ALL),  AsyncHandler(getLeaveRequest));
router.put('/requests/:id/approve',      allowRoles(MGMT), AsyncHandler(approveLeaveRequest));
router.put('/requests/:id/decline',      allowRoles(MGMT), AsyncHandler(rejectLeaveRequest));
router.put('/requests/:id/cancel',       allowRoles(ALL),  AsyncHandler(cancelLeaveRequest));
router.put('/requests/:id/revoke',       allowRoles(MGMT), AsyncHandler(revokeLeaveRequest));
router.put('/requests/:id/resolve-dispute', allowRoles(HR), AsyncHandler(resolveDispute));
router.delete('/requests/:id',           allowRoles(HR),   AsyncHandler(deleteLeaveRequest));
// Legacy PATCH (backwards compat with existing frontend)
router.patch('/requests/:id/approve',         allowRoles(MGMT), AsyncHandler(approveLeaveRequest));
router.patch('/requests/:id/reject',          allowRoles(MGMT), AsyncHandler(rejectLeaveRequest));
router.patch('/requests/:id/revoke',          allowRoles(MGMT), AsyncHandler(revokeLeaveRequest));
router.patch('/requests/:id/resolve-dispute', allowRoles(HR),   AsyncHandler(resolveDispute));

// Calendar & overview
router.get('/calendar/entries',          allowRoles(ALL),  AsyncHandler(getCalendarEntries));
router.get('/calendar',                  allowRoles(ALL),  AsyncHandler(getLeaveCalendar));
router.get('/conflicts',                 allowRoles(ALL),  AsyncHandler(getLeaveConflicts));
router.get('/today-absences',            allowRoles(MGMT), AsyncHandler(getTodayAbsences));
router.get('/upcoming',                  allowRoles(ALL),  AsyncHandler(getUpcomingLeaves));

// Policies
router.get('/policies',                  allowRoles(HR),   AsyncHandler(listPolicies));
router.post('/policies',                 allowRoles(HR),   AsyncHandler(createPolicy));
router.get('/policies/:id',              allowRoles(HR),   AsyncHandler(getPolicy));
router.put('/policies/:id',              allowRoles(HR),   AsyncHandler(updatePolicy));
router.delete('/policies/:id',           allowRoles(HR),   AsyncHandler(deletePolicy));
router.post('/policies/:id/set-default', allowRoles(HR),   AsyncHandler(setDefaultPolicy));

// Public holidays
router.get('/holidays',                  allowRoles(ALL),  AsyncHandler(listHolidays));
router.post('/holidays',                 allowRoles(HR),   AsyncHandler(addHoliday));
router.delete('/holidays/:id',           allowRoles(HR),   AsyncHandler(deleteHoliday));

// Analytics
router.get('/analytics',                 allowRoles(MGMT), AsyncHandler(getLeaveAnalytics));

// Monthly accrual (HR-only, safe to call multiple times — idempotent per month)
router.post('/accrual/run',              allowRoles(HR),   AsyncHandler(runLeaveAccrual));

// Blackout periods
router.get('/blackouts',                 allowRoles(ALL),  AsyncHandler(listBlackouts));
router.post('/blackouts',                allowRoles(HR),   AsyncHandler(addBlackout));
router.delete('/blackouts/:id',          allowRoles(HR),   AsyncHandler(deleteBlackout));

// Leave config (min notice days per leave type, etc.)
router.get('/config',                    allowRoles(ALL),  AsyncHandler(getLeaveConfig));
router.patch('/config',                  allowRoles(HR),   AsyncHandler(updateLeaveConfig));

// Year-end carry-forward
router.post('/year-end/carry-forward',   allowRoles(HR),   AsyncHandler(runYearEndCarryForward));

module.exports = router;
