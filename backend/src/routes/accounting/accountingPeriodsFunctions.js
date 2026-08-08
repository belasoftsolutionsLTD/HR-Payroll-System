// Postgres migration (Phase 7) — gl_accounting_periods is Postgres now.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');

const listPeriods = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level || level === 'viewer') return returnFunction(res, 403, false, 'Not authorized.');
  const periods = await knex('gl_accounting_periods').orderBy('year', 'desc').orderBy('month', 'desc');
  return returnFunction(res, 200, true, req.locale.success, periods);
};

const closePeriod = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only an accounting admin can close a period.');
  if (!validateRequiredFields(req, res, ['year', 'month'])) return;

  const year = Number(req.body.year);
  const month = Number(req.body.month);
  const existing = await knex('gl_accounting_periods').where({ year, month }).first();
  if (existing) {
    await knex('gl_accounting_periods').where({ id: existing.id }).update({ status: 'closed', closedAt: new Date(), closedBy: req.user.id });
  } else {
    await knex('gl_accounting_periods').insert({ id: newId(), year, month, status: 'closed', closedAt: new Date(), closedBy: req.user.id, createdAt: new Date() });
  }
  return returnFunction(res, 200, true, `Period ${month}/${year} closed.`);
};

const reopenPeriod = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only an accounting admin can reopen a period.');
  const year = Number(req.body.year);
  const month = Number(req.body.month);
  const existing = await knex('gl_accounting_periods').where({ year, month }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('gl_accounting_periods').where({ id: existing.id }).update({ status: 'open', closedAt: null, closedBy: null });
  return returnFunction(res, 200, true, `Period ${month}/${year} reopened.`);
};

module.exports = { listPeriods, closePeriod, reopenPeriod };
