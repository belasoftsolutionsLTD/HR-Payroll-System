const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { ALL_ROLES, HR_ROLES } = require('../../constants/roles');
const returnFunction = require('../../functions/returnFunction');
const { getCrmAccessLevel, listTeamMembers } = require('../../lib/crm/crmAccess');

const { listContacts, getContact, createContact, updateContact, deleteContact } = require('./crmContactsFunctions');
const { listCompanies, getCompany, createCompany, updateCompany, deleteCompany } = require('./crmCompaniesFunctions');
const { listCustomFieldDefs, createCustomFieldDef, updateCustomFieldDef, deleteCustomFieldDef } = require('./crmCustomFieldsFunctions');
const { listPipelines, createPipeline, updatePipeline, deletePipeline } = require('./crmPipelinesFunctions');
const { listDeals, getDeal, createDeal, updateDeal, moveDealStage, winDeal, loseDeal, reassignDeal } = require('./crmDealsFunctions');
const { logActivity, createTask, updateTask, completeTask, addSubtask, toggleSubtask, getContactTimeline, listTasks } = require('./crmActivitiesFunctions');
const { searchStock } = require('./crmInventoryFunctions');
const { getContactSales } = require('./crmSalesFunctions');
const { getPipelineReport, getActivityReport, exportDealsCSV, getSourceEffectivenessReport, getFeedbackSummary } = require('./crmReportsFunctions');
const { createFeedback, listFeedbackForContact } = require('./crmFeedbackFunctions');

// Broad gate at the route level, real authorization inside each handler via
// getCrmAccessLevel — identical layered convention to Inventory/POS.
const ANY = ALL_ROLES;
const ADMIN = HR_ROLES;

router.get('/my-access', allowRoles(ANY), AsyncHandler(async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  // 'level' alone isn't enough to decide whether CRM is actually relevant to this user —
  // getCrmAccessLevel gives every plain staff account 'staff' as a generic fallback (no
  // gating flag, unlike Inventory/POS — see crmAccess.js), even one with zero contacts
  // or deals ever assigned to them. 'relevant' answers "does this person have real
  // standing here": admin/manager always do; 'staff' only if something has actually been
  // assigned to them. Callers like the nav sidebar should key off `relevant`, not `level`.
  let relevant = level === 'admin' || level === 'manager';
  if (level === 'staff') {
    const [hasContact, hasDeal] = await Promise.all([
      global.dbo.collection('crm_contacts').findOne({ assignedTo: req.user._id }, { projection: { _id: 1 } }),
      global.dbo.collection('crm_deals').findOne({ assignedTo: req.user._id }, { projection: { _id: 1 } }),
    ]);
    relevant = !!(hasContact || hasDeal);
  }
  return returnFunction(res, 200, true, req.locale.success, { level, relevant });
}));

// Candidate list for reassigning a deal/contact — scoped the same way as everything else.
router.get('/team-members', allowRoles(ANY), AsyncHandler(async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized.');
  const members = await listTeamMembers(req.user, level);
  return returnFunction(res, 200, true, req.locale.success, members);
}));

// ── Reports & export — specific paths before /deals/:id ──────────────────────
router.get('/reports/pipeline',  allowRoles(ANY), AsyncHandler(getPipelineReport));
router.get('/reports/activity',  allowRoles(ANY), AsyncHandler(getActivityReport));
router.get('/reports/sources',   allowRoles(ANY), AsyncHandler(getSourceEffectivenessReport));
router.get('/reports/feedback',  allowRoles(ANY), AsyncHandler(getFeedbackSummary));
router.get('/deals/export',      allowRoles(ANY), AsyncHandler(exportDealsCSV));

// ── Tasks — specific paths before nothing conflicting, kept together ─────────
router.get('/tasks',              allowRoles(ANY), AsyncHandler(listTasks));
router.post('/tasks',             allowRoles(ANY), AsyncHandler(createTask));
router.put('/tasks/:id',          allowRoles(ANY), AsyncHandler(updateTask));
router.patch('/tasks/:id/complete', allowRoles(ANY), AsyncHandler(completeTask));
router.post('/tasks/:id/subtasks',    allowRoles(ANY), AsyncHandler(addSubtask));
router.patch('/tasks/:id/subtasks/:subId', allowRoles(ANY), AsyncHandler(toggleSubtask));

// ── Activities (manual log) ───────────────────────────────────────────────────
router.post('/activities', allowRoles(ANY), AsyncHandler(logActivity));

// ── Inventory integration (read-only) ─────────────────────────────────────────
router.get('/inventory/stock', allowRoles(ANY), AsyncHandler(searchStock));

// ── Custom field definitions ───────────────────────────────────────────────────
router.get('/custom-fields',        allowRoles(ANY),   AsyncHandler(listCustomFieldDefs));
router.post('/custom-fields',       allowRoles(ADMIN),  AsyncHandler(createCustomFieldDef));
router.put('/custom-fields/:id',    allowRoles(ADMIN),  AsyncHandler(updateCustomFieldDef));
router.delete('/custom-fields/:id', allowRoles(ADMIN),  AsyncHandler(deleteCustomFieldDef));

// ── Pipelines ──────────────────────────────────────────────────────────────────
router.get('/pipelines',        allowRoles(ANY),   AsyncHandler(listPipelines));
router.post('/pipelines',       allowRoles(ADMIN),  AsyncHandler(createPipeline));
router.put('/pipelines/:id',    allowRoles(ADMIN),  AsyncHandler(updatePipeline));
router.delete('/pipelines/:id', allowRoles(ADMIN),  AsyncHandler(deletePipeline));

// ── Companies ──────────────────────────────────────────────────────────────────
router.get('/companies',        allowRoles(ANY), AsyncHandler(listCompanies));
router.get('/companies/:id',    allowRoles(ANY), AsyncHandler(getCompany));
router.post('/companies',       allowRoles(ANY), AsyncHandler(createCompany));
router.put('/companies/:id',    allowRoles(ANY), AsyncHandler(updateCompany));
router.delete('/companies/:id', allowRoles(ANY), AsyncHandler(deleteCompany)); // admin/manager checked in handler

// ── Contacts — specific sub-paths before plain /:id ──────────────────────────
router.get('/contacts',                allowRoles(ANY), AsyncHandler(listContacts));
router.post('/contacts',               allowRoles(ANY), AsyncHandler(createContact));
router.get('/contacts/:id',            allowRoles(ANY), AsyncHandler(getContact));
router.put('/contacts/:id',            allowRoles(ANY), AsyncHandler(updateContact));
router.delete('/contacts/:id',         allowRoles(ANY), AsyncHandler(deleteContact)); // admin/manager checked in handler
router.get('/contacts/:id/timeline',   allowRoles(ANY), AsyncHandler(getContactTimeline));
router.get('/contacts/:id/sales',      allowRoles(ANY), AsyncHandler(getContactSales));
router.get('/contacts/:id/feedback',   allowRoles(ANY), AsyncHandler(listFeedbackForContact));
router.post('/contacts/:id/feedback',  allowRoles(ANY), AsyncHandler(createFeedback));

// ── Deals — action verbs before plain :id where it matters ────────────────────
router.get('/deals',               allowRoles(ANY), AsyncHandler(listDeals));
router.post('/deals',              allowRoles(ANY), AsyncHandler(createDeal));
router.get('/deals/:id',           allowRoles(ANY), AsyncHandler(getDeal));
router.put('/deals/:id',           allowRoles(ANY), AsyncHandler(updateDeal));
router.post('/deals/:id/stage',    allowRoles(ANY), AsyncHandler(moveDealStage));
router.post('/deals/:id/win',      allowRoles(ANY), AsyncHandler(winDeal));
router.post('/deals/:id/lose',     allowRoles(ANY), AsyncHandler(loseDeal));
router.post('/deals/:id/reassign', allowRoles(ANY), AsyncHandler(reassignDeal)); // admin/manager checked in handler

module.exports = router;
