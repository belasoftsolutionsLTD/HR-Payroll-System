const returnFunction = require('../../functions/returnFunction');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');

// Used by the frontend nav (HrSidebar.tsx-style gating) and the Accounting page shell to
// decide what to render — mirrors getMyAccessLevel in every other module.
const getMyAccessLevel = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  return returnFunction(res, 200, true, req.locale.success, { level });
};

module.exports = { getMyAccessLevel };
