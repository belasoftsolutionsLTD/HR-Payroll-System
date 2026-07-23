const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listDepartments, createDepartment, updateDepartment, deleteDepartment, bulkDeleteDepartments,
  listJobGroups,   createJobGroup,   updateJobGroup,   deleteJobGroup,
  getCommunicationSettings, updateCommunicationSettings,
  listDesignations, createDesignation, updateDesignation, deleteDesignation,
  listJdTemplates,  createJdTemplate,  updateJdTemplate,  deleteJdTemplate, serveJdTemplate,
  listCompanyAccounts, createCompanyAccount, updateCompanyAccount, deleteCompanyAccount,
  listScheduledEvents, createScheduledEvent, updateScheduledEvent, deleteScheduledEvent,
} = require('./configFunctions');
const { getCompanySettings, updateCompanySettings, uploadCompanyFile, serveCompanyLogo, serveTermsPdf } = require('./companySettingsFunctions');
const { getTaxConfig, updateTaxConfig } = require('./taxFunctions');
const { getOvertimeConfig, updateOvertimeConfig } = require('./overtimeFunctions');

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
router.post('/departments/bulk-delete', allowRoles(ROLES), AsyncHandler(bulkDeleteDepartments));

// Job Groups
router.get('/job-groups',         allowRoles(ROLES), AsyncHandler(listJobGroups));
router.post('/job-groups',        allowRoles(ROLES), AsyncHandler(createJobGroup));
router.put('/job-groups/:id',     allowRoles(ROLES), AsyncHandler(updateJobGroup));
router.delete('/job-groups/:id',  allowRoles(ROLES), AsyncHandler(deleteJobGroup));

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

// Overtime Rate Configuration (HR-defined multipliers — no hardcoded defaults)
router.get('/overtime-config', allowRoles(ROLES), AsyncHandler(getOvertimeConfig));
router.put('/overtime-config', allowRoles(ROLES), AsyncHandler(updateOvertimeConfig));

// JD Templates
router.get('/jd-templates',              allowRoles(ROLES), AsyncHandler(listJdTemplates));
router.post('/jd-templates',             allowRoles(ROLES), upload.single('jdPdf'), AsyncHandler(createJdTemplate));
router.put('/jd-templates/:id',          allowRoles(ROLES), upload.single('jdPdf'), AsyncHandler(updateJdTemplate));
router.delete('/jd-templates/:id',       allowRoles(ROLES), AsyncHandler(deleteJdTemplate));
router.get('/jd-templates/:id/pdf',      allowRoles(ROLES), AsyncHandler(serveJdTemplate));

module.exports = router;
