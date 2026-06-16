const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  getOverviewReport, getAttendanceReport, getPayrollReport,
  getLeaveReport, getRecruitmentReport, getOnboardingReport, getPerformanceReport,
} = require('./reportFunctions');

const HR = ['super_admin', 'hr_manager'];

router.get('/reports/overview',    allowRoles(HR), AsyncHandler(getOverviewReport));
router.get('/reports/attendance',  allowRoles(HR), AsyncHandler(getAttendanceReport));
router.get('/reports/payroll',     allowRoles(HR), AsyncHandler(getPayrollReport));
router.get('/reports/leave',       allowRoles(HR), AsyncHandler(getLeaveReport));
router.get('/reports/recruitment', allowRoles(HR), AsyncHandler(getRecruitmentReport));
router.get('/reports/onboarding',  allowRoles(HR), AsyncHandler(getOnboardingReport));
router.get('/reports/performance', allowRoles(HR), AsyncHandler(getPerformanceReport));

module.exports = router;
