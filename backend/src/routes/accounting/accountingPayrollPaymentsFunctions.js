// Postgres migration (Phase 7) — gl_journal_entries is Postgres now; payroll_cycles has
// been Postgres since Phase 2, but this file was still reading it off the Mongo helper
// (found while sweeping for Phase 7 — the same "shared cross-module file lands on a
// stale Mongo helper" pattern every phase so far has hit at least once).
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');
const { postJournalEntry, resolveSystemAccount } = require('../../lib/accounting/glEngine');
const { resolvePaymentSystemKey, GENERIC_PAYMENT_SYSTEM_KEYS } = require('../../lib/accounting/paymentMethodAccounts');
const { logPostingFailure } = require('./accountingPostingFailuresFunctions');

const round2 = (n) => Math.round(n * 100) / 100;

// The payment-confirmation step Payroll itself doesn't have — closeCycleInternal posts
// Salary Expense/Payable (a liability) but nothing in Payroll ever confirms the bank
// transfer actually happened. Built here, in Accounting, since the trigger genuinely
// belongs to whoever controls the books, not to Payroll's own close action.
const markPayrollCyclePaid = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['paymentMethod', 'paymentReference'])) return;
  if (!Object.keys(GENERIC_PAYMENT_SYSTEM_KEYS).includes(req.body.paymentMethod)) {
    return returnFunction(res, 400, false, `paymentMethod must be one of: ${Object.keys(GENERIC_PAYMENT_SYSTEM_KEYS).join(', ')}`);
  }

  const cycle = await knex('payroll_cycles').where({ id: req.params.cycleId }).first();
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  if (cycle.status !== 'closed') return returnFunction(res, 400, false, 'Only a closed payroll cycle can be marked paid.');

  const closeEntry = await knex('gl_journal_entries').where({ referenceId: cycle.id, referenceModel: 'payroll_cycles', source: 'payroll_cycle_close', status: 'posted' }).first();
  if (!closeEntry) return returnFunction(res, 400, false, 'No posted payroll close entry was found for this cycle — nothing to pay.');
  const alreadyPaid = await knex('gl_journal_entries').where({ referenceId: cycle.id, referenceModel: 'payroll_cycles', source: 'payroll_payment', status: 'posted' }).first();
  if (alreadyPaid) return returnFunction(res, 409, false, 'This payroll cycle has already been marked paid.');

  const totalNet = round2(closeEntry.lines.filter((l) => l.debit > 0).reduce((s, l) => s + l.debit, 0));
  const payload = {
    date: new Date(), description: `Payroll payment — cycle ${cycle.id} (${req.body.paymentReference})`, source: 'payroll_payment', sourceModule: 'accounting',
    referenceId: cycle.id, referenceModel: 'payroll_cycles', lines: [],
  };
  try {
    const payableAcct = await resolveSystemAccount('salary_payable');
    const paymentAcct = await resolveSystemAccount(resolvePaymentSystemKey(req.body.paymentMethod));
    payload.lines = [{ accountId: payableAcct._id, debit: totalNet }, { accountId: paymentAcct._id, credit: totalNet }];
    const entry = await postJournalEntry({ ...payload, postedBy: req.user._id });
    return returnFunction(res, 201, true, 'Payroll cycle marked paid.', entry);
  } catch (err) {
    await logPostingFailure({ source: 'payroll_payment', sourceModule: 'accounting', referenceId: cycle.id, referenceModel: 'payroll_cycles', attemptedPayload: payload, error: err });
    return returnFunction(res, 400, false, `Could not post payment entry: ${err.message}`);
  }
};

module.exports = { markPayrollCyclePaid };
