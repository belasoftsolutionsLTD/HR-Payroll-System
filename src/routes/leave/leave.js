const express = require('express');
const router = express.Router();
const multer = require('multer');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, MGMT_ROLES, ALL_ROLES } = require('../../constants/roles');
const {
  createLeaveType, listLeaveTypes, getLeaveType, updateLeaveType, deleteLeaveType,
  createPublicHoliday, listPublicHolidays, updatePublicHoliday, deletePublicHoliday,
  createAccrualPolicy, listAccrualPolicies, getAccrualPolicy, updateAccrualPolicy, deleteAccrualPolicy,
  runAccrualPolicies, runYearEndCarryForward,
  getLeaveBalances, getEmployeeLeaveBalances, adjustLeaveBalance,
  listLeaveRequests, getLeaveRequest, createLeaveRequest, updateMyDraftRequest,
  approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
  revokeLeaveRequest, disputeLeaveRequest, resolveDispute,
  getLeaveCalendar, getPayrollFeed, markPayrollFeedProcessed, getLeaveAnalytics,
  listBlackouts, addBlackout, deleteBlackout,
  getMyLeaveTypeOptions, getMyBalances, getMyRequests, getMyRequestDetail, uploadMyAttachment, getMyCalendar,
} = require('./leaveFunctions');

const hrOnly = allowRoles(HR_ROLES);
const mgmtOnly = allowRoles(MGMT_ROLES);
const allRoles = allowRoles(ALL_ROLES);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
    filename: (req, file, cb) => cb(null, `leave-attachment-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Leave Types — HR only ───────────────────────────────────────────────────────
router.post('/types',       hrOnly, AsyncHandler(createLeaveType));
router.get('/types',        hrOnly, AsyncHandler(listLeaveTypes));
router.get('/types/:id',    hrOnly, AsyncHandler(getLeaveType));
router.patch('/types/:id',  hrOnly, AsyncHandler(updateLeaveType));
router.delete('/types/:id', hrOnly, AsyncHandler(deleteLeaveType));

// ── Accrual Policies — HR only ──────────────────────────────────────────────────
router.post('/accrual-policies',       hrOnly, AsyncHandler(createAccrualPolicy));
router.get('/accrual-policies',        hrOnly, AsyncHandler(listAccrualPolicies));
router.post('/accrual-policies/run',   hrOnly, AsyncHandler(runAccrualPolicies));
router.get('/accrual-policies/:id',    hrOnly, AsyncHandler(getAccrualPolicy));
router.patch('/accrual-policies/:id',  hrOnly, AsyncHandler(updateAccrualPolicy));
router.delete('/accrual-policies/:id', hrOnly, AsyncHandler(deleteAccrualPolicy));
router.post('/year-end/carry-forward', hrOnly, AsyncHandler(runYearEndCarryForward));

// ── Employee self-service (own record only) — declared before /requests/:id ───
router.get('/my/leave-types',           allRoles, AsyncHandler(getMyLeaveTypeOptions));
router.get('/my/balances',              allRoles, AsyncHandler(getMyBalances));
router.get('/my/requests',              allRoles, AsyncHandler(getMyRequests));
router.get('/my/requests/:id',          allRoles, AsyncHandler(getMyRequestDetail));
router.post('/my/requests',             allRoles, AsyncHandler(createLeaveRequest));
router.patch('/my/requests/:id',        allRoles, AsyncHandler(updateMyDraftRequest));
router.delete('/my/requests/:id',       allRoles, AsyncHandler(cancelLeaveRequest));
router.post('/my/requests/:id/attachment', allRoles, upload.single('file'), AsyncHandler(uploadMyAttachment));
router.post('/my/requests/:id/dispute', allRoles, AsyncHandler(disputeLeaveRequest));
router.get('/my/calendar',              allRoles, AsyncHandler(getMyCalendar));

// ── Leave Balances — scoped by role ─────────────────────────────────────────────
router.get('/balances',              allRoles, AsyncHandler(getLeaveBalances));
router.patch('/balances/:id/adjust', hrOnly, AsyncHandler(adjustLeaveBalance));
// scoping (including staff-role managers via employees.managerId) is enforced inside the handler
router.get('/balances/:employeeId',  allRoles, AsyncHandler(getEmployeeLeaveBalances));

// ── Leave Requests — HR/manager views, role-scoped inside handlers ─────────────
router.get('/requests',                    allRoles, AsyncHandler(listLeaveRequests));
router.get('/requests/:id',                allRoles, AsyncHandler(getLeaveRequest));
// approve/reject use allRoles at the route level because a Level 1 approver is
// often a plain "staff" user acting as a manager via employees.managerId — the
// fine-grained check (current approval step's approverId, or HR override) lives
// inside approveLeaveRequest/rejectLeaveRequest themselves.
router.patch('/requests/:id/approve',      allRoles, AsyncHandler(approveLeaveRequest));
router.patch('/requests/:id/reject',       allRoles, AsyncHandler(rejectLeaveRequest));
router.patch('/requests/:id/cancel',       allRoles, AsyncHandler(cancelLeaveRequest));
router.patch('/requests/:id/revoke',       hrOnly, AsyncHandler(revokeLeaveRequest));
router.patch('/requests/:id/resolve-dispute', hrOnly, AsyncHandler(resolveDispute));

// ── Public Holidays — HR manages, all roles can view ────────────────────────────
router.post('/public-holidays',       hrOnly, AsyncHandler(createPublicHoliday));
router.get('/public-holidays',        allRoles, AsyncHandler(listPublicHolidays));
router.patch('/public-holidays/:id',  hrOnly, AsyncHandler(updatePublicHoliday));
router.delete('/public-holidays/:id', hrOnly, AsyncHandler(deletePublicHoliday));

// ── Blackout Periods — bonus feature, HR manages ────────────────────────────────
router.get('/blackouts',        allRoles, AsyncHandler(listBlackouts));
router.post('/blackouts',       hrOnly, AsyncHandler(addBlackout));
router.delete('/blackouts/:id', hrOnly, AsyncHandler(deleteBlackout));

// ── Team Calendar — scoped by role ──────────────────────────────────────────────
router.get('/calendar', allRoles, AsyncHandler(getLeaveCalendar));

// ── Payroll Integration ──────────────────────────────────────────────────────────
router.get('/payroll-feed',       hrOnly, AsyncHandler(getPayrollFeed));
router.post('/payroll-feed/mark', hrOnly, AsyncHandler(markPayrollFeedProcessed));

// ── Analytics — scoped by role ──────────────────────────────────────────────────
router.get('/analytics', mgmtOnly, AsyncHandler(getLeaveAnalytics));

module.exports = router;
