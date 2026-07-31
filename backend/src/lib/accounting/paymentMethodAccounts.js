// Shared across every module's payment/reimbursement journal-entry hook (Inventory PO
// close, Spending vendor-invoice payment, Payroll mark-paid, Expense reimbursement) —
// all of them draw from the same 4-value method list (PAYMENT_METHODS in
// inventoryPurchaseOrdersFunctions.js, REIMBURSEMENT_METHODS in expenseClaimsFunctions.js).
// Card/M-Pesa settle through a processor rather than landing as physical cash-on-hand,
// so they resolve to the same clearing accounts POS sales already use.
const GENERIC_PAYMENT_SYSTEM_KEYS = {
  bank_transfer: 'bank',
  cheque: 'bank',
  cash: 'cash',
  mpesa: 'pos_mpesa_clearing',
};

const resolvePaymentSystemKey = (method) => GENERIC_PAYMENT_SYSTEM_KEYS[method] || 'bank';

module.exports = { GENERIC_PAYMENT_SYSTEM_KEYS, resolvePaymentSystemKey };
