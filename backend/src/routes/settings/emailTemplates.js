const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES } = require('../../constants/roles');
const {
  listEmailTemplates, getEmailTemplate, upsertEmailTemplate, resetEmailTemplate,
} = require('./emailTemplatesFunctions');

// HR_ROLES = [SUPER_ADMIN, HR_MANAGER] — same admin-only gate as every other
// Settings panel (Chart of Accounts, Vehicle Types, Company Settings, etc.).
router.get('/',                allowRoles(HR_ROLES), AsyncHandler(listEmailTemplates));
router.get('/:trigger',        allowRoles(HR_ROLES), AsyncHandler(getEmailTemplate));
router.put('/:trigger',        allowRoles(HR_ROLES), AsyncHandler(upsertEmailTemplate));
router.delete('/:trigger',     allowRoles(HR_ROLES), AsyncHandler(resetEmailTemplate));

module.exports = router;
