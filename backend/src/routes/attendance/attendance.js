const express = require('express');
const router = express.Router();
const multer = require('multer');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { listAttendance, markAttendance, bulkImportAttendance, getAbsenceAlerts, clockIn, clockOut, getTodayStatus, getMyRecords } = require('./attendanceFunctions');

const SUPER_ADMIN = 'super_admin';
const HR_MANAGER = 'hr_manager';
const ALL_ROLES   = [SUPER_ADMIN, HR_MANAGER, 'staff', 'department_head'];

const upload = multer({ dest: process.env.UPLOAD_DIR || 'uploads' });

// Self-service (all authenticated roles)
router.get('/today-status', allowRoles(ALL_ROLES), AsyncHandler(getTodayStatus));
router.get('/my-records',   allowRoles(ALL_ROLES), AsyncHandler(getMyRecords));
router.post('/clock-in',    allowRoles(ALL_ROLES), AsyncHandler(clockIn));
router.post('/clock-out',   allowRoles(ALL_ROLES), AsyncHandler(clockOut));

// HR-only
router.get('/', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(listAttendance));
router.post('/', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(markAttendance));
router.post('/bulk', allowRoles([SUPER_ADMIN, HR_MANAGER]), upload.single('csv'), AsyncHandler(bulkImportAttendance));
router.get('/alerts', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(getAbsenceAlerts));

module.exports = router;
