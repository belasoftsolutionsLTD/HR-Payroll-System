// Postgres migration (Phase 8) — expense_claims/purchase_requests are Postgres now.
// employeeId is now a plain string, not a Mongo ObjectId — callers (offboardingFunctions.js)
// no longer need to wrap it.
const { knex } = require('../../functions/Database/pgDBFunctions');

// Used by offboarding to block completion while an employee still has open spend items.
// "Open" = anything not yet in a terminal state: expense claims still submitted/disputed
// (not yet approved/rejected/reimbursed), and purchase requests still pending (not yet
// approved/rejected/converted).
const getOpenSpendItems = async (employeeId) => {
  const [openClaims, openRequests] = await Promise.all([
    knex('expense_claims').where({ employeeId: String(employeeId) }).whereIn('status', ['submitted', 'disputed'])
      .select('id', 'description', 'amount', 'currency', 'status'),
    knex('purchase_requests').where({ employeeId: String(employeeId), status: 'pending' })
      .select('id', 'title', 'estimatedCost', 'currency', 'status'),
  ]);
  return { openClaims, openRequests, hasOpenItems: openClaims.length > 0 || openRequests.length > 0 };
};

module.exports = { getOpenSpendItems };
