const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES } = require('../../constants/roles');
const { listPayroll, getEmployeePayroll, createPayroll, downloadPayslip, bulkGeneratePayroll, disbursePayroll } = require('./payrollFunctions');

const hrOnly = allowRoles(HR_ROLES);

router.get('/',                              hrOnly, AsyncHandler(listPayroll));
router.post('/bulk',                         hrOnly, AsyncHandler(bulkGeneratePayroll));
router.post('/',                             hrOnly, AsyncHandler(createPayroll));
router.get('/:employeeId',                   hrOnly, AsyncHandler(getEmployeePayroll));
router.get('/:employeeId/:month/:year/payslip', hrOnly, AsyncHandler(downloadPayslip));
router.post('/:payrollId/disburse',             hrOnly, AsyncHandler(disbursePayroll));

module.exports = router;
