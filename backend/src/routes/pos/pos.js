const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { ALL_ROLES, HR_ROLES } = require('../../constants/roles');

const { getCurrentSession, openRegister, closeRegister, listSessions } = require('./posRegisterFunctions');
const { createSale, getSale, listSales, voidSale, getReceipt } = require('./posSalesFunctions');
const { createRefund, listRefunds } = require('./posRefundsFunctions');
const { listPromoCodes, createPromoCode, updatePromoCode, deletePromoCode, checkPromoCode } = require('./posDiscountsFunctions');
const { listVouchers, createVoucher, updateVoucher, deleteVoucher, checkVoucher } = require('./posVouchersFunctions');
const { getDailySummary, getSalesByStaff, exportSalesCSV } = require('./posReportsFunctions');
const { listStaffAccess, setStaffLocations, getMyAccessLevel } = require('./posStaffAccessFunctions');
const { listLocations, listStockLevelsForLocation, listSellableItems } = require('./posInventoryFunctions');

// Broad gate at the route level, real authorization inside each handler via
// getPosAccessLevel — identical layered convention to Inventory's routes.
const ANY = ALL_ROLES;
const ADMIN = HR_ROLES;

router.get('/my-access', allowRoles(ANY), AsyncHandler(getMyAccessLevel));

// POS's own read-only view into Inventory's data (locations, live stock, item catalog)
// — scoped by POS's own access level, not Inventory's (see posInventoryFunctions.js
// for why those two must stay separate).
router.get('/locations', allowRoles(ANY), AsyncHandler(listLocations));
router.get('/stock-levels', allowRoles(ANY), AsyncHandler(listStockLevelsForLocation));
router.get('/items', allowRoles(ANY), AsyncHandler(listSellableItems));

// ── Register sessions ─────────────────────────────────────────────────────────
router.get('/register/current',  allowRoles(ANY), AsyncHandler(getCurrentSession));
router.post('/register/open',    allowRoles(ANY), AsyncHandler(openRegister));
router.post('/register/close',   allowRoles(ANY), AsyncHandler(closeRegister));
router.get('/register/sessions', allowRoles(ANY), AsyncHandler(listSessions)); // admin/manager checked in handler

// ── Promo codes ──────────────────────────────────────────────────────────────
router.get('/promo-codes',             allowRoles(ANY),   AsyncHandler(listPromoCodes));
router.get('/promo-codes/check/:code', allowRoles(ANY),   AsyncHandler(checkPromoCode));
router.post('/promo-codes',            allowRoles(ADMIN), AsyncHandler(createPromoCode));
router.put('/promo-codes/:id',         allowRoles(ADMIN), AsyncHandler(updatePromoCode));
router.delete('/promo-codes/:id',      allowRoles(ADMIN), AsyncHandler(deletePromoCode));

// ── Vouchers (fixed-value, company-funded, single-use — separate from promo codes) ──
router.get('/vouchers',             allowRoles(ANY),   AsyncHandler(listVouchers));
router.get('/vouchers/check/:code', allowRoles(ANY),   AsyncHandler(checkVoucher));
router.post('/vouchers',            allowRoles(ADMIN), AsyncHandler(createVoucher));
router.put('/vouchers/:id',         allowRoles(ADMIN), AsyncHandler(updateVoucher));
router.delete('/vouchers/:id',      allowRoles(ADMIN), AsyncHandler(deleteVoucher));

// ── Staff access (posLocationIds assignment) ──────────────────────────────────
router.get('/staff-access',           allowRoles(ADMIN), AsyncHandler(listStaffAccess));
router.patch('/staff-access/:userId', allowRoles(ADMIN), AsyncHandler(setStaffLocations));

// ── Reports — specific paths before /sales/:id ────────────────────────────────
router.get('/reports/daily-summary',  allowRoles(ANY), AsyncHandler(getDailySummary));
router.get('/reports/sales-by-staff', allowRoles(ANY), AsyncHandler(getSalesByStaff));
router.get('/sales/export',           allowRoles(ANY), AsyncHandler(exportSalesCSV));

// ── Refunds ───────────────────────────────────────────────────────────────────
router.get('/refunds',  allowRoles(ANY), AsyncHandler(listRefunds));
router.post('/refunds', allowRoles(ANY), AsyncHandler(createRefund)); // manager/admin checked in handler

// ── Sales ─────────────────────────────────────────────────────────────────────
router.get('/sales',              allowRoles(ANY), AsyncHandler(listSales));
router.post('/sales',             allowRoles(ANY), AsyncHandler(createSale));
router.get('/sales/:id',          allowRoles(ANY), AsyncHandler(getSale));
router.get('/sales/:id/receipt',  allowRoles(ANY), AsyncHandler(getReceipt));
router.post('/sales/:id/void',    allowRoles(ANY), AsyncHandler(voidSale)); // manager/admin checked in handler

module.exports = router;
