const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, MGMT_ROLES, ALL_ROLES } = require('../../constants/roles');
const { listExpenses, recordExpenses, updateExpense, deleteExpense } = require('./expenseFunctions');
const { listClaims, getClaim, submitClaim, updateClaim, deleteClaim, disputeClaim, approveClaim, rejectClaim, markReimbursed, exportClaims, getAnalytics, getPolicy, updatePolicy, calculateDistance } = require('./expenseClaimsFunctions');

const upload = multer({
  dest: process.env.UPLOAD_DIR || 'uploads',
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max for receipts
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only JPEG, PNG, WebP and PDF files are allowed for receipts.'), allowed.includes(file.mimetype));
  },
});

const hrOnly   = allowRoles(HR_ROLES);
const mgmtOnly = allowRoles(MGMT_ROLES);
const allRoles = allowRoles(ALL_ROLES);

// ── New expense claims (all employees + manager approval) ─────────────────────
router.get('/expense-claims/export',      hrOnly,   AsyncHandler(exportClaims));
router.get('/expense-claims/analytics',   hrOnly,   AsyncHandler(getAnalytics));
router.get('/expense-claims/policy',      hrOnly,   AsyncHandler(getPolicy));
router.put('/expense-claims/policy',      hrOnly,   AsyncHandler(updatePolicy));
router.post('/expense-claims/calculate-distance', allRoles, AsyncHandler(calculateDistance));
router.get('/expense-claims',             allRoles,  AsyncHandler(listClaims));
router.post('/expense-claims',            allRoles,  upload.single('receipt'), AsyncHandler(submitClaim));
router.get('/expense-claims/:id',         allRoles,  AsyncHandler(getClaim));
router.put('/expense-claims/:id',         allRoles,  AsyncHandler(updateClaim));
router.delete('/expense-claims/:id',      allRoles,  AsyncHandler(deleteClaim));
router.put('/expense-claims/:id/dispute', allRoles,  AsyncHandler(disputeClaim));
router.put('/expense-claims/:id/approve',    mgmtOnly,  AsyncHandler(approveClaim));
router.put('/expense-claims/:id/reject',     mgmtOnly,  AsyncHandler(rejectClaim));
router.put('/expense-claims/:id/reimburse',  hrOnly,    AsyncHandler(markReimbursed));

// ── Legacy expense routes (preserved) ────────────────────────────────────────
router.get('/expenses',        hrOnly, AsyncHandler(listExpenses));
router.post('/expenses/batch', hrOnly, AsyncHandler(recordExpenses));
router.put('/expenses/:id',    hrOnly, AsyncHandler(updateExpense));
router.delete('/expenses/:id', hrOnly, AsyncHandler(deleteExpense));

module.exports = router;
