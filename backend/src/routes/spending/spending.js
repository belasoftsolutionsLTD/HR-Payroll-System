const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, MGMT_ROLES, ALL_ROLES } = require('../../constants/roles');
const {
  listCards, createCard, updateCard,
  listTransactions, addTransaction,
  listInvoices, createInvoice, approveInvoice, rejectInvoice, markPaid,
  listPurchaseRequests, createPurchaseRequest, approvePurchaseRequest, rejectPurchaseRequest,
} = require('./spendingFunctions');

const hrOnly   = allowRoles(HR_ROLES);
const mgmtOnly = allowRoles(MGMT_ROLES);
const allRoles = allowRoles(ALL_ROLES);

// ── Corporate Cards ───────────────────────────────────────────────────────────
router.get('/cards',     hrOnly,   AsyncHandler(listCards));
router.post('/cards',    hrOnly,   AsyncHandler(createCard));
router.put('/cards/:id', hrOnly,   AsyncHandler(updateCard));

// ── Card Transactions ─────────────────────────────────────────────────────────
router.get('/cards/:cardId/transactions',  hrOnly,   AsyncHandler(listTransactions));
router.post('/cards/:cardId/transactions', hrOnly,   AsyncHandler(addTransaction));

// ── All Transactions (cross-card) ─────────────────────────────────────────────
router.get('/transactions', hrOnly, AsyncHandler(listTransactions));

// ── Invoices ──────────────────────────────────────────────────────────────────
router.get('/invoices',           hrOnly,   AsyncHandler(listInvoices));
router.post('/invoices',          hrOnly,   AsyncHandler(createInvoice));
router.put('/invoices/:id/approve', hrOnly, AsyncHandler(approveInvoice));
router.put('/invoices/:id/reject',  hrOnly, AsyncHandler(rejectInvoice));
router.put('/invoices/:id/pay',     hrOnly, AsyncHandler(markPaid));

// ── Procurement (Purchase Requests) ───────────────────────────────────────────
router.get('/procurement',                      allRoles,  AsyncHandler(listPurchaseRequests));
router.post('/procurement',                     allRoles,  AsyncHandler(createPurchaseRequest));
router.put('/procurement/:id/approve',          mgmtOnly,  AsyncHandler(approvePurchaseRequest));
router.put('/procurement/:id/reject',           mgmtOnly,  AsyncHandler(rejectPurchaseRequest));

module.exports = router;
