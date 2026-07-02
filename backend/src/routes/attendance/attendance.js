const express = require('express');
const router = express.Router();
const multer = require('multer');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { scopeBodyToSelf } = require('../../middleware/ScopeMiddleware');
const {
  listAttendance, markAttendance, bulkImportAttendance, getAbsenceAlerts,
  clockIn, clockOut, getTodayStatus, getMyRecords,
  breakStart, breakEnd,
  getTeamStatus,
  getTimesheets, getCurrentTimesheet, saveTimesheet, submitTimesheet, approveTimesheet, rejectTimesheet,
  getShifts, createShift, updateShift, deleteShift,
  getMyShifts, getOpenShifts, applyForShift, getShiftApplications, resolveShiftApplication, getMyShiftApplications,
  getAttendanceReport, getAttendanceStats,
  getSettings, saveSettings, getSchedules, createSchedule, updateSchedule, deleteSchedule,
  bulkCreateShifts,
} = require('./attendanceFunctions');

const MGMT     = ['super_admin', 'hr_manager', 'department_head'];
const ALL      = ['super_admin', 'hr_manager', 'department_head', 'staff'];

const upload = multer({ dest: process.env.UPLOAD_DIR || 'uploads' });

// ── Self-service (all roles) ──────────────────────────────────────────────────
router.get('/today-status',      allowRoles(ALL),  AsyncHandler(getTodayStatus));
router.get('/my-records',        allowRoles(ALL),  AsyncHandler(getMyRecords));
router.post('/clock-in',         allowRoles(ALL),  AsyncHandler(clockIn));
router.post('/clock-out',        allowRoles(ALL),  AsyncHandler(clockOut));
router.post('/break-start',      allowRoles(ALL),  AsyncHandler(breakStart));
router.post('/break-end',        allowRoles(ALL),  AsyncHandler(breakEnd));

// ── Timesheets ────────────────────────────────────────────────────────────────
router.get('/timesheets',        allowRoles(ALL),  AsyncHandler(getTimesheets));
router.get('/timesheets/current',allowRoles(ALL),  AsyncHandler(getCurrentTimesheet));
router.post('/timesheets',       allowRoles(ALL),  scopeBodyToSelf, AsyncHandler(saveTimesheet));
router.put('/timesheets/:id/submit',  allowRoles(ALL),  AsyncHandler(submitTimesheet));
router.put('/timesheets/:id/approve', allowRoles(MGMT), AsyncHandler(approveTimesheet));
router.put('/timesheets/:id/reject',  allowRoles(MGMT), AsyncHandler(rejectTimesheet));

// ── Shifts ────────────────────────────────────────────────────────────────────
// specific paths before :id to avoid conflicts
router.get('/shifts/my',                   allowRoles(ALL),  AsyncHandler(getMyShifts));
router.get('/shifts/open',                 allowRoles(ALL),  AsyncHandler(getOpenShifts));
router.get('/shifts/my-applications',      allowRoles(ALL),  AsyncHandler(getMyShiftApplications));
router.get('/shifts/applications',         allowRoles(MGMT), AsyncHandler(getShiftApplications));
router.put('/shifts/applications/:id',     allowRoles(MGMT), AsyncHandler(resolveShiftApplication));
router.post('/shifts/:id/apply',           allowRoles(ALL),  AsyncHandler(applyForShift));
router.get('/shifts',            allowRoles(ALL),  AsyncHandler(getShifts));
router.post('/shifts',           allowRoles(MGMT), AsyncHandler(createShift));
router.post('/shifts/bulk',      allowRoles(MGMT), AsyncHandler(bulkCreateShifts));
router.put('/shifts/:id',        allowRoles(MGMT), AsyncHandler(updateShift));
router.delete('/shifts/:id',     allowRoles(MGMT), AsyncHandler(deleteShift));

// ── HR / Management ───────────────────────────────────────────────────────────
router.get('/team-status',       allowRoles(MGMT), AsyncHandler(getTeamStatus));
router.get('/report',            allowRoles(MGMT), AsyncHandler(getAttendanceReport));
router.get('/stats',             allowRoles(MGMT), AsyncHandler(getAttendanceStats));
router.get('/alerts',            allowRoles(MGMT), AsyncHandler(getAbsenceAlerts));

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings',          allowRoles(MGMT), AsyncHandler(getSettings));
router.put('/settings',          allowRoles(['super_admin', 'hr_manager']), AsyncHandler(saveSettings));
router.get('/schedules',         allowRoles(MGMT), AsyncHandler(getSchedules));
router.post('/schedules',        allowRoles(['super_admin', 'hr_manager']), AsyncHandler(createSchedule));
router.put('/schedules/:id',     allowRoles(['super_admin', 'hr_manager']), AsyncHandler(updateSchedule));
router.delete('/schedules/:id',  allowRoles(['super_admin', 'hr_manager']), AsyncHandler(deleteSchedule));

// ── CRUD (HR) ─────────────────────────────────────────────────────────────────
router.get('/',                  allowRoles(MGMT), AsyncHandler(listAttendance));
router.post('/',                 allowRoles(MGMT), AsyncHandler(markAttendance));
router.post('/bulk', allowRoles(['super_admin', 'hr_manager']), upload.single('csv'), AsyncHandler(bulkImportAttendance));

module.exports = router;
