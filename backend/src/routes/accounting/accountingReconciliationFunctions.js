const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments, aggregate } = require('../../functions/Database/commonDBFunctions');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');
const { round2 } = require('../../lib/accounting/glEngine');

const DAY_MS = 86400000;

// Hand-rolled CSV parse — no CSV library exists anywhere in this codebase's
// package.json, same posture as the CSV *export* helpers elsewhere (posReportsFunctions.js
// etc.) which are also hand-rolled. Expected columns: date,description,amount
// (amount signed: positive = deposit, negative = withdrawal).
function parseStatementCSV(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  const startIdx = /date/i.test(lines[0]) && /amount/i.test(lines[0]) ? 1 : 0; // skip a header row if present
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(',').map((p) => p.trim());
    if (parts.length < 3) continue;
    const [dateStr, description, amountStr] = parts;
    const date = new Date(dateStr);
    const amount = Number(amountStr);
    if (isNaN(date.getTime()) || isNaN(amount)) continue;
    rows.push({ date, description, amount, matched: false, matchedJournalEntryId: null, matchedLineIndex: null, flagged: false, flagReason: null });
  }
  return rows;
}

const importBankStatement = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['accountId', 'openingBalance', 'closingBalance'])) return;
  if (!req.file) return returnFunction(res, 400, false, 'A CSV bank statement file is required.');

  const account = await findOne('gl_accounts', { _id: new ObjectId(req.body.accountId) });
  if (!account) return returnFunction(res, 404, false, 'Account not found.');

  const fs = require('fs');
  const text = fs.readFileSync(req.file.path, 'utf8');
  const lines = parseStatementCSV(text);
  if (!lines.length) return returnFunction(res, 400, false, 'No valid rows found in the CSV (expected columns: date,description,amount).');

  const dates = lines.map((l) => l.date.getTime());
  const doc = {
    accountId: account._id, filename: req.file.originalname,
    importedBy: req.user._id, importedAt: new Date(),
    periodStart: new Date(Math.min(...dates)), periodEnd: new Date(Math.max(...dates)),
    openingBalance: round2(Number(req.body.openingBalance)), closingBalance: round2(Number(req.body.closingBalance)),
    lines, status: 'in_progress', reconciledAt: null, reconciledBy: null, createdAt: new Date(),
  };
  const result = await insertOne('bank_statement_imports', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const listImports = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const { page, limit, skip } = getPagination(req.query);
  const [total, imports] = await Promise.all([
    countDocuments('bank_statement_imports', {}),
    findMany('bank_statement_imports', {}, { skip, limit, sort: { importedAt: -1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(imports, total, page, limit));
};

const getImport = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const imp = await findOne('bank_statement_imports', { _id: new ObjectId(req.params.id) });
  if (!imp) return returnFunction(res, 404, false, req.locale.notFound);

  // Ledger lines for this account within the statement period, surfaced alongside so the
  // UI can show "unrecordedInLedger" — entries with no matching statement line — without
  // writing anything back onto the statement doc itself.
  const ledgerRows = await aggregate('gl_journal_entries', [
    { $match: { status: 'posted', date: { $gte: imp.periodStart, $lte: imp.periodEnd } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': imp.accountId } },
    { $project: { entryId: '$_id', entryNumber: 1, date: 1, description: 1, debit: '$lines.debit', credit: '$lines.credit' } },
  ]);
  const matchedEntryIds = new Set(imp.lines.filter((l) => l.matched).map((l) => String(l.matchedJournalEntryId)));
  const unrecordedInLedger = ledgerRows.filter((r) => !matchedEntryIds.has(String(r.entryId)));

  return returnFunction(res, 200, true, req.locale.success, { ...imp, unrecordedInLedger });
};

// Rule-based only, no ML, per spec — exact, sign-aware amount match within a ±3-day
// window. A statement deposit (positive) must match a ledger DEBIT to this asset
// account (asset increased); a withdrawal (negative) must match a ledger CREDIT.
const autoMatchStatementLines = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const imp = await findOne('bank_statement_imports', { _id: new ObjectId(req.params.id) });
  if (!imp) return returnFunction(res, 404, false, req.locale.notFound);

  const ledgerRows = await aggregate('gl_journal_entries', [
    { $match: { status: 'posted', date: { $gte: new Date(imp.periodStart.getTime() - 3 * DAY_MS), $lte: new Date(imp.periodEnd.getTime() + 3 * DAY_MS) } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': imp.accountId } },
    { $project: { entryId: '$_id', date: 1, debit: '$lines.debit', credit: '$lines.credit' } },
  ]);
  const usedEntryIds = new Set();

  let matchedCount = 0;
  const updatedLines = imp.lines.map((line) => {
    if (line.matched) return line;
    const wantDebit = line.amount > 0;
    const target = round2(Math.abs(line.amount));
    const candidate = ledgerRows.find((r) => {
      if (usedEntryIds.has(String(r.entryId))) return false;
      const amt = wantDebit ? r.debit : r.credit;
      if (round2(amt || 0) !== target) return false;
      return Math.abs(new Date(r.date).getTime() - line.date.getTime()) <= 3 * DAY_MS;
    });
    if (candidate) {
      usedEntryIds.add(String(candidate.entryId));
      matchedCount += 1;
      return { ...line, matched: true, matchedJournalEntryId: candidate.entryId, flagged: false, flagReason: null };
    }
    return { ...line, flagged: true, flagReason: 'unmatched' };
  });

  await updateOne('bank_statement_imports', { _id: imp._id }, { $set: { lines: updatedLines, updatedAt: new Date() } });
  return returnFunction(res, 200, true, `${matchedCount} line(s) auto-matched.`, { matchedCount, totalLines: updatedLines.length });
};

const manualMatchLine = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['journalEntryId'])) return;
  const imp = await findOne('bank_statement_imports', { _id: new ObjectId(req.params.id) });
  if (!imp) return returnFunction(res, 404, false, req.locale.notFound);
  const idx = Number(req.params.lineIndex);
  if (!imp.lines[idx]) return returnFunction(res, 400, false, 'Invalid line index.');

  imp.lines[idx] = { ...imp.lines[idx], matched: true, matchedJournalEntryId: new ObjectId(req.body.journalEntryId), flagged: false, flagReason: null };
  await updateOne('bank_statement_imports', { _id: imp._id }, { $set: { lines: imp.lines, updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Line matched.');
};

const unmatchLine = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const imp = await findOne('bank_statement_imports', { _id: new ObjectId(req.params.id) });
  if (!imp) return returnFunction(res, 404, false, req.locale.notFound);
  const idx = Number(req.params.lineIndex);
  if (!imp.lines[idx]) return returnFunction(res, 400, false, 'Invalid line index.');

  imp.lines[idx] = { ...imp.lines[idx], matched: false, matchedJournalEntryId: null, flagged: true, flagReason: 'unmatched' };
  await updateOne('bank_statement_imports', { _id: imp._id }, { $set: { lines: imp.lines, updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Line unmatched.');
};

// No journal entry is posted here — reconciliation is a control/attestation pass over
// entries already posted elsewhere, not a new source of GL entries.
const reconcilePeriod = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin' && level !== 'bookkeeper') return returnFunction(res, 403, false, 'Not authorized.');
  const imp = await findOne('bank_statement_imports', { _id: new ObjectId(req.params.id) });
  if (!imp) return returnFunction(res, 404, false, req.locale.notFound);

  const matchedTotal = round2(imp.lines.filter((l) => l.matched).reduce((s, l) => s + l.amount, 0));
  const expectedClosing = round2(imp.openingBalance + matchedTotal);
  if (Math.abs(expectedClosing - imp.closingBalance) > 0.01) {
    return returnFunction(res, 400, false, `Opening balance + matched lines (${expectedClosing}) does not equal the closing balance (${imp.closingBalance}) — match or explain every line first.`);
  }
  await updateOne('bank_statement_imports', { _id: imp._id }, { $set: { status: 'reconciled', reconciledAt: new Date(), reconciledBy: req.user._id } });
  return returnFunction(res, 200, true, 'Period reconciled.');
};

module.exports = { importBankStatement, listImports, getImport, autoMatchStatementLines, manualMatchLine, unmatchLine, reconcilePeriod };
