const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES } = require('../../constants/roles');
const { getWorkspaceSummary, getCompensationByGroup, getCostCenters, getWorkforceHistory, getTrends } = require('./financeFunctions');

const hrOnly = allowRoles(HR_ROLES);

router.get('/workspace/summary',      hrOnly, AsyncHandler(getWorkspaceSummary));
router.get('/workspace/compensation', hrOnly, AsyncHandler(getCompensationByGroup));
router.get('/workspace/cost-centers', hrOnly, AsyncHandler(getCostCenters));
router.get('/workspace/history',      hrOnly, AsyncHandler(getWorkforceHistory));
router.get('/workspace/trends',       hrOnly, AsyncHandler(getTrends));

module.exports = router;
