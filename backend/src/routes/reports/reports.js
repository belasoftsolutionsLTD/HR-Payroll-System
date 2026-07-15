const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES } = require('../../constants/roles');
const {
  getExecutiveDashboard, getExecutiveTrends,
  getHeadcountAnalytics, getTurnoverAnalytics, getTenureAnalytics, getDemographicsAnalytics, getWorkforceMovement,
  getPayrollAnalytics, getPayrollBreakdown, getPayrollOvertimeCost, getExpenseClaimsAnalytics,
  getLeaveAnalytics, getLeaveLiabilityReport, getAbsenteeismAnalytics, getLeavePatterns,
  getAttendanceSummary, getOvertimeAnalytics, getLateArrivalsAnalytics,
  getPerformanceAnalytics, getPerformanceGoalsReport, getPerformanceFeedbackReport, getPipReport,
  getRecruitmentPipeline, getSourceEffectiveness, getRecruitmentFunnel,
  getTrainingCompletionByDept, getComplianceReport, getTrainingEngagement,
  getProcurementSpend, getVendorAnalytics, getSpendPending,
  getAttritionRiskInsight, getCostPerEmployeeInsight, getDepartmentHealthInsight, getManagerEffectivenessInsight,
  buildCustomReport, listCustomReports, runSavedCustomReport, scheduleCustomReport, deleteCustomReport,
  exportReport,
  getAwardsReport, getITAssetsReport,
} = require('./reportFunctions');

// Scoped to '/reports' — this router is mounted at the shared bare '/api' prefix
// (app.js), so an unscoped router.use() here would intercept every request that
// reaches this router in the chain (e.g. /api/expense-claims, /api/notifications,
// /api/finance/*), rejecting non-HR staff before it ever reaches its real handler.
router.use('/reports', allowRoles(HR_ROLES));

// Executive Dashboard
router.get('/reports/executive',        AsyncHandler(getExecutiveDashboard));
router.get('/reports/executive/trends', AsyncHandler(getExecutiveTrends));

// Workforce
router.get('/reports/workforce/headcount',    AsyncHandler(getHeadcountAnalytics));
router.get('/reports/workforce/turnover',     AsyncHandler(getTurnoverAnalytics));
router.get('/reports/workforce/tenure',       AsyncHandler(getTenureAnalytics));
router.get('/reports/workforce/demographics', AsyncHandler(getDemographicsAnalytics));
router.get('/reports/workforce/movement',     AsyncHandler(getWorkforceMovement));

// Payroll
router.get('/reports/payroll/summary',   AsyncHandler(getPayrollAnalytics));
router.get('/reports/payroll/breakdown', AsyncHandler(getPayrollBreakdown));
router.get('/reports/payroll/overtime',  AsyncHandler(getPayrollOvertimeCost));
router.get('/reports/payroll/expenses',  AsyncHandler(getExpenseClaimsAnalytics));

// Leave
router.get('/reports/leave/summary',      AsyncHandler(getLeaveAnalytics));
router.get('/reports/leave/liability',    AsyncHandler(getLeaveLiabilityReport));
router.get('/reports/leave/absenteeism',  AsyncHandler(getAbsenteeismAnalytics));
router.get('/reports/leave/patterns',     AsyncHandler(getLeavePatterns));

// Attendance
router.get('/reports/attendance/summary',     AsyncHandler(getAttendanceSummary));
router.get('/reports/attendance/overtime',    AsyncHandler(getOvertimeAnalytics));
router.get('/reports/attendance/punctuality', AsyncHandler(getLateArrivalsAnalytics));

// Performance
router.get('/reports/performance/ratings',  AsyncHandler(getPerformanceAnalytics));
router.get('/reports/performance/goals',    AsyncHandler(getPerformanceGoalsReport));
router.get('/reports/performance/feedback', AsyncHandler(getPerformanceFeedbackReport));
router.get('/reports/performance/pip',      AsyncHandler(getPipReport));

// Recruitment
router.get('/reports/recruitment/pipeline', AsyncHandler(getRecruitmentPipeline));
router.get('/reports/recruitment/source',   AsyncHandler(getSourceEffectiveness));
router.get('/reports/recruitment/funnel',   AsyncHandler(getRecruitmentFunnel));

// Training
router.get('/reports/training/completion', AsyncHandler(getTrainingCompletionByDept));
router.get('/reports/training/compliance', AsyncHandler(getComplianceReport));
router.get('/reports/training/engagement', AsyncHandler(getTrainingEngagement));

// Spend
router.get('/reports/spend/expenses',    AsyncHandler(getExpenseClaimsAnalytics));
router.get('/reports/spend/procurement', AsyncHandler(getProcurementSpend));
router.get('/reports/spend/vendors',     AsyncHandler(getVendorAnalytics));
router.get('/reports/spend/pending',     AsyncHandler(getSpendPending));

// Cross-Module Insights
router.get('/reports/insights/attrition-risk',        AsyncHandler(getAttritionRiskInsight));
router.get('/reports/insights/cost-per-employee',     AsyncHandler(getCostPerEmployeeInsight));
router.get('/reports/insights/dept-health',           AsyncHandler(getDepartmentHealthInsight));
router.get('/reports/insights/manager-effectiveness', AsyncHandler(getManagerEffectivenessInsight));

// Custom Report Builder
router.post('/reports/custom/build',        AsyncHandler(buildCustomReport));
router.get('/reports/custom',               AsyncHandler(listCustomReports));
router.get('/reports/custom/:id/run',       AsyncHandler(runSavedCustomReport));
router.post('/reports/custom/:id/schedule', AsyncHandler(scheduleCustomReport));
router.delete('/reports/custom/:id',        AsyncHandler(deleteCustomReport));

// Export
router.post('/reports/export', AsyncHandler(exportReport));

// Legacy (kept — not covered by the new spec, no duplication concern found for these)
router.get('/reports/awards',    AsyncHandler(getAwardsReport));
router.get('/reports/it-assets', AsyncHandler(getITAssetsReport));

module.exports = router;
