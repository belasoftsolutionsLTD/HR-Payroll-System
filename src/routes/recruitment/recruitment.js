const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  createRequisition, listRequisitions, getRequisition, updateRequisition,
  submitRequisition, approveRequisition, deleteRequisition,
  listApplicationsForRequisition, moveApplicationStage, updateApplicationStatus,
  extendOffer, respondToOffer,
  assignInterviewer, unassignInterviewer,
  submitScorecard, listScorecardsForApplication, getScorecard,
  createCandidate, listCandidates, getCandidate, updateCandidate, convertCandidate,
  createNurtureCampaign, listNurtureCampaigns, addNurtureTouchpoint, listNurtureCandidates,
  getRecruitmentOverview, getRequisitionFunnel, getTimeToFill, getTimeInStage,
  getSourceEffectiveness, getOfferAcceptanceRate,
  createInterviewKit, listInterviewKits, updateInterviewKit, deleteInterviewKit,
  createEmailTemplate, listEmailTemplates, updateEmailTemplate, deleteEmailTemplate,
} = require('./recruitmentFunctions');

const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD } = require('../../constants/roles');
const MGMT = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD];

// ── Requisitions ───────────────────────────────────────────────────────────────
router.post('/requisitions',                allowRoles(MGMT), AsyncHandler(createRequisition));
router.get('/requisitions',                 allowRoles(MGMT), AsyncHandler(listRequisitions));
router.get('/requisitions/:id',             allowRoles(MGMT), AsyncHandler(getRequisition));
router.patch('/requisitions/:id',           allowRoles(MGMT), AsyncHandler(updateRequisition));
router.post('/requisitions/:id/submit',     allowRoles(MGMT), AsyncHandler(submitRequisition));
router.post('/requisitions/:id/approve',    allowRoles(MGMT), AsyncHandler(approveRequisition));
router.delete('/requisitions/:id',          allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(deleteRequisition));

// ── Applications / Pipeline ──────────────────────────────────────────────────────
router.get('/requisitions/:id/applications', allowRoles(MGMT), AsyncHandler(listApplicationsForRequisition));
router.patch('/applications/:id/stage',       allowRoles(MGMT), AsyncHandler(moveApplicationStage));
router.patch('/applications/:id/status',      allowRoles(MGMT), AsyncHandler(updateApplicationStatus));
router.post('/applications/:id/offer',        allowRoles(MGMT), AsyncHandler(extendOffer));
router.patch('/applications/:id/offer',       allowRoles(MGMT), AsyncHandler(respondToOffer));

// ── Interviewer assignments ───────────────────────────────────────────────────
router.post('/applications/:id/interviewers',                          allowRoles(MGMT), AsyncHandler(assignInterviewer));
router.delete('/applications/:id/interviewers/:stageId/:interviewerId', allowRoles(MGMT), AsyncHandler(unassignInterviewer));

// ── Scorecards ────────────────────────────────────────────────────────────────
router.post('/applications/:id/scorecards',   allowRoles(MGMT), AsyncHandler(submitScorecard));
router.get('/applications/:id/scorecards',    allowRoles(MGMT), AsyncHandler(listScorecardsForApplication));
router.get('/scorecards/:id',                 allowRoles(MGMT), AsyncHandler(getScorecard));

// ── Candidates / CRM ──────────────────────────────────────────────────────────
router.post('/candidates',              allowRoles(MGMT), AsyncHandler(createCandidate));
router.get('/candidates',               allowRoles(MGMT), AsyncHandler(listCandidates));
router.get('/candidates/:id',           allowRoles(MGMT), AsyncHandler(getCandidate));
router.patch('/candidates/:id',         allowRoles(MGMT), AsyncHandler(updateCandidate));
router.post('/candidates/:id/convert',  allowRoles(MGMT), AsyncHandler(convertCandidate));

// ── Nurture Campaigns ─────────────────────────────────────────────────────────
router.post('/nurture/campaigns',                 allowRoles(MGMT), AsyncHandler(createNurtureCampaign));
router.get('/nurture/campaigns',                  allowRoles(MGMT), AsyncHandler(listNurtureCampaigns));
router.post('/nurture/campaigns/:id/touchpoint',  allowRoles(MGMT), AsyncHandler(addNurtureTouchpoint));
router.get('/nurture/candidates',                 allowRoles(MGMT), AsyncHandler(listNurtureCandidates));

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get('/analytics/overview',              allowRoles(MGMT), AsyncHandler(getRecruitmentOverview));
router.get('/analytics/funnel/:requisitionId', allowRoles(MGMT), AsyncHandler(getRequisitionFunnel));
router.get('/analytics/time-to-fill',          allowRoles(MGMT), AsyncHandler(getTimeToFill));
router.get('/analytics/time-in-stage',         allowRoles(MGMT), AsyncHandler(getTimeInStage));
router.get('/analytics/source-effectiveness',  allowRoles(MGMT), AsyncHandler(getSourceEffectiveness));
router.get('/analytics/offer-acceptance',      allowRoles(MGMT), AsyncHandler(getOfferAcceptanceRate));

// ── Interview Kits ────────────────────────────────────────────────────────────
router.post('/interview-kits',       allowRoles(MGMT), AsyncHandler(createInterviewKit));
router.get('/interview-kits',        allowRoles(MGMT), AsyncHandler(listInterviewKits));
router.patch('/interview-kits/:id',  allowRoles(MGMT), AsyncHandler(updateInterviewKit));
router.delete('/interview-kits/:id', allowRoles(MGMT), AsyncHandler(deleteInterviewKit));

// ── Email Templates ───────────────────────────────────────────────────────────
router.post('/email-templates',       allowRoles(MGMT), AsyncHandler(createEmailTemplate));
router.get('/email-templates',        allowRoles(MGMT), AsyncHandler(listEmailTemplates));
router.patch('/email-templates/:id',  allowRoles(MGMT), AsyncHandler(updateEmailTemplate));
router.delete('/email-templates/:id', allowRoles(MGMT), AsyncHandler(deleteEmailTemplate));

module.exports = router;
