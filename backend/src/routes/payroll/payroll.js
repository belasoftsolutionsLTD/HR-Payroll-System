const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, MGMT_ROLES, ALL_ROLES } = require('../../constants/roles');

const { listConcepts, createConcept, updateConcept, deleteConcept, getConcept } = require('./payrollConceptsFunctions');
const { getEmployeeCompensations, listEmployeeCompensationSummaries, addCompensation, assignConcept, updateCompensation, removeCompensation, getCompensationAuditLog } = require('./payrollCompensationsFunctions');
const { listCycles, getCycle, createCycle, advanceCycleStatus, compareCycles, getCycleResults, getCycleExceptions, approveEmployees, lockCycle, closeCycle, exportCycleCSV, exportBankFile, getEmployeeResult, emailPayslips, downloadP9Form, previewConceptsEngine } = require('./payrollCyclesFunctions');
const { getMyPayslips, downloadPayslipPDF, getPayslip, getEmployeePayslips } = require('./payrollPayslipsFunctions');
const { getPayrollAnalytics } = require('./payrollAnalyticsFunctions');

const hrOnly   = allowRoles(HR_ROLES);
const mgmtOnly = allowRoles(MGMT_ROLES);
const allRoles = allowRoles(ALL_ROLES);

// ── Payroll Concepts ──────────────────────────────────────────────────────────
router.get('/concepts',          hrOnly, AsyncHandler(listConcepts));
router.post('/concepts',         hrOnly, AsyncHandler(createConcept));
router.get('/concepts/:id',      hrOnly, AsyncHandler(getConcept));
router.put('/concepts/:id',      hrOnly, AsyncHandler(updateConcept));
router.delete('/concepts/:id',   hrOnly, AsyncHandler(deleteConcept));
router.post('/concepts/:id/assign', hrOnly, AsyncHandler((req, res) => assignConcept({ ...req, body: { ...req.body, conceptId: req.params.id } }, res)));

// ── Employee Compensations ────────────────────────────────────────────────────
router.get('/compensations/employees',              hrOnly, AsyncHandler(listEmployeeCompensationSummaries));
router.get('/compensations/:employeeId',            hrOnly, AsyncHandler(getEmployeeCompensations));
router.get('/compensations/:employeeId/audit-log',  hrOnly, AsyncHandler(getCompensationAuditLog));
router.post('/compensations',                       hrOnly, AsyncHandler(addCompensation));
router.put('/compensations/:id',                    hrOnly, AsyncHandler(updateCompensation));
router.delete('/compensations/:id',                 hrOnly, AsyncHandler(removeCompensation));

// ── Payroll Cycles ────────────────────────────────────────────────────────────
router.get('/cycles',                               hrOnly, AsyncHandler(listCycles));
router.post('/cycles',                              hrOnly, AsyncHandler(createCycle));
router.get('/cycles/compare',                       hrOnly, AsyncHandler(compareCycles));
router.get('/cycles/:id',                           hrOnly, AsyncHandler(getCycle));
router.put('/cycles/:id/status',                    hrOnly, AsyncHandler(advanceCycleStatus));
router.get('/cycles/:id/results',                   hrOnly, AsyncHandler(getCycleResults));
router.get('/cycles/:id/exceptions',                hrOnly, AsyncHandler(getCycleExceptions));
router.get('/cycles/:id/preview-concepts-engine',   hrOnly, AsyncHandler(previewConceptsEngine));
router.post('/cycles/:id/approve',                  hrOnly, AsyncHandler(approveEmployees));
router.post('/cycles/:id/lock',                     hrOnly, AsyncHandler(lockCycle));
router.post('/cycles/:id/close',                    hrOnly, AsyncHandler(closeCycle));
router.get('/cycles/:id/export',                    hrOnly, AsyncHandler(exportCycleCSV));
router.get('/cycles/:id/bank-file',                 hrOnly, AsyncHandler(exportBankFile));
router.post('/cycles/:id/email-payslips',           hrOnly, AsyncHandler(emailPayslips));

// ── Payroll Results ───────────────────────────────────────────────────────────
router.get('/results/:cycleId/:employeeId',         hrOnly, AsyncHandler(getEmployeeResult));

// ── Payslips ──────────────────────────────────────────────────────────────────
router.get('/payslips',                             allRoles, AsyncHandler(getMyPayslips));
router.get('/payslips/:id',                         allRoles, AsyncHandler(getPayslip));
router.get('/payslips/:id/pdf',                     allRoles, AsyncHandler(downloadPayslipPDF));
router.get('/employee-payslips/:employeeId',        hrOnly,   AsyncHandler(getEmployeePayslips));

// ── P9A Form ──────────────────────────────────────────────────────────────────
router.get('/p9/:employeeId',                       hrOnly, AsyncHandler(downloadP9Form));

// ── Analytics (HR admin only) ──────────────────────────────────────────────────
router.get('/analytics',                            hrOnly, AsyncHandler(getPayrollAnalytics));

module.exports = router;
