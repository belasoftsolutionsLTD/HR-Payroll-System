const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, MGMT_ROLES, ALL_ROLES } = require('../../constants/roles');
const {
  listCards, createCard, updateCard,
  listTransactions, addTransaction,
  listInvoices, createInvoice, approveInvoice, rejectInvoice, markPaid,
  listPurchaseRequests, getPurchaseRequest, createPurchaseRequest, updatePurchaseRequest,
  approvePurchaseRequest, rejectPurchaseRequest,
  listVendors, getVendor, createVendor, updateVendor, deleteVendor, approveVendor, rejectVendor,
  listProcurementPolicies, getProcurementPolicy, createProcurementPolicy, updateProcurementPolicy, deleteProcurementPolicy,
  convertRequisitionToPO,
  listPurchaseOrders, getPurchaseOrder, updatePurchaseOrder, sendPurchaseOrder, acknowledgePurchaseOrder, cancelPurchaseOrder,
  listGoodsReceipts, getGoodsReceipt, createGoodsReceipt,
  listVendorInvoices, getVendorInvoice, createVendorInvoice, matchVendorInvoice, approveVendorInvoice, disputeVendorInvoice, payVendorInvoice,
  getProcurementOverview, getProcurementSpend, getVendorAnalytics, getCycleTimeAnalytics,
} = require('./spendingFunctions');

const hrOnly    = allowRoles(HR_ROLES);
const deptHeadUp = allowRoles([...MGMT_ROLES]); // super_admin/hr_manager/department_head
const allRoles  = allowRoles(ALL_ROLES);

// diskStorage + timestamp-prefixed-original-filename, matching the convention used
// elsewhere in the app (expenses.js, training.js, employees.js).
const vendorDocUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only JPEG, PNG, WebP and PDF files are allowed.'), allowed.includes(file.mimetype));
  },
});
const vendorDocFields = vendorDocUpload.fields([
  { name: 'kraPinCertificate', maxCount: 1 },
  { name: 'registrationCertificate', maxCount: 1 },
  { name: 'businessPermit', maxCount: 1 },
]);

// ── Corporate Cards ───────────────────────────────────────────────────────────
router.get('/cards',     hrOnly,   AsyncHandler(listCards));
router.post('/cards',    hrOnly,   AsyncHandler(createCard));
router.put('/cards/:id', hrOnly,   AsyncHandler(updateCard));

// ── Card Transactions ─────────────────────────────────────────────────────────
router.get('/cards/:cardId/transactions',  hrOnly,   AsyncHandler(listTransactions));
router.post('/cards/:cardId/transactions', hrOnly,   AsyncHandler(addTransaction));

// ── All Transactions (cross-card) ─────────────────────────────────────────────
router.get('/transactions', hrOnly, AsyncHandler(listTransactions));

// ── Invoices (legacy AP/AR — preserved) ───────────────────────────────────────
router.get('/invoices',           hrOnly,   AsyncHandler(listInvoices));
router.post('/invoices',          hrOnly,   AsyncHandler(createInvoice));
router.put('/invoices/:id/approve', hrOnly, AsyncHandler(approveInvoice));
router.put('/invoices/:id/reject',  hrOnly, AsyncHandler(rejectInvoice));
router.put('/invoices/:id/pay',     hrOnly, AsyncHandler(markPaid));

// ── Procurement — Vendors (all roles can view to select on a PR; HR manages) ──
router.get('/procurement/vendors',        allRoles, AsyncHandler(listVendors));
router.post('/procurement/vendors',       hrOnly,   vendorDocFields, AsyncHandler(createVendor));
router.get('/procurement/vendors/:id',    allRoles, AsyncHandler(getVendor));
router.patch('/procurement/vendors/:id',  hrOnly,   AsyncHandler(updateVendor));
router.delete('/procurement/vendors/:id', hrOnly,   AsyncHandler(deleteVendor));
router.patch('/procurement/vendors/:id/approve', hrOnly, AsyncHandler(approveVendor));
router.patch('/procurement/vendors/:id/reject',  hrOnly, AsyncHandler(rejectVendor));

// ── Procurement — Policies (HR only) ──────────────────────────────────────────
router.get('/procurement/policies',        hrOnly, AsyncHandler(listProcurementPolicies));
router.post('/procurement/policies',       hrOnly, AsyncHandler(createProcurementPolicy));
router.get('/procurement/policies/:id',    hrOnly, AsyncHandler(getProcurementPolicy));
router.patch('/procurement/policies/:id',  hrOnly, AsyncHandler(updateProcurementPolicy));
router.delete('/procurement/policies/:id', hrOnly, AsyncHandler(deleteProcurementPolicy));

// ── Procurement — Analytics (role-scoped inside the handler) ─────────────────
router.get('/procurement/analytics/overview',   allRoles, AsyncHandler(getProcurementOverview));
router.get('/procurement/analytics/spend',      allRoles, AsyncHandler(getProcurementSpend));
router.get('/procurement/analytics/vendors',    hrOnly,   AsyncHandler(getVendorAnalytics));
router.get('/procurement/analytics/cycle-time', hrOnly,   AsyncHandler(getCycleTimeAnalytics));

// ── Procurement — Purchase Requests (all roles create; scoped viewing/approval) ─
// mgmtOnly is too tight for approve/reject — a level-1 approver is often a plain
// 'staff' user (employees.managerId), not a role. Real authorization is enforced
// per-level inside approvePurchaseRequest/rejectPurchaseRequest (canActOnLevel).
router.get('/procurement',                allRoles,  AsyncHandler(listPurchaseRequests));
router.post('/procurement',               allRoles,  AsyncHandler(createPurchaseRequest));
router.get('/procurement/:id',            allRoles,  AsyncHandler(getPurchaseRequest));
router.patch('/procurement/:id',          allRoles,  AsyncHandler(updatePurchaseRequest));
router.put('/procurement/:id/approve',    allRoles,  AsyncHandler(approvePurchaseRequest));
router.put('/procurement/:id/reject',     allRoles,  AsyncHandler(rejectPurchaseRequest));
router.post('/procurement/:id/convert',   hrOnly,    AsyncHandler(convertRequisitionToPO));

// ── Procurement — Purchase Orders (HR manage; department_head view-only scoped) ─
router.get('/procurement-orders',              deptHeadUp, AsyncHandler(listPurchaseOrders));
router.get('/procurement-orders/:id',          deptHeadUp, AsyncHandler(getPurchaseOrder));
router.patch('/procurement-orders/:id',        hrOnly,     AsyncHandler(updatePurchaseOrder));
router.put('/procurement-orders/:id/send',        hrOnly,  AsyncHandler(sendPurchaseOrder));
router.put('/procurement-orders/:id/acknowledge', hrOnly,  AsyncHandler(acknowledgePurchaseOrder));
router.delete('/procurement-orders/:id',       hrOnly,     AsyncHandler(cancelPurchaseOrder));

// ── Procurement — Goods Receipts (any role can log a delivery they received) ──
router.post('/procurement-receipts',      allRoles,   AsyncHandler(createGoodsReceipt));
router.get('/procurement-receipts',       deptHeadUp, AsyncHandler(listGoodsReceipts));
router.get('/procurement-receipts/:id',   deptHeadUp, AsyncHandler(getGoodsReceipt));

// ── Procurement — Vendor Invoices (HR only) ───────────────────────────────────
router.post('/procurement-invoices',              hrOnly, AsyncHandler(createVendorInvoice));
router.get('/procurement-invoices',               hrOnly, AsyncHandler(listVendorInvoices));
router.get('/procurement-invoices/:id',           hrOnly, AsyncHandler(getVendorInvoice));
router.patch('/procurement-invoices/:id/match',   hrOnly, AsyncHandler(matchVendorInvoice));
router.patch('/procurement-invoices/:id/approve', hrOnly, AsyncHandler(approveVendorInvoice));
router.patch('/procurement-invoices/:id/dispute', hrOnly, AsyncHandler(disputeVendorInvoice));
router.patch('/procurement-invoices/:id/pay',     hrOnly, AsyncHandler(payVendorInvoice));

module.exports = router;
