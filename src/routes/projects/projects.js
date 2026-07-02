const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, MGMT_ROLES, ALL_ROLES } = require('../../constants/roles');
const {
  listProjects, createProject, getProject, updateProject, deleteProject,
  listTimeEntries, addTimeEntry,
  listProjectExpenses, addProjectExpense,
  getProjectBudget, addMember, removeMember,
} = require('./projectsFunctions');

const hrOnly   = allowRoles(HR_ROLES);
const mgmtOnly = allowRoles(MGMT_ROLES);
const allRoles = allowRoles(ALL_ROLES);

// ── Projects ──────────────────────────────────────────────────────────────────
router.get('/',    allRoles,  AsyncHandler(listProjects));
router.post('/',   mgmtOnly,  AsyncHandler(createProject));

// ── Named sub-routes before /:id ──────────────────────────────────────────────
router.get('/:id/time-entries',  allRoles,  AsyncHandler(listTimeEntries));
router.post('/:id/time-entries', allRoles,  AsyncHandler(addTimeEntry));
router.get('/:id/expenses',      allRoles,  AsyncHandler(listProjectExpenses));
router.post('/:id/expenses',     allRoles,  AsyncHandler(addProjectExpense));
router.get('/:id/budget',        mgmtOnly,  AsyncHandler(getProjectBudget));
router.post('/:id/members',      mgmtOnly,  AsyncHandler(addMember));
router.delete('/:id/members/:employeeId', mgmtOnly, AsyncHandler(removeMember));

// ── Project CRUD ──────────────────────────────────────────────────────────────
router.get('/:id',    allRoles,  AsyncHandler(getProject));
router.put('/:id',    mgmtOnly,  AsyncHandler(updateProject));
router.delete('/:id', hrOnly,    AsyncHandler(deleteProject));

module.exports = router;
