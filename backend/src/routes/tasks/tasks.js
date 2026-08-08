const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { ALL_ROLES } = require('../../constants/roles');
const {
  getTaskStats, getMyTasks, listTeamTasks, listAllTasks,
  getTaskDetail, createTask, updateTask, deleteTask,
  completeTask, reopenTask, updateTaskStatus, addComment, addSubtask, toggleSubtask,
  exportTasksCSV, getTaskAnalytics,
  searchEmployeesForTask, listEmployeesWithTaskCounts, listTasksByEmployee,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, applyTemplate,
} = require('./taskFunctions');

const HR   = ['super_admin', 'hr_manager'];
const MGMT = ['super_admin', 'hr_manager', 'department_head'];
const auth = allowRoles(ALL_ROLES);

// ── Static/search routes (MUST come before /:id) ──────────────────────────────
router.get('/tasks/stats',                       auth,         AsyncHandler(getTaskStats));
router.get('/tasks/export',                      allowRoles(HR), AsyncHandler(exportTasksCSV));
router.get('/tasks/analytics',                   allowRoles(MGMT), AsyncHandler(getTaskAnalytics));
router.get('/tasks/team',                        allowRoles(MGMT), AsyncHandler(listTeamTasks));
router.get('/tasks/employees/search',            allowRoles(MGMT), AsyncHandler(searchEmployeesForTask));
router.get('/tasks/employees',                   allowRoles(MGMT), AsyncHandler(listEmployeesWithTaskCounts));
router.get('/tasks/by-employee/:employeeId',     allowRoles(MGMT), AsyncHandler(listTasksByEmployee));

// ── Templates (MUST come before /tasks/:id) ───────────────────────────────────
router.get('/tasks/templates',                   allowRoles(MGMT), AsyncHandler(listTemplates));
router.post('/tasks/templates',                  allowRoles(HR),   AsyncHandler(createTemplate));
router.get('/tasks/templates/:id',               allowRoles(MGMT), AsyncHandler(getTemplate));
router.put('/tasks/templates/:id',               allowRoles(HR),   AsyncHandler(updateTemplate));
router.delete('/tasks/templates/:id',            allowRoles(HR),   AsyncHandler(deleteTemplate));
router.post('/tasks/templates/:id/apply',        allowRoles(MGMT), AsyncHandler(applyTemplate));

// ── Task CRUD ─────────────────────────────────────────────────────────────────
router.get('/tasks',                             allowRoles(MGMT), AsyncHandler(listAllTasks));
router.post('/tasks',                            allowRoles(MGMT), AsyncHandler(createTask));
router.get('/tasks/:id',                         auth,             AsyncHandler(getTaskDetail));
router.put('/tasks/:id',                         allowRoles(MGMT), AsyncHandler(updateTask));
router.delete('/tasks/:id',                      allowRoles(HR),   AsyncHandler(deleteTask));

// ── Task actions ──────────────────────────────────────────────────────────────
router.put('/tasks/:id/complete',                auth, AsyncHandler(completeTask));
router.put('/tasks/:id/reopen',                  auth, AsyncHandler(reopenTask));
// Quick status patch — used by staff portal. Moved into taskFunctions.js as a
// real exported handler (was an inline closure here, bypassing that file's
// shared VALID_STATUSES/auth pattern — the same route-glue-in-the-router smell
// flagged in earlier phases).
router.patch('/tasks/:id/status',                auth, AsyncHandler(updateTaskStatus));

router.post('/tasks/:id/comment',                auth, AsyncHandler(addComment));
router.post('/tasks/:id/subtask',                auth, AsyncHandler(addSubtask));
router.put('/tasks/:id/subtask/:subId',          auth, AsyncHandler(toggleSubtask));

// ── Personal task feed (also consumed by staff portal) ────────────────────────
router.get('/me/tasks',                          auth, AsyncHandler(getMyTasks));

module.exports = router;
