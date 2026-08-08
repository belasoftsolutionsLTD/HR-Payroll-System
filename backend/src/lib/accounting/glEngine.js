// Postgres migration (Phase 7) — gl_accounts/gl_journal_entries/gl_accounting_periods
// are Postgres now. This is the one file every automatic-posting hook across POS/
// Inventory/Payroll/Spending/Expenses calls into (postJournalEntry/resolveSystemAccount/
// reverseJournalEntry) — its external contract is deliberately preserved exactly:
// every returned account/entry object still carries a real Mongo ObjectId `_id` (built
// the same inline way AuthMiddleware.js already does for req.user._id) alongside the
// plain-string `id`, so the ~10 caller files across every earlier phase that read
// `acct._id`/`entry._id` directly into a `lines` array or a follow-up query keep working
// completely unchanged — verified live after this rewrite, not just assumed.
const { ObjectId } = require('mongodb');
const { knex, newId } = require('../../functions/Database/pgDBFunctions');

const round2 = (n) => Math.round(n * 100) / 100;

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const withMongoId = (row) => (row && row.id !== undefined && OBJECT_ID_RE.test(row.id) ? { ...row, _id: new ObjectId(row.id) } : row);

// One row per journal entry (header + embedded lines[]), not one row per line.
// This codebase has no multi-document Mongo transactions anywhere (confirmed by grep) and
// balanced double-entry needs "all lines exist, or none do" — embedding was the only way
// to get that guarantee with a single insertOne, same reasoning this codebase already
// applies to pos_sales.items[]/expense_claims.items[] (atomic-together data), as opposed
// to inventory_stock_movements' one-doc-per-event ledger (independent events). Kept as
// JSONB here for the same reason plus Postgres now gives real transactions if this ever
// needs splitting into a real line-item table — not needed today.

const generateEntryNumber = async () => {
  const year = new Date().getFullYear();
  const [row] = await knex('counters')
    .insert({ id: `gl_journal_entry_number_${year}`, seq: 1 })
    .onConflict('id')
    .merge({ seq: knex.raw('"counters"."seq" + 1') })
    .returning('*');
  return `JE-${year}-${String(row.seq).padStart(6, '0')}`;
};

// Looked up by a stable systemKey, never a hardcoded id, so the seeded Chart of
// Accounts template stays fully editable (renamed/recoded) without breaking any
// automatic-posting call site across POS/Inventory/Payroll/Spending.
const resolveSystemAccount = async (systemKey) => {
  const account = await knex('gl_accounts').where({ systemKey }).whereNot({ isActive: false }).first();
  if (!account) throw new Error(`No active Chart of Accounts entry is mapped to systemKey "${systemKey}". Ask an admin to configure it.`);
  return withMongoId(account);
};

const assertPeriodOpen = async (date) => {
  const period = await knex('gl_accounting_periods').where({ year: date.getFullYear(), month: date.getMonth() + 1 }).first();
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

  const accountIds = [...new Set(lines.map((l) => String(l.accountId)))];
  const accounts = await knex('gl_accounts').whereIn('id', accountIds);
  const accountById = Object.fromEntries(accounts.map((a) => [a.id, a]));
  for (const l of lines) {
    const acct = accountById[String(l.accountId)];
    if (!acct || acct.isActive === false) throw new Error(`Account ${l.accountId} not found or inactive.`);
  }

  const entryNumber = await generateEntryNumber();
  const entryId = newId();
  const linesOut = lines.map((l) => ({
    accountId: String(l.accountId),
    accountCode: accountById[String(l.accountId)].code,
    accountName: accountById[String(l.accountId)].name,
    debit: round2(Number(l.debit) || 0),
    credit: round2(Number(l.credit) || 0),
    department: l.department || null,
    memo: l.memo || null,
  }));
  const row = {
    id: entryId,
    entryNumber,
    date: entryDate,
    description: description || null,
    source, // 'manual' | 'pos_sale' | 'pos_refund' | 'inventory_po_receipt' | ... | 'reversal'
    sourceModule: sourceModule || null, // 'accounting' | 'pos' | 'inventory' | 'payroll' | 'spending' | 'expenses'
    referenceId: referenceId ? String(referenceId) : null,
    referenceModel: referenceModel || null,
    lines: JSON.stringify(linesOut),
    totalDebit, totalCredit,
    status: 'posted',
    reversedByEntryId: null,
    reversesEntryId: null,
    department: department || null,
    postedBy: postedBy ? String(postedBy) : null,
    postedAt: new Date(),
    createdAt: new Date(),
  };
  const [saved] = await knex('gl_journal_entries').insert(row).returning('*');

  // Materialized balance cache — same posture as inventory_stock_levels caching
  // inventory_stock_movements. recomputeAccountBalancesFromLedger is the reconciling
  // safety net if this cache and the ledger (the real source of truth) ever diverge.
  // Increment then immediately re-round: a raw increment alone is atomic but, over many
  // postings, accumulates IEEE-754 floating-point noise (e.g. a cached balance landing on
  // 86.22999999999999 instead of 86.23) — invisible in any report (every read path already
  // wraps values in round2()), but a real discrepancy against recomputeAccountBalancesFromLedger's
  // fresh, once-rounded recalculation. Self-healing this on every write keeps the two in
  // exact agreement rather than relying solely on the safety net to paper over it later.
  for (const l of linesOut) {
    const acct = accountById[l.accountId];
    const delta = acct.normalBalance === 'debit' ? (l.debit - l.credit) : (l.credit - l.debit);
    const [updated] = await knex('gl_accounts').where({ id: acct.id })
      .update({ balanceCache: knex.raw('"balanceCache" + ?', [delta]), updatedAt: new Date() })
      .returning('*');
    const rounded = round2(updated.balanceCache || 0);
    if (rounded !== updated.balanceCache) {
      await knex('gl_accounts').where({ id: acct.id }).update({ balanceCache: rounded });
    }
  }

  return withMongoId({ ...saved, lines: linesOut });
};

// Corrections are always a new entry with every line's debit/credit swapped, pointing
// back at the original — gl_journal_entries has no update/delete route at all, standard
// audit-safe practice ("never edit a posted entry, only reverse it").
const reverseJournalEntry = async (entryId, { reason, postedBy, date } = {}) => {
  const original = await knex('gl_journal_entries').where({ id: entryId }).first();
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

  await knex('gl_journal_entries').where({ id: original.id }).update({ status: 'reversed', reversedByEntryId: reversal.id, updatedAt: new Date() });
  await knex('gl_journal_entries').where({ id: reversal.id }).update({ reversesEntryId: original.id });
  return reversal;
};

// Admin-only maintenance action — re-aggregates every posted entry to reset balanceCache
// from scratch, mirroring recomputeStockLevelsFromLedger's role for inventory_stock_levels.
// lines is JSONB, so this unnests it via jsonb_array_elements rather than a Mongo $unwind.
const recomputeAccountBalancesFromLedger = async () => {
  const accounts = await knex('gl_accounts');
  const totals = await knex.raw(`
    select elem->>'accountId' as "accountId",
           sum((elem->>'debit')::numeric) as debit,
           sum((elem->>'credit')::numeric) as credit
    from gl_journal_entries, jsonb_array_elements(lines) as elem
    where status = 'posted'
    group by elem->>'accountId'
  `);
  const totalsByAccount = Object.fromEntries(totals.rows.map((t) => [t.accountId, t]));
  for (const acct of accounts) {
    const t = totalsByAccount[acct.id] || { debit: 0, credit: 0 };
    const balance = acct.normalBalance === 'debit' ? round2(Number(t.debit) - Number(t.credit)) : round2(Number(t.credit) - Number(t.debit));
    await knex('gl_accounts').where({ id: acct.id }).update({ balanceCache: balance, updatedAt: new Date() });
  }
  return accounts.length;
};

module.exports = { postJournalEntry, reverseJournalEntry, resolveSystemAccount, recomputeAccountBalancesFromLedger, round2 };
