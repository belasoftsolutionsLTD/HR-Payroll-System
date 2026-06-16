const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  listJobGroups,   createJobGroup,   updateJobGroup,   deleteJobGroup,
  listAllowances,  createAllowance,  updateAllowance,  deleteAllowance,
  listFixedAllowances, createFixedAllowance, updateFixedAllowance, deleteFixedAllowance,
  listDeductions,  createDeduction,  updateDeduction,  deleteDeduction,
  listLeaveTypes,  createLeaveType,  updateLeaveType,  deleteLeaveType,
  getCommunicationSettings, updateCommunicationSettings,
  listDesignations, createDesignation, updateDesignation, deleteDesignation,
  listJdTemplates,  createJdTemplate,  updateJdTemplate,  deleteJdTemplate, serveJdTemplate,
  listCompanyAccounts, createCompanyAccount, updateCompanyAccount, deleteCompanyAccount,
  listScheduledEvents, createScheduledEvent, updateScheduledEvent, deleteScheduledEvent,
} = require('./configFunctions');
const { getCompanySettings, updateCompanySettings, uploadCompanyFile, serveCompanyLogo, serveTermsPdf } = require('./companySettingsFunctions');
const { getTaxConfig, updateTaxConfig } = require('./taxFunctions');

const ROLES = ['super_admin', 'hr_manager'];
const multer = require('multer');
const path   = require('path');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
  filename: (req, file, cb) => cb(null, `company-${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Departments
router.get('/departments',        allowRoles(ROLES), AsyncHandler(listDepartments));
router.post('/departments',       allowRoles(ROLES), AsyncHandler(createDepartment));
router.put('/departments/:id',    allowRoles(ROLES), AsyncHandler(updateDepartment));
router.delete('/departments/:id', allowRoles(ROLES), AsyncHandler(deleteDepartment));

// Job Groups
router.get('/job-groups',         allowRoles(ROLES), AsyncHandler(listJobGroups));
router.post('/job-groups',        allowRoles(ROLES), AsyncHandler(createJobGroup));
router.put('/job-groups/:id',     allowRoles(ROLES), AsyncHandler(updateJobGroup));
router.delete('/job-groups/:id',  allowRoles(ROLES), AsyncHandler(deleteJobGroup));

// Allowances (job-group linked)
router.get('/allowances',         allowRoles(ROLES), AsyncHandler(listAllowances));
router.post('/allowances',        allowRoles(ROLES), AsyncHandler(createAllowance));
router.put('/allowances/:id',     allowRoles(ROLES), AsyncHandler(updateAllowance));
router.delete('/allowances/:id',  allowRoles(ROLES), AsyncHandler(deleteAllowance));

// Fixed Allowances (standalone)
router.get('/fixed-allowances',         allowRoles(ROLES), AsyncHandler(listFixedAllowances));
router.post('/fixed-allowances',        allowRoles(ROLES), AsyncHandler(createFixedAllowance));
router.put('/fixed-allowances/:id',     allowRoles(ROLES), AsyncHandler(updateFixedAllowance));
router.delete('/fixed-allowances/:id',  allowRoles(ROLES), AsyncHandler(deleteFixedAllowance));

// Deductions
router.get('/deductions',         allowRoles(ROLES), AsyncHandler(listDeductions));
router.post('/deductions',        allowRoles(ROLES), AsyncHandler(createDeduction));
router.put('/deductions/:id',     allowRoles(ROLES), AsyncHandler(updateDeduction));
router.delete('/deductions/:id',  allowRoles(ROLES), AsyncHandler(deleteDeduction));

// Leave Types
router.get('/leave-types',        allowRoles(ROLES), AsyncHandler(listLeaveTypes));
router.post('/leave-types',       allowRoles(ROLES), AsyncHandler(createLeaveType));
router.put('/leave-types/:id',    allowRoles(ROLES), AsyncHandler(updateLeaveType));
router.delete('/leave-types/:id', allowRoles(ROLES), AsyncHandler(deleteLeaveType));

// Communication Settings
router.get('/communication-settings',   allowRoles(ROLES), AsyncHandler(getCommunicationSettings));
router.put('/communication-settings',   allowRoles(ROLES), AsyncHandler(updateCommunicationSettings));

// Company Settings
router.get('/company-settings',  allowRoles(ROLES), AsyncHandler(getCompanySettings));
router.put('/company-settings',  allowRoles(ROLES), AsyncHandler(updateCompanySettings));
router.post('/company-settings/logo',        allowRoles(ROLES), upload.single('logo'),        AsyncHandler((req, res) => uploadCompanyFile(req, res, 'logo')));
router.post('/company-settings/letterhead',  allowRoles(ROLES), upload.single('letterhead'),  AsyncHandler((req, res) => uploadCompanyFile(req, res, 'letterhead')));
router.post('/company-settings/terms',       allowRoles(ROLES), upload.single('terms'),       AsyncHandler((req, res) => uploadCompanyFile(req, res, 'terms')));
router.get('/company-logo', AsyncHandler(serveCompanyLogo));
router.get('/terms-pdf', AsyncHandler(serveTermsPdf));

// Designations
router.get('/designations',         allowRoles(ROLES), AsyncHandler(listDesignations));
router.post('/designations',        allowRoles(ROLES), AsyncHandler(createDesignation));
router.put('/designations/:id',     allowRoles(ROLES), AsyncHandler(updateDesignation));
router.delete('/designations/:id',  allowRoles(ROLES), AsyncHandler(deleteDesignation));

// Company Accounts
router.get('/company-accounts',         allowRoles(ROLES), AsyncHandler(listCompanyAccounts));
router.post('/company-accounts',        allowRoles(ROLES), AsyncHandler(createCompanyAccount));
router.put('/company-accounts/:id',     allowRoles(ROLES), AsyncHandler(updateCompanyAccount));
router.delete('/company-accounts/:id',  allowRoles(ROLES), AsyncHandler(deleteCompanyAccount));

// Scheduled Events (training sessions & team building with dates)
router.get('/events',         AsyncHandler(listScheduledEvents));
router.post('/events',        allowRoles(ROLES), AsyncHandler(createScheduledEvent));
router.put('/events/:id',     allowRoles(ROLES), AsyncHandler(updateScheduledEvent));
router.delete('/events/:id',  allowRoles(ROLES), AsyncHandler(deleteScheduledEvent));

// Tax & Payroll Configuration
router.get('/tax-config',  allowRoles(ROLES), AsyncHandler(getTaxConfig));
router.put('/tax-config',  allowRoles(ROLES), AsyncHandler(updateTaxConfig));

// JD Templates
router.get('/jd-templates',              allowRoles(ROLES), AsyncHandler(listJdTemplates));
router.post('/jd-templates',             allowRoles(ROLES), upload.single('jdPdf'), AsyncHandler(createJdTemplate));
router.put('/jd-templates/:id',          allowRoles(ROLES), upload.single('jdPdf'), AsyncHandler(updateJdTemplate));
router.delete('/jd-templates/:id',       allowRoles(ROLES), AsyncHandler(deleteJdTemplate));
router.get('/jd-templates/:id/pdf',      allowRoles(ROLES), AsyncHandler(serveJdTemplate));

module.exports = router;
