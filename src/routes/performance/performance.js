const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { getEmployeePerformance, createAppraisal, updateAppraisal, getPerformanceAlerts } = require('./performanceFunctions');

const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD } = require('../../constants/roles');
const MGMT = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD];

// alerts must come before /:employeeId
router.get('/alerts', allowRoles(MGMT), AsyncHandler(getPerformanceAlerts));
router.get('/:employeeId', allowRoles(MGMT), AsyncHandler(getEmployeePerformance));
router.post('/', allowRoles(MGMT), AsyncHandler(createAppraisal));
router.put('/:id', allowRoles(MGMT), AsyncHandler(updateAppraisal));

module.exports = router;
