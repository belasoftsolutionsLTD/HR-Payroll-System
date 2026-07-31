const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, MGMT_ROLES, ALL_ROLES } = require('../../constants/roles');

const {
  listCategories, createCategory, updateCategory, deleteCategory,
  listBrands, createBrand, updateBrand, deleteBrand,
  listUnitsOfMeasure, createUnitOfMeasure, updateUnitOfMeasure, deleteUnitOfMeasure,
  listCustomFieldDefs, createCustomFieldDef, updateCustomFieldDef, deleteCustomFieldDef,
  listItems, getItem, createItem, updateItem, archiveItem, uploadItemImage, suggestSku,
} = require('./inventoryItemsFunctions');
const {
  listLocations, createLocation, updateLocation, deleteLocation,
  listStockLevels, getItemTotalStock, setReorderPoint, getLowStockReport,
} = require('./inventoryLocationsFunctions');
const { listMovements, exportMovementsCSV, createAdjustment, recomputeStockLevelsFromLedger } = require('./inventoryMovementsFunctions');
const { listSuppliers, getSupplier, createSupplier, updateSupplier, deleteSupplier } = require('./inventorySuppliersFunctions');
const {
  listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, updatePurchaseOrder,
  sendPurchaseOrder, logSupplierInvoice, receivePurchaseOrder, requestPoPayment, deletePurchaseOrder,
} = require('./inventoryPurchaseOrdersFunctions');
const { listTransfers, getTransfer, requestTransfer, approveTransfer, rejectTransfer, receiveTransfer } = require('./inventoryTransfersFunctions');
const { listLotsForItem, traceLot } = require('./inventoryLotsFunctions');
const { getValuationReport, getStockByCategoryReport, getInventoryInsights } = require('./inventoryReportsFunctions');
const { listStaffAccess, setInventoryClerkFlag, getMyAccessLevel } = require('./inventoryStaffAccessFunctions');

// Broad gate at the route level (any of the 4 roles might have SOME level of access —
// a plain "staff" could be a manager-via-managerId or an isInventoryClerk-flagged
// clerk) — the real authorization happens inside each handler via getInventoryAccessLevel,
// same layered convention as attendance/leave/expenses use throughout this codebase.
const ANY = ALL_ROLES;
const ADMIN = HR_ROLES;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
    filename: (req, file, cb) => cb(null, `inventory-item-${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ── My access level ──────────────────────────────────────────────────────────
router.get('/my-access', allowRoles(ANY), AsyncHandler(getMyAccessLevel));

// ── Categories & custom field definitions (admin-managed) ───────────────────
router.get('/categories',        allowRoles(ANY),   AsyncHandler(listCategories));
router.post('/categories',       allowRoles(ADMIN),  AsyncHandler(createCategory));
router.put('/categories/:id',    allowRoles(ADMIN),  AsyncHandler(updateCategory));
router.delete('/categories/:id', allowRoles(ADMIN),  AsyncHandler(deleteCategory));

router.get('/brands',        allowRoles(ANY),   AsyncHandler(listBrands));
router.post('/brands',       allowRoles(ADMIN),  AsyncHandler(createBrand));
router.put('/brands/:id',    allowRoles(ADMIN),  AsyncHandler(updateBrand));
router.delete('/brands/:id', allowRoles(ADMIN),  AsyncHandler(deleteBrand));

router.get('/units-of-measure',        allowRoles(ANY),   AsyncHandler(listUnitsOfMeasure));
router.post('/units-of-measure',       allowRoles(ADMIN),  AsyncHandler(createUnitOfMeasure));
router.put('/units-of-measure/:id',    allowRoles(ADMIN),  AsyncHandler(updateUnitOfMeasure));
router.delete('/units-of-measure/:id', allowRoles(ADMIN),  AsyncHandler(deleteUnitOfMeasure));

router.get('/custom-fields',        allowRoles(ANY),  AsyncHandler(listCustomFieldDefs));
router.post('/custom-fields',       allowRoles(ADMIN), AsyncHandler(createCustomFieldDef));
router.put('/custom-fields/:id',    allowRoles(ADMIN), AsyncHandler(updateCustomFieldDef));
router.delete('/custom-fields/:id', allowRoles(ADMIN), AsyncHandler(deleteCustomFieldDef));

// ── Staff access (isInventoryClerk flag) ─────────────────────────────────────
router.get('/staff-access',            allowRoles(ADMIN), AsyncHandler(listStaffAccess));
router.patch('/staff-access/:userId',  allowRoles(ADMIN), AsyncHandler(setInventoryClerkFlag));

// ── Reports — specific paths before /items/:id etc. ──────────────────────────
router.get('/reports/valuation',        allowRoles(ADMIN), AsyncHandler(getValuationReport));
router.get('/reports/stock-by-category', allowRoles(ANY),  AsyncHandler(getStockByCategoryReport));
router.get('/reports/low-stock',        allowRoles(ANY),   AsyncHandler(getLowStockReport));
router.get('/reports/insights',         allowRoles(ADMIN), AsyncHandler(getInventoryInsights));

// ── Stock movements ledger ────────────────────────────────────────────────────
router.get('/movements',        allowRoles(ANY),  AsyncHandler(listMovements));
router.get('/movements/export', allowRoles(ANY),  AsyncHandler(exportMovementsCSV));
router.post('/movements/adjustment', allowRoles(ANY), AsyncHandler(createAdjustment));
router.post('/movements/recompute',  allowRoles(ADMIN), AsyncHandler(recomputeStockLevelsFromLedger));

// ── Stock levels ──────────────────────────────────────────────────────────────
router.get('/stock-levels',            allowRoles(ANY),   AsyncHandler(listStockLevels));
router.put('/stock-levels/reorder-point', allowRoles(ADMIN), AsyncHandler(setReorderPoint));
router.get('/items/:itemId/stock',     allowRoles(ANY),   AsyncHandler(getItemTotalStock));
router.get('/items/:itemId/lots',      allowRoles(ANY),   AsyncHandler(listLotsForItem));
router.get('/lots/trace',              allowRoles(ANY),   AsyncHandler(traceLot));

// ── Locations ──────────────────────────────────────────────────────────────────
router.get('/locations',        allowRoles(ANY),   AsyncHandler(listLocations));
router.post('/locations',       allowRoles(ADMIN),  AsyncHandler(createLocation));
router.put('/locations/:id',    allowRoles(ADMIN),  AsyncHandler(updateLocation));
router.delete('/locations/:id', allowRoles(ADMIN),  AsyncHandler(deleteLocation));

// ── Suppliers ──────────────────────────────────────────────────────────────────
router.get('/suppliers',        allowRoles(ANY),   AsyncHandler(listSuppliers));
router.get('/suppliers/:id',    allowRoles(ANY),   AsyncHandler(getSupplier));
router.post('/suppliers',       allowRoles(ADMIN),  AsyncHandler(createSupplier));
router.put('/suppliers/:id',    allowRoles(ADMIN),  AsyncHandler(updateSupplier));
router.delete('/suppliers/:id', allowRoles(ADMIN),  AsyncHandler(deleteSupplier));

// ── Purchase orders — specific paths before /:id, action verbs before plain :id put ──
router.get('/purchase-orders',            allowRoles(ANY),  AsyncHandler(listPurchaseOrders));
router.get('/purchase-orders/:id',        allowRoles(ANY),  AsyncHandler(getPurchaseOrder));
router.post('/purchase-orders',           allowRoles(ADMIN), AsyncHandler(createPurchaseOrder));
router.put('/purchase-orders/:id',        allowRoles(ADMIN), AsyncHandler(updatePurchaseOrder));
router.delete('/purchase-orders/:id',     allowRoles(ADMIN), AsyncHandler(deletePurchaseOrder));
router.post('/purchase-orders/:id/send',    allowRoles(ADMIN), AsyncHandler(sendPurchaseOrder));
router.post('/purchase-orders/:id/invoice', allowRoles(ADMIN), AsyncHandler(logSupplierInvoice));
router.post('/purchase-orders/:id/receive', allowRoles(ANY),   AsyncHandler(receivePurchaseOrder)); // clerk receives
router.post('/purchase-orders/:id/request-payment', allowRoles(ADMIN), upload.single('paymentEvidence'), AsyncHandler(requestPoPayment));

// ── Transfers ─────────────────────────────────────────────────────────────────
router.get('/transfers',             allowRoles(ANY), AsyncHandler(listTransfers));
router.get('/transfers/:id',         allowRoles(ANY), AsyncHandler(getTransfer));
router.post('/transfers',            allowRoles(ANY), AsyncHandler(requestTransfer)); // manager/clerk/admin can request
router.post('/transfers/:id/approve', allowRoles(ANY), AsyncHandler(approveTransfer)); // admin/clerk only, checked in handler
router.post('/transfers/:id/reject',  allowRoles(ANY), AsyncHandler(rejectTransfer));
router.post('/transfers/:id/receive', allowRoles(ANY), AsyncHandler(receiveTransfer));

// ── Items — plain :id routes last ────────────────────────────────────────────
router.get('/items/suggest-sku', allowRoles(ANY),  AsyncHandler(suggestSku));
router.get('/items',            allowRoles(ANY),   AsyncHandler(listItems));
router.get('/items/:id',        allowRoles(ANY),   AsyncHandler(getItem));
router.post('/items',           allowRoles(ADMIN),  AsyncHandler(createItem));
router.put('/items/:id',        allowRoles(ADMIN),  AsyncHandler(updateItem));
router.delete('/items/:id',     allowRoles(ADMIN),  AsyncHandler(archiveItem));
router.post('/items/:id/image', allowRoles(ADMIN), upload.single('image'), AsyncHandler(uploadItemImage));

module.exports = router;
