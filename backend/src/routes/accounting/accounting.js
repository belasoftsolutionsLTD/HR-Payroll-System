const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { MGMT_ROLES, HR_ROLES } = require('../../constants/roles');

const {
  listAccounts, getAccount, createAccount, updateAccount, archiveAccount, seedDefaultChartOfAccounts,
} = require('./accountingChartFunctions');
const {
  listJournalEntries, getJournalEntry, createManualJournalEntry, reverseJournalEntryHandler,
} = require('./accountingJournalFunctions');
const { listPeriods, closePeriod, reopenPeriod } = require('./accountingPeriodsFunctions');
const { listPostingFailures, retryPostingFailure, dismissPostingFailure } = require('./accountingPostingFailuresFunctions');
const { getMyAccessLevel } = require('./accountingStaffAccessFunctions');
const { getGeneralLedgerDetail, getTrialBalance, exportTrialBalanceCSV, getBalanceSheet, getIncomeStatement, exportBalanceSheetCSV } = require('./accountingReportsFunctions');
const { markPayrollCyclePaid } = require('./accountingPayrollPaymentsFunctions');
const { listPendingPoPayments, approvePoPayment, rejectPoPayment } = require('./accountingPoPaymentsFunctions');
const { listArInvoices, getArInvoice, createArInvoice, sendArInvoice, recordArPayment } = require('./accountingArFunctions');
const { listApBills, getApBill, createApBill, approveApBill, scheduleApBill, payApBill } = require('./accountingApFunctions');
const { importBankStatement, listImports, getImport, autoMatchStatementLines, manualMatchLine, unmatchLine, reconcilePeriod } = require('./accountingReconciliationFunctions');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
    filename: (req, file, cb) => cb(null, `accounting-${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Broad gate at the route level — VIEW blocks plain staff outright (unlike Inventory,
// Accounting has no clerk-style operational tier for staff at all), WRITE narrows further
// to the two roles that can transact. Real authorization still happens inside each
// handler via getAccountingAccessLevel, same layered convention as every other module.
const VIEW = MGMT_ROLES;
const WRITE = HR_ROLES;

router.get('/my-access', allowRoles(VIEW), AsyncHandler(getMyAccessLevel));

// ── Chart of Accounts ────────────────────────────────────────────────────────
router.get('/chart-of-accounts',                allowRoles(VIEW),  AsyncHandler(listAccounts));
router.get('/chart-of-accounts/:id',             allowRoles(VIEW),  AsyncHandler(getAccount));
router.post('/chart-of-accounts',                allowRoles(WRITE), AsyncHandler(createAccount));
router.put('/chart-of-accounts/:id',             allowRoles(WRITE), AsyncHandler(updateAccount));
router.delete('/chart-of-accounts/:id',          allowRoles(WRITE), AsyncHandler(archiveAccount));
router.post('/chart-of-accounts/seed-defaults',  allowRoles(WRITE), AsyncHandler(seedDefaultChartOfAccounts));

// ── Journal entries ───────────────────────────────────────────────────────────
router.get('/journal-entries',            allowRoles(WRITE), AsyncHandler(listJournalEntries));
router.get('/journal-entries/:id',        allowRoles(WRITE), AsyncHandler(getJournalEntry));
router.post('/journal-entries',           allowRoles(WRITE), AsyncHandler(createManualJournalEntry));
router.post('/journal-entries/:id/reverse', allowRoles(WRITE), AsyncHandler(reverseJournalEntryHandler));

// ── Accounting periods ────────────────────────────────────────────────────────
router.get('/periods',        allowRoles(WRITE), AsyncHandler(listPeriods));
router.post('/periods/close', allowRoles(WRITE), AsyncHandler(closePeriod));
router.post('/periods/reopen', allowRoles(WRITE), AsyncHandler(reopenPeriod));

// ── Reports (General Ledger detail, Trial Balance) ────────────────────────────
router.get('/reports/general-ledger',        allowRoles(WRITE), AsyncHandler(getGeneralLedgerDetail));
router.get('/reports/trial-balance',          allowRoles(WRITE), AsyncHandler(getTrialBalance));
router.get('/reports/trial-balance/export',   allowRoles(WRITE), AsyncHandler(exportTrialBalanceCSV));
// Balance Sheet / Income Statement are open to VIEW (department_head gets these
// pre-aggregated, department-scoped reports — never the raw journal-entry list above,
// which stays WRITE-gated).
router.get('/reports/balance-sheet',          allowRoles(VIEW),  AsyncHandler(getBalanceSheet));
router.get('/reports/balance-sheet/export',   allowRoles(VIEW),  AsyncHandler(exportBalanceSheetCSV));
router.get('/reports/income-statement',       allowRoles(VIEW),  AsyncHandler(getIncomeStatement));

// ── Accounts Receivable (independent of POS — manual, credit-based sales) ─────
router.get('/ar-invoices',              allowRoles(WRITE), AsyncHandler(listArInvoices));
router.get('/ar-invoices/:id',          allowRoles(WRITE), AsyncHandler(getArInvoice));
router.post('/ar-invoices',             allowRoles(WRITE), AsyncHandler(createArInvoice));
router.post('/ar-invoices/:id/send',    allowRoles(WRITE), AsyncHandler(sendArInvoice));
router.post('/ar-invoices/:id/payments', allowRoles(WRITE), AsyncHandler(recordArPayment));

// ── Bills & Accounts Payable (manual entry, coexists with automatic AP triggers) ──
router.get('/ap-bills',                allowRoles(WRITE), AsyncHandler(listApBills));
router.get('/ap-bills/:id',            allowRoles(WRITE), AsyncHandler(getApBill));
router.post('/ap-bills',               allowRoles(WRITE), AsyncHandler(createApBill));
router.post('/ap-bills/:id/approve',   allowRoles(WRITE), AsyncHandler(approveApBill));
router.post('/ap-bills/:id/schedule',  allowRoles(WRITE), AsyncHandler(scheduleApBill));
router.post('/ap-bills/:id/pay',       allowRoles(WRITE), AsyncHandler(payApBill));

// ── Bank Reconciliation ────────────────────────────────────────────────────────
router.get('/reconciliation/imports',                    allowRoles(WRITE), AsyncHandler(listImports));
router.get('/reconciliation/imports/:id',                 allowRoles(WRITE), AsyncHandler(getImport));
router.post('/reconciliation/imports',                    allowRoles(WRITE), upload.single('statement'), AsyncHandler(importBankStatement));
router.post('/reconciliation/imports/:id/auto-match',     allowRoles(WRITE), AsyncHandler(autoMatchStatementLines));
router.post('/reconciliation/imports/:id/lines/:lineIndex/match',   allowRoles(WRITE), AsyncHandler(manualMatchLine));
router.post('/reconciliation/imports/:id/lines/:lineIndex/unmatch', allowRoles(WRITE), AsyncHandler(unmatchLine));
router.post('/reconciliation/imports/:id/reconcile',      allowRoles(WRITE), AsyncHandler(reconcilePeriod));

// ── Payroll payment (the confirmation step Payroll itself doesn't have) ───────
router.post('/payroll-cycles/:cycleId/mark-paid', allowRoles(WRITE), AsyncHandler(markPayrollCyclePaid));

router.get('/po-payments/pending',        allowRoles(WRITE), AsyncHandler(listPendingPoPayments));
router.post('/po-payments/:id/approve',   allowRoles(WRITE), AsyncHandler(approvePoPayment));
router.post('/po-payments/:id/reject',    allowRoles(WRITE), AsyncHandler(rejectPoPayment));

// ── Posting failures queue ────────────────────────────────────────────────────
router.get('/posting-failures',              allowRoles(WRITE), AsyncHandler(listPostingFailures));
router.post('/posting-failures/:id/retry',   allowRoles(WRITE), AsyncHandler(retryPostingFailure));
router.post('/posting-failures/:id/dismiss', allowRoles(WRITE), AsyncHandler(dismissPostingFailure));

module.exports = router;
