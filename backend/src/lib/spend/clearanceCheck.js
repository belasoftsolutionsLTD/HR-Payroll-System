const { findMany } = require('../../functions/Database/commonDBFunctions');

// Used by offboarding to block completion while an employee still has open spend items.
// "Open" = anything not yet in a terminal state: expense claims still submitted/disputed
// (not yet approved/rejected/reimbursed), and purchase requests still pending (not yet
// approved/rejected/converted).
const getOpenSpendItems = async (employeeId) => {
  const [openClaims, openRequests] = await Promise.all([
    findMany('expense_claims', { employeeId, status: { $in: ['submitted', 'disputed'] } },
      { projection: { title: 1, description: 1, amount: 1, currency: 1, status: 1 } }),
    findMany('purchase_requests', { employeeId, status: 'pending' },
      { projection: { title: 1, estimatedCost: 1, currency: 1, status: 1 } }),
  ]);
  return { openClaims, openRequests, hasOpenItems: openClaims.length > 0 || openRequests.length > 0 };
};

module.exports = { getOpenSpendItems };
