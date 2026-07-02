const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listDevices, getDeviceSummary, getDevice, createDevice, updateDevice, deleteDevice,
  assignDevice, unassignDevice,
  listSoftware, getSoftwareSummary, createSoftware, updateSoftware, deleteSoftware,
  assignSoftware, revokeSoftware,
  listRequests, createRequest, updateRequest, resolveRequest,
  getExpiringAssets,
} = require('./itFunctions');

const ALL  = ['super_admin', 'hr_manager', 'department_head', 'staff'];
const MGMT = ['super_admin', 'hr_manager', 'department_head'];
const HR   = ['super_admin', 'hr_manager'];

// Devices
router.get('/devices/expiring',         allowRoles(MGMT), AsyncHandler(getExpiringAssets));
router.get('/devices/summary',          allowRoles(MGMT), AsyncHandler(getDeviceSummary));
router.get('/devices',                  allowRoles(ALL),  AsyncHandler(listDevices));
router.post('/devices',                 allowRoles(HR),   AsyncHandler(createDevice));
router.get('/devices/:id',              allowRoles(MGMT), AsyncHandler(getDevice));
router.put('/devices/:id',              allowRoles(HR),   AsyncHandler(updateDevice));
router.delete('/devices/:id',           allowRoles(HR),   AsyncHandler(deleteDevice));
router.post('/devices/:id/assign',      allowRoles(HR),   AsyncHandler(assignDevice));
router.post('/devices/:id/unassign',    allowRoles(HR),   AsyncHandler(unassignDevice));

// Software & Apps
router.get('/software/summary',         allowRoles(MGMT), AsyncHandler(getSoftwareSummary));
router.get('/software',                 allowRoles(MGMT), AsyncHandler(listSoftware));
router.post('/software',                allowRoles(HR),   AsyncHandler(createSoftware));
router.put('/software/:id',             allowRoles(HR),   AsyncHandler(updateSoftware));
router.delete('/software/:id',          allowRoles(HR),   AsyncHandler(deleteSoftware));
router.post('/software/:id/assign/:employeeId',  allowRoles(HR), AsyncHandler(assignSoftware));
router.delete('/software/:id/assign/:employeeId', allowRoles(HR), AsyncHandler(revokeSoftware));

// IT Requests
router.get('/requests',                 allowRoles(ALL),  AsyncHandler(listRequests));
router.post('/requests',                allowRoles(ALL),  AsyncHandler(createRequest));
router.put('/requests/:id',             allowRoles(MGMT), AsyncHandler(updateRequest));
router.put('/requests/:id/resolve',     allowRoles(MGMT), AsyncHandler(resolveRequest));

module.exports = router;
