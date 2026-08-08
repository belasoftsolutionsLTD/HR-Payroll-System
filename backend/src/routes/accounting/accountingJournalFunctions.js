// Postgres migration (Phase 7) — gl_journal_entries is Postgres now. Filtering by
// accountId means "any line in this entry references this account" — a Mongo dot-path
// match into the embedded array (`filter['lines.accountId'] = ...`) with no real
// Postgres equivalent shorthand, translated to an EXISTS + jsonb_array_elements check.
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');
const { postJournalEntry, reverseJournalEntry } = require('../../lib/accounting/glEngine');

// Raw journal entries are never exposed to 'viewer' — per the module's role table,
// department_head-level access gets pre-aggregated REPORTS only (Phase 10), not the
// ledger detail itself. Enforced here explicitly, not just by the route-level gate.
const listJournalEntries = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level || level === 'viewer') return returnFunction(res, 403, false, 'Not authorized.');

  const { page, limit, skip } = getPagination(req.query);
  let query = knex('gl_journal_entries');
  if (req.query.accountId) {
    query = query.whereRaw(
      `exists (select 1 from jsonb_array_elements(lines) as elem where elem->>'accountId' = ?)`,
      [req.query.accountId]
    );
  }
  if (req.query.source) query = query.where({ source: req.query.source });
  if (req.query.sourceModule) query = query.where({ sourceModule: req.query.sourceModule });
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.startDate) query = query.where('date', '>=', new Date(req.query.startDate));
  if (req.query.endDate) query = query.where('date', '<=', new Date(req.query.endDate));

  const [{ count }] = await query.clone().count('* as count');
  const entries = await query.clone().orderBy('date', 'desc').orderBy('createdAt', 'desc').limit(limit).offset(skip);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(entries, Number(count), page, limit));
};

const getJournalEntry = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level || level === 'viewer') return returnFunction(res, 403, false, 'Not authorized.');
  const entry = await knex('gl_journal_entries').where({ id: req.params.id }).first();
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
