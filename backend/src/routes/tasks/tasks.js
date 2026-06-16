const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { ALL_ROLES } = require('../../constants/roles');
const { listTasks, createTask, updateTask, deleteTask, updateMyTaskStatus, getMyTasks, searchEmployeesForTask } = require('./taskFunctions');

const HR   = ['super_admin', 'hr_manager'];
const auth = allowRoles(ALL_ROLES);

// HR task management
router.get('/tasks',              allowRoles(HR), AsyncHandler(listTasks));
router.post('/tasks',             allowRoles(HR), AsyncHandler(createTask));
router.put('/tasks/:id',          allowRoles(HR), AsyncHandler(updateTask));
router.delete('/tasks/:id',       allowRoles(HR), AsyncHandler(deleteTask));
router.get('/tasks/employees/search', allowRoles(HR), AsyncHandler(searchEmployeesForTask));

// Employee: update own task status
router.patch('/tasks/:id/status', auth, AsyncHandler(updateMyTaskStatus));

// Employee: get own tasks (also exposed via /me/tasks in me.js)
router.get('/me/tasks', auth, AsyncHandler(getMyTasks));

module.exports = router;
