const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');
const { postJournalEntry, reverseJournalEntry } = require('../../lib/accounting/glEngine');

// Raw journal entries are never exposed to 'viewer' — per the module's role table,
// department_head-level access gets pre-aggregated REPORTS only (Phase 10), not the
// ledger detail itself. Enforced here explicitly, not just by the route-level gate.
const listJournalEntries = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level || level === 'viewer') return returnFunction(res, 403, false, 'Not authorized.');

  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.accountId) filter['lines.accountId'] = new ObjectId(req.query.accountId);
  if (req.query.source) filter.source = req.query.source;
  if (req.query.sourceModule) filter.sourceModule = req.query.sourceModule;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.startDate || req.query.endDate) {
    filter.date = {};
    if (req.query.startDate) filter.date.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.date.$lte = new Date(req.query.endDate);
  }

  const [total, entries] = await Promise.all([
    countDocuments('gl_journal_entries', filter),
    findMany('gl_journal_entries', filter, { skip, limit, sort: { date: -1, createdAt: -1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(entries, total, page, limit));
};

const getJournalEntry = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level || level === 'viewer') return returnFunction(res, 403, false, 'Not authorized.');
  const entry = await findOne('gl_journal_entries', { _id: new ObjectId(req.params.id) });
  if (!entry) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, entry);
};

const createManualJournalEntry = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['lines'])) return;

  try {
    const entry = await postJournalEntry({
      date: req.body.date, description: req.body.description, source: 'manual', sourceModule: 'accounting',
      referenceId: null, referenceModel: null, lines: req.body.lines, department: req.body.department || null,
      postedBy: req.user._id,
    });
    return returnFunction(res, 201, true, req.locale.createdSuccessfully, entry);
  } catch (err) {
    return returnFunction(res, 400, false, err.message);
  }
};

const reverseJournalEntryHandler = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  try {
    const reversal = await reverseJournalEntry(req.params.id, { reason: req.body.reason, postedBy: req.user._id });
    return returnFunction(res, 201, true, 'Journal entry reversed.', reversal);
  } catch (err) {
    return returnFunction(res, 400, false, err.message);
  }
};

module.exports = { listJournalEntries, getJournalEntry, createManualJournalEntry, reverseJournalEntryHandler };
