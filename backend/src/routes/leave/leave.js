const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  getLeaveBalances, listLeaveRequests, createLeaveRequest,
  approveLeaveRequest, rejectLeaveRequest,
  deleteLeaveRequest, revokeLeaveRequest, resolveDispute,
  getLeaveCalendar, getLeaveConflicts,
} = require('./leaveFunctions');

const { HR_ROLES } = require('../../constants/roles');
const hrOnly = allowRoles(HR_ROLES);

router.get('/balances/:employeeId', AsyncHandler(getLeaveBalances));
router.get('/requests', AsyncHandler(listLeaveRequests));
router.post('/requests', AsyncHandler(createLeaveRequest));
router.patch('/requests/:id/approve',         hrOnly, AsyncHandler(approveLeaveRequest));
router.patch('/requests/:id/reject',          hrOnly, AsyncHandler(rejectLeaveRequest));
router.patch('/requests/:id/revoke',          hrOnly, AsyncHandler(revokeLeaveRequest));
router.patch('/requests/:id/resolve-dispute', hrOnly, AsyncHandler(resolveDispute));
router.delete('/requests/:id',                hrOnly, AsyncHandler(deleteLeaveRequest));
router.get('/calendar', AsyncHandler(getLeaveCalendar));
router.get('/conflicts', AsyncHandler(getLeaveConflicts));

module.exports = router;
