const { ObjectId } = require('mongodb');
const { findOne, findMany, insertOne, updateOne, aggregate } = require('../../functions/Database/commonDBFunctions');

const round2 = (n) => Math.round(n * 100) / 100;

// One document per journal entry (header + embedded lines[]), not one document per line.
// This codebase has no multi-document Mongo transactions anywhere (confirmed by grep) and
// balanced double-entry needs "all lines exist, or none do" — embedding is the only way
// to get that guarantee with a single insertOne, same reasoning this codebase already
// applies to pos_sales.items[]/expense_claims.items[] (atomic-together data), as opposed
// to inventory_stock_movements' one-doc-per-event ledger (independent events).

const generateEntryNumber = async () => {
  const year = new Date().getFullYear();
  const result = await global.dbo.collection('counters').findOneAndUpdate(
    { _id: `gl_journal_entry_number_${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return `JE-${year}-${String(result.seq).padStart(6, '0')}`;
};

// Looked up by a stable systemKey, never a hardcoded ObjectId, so the seeded Chart of
// Accounts template stays fully editable (renamed/recoded) without breaking any
// automatic-posting call site across POS/Inventory/Payroll/Spending.
const resolveSystemAccount = async (systemKey) => {
  const account = await findOne('gl_accounts', { systemKey, isActive: { $ne: false } });
  if (!account) throw new Error(`No active Chart of Accounts entry is mapped to systemKey "${systemKey}". Ask an admin to configure it.`);
  return account;
};

const assertPeriodOpen = async (date) => {
  const period = await findOne('gl_accounting_periods', { year: date.getFullYear(), month: date.getMonth() + 1 });
  if (period?.status === 'closed') {
    throw new Error(`The accounting period ${period.month}/${period.year} is closed. Post a current-period entry instead.`);
  }
};

// The one write path for every journal entry in the system — manual (from the Journal
// tab) and automatic (triggered by POS/Inventory/Payroll/Spending events) alike.
// Immutable once posted: this module exposes no update/delete — only reverseJournalEntry.
const postJournalEntry = async ({ date, description, source, sourceModule, referenceId, referenceModel, lines, department, postedBy }) => {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('A journal entry requires at least 2 lines.');
  for (const l of lines) {
    const d = round2(Number(l.debit) || 0);
    const c = round2(Number(l.credit) || 0);
    if (d < 0 || c < 0) throw new Error('Line amounts cannot be negative.');
    if ((d > 0) === (c > 0)) throw new Error('Each line must have exactly one of debit or credit set, not both, not neither.');
  }
  const totalDebit = round2(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`Journal entry is not balanced: debit ${totalDebit} vs credit ${totalCredit}.`);
  }

  const entryDate = date ? new Date(date) : new Date();
  await assertPeriodOpen(entryDate);

  const accountIds = [...new Set(lines.map((l) => String(l.accountId)))].map((id) => new ObjectId(id));
  const accounts = await findMany('gl_accounts', { _id: { $in: accountIds } }, {});
  const accountById = Object.fromEntries(accounts.map((a) => [String(a._id), a]));
  for (const l of lines) {
    const acct = accountById[String(l.accountId)];
    if (!acct || acct.isActive === false) throw new Error(`Account ${l.accountId} not found or inactive.`);
  }

  const entryNumber = await generateEntryNumber();
  const doc = {
    entryNumber,
    date: entryDate,
    description: description || null,
    source, // 'manual' | 'pos_sale' | 'pos_refund' | 'inventory_po_receipt' | ... | 'reversal'
    sourceModule: sourceModule || null, // 'accounting' | 'pos' | 'inventory' | 'payroll' | 'spending' | 'expenses'
    referenceId: referenceId || null,
    referenceModel: referenceModel || null,
    lines: lines.map((l) => ({
      accountId: new ObjectId(l.accountId),
      accountCode: accountById[String(l.accountId)].code,
      accountName: accountById[String(l.accountId)].name,
      debit: round2(Number(l.debit) || 0),
      credit: round2(Number(l.credit) || 0),
      department: l.department || null,
      memo: l.memo || null,
    })),
    totalDebit, totalCredit,
    status: 'posted',
    reversedByEntryId: null,
    reversesEntryId: null,
    department: department || null,
    postedBy: postedBy || null,
    postedAt: new Date(),
    createdAt: new Date(),
  };
  const result = await insertOne('gl_journal_entries', doc);

  // Materialized balance cache — same posture as inventory_stock_levels caching
  // inventory_stock_movements. recomputeAccountBalancesFromLedger is the reconciling
  // safety net if this cache and the ledger (the real source of truth) ever diverge.
  // Increment then immediately re-round: a raw $inc alone is atomic but, over many
  // postings, accumulates IEEE-754 floating-point noise (e.g. a cached balance landing on
  // 86.22999999999999 instead of 86.23) — invisible in any report (every read path already
  // wraps values in round2()), but a real discrepancy against recomputeAccountBalancesFromLedger's
  // fresh, once-rounded recalculation. Self-healing this on every write keeps the two in
  // exact agreement rather than relying solely on the safety net to paper over it later.
  for (const l of doc.lines) {
    const acct = accountById[String(l.accountId)];
    const delta = acct.normalBalance === 'debit' ? (l.debit - l.credit) : (l.credit - l.debit);
    const updated = await global.dbo.collection('gl_accounts').findOneAndUpdate(
      { _id: acct._id },
      { $inc: { balanceCache: delta }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    const rounded = round2(updated.balanceCache || 0);
    if (rounded !== updated.balanceCache) {
      await updateOne('gl_accounts', { _id: acct._id }, { $set: { balanceCache: rounded } });
    }
  }

  return { _id: result.insertedId, ...doc };
};

// Corrections are always a new entry with every line's debit/credit swapped, pointing
// back at the original — gl_journal_entries has no update/delete route at all, standard
// audit-safe practice ("never edit a posted entry, only reverse it").
const reverseJournalEntry = async (entryId, { reason, postedBy, date } = {}) => {
  const original = await findOne('gl_journal_entries', { _id: new ObjectId(entryId) });
  if (!original) throw new Error('Journal entry not found.');
  if (original.status !== 'posted') throw new Error('Only a posted entry can be reversed.');

  const reversal = await postJournalEntry({
    date: date || new Date(),
    description: `Reversal of ${original.entryNumber}${reason ? `: ${reason}` : ''}`,
    source: 'reversal',
    sourceModule: original.sourceModule,
    referenceId: original.referenceId,
    referenceModel: original.referenceModel,
    lines: original.lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, department: l.department, memo: l.memo })),
    department: original.department,
    postedBy,
  });

  await updateOne('gl_journal_entries', { _id: original._id }, { $set: { status: 'reversed', reversedByEntryId: reversal._id, updatedAt: new Date() } });
  await updateOne('gl_journal_entries', { _id: reversal._id }, { $set: { reversesEntryId: original._id } });
  return reversal;
};

// Admin-only maintenance action — re-aggregates every posted entry to reset balanceCache
// from scratch, mirroring recomputeStockLevelsFromLedger's role for inventory_stock_levels.
const recomputeAccountBalancesFromLedger = async () => {
  const accounts = await findMany('gl_accounts', {}, {});
  const totals = await aggregate('gl_journal_entries', [
    { $match: { status: 'posted' } },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.accountId', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const totalsByAccount = Object.fromEntries(totals.map((t) => [String(t._id), t]));
  for (const acct of accounts) {
    const t = totalsByAccount[String(acct._id)] || { debit: 0, credit: 0 };
    const balance = acct.normalBalance === 'debit' ? round2(t.debit - t.credit) : round2(t.credit - t.debit);
    await updateOne('gl_accounts', { _id: acct._id }, { $set: { balanceCache: balance, updatedAt: new Date() } });
  }
  return accounts.length;
};

module.exports = { postJournalEntry, reverseJournalEntry, resolveSystemAccount, recomputeAccountBalancesFromLedger, round2 };
