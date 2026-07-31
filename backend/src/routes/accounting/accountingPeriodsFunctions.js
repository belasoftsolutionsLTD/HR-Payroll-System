const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');

const listPeriods = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level || level === 'viewer') return returnFunction(res, 403, false, 'Not authorized.');
  const periods = await findMany('gl_accounting_periods', {}, { sort: { year: -1, month: -1 } });
  return returnFunction(res, 200, true, req.locale.success, periods);
};

const closePeriod = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only an accounting admin can close a period.');
  if (!validateRequiredFields(req, res, ['year', 'month'])) return;

  const year = Number(req.body.year);
  const month = Number(req.body.month);
  const existing = await findOne('gl_accounting_periods', { year, month });
  if (existing) {
    await updateOne('gl_accounting_periods', { _id: existing._id }, { $set: { status: 'closed', closedAt: new Date(), closedBy: req.user._id } });
  } else {
    await insertOne('gl_accounting_periods', { year, month, status: 'closed', closedAt: new Date(), closedBy: req.user._id, createdAt: new Date() });
  }
  return returnFunction(res, 200, true, `Period ${month}/${year} closed.`);
};

const reopenPeriod = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only an accounting admin can reopen a period.');
  const year = Number(req.body.year);
  const month = Number(req.body.month);
  const existing = await findOne('gl_accounting_periods', { year, month });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('gl_accounting_periods', { _id: existing._id }, { $set: { status: 'open' }, $unset: { closedAt: '', closedBy: '' } });
  return returnFunction(res, 200, true, `Period ${month}/${year} reopened.`);
};

module.exports = { listPeriods, closePeriod, reopenPeriod };
