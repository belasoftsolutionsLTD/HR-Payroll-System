const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');
const { postJournalEntry } = require('../../lib/accounting/glEngine');

// Every automatic posting call site across POS/Inventory/Payroll/Spending wraps
// postJournalEntry in try/catch and logs here on failure — the source transaction (a
// sale, a PO receipt, a payroll close) always succeeds regardless, since Accounting is
// layered on top of four already-shipped, load-bearing modules that must never be
// blocked by a missing systemKey account or a closed period. This queue is how an admin
// notices and fixes that instead of the gap going unnoticed.
const logPostingFailure = async ({ source, sourceModule, referenceId, referenceModel, attemptedPayload, error }) => {
  await insertOne('gl_posting_failures', {
    source, sourceModule, referenceId: referenceId || null, referenceModel: referenceModel || null,
    attemptedPayload, error: error?.message || String(error),
    resolved: false, resolvedAt: null, resolvedBy: null,
    createdAt: new Date(),
  });
};

const listPostingFailures = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const filter = {};
  if (req.query.resolved !== undefined) filter.resolved = req.query.resolved === 'true';
  const failures = await findMany('gl_posting_failures', filter, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, failures);
};

const retryPostingFailure = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const failure = await findOne('gl_posting_failures', { _id: new ObjectId(req.params.id) });
  if (!failure) return returnFunction(res, 404, false, req.locale.notFound);
  if (failure.resolved) return returnFunction(res, 400, false, 'This failure was already resolved.');

  try {
    const entry = await postJournalEntry({ ...failure.attemptedPayload, postedBy: req.user._id });
    await updateOne('gl_posting_failures', { _id: failure._id }, { $set: { resolved: true, resolvedAt: new Date(), resolvedBy: req.user._id } });
    return returnFunction(res, 200, true, 'Posted successfully.', entry);
  } catch (err) {
    return returnFunction(res, 400, false, `Retry failed: ${err.message}`);
  }
};

const dismissPostingFailure = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  await updateOne('gl_posting_failures', { _id: new ObjectId(req.params.id) }, { $set: { resolved: true, resolvedAt: new Date(), resolvedBy: req.user._id } });
  return returnFunction(res, 200, true, 'Dismissed.');
};

module.exports = { logPostingFailure, listPostingFailures, retryPostingFailure, dismissPostingFailure };
