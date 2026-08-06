const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { ALL_ROLES } = require('../../constants/roles');

const {
  listVehicles, getVehicle, createVehicle, updateVehicle, archiveVehicle,
  assignDriver, updateVehicleStatus, updateVehicleLocation, getFleetUtilization,
} = require('./logisticsVehiclesFunctions');
const {
  listWorkOrders, getWorkOrder, createWorkOrder, addPartUsed, completeWorkOrder,
} = require('./logisticsMaintenanceFunctions');
const {
  listRoutes, getRoute, createRoute, updateRouteStatus, updateStopStatus, uploadProofOfDelivery,
} = require('./logisticsRoutesFunctions');
const {
  listShipments, getShipment, createShipment, updateShipmentStatus, markDelivered,
  flagException, resolveException, getPredictedETA, getDeliveryPerformanceReport, exportDeliveryPerformanceCSV,
} = require('./logisticsShipmentsFunctions');
const {
  listVehicleTypes, createVehicleType, deleteVehicleType,
  listServiceBays, createServiceBay, deleteServiceBay,
} = require('./logisticsSettingsFunctions');
const { getLogisticsAccessLevel } = require('../../lib/logistics/logisticsAccess');
const returnFunction = require('../../functions/returnFunction');

// Route-level gate is deliberately broad (any authenticated role) — same convention as
// Inventory/POS/Accounting: fine-grained access (admin/opsAdmin/manager/driver, and
// "only your own route") is resolved per-request inside each handler via
// getLogisticsAccessLevel, not by the role string alone.
const ANY = ALL_ROLES;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
    filename: (req, file, cb) => cb(null, `logistics-pod-${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// 'relevant' answers "does this person have real business in Logistics" for the nav
// sidebar to key off of — unlike POS's manager-with-zero-locations edge case,
// getLogisticsAccessLevel already only returns 'manager'/'driver' when there's a real
// team or vehicle assignment, so level !== null is accurate here with no extra caveat.
router.get('/my-access', allowRoles(ANY), AsyncHandler(async (req, res) => {
  const level = await getLogisticsAccessLevel(req.user);
  return returnFunction(res, 200, true, req.locale.success, { level, relevant: level !== null });
}));

// ── Fleet: vehicles ──────────────────────────────────────────────────────────
router.get('/vehicles',                 allowRoles(ANY), AsyncHandler(listVehicles));
router.get('/vehicles/:id',             allowRoles(ANY), AsyncHandler(getVehicle));
router.post('/vehicles',                allowRoles(ANY), AsyncHandler(createVehicle));
router.put('/vehicles/:id',             allowRoles(ANY), AsyncHandler(updateVehicle));
router.delete('/vehicles/:id',          allowRoles(ANY), AsyncHandler(archiveVehicle));
router.post('/vehicles/:id/driver',     allowRoles(ANY), AsyncHandler(assignDriver));
router.post('/vehicles/:id/status',     allowRoles(ANY), AsyncHandler(updateVehicleStatus));
router.post('/vehicles/:id/location',   allowRoles(ANY), AsyncHandler(updateVehicleLocation));
router.get('/fleet/utilization',        allowRoles(ANY), AsyncHandler(getFleetUtilization));

// ── Settings: vehicle types ──────────────────────────────────────────────────
router.get('/vehicle-types',            allowRoles(ANY), AsyncHandler(listVehicleTypes));
router.post('/vehicle-types',           allowRoles(ANY), AsyncHandler(createVehicleType));
router.delete('/vehicle-types/:id',     allowRoles(ANY), AsyncHandler(deleteVehicleType));
router.get('/service-bays',             allowRoles(ANY), AsyncHandler(listServiceBays));
router.post('/service-bays',            allowRoles(ANY), AsyncHandler(createServiceBay));
router.delete('/service-bays/:id',      allowRoles(ANY), AsyncHandler(deleteServiceBay));

// ── Fleet: maintenance work orders ───────────────────────────────────────────
router.get('/work-orders',              allowRoles(ANY), AsyncHandler(listWorkOrders));
router.get('/work-orders/:id',          allowRoles(ANY), AsyncHandler(getWorkOrder));
router.post('/work-orders',             allowRoles(ANY), AsyncHandler(createWorkOrder));
router.post('/work-orders/:id/parts',   allowRoles(ANY), AsyncHandler(addPartUsed));
router.post('/work-orders/:id/complete',allowRoles(ANY), AsyncHandler(completeWorkOrder));

// ── Route optimization ───────────────────────────────────────────────────────
router.get('/routes',                   allowRoles(ANY), AsyncHandler(listRoutes));
router.get('/routes/:id',               allowRoles(ANY), AsyncHandler(getRoute));
router.post('/routes',                  allowRoles(ANY), AsyncHandler(createRoute));
router.post('/routes/:id/status',       allowRoles(ANY), AsyncHandler(updateRouteStatus));
router.post('/routes/:id/stops/:stopId/status', allowRoles(ANY), AsyncHandler(updateStopStatus));
router.post('/routes/:id/stops/:stopId/photo',     allowRoles(ANY), upload.single('photo'),     AsyncHandler((req, res) => uploadProofOfDelivery(req, res, 'photo')));
router.post('/routes/:id/stops/:stopId/signature', allowRoles(ANY), upload.single('signature'), AsyncHandler((req, res) => uploadProofOfDelivery(req, res, 'signature')));

// ── Shipment tracking ────────────────────────────────────────────────────────
router.get('/shipments',                allowRoles(ANY), AsyncHandler(listShipments));
router.get('/shipments/:id',            allowRoles(ANY), AsyncHandler(getShipment));
router.post('/shipments',               allowRoles(ANY), AsyncHandler(createShipment));
router.post('/shipments/:id/status',    allowRoles(ANY), AsyncHandler(updateShipmentStatus));
router.post('/shipments/:id/deliver',   allowRoles(ANY), AsyncHandler(markDelivered));
router.post('/shipments/:id/exception', allowRoles(ANY), AsyncHandler(flagException));
router.post('/shipments/:id/exception/resolve', allowRoles(ANY), AsyncHandler(resolveException));
router.get('/shipments/:id/eta',        allowRoles(ANY), AsyncHandler(getPredictedETA));

// ── Reporting ─────────────────────────────────────────────────────────────────
router.get('/reports/delivery-performance',      allowRoles(ANY), AsyncHandler(getDeliveryPerformanceReport));
router.get('/reports/delivery-performance/csv',  allowRoles(ANY), AsyncHandler(exportDeliveryPerformanceCSV));

module.exports = router;
