const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  getEmployeePerformance, createAppraisal, updateAppraisal, getPerformanceAlerts,
  listGoals, createGoal, getGoal, updateGoal, deleteGoal, addCheckin, addGoalComment,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
  listCycles, createCycle, getCycle, updateCycle, launchCycle, closeCycle, assignPeerReviewers,
  listReviews, getReview, getMyReviewTasks, upsertReview, submitReview,
  getCalibration, updateCalibrationBox,
  listFeedback, giveFeedback, listAllFeedback, updateFeedbackVisibility,
  listOneOnOnes, createOneOnOne, getOneOnOne, updateOneOnOne, addOneOnOneAgendaItem, toggleOneOnOneAgendaItem, completeOneOnOne,
  listPIPs, createPIP, getPIP, updatePIP, addPIPCheckIn, closePIP,
  getEmployeePerformanceSnapshot,
  getAnalytics,
} = require('./performanceFunctions');

const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF } = require('../../constants/roles');
const MGMT  = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD];
const ALL   = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF];
const HR    = [SUPER_ADMIN, HR_MANAGER];

// ── Specific named routes first (before /:employeeId catch-all) ───────────────

// Analytics
router.get('/analytics',  allowRoles(MGMT), AsyncHandler(getAnalytics));

// Goals — create/edit/delete restricted to HR + dept head; staff can only view and check in
router.get('/goals',              allowRoles(ALL),  AsyncHandler(listGoals));
router.post('/goals',             allowRoles(MGMT), AsyncHandler(createGoal));
router.get('/goals/:id',          allowRoles(ALL),  AsyncHandler(getGoal));
router.put('/goals/:id',          allowRoles(MGMT), AsyncHandler(updateGoal));
router.delete('/goals/:id',       allowRoles(MGMT), AsyncHandler(deleteGoal));
router.post('/goals/:id/checkin', allowRoles(ALL),  AsyncHandler(addCheckin));
router.post('/goals/:id/comment', allowRoles(ALL),  AsyncHandler(addGoalComment));

// Review templates — read is open to all (reviewers need them to render a review form),
// authoring restricted to HR.
router.get('/templates',          allowRoles(ALL),  AsyncHandler(listTemplates));
router.post('/templates',         allowRoles(HR),   AsyncHandler(createTemplate));
router.get('/templates/:id',      allowRoles(ALL),  AsyncHandler(getTemplate));
router.put('/templates/:id',      allowRoles(HR),   AsyncHandler(updateTemplate));
router.delete('/templates/:id',   allowRoles(HR),   AsyncHandler(deleteTemplate));

// Review cycles
router.get('/cycles',             allowRoles(MGMT), AsyncHandler(listCycles));
router.post('/cycles',            allowRoles(HR),   AsyncHandler(createCycle));
router.get('/cycles/:id',         allowRoles(MGMT), AsyncHandler(getCycle));
router.put('/cycles/:id',         allowRoles(HR),   AsyncHandler(updateCycle));
router.post('/cycles/:id/launch', allowRoles(HR),   AsyncHandler(launchCycle));
router.post('/cycles/:id/close',  allowRoles(HR),   AsyncHandler(closeCycle));
router.put('/cycles/:id/participants/:employeeId/peers', allowRoles(HR), AsyncHandler(assignPeerReviewers));

// Reviews — /reviews/mine must be registered before /reviews/:id so it isn't swallowed
// by the param route.
router.get('/reviews',            allowRoles(ALL),  AsyncHandler(listReviews));
router.post('/reviews',           allowRoles(ALL),  AsyncHandler(upsertReview));
router.get('/reviews/mine',       allowRoles(ALL),  AsyncHandler(getMyReviewTasks));
router.get('/reviews/:id',        allowRoles(ALL),  AsyncHandler(getReview));
router.post('/reviews/:id/submit',allowRoles(ALL),  AsyncHandler(submitReview));

// Calibration (HR only)
router.get('/calibration/:cycleId',                        allowRoles(HR), AsyncHandler(getCalibration));
router.put('/calibration/:cycleId/employee/:empId',        allowRoles(HR), AsyncHandler(updateCalibrationBox));

// Feedback
router.get('/feedback/all',                allowRoles(HR),   AsyncHandler(listAllFeedback));
router.patch('/feedback/:id/visibility',   allowRoles(HR),   AsyncHandler(updateFeedbackVisibility));
router.get('/feedback',           allowRoles(ALL),  AsyncHandler(listFeedback));
router.post('/feedback',          allowRoles(ALL),  AsyncHandler(giveFeedback));

// 1-on-1 Check-ins — visibility is enforced inside each handler (participant-only), so ALL
// roles can hit these routes; a plain "staff" employee referenced as someone's managerId
// still needs to reach these to run their own 1-on-1s.
router.get('/one-on-ones',                      allowRoles(ALL), AsyncHandler(listOneOnOnes));
router.post('/one-on-ones',                     allowRoles(ALL), AsyncHandler(createOneOnOne));
router.get('/one-on-ones/:id',                  allowRoles(ALL), AsyncHandler(getOneOnOne));
router.put('/one-on-ones/:id',                  allowRoles(ALL), AsyncHandler(updateOneOnOne));
router.post('/one-on-ones/:id/agenda',          allowRoles(ALL), AsyncHandler(addOneOnOneAgendaItem));
router.patch('/one-on-ones/:id/agenda/:itemId', allowRoles(ALL), AsyncHandler(toggleOneOnOneAgendaItem));
router.post('/one-on-ones/:id/complete',        allowRoles(ALL), AsyncHandler(completeOneOnOne));

// Performance Improvement Plans — visibility enforced inside each handler (employee sees
// their own, manager/dept_head see their reports', HR sees all).
router.get('/pips',              allowRoles(ALL), AsyncHandler(listPIPs));
router.post('/pips',             allowRoles(ALL), AsyncHandler(createPIP));
router.get('/pips/:id',          allowRoles(ALL), AsyncHandler(getPIP));
router.put('/pips/:id',          allowRoles(ALL), AsyncHandler(updatePIP));
router.post('/pips/:id/checkin', allowRoles(ALL), AsyncHandler(addPIPCheckIn));
router.post('/pips/:id/close',   allowRoles(ALL), AsyncHandler(closePIP));

// Employee profile snapshot (before /:employeeId) — self, manager, dept_head, or HR
router.get('/snapshot/:employeeId', allowRoles(ALL), AsyncHandler(getEmployeePerformanceSnapshot));

// Alerts (before /:employeeId)
router.get('/alerts', allowRoles(MGMT), AsyncHandler(getPerformanceAlerts));

// ── Legacy appraisal routes (generic catch-all last) ─────────────────────────
router.get('/:employeeId', allowRoles(MGMT), AsyncHandler(getEmployeePerformance));
router.post('/',           allowRoles(MGMT), AsyncHandler(createAppraisal));
router.put('/:id',         allowRoles(MGMT), AsyncHandler(updateAppraisal));

module.exports = router;
