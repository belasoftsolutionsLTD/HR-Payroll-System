const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, ALL_ROLES } = require('../../constants/roles');
const { listExpenses, recordExpenses, updateExpense, deleteExpense } = require('./expenseFunctions');
const {
  listClaims, getClaim, submitClaim, updateClaim, deleteClaim, disputeClaim, approveClaim, rejectClaim,
  markReimbursed, exportClaims, getAnalytics, getPolicy, updatePolicy, calculateDistance,
  listPolicies, createPolicy, getPolicyById, updatePolicyById, deletePolicyById,
} = require('./expenseClaimsFunctions');

// diskStorage + timestamp-prefixed-original-filename, matching the convention used
// everywhere else in the app (training.js, employees.js, messages.js, etc). The old
// `dest` shorthand generated random filenames with NO extension, which silently broke
// image-receipt previews in ExpensesPage.tsx (its image-vs-file-link check is a
// regex against the filename's extension).
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max for receipts
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only JPEG, PNG, WebP and PDF files are allowed for receipts.'), allowed.includes(file.mimetype));
  },
});

const hrOnly   = allowRoles(HR_ROLES);
const allRoles = allowRoles(ALL_ROLES);

// ── New expense claims (all employees + manager approval) ─────────────────────
router.get('/expense-claims/export',      hrOnly,   AsyncHandler(exportClaims));
// hrOnly was too tight — department_head/managers get their own scoped analytics now
// (getAnalytics applies buildSpendScopeFilter internally); HR still sees org-wide.
router.get('/expense-claims/analytics',   allRoles, AsyncHandler(getAnalytics));
router.get('/expense-claims/policy',      hrOnly,   AsyncHandler(getPolicy));
router.put('/expense-claims/policy',      hrOnly,   AsyncHandler(updatePolicy));
router.get('/expense-claims/policies',       hrOnly, AsyncHandler(listPolicies));
router.post('/expense-claims/policies',      hrOnly, AsyncHandler(createPolicy));
router.get('/expense-claims/policies/:id',   hrOnly, AsyncHandler(getPolicyById));
router.patch('/expense-claims/policies/:id', hrOnly, AsyncHandler(updatePolicyById));
router.delete('/expense-claims/policies/:id',hrOnly, AsyncHandler(deletePolicyById));
router.post('/expense-claims/calculate-distance', allRoles, AsyncHandler(calculateDistance));
router.get('/expense-claims',             allRoles,  AsyncHandler(listClaims));
router.post('/expense-claims',            allRoles,  upload.single('receipt'), AsyncHandler(submitClaim));
router.get('/expense-claims/:id',         allRoles,  AsyncHandler(getClaim));
router.put('/expense-claims/:id',         allRoles,  AsyncHandler(updateClaim));
router.delete('/expense-claims/:id',      allRoles,  AsyncHandler(deleteClaim));
router.put('/expense-claims/:id/dispute', allRoles,  AsyncHandler(disputeClaim));
// mgmtOnly is too tight here: a level-1 approver is often a plain 'staff' user who
// happens to be someone's manager (employees.managerId), not a role. Real
// authorization is enforced per-level inside approveClaim/rejectClaim (canActOnLevel).
router.put('/expense-claims/:id/approve',    allRoles,  AsyncHandler(approveClaim));
router.put('/expense-claims/:id/reject',     allRoles,  AsyncHandler(rejectClaim));
router.put('/expense-claims/:id/reimburse',  hrOnly,    AsyncHandler(markReimbursed));

// ── Legacy expense routes (preserved) ────────────────────────────────────────
router.get('/expenses',        hrOnly, AsyncHandler(listExpenses));
router.post('/expenses/batch', hrOnly, AsyncHandler(recordExpenses));
router.put('/expenses/:id',    hrOnly, AsyncHandler(updateExpense));
router.delete('/expenses/:id', hrOnly, AsyncHandler(deleteExpense));

module.exports = router;
