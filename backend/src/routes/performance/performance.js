const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  getEmployeePerformance, createAppraisal, updateAppraisal, getPerformanceAlerts,
  listGoals, createGoal, getGoal, updateGoal, deleteGoal, addCheckin, addGoalComment,
  listCycles, createCycle, getCycle, updateCycle, launchCycle, closeCycle,
  listReviews, getReview, upsertReview, submitReview,
  getCalibration, updateCalibrationBox,
  listFeedback, giveFeedback,
  getAnalytics,
} = require('./performanceFunctions');

const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF } = require('../../constants/roles');
const MGMT  = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD];
const ALL   = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF];
const HR    = [SUPER_ADMIN, HR_MANAGER];

// ── Specific named routes first (before /:employeeId catch-all) ───────────────

// Analytics
router.get('/analytics',  allowRoles(MGMT), AsyncHandler(getAnalytics));

// Goals
router.get('/goals',              allowRoles(ALL),  AsyncHandler(listGoals));
router.post('/goals',             allowRoles(ALL),  AsyncHandler(createGoal));
router.get('/goals/:id',          allowRoles(ALL),  AsyncHandler(getGoal));
router.put('/goals/:id',          allowRoles(ALL),  AsyncHandler(updateGoal));
router.delete('/goals/:id',       allowRoles(ALL),  AsyncHandler(deleteGoal));
router.post('/goals/:id/checkin', allowRoles(ALL),  AsyncHandler(addCheckin));
router.post('/goals/:id/comment', allowRoles(ALL),  AsyncHandler(addGoalComment));

// Review cycles
router.get('/cycles',             allowRoles(MGMT), AsyncHandler(listCycles));
router.post('/cycles',            allowRoles(HR),   AsyncHandler(createCycle));
router.get('/cycles/:id',         allowRoles(MGMT), AsyncHandler(getCycle));
router.put('/cycles/:id',         allowRoles(HR),   AsyncHandler(updateCycle));
router.post('/cycles/:id/launch', allowRoles(HR),   AsyncHandler(launchCycle));
router.post('/cycles/:id/close',  allowRoles(HR),   AsyncHandler(closeCycle));

// Reviews
router.get('/reviews',            allowRoles(ALL),  AsyncHandler(listReviews));
router.post('/reviews',           allowRoles(ALL),  AsyncHandler(upsertReview));
router.get('/reviews/:id',        allowRoles(ALL),  AsyncHandler(getReview));
router.post('/reviews/:id/submit',allowRoles(ALL),  AsyncHandler(submitReview));

// Calibration (HR only)
router.get('/calibration/:cycleId',                        allowRoles(HR), AsyncHandler(getCalibration));
router.put('/calibration/:cycleId/employee/:empId',        allowRoles(HR), AsyncHandler(updateCalibrationBox));

// Feedback
router.get('/feedback',           allowRoles(ALL),  AsyncHandler(listFeedback));
router.post('/feedback',          allowRoles(ALL),  AsyncHandler(giveFeedback));

// Alerts (before /:employeeId)
router.get('/alerts', allowRoles(MGMT), AsyncHandler(getPerformanceAlerts));

// ── Legacy appraisal routes (generic catch-all last) ─────────────────────────
router.get('/:employeeId', allowRoles(MGMT), AsyncHandler(getEmployeePerformance));
router.post('/',           allowRoles(MGMT), AsyncHandler(createAppraisal));
router.put('/:id',         allowRoles(MGMT), AsyncHandler(updateAppraisal));

module.exports = router;
