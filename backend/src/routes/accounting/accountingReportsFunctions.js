// Postgres migration (Phase 7) — gl_accounts/gl_journal_entries are Postgres now.
// lines is JSONB — both Mongo $unwind pipelines here become jsonb_array_elements raw
// queries; getAccountingDepartmentFilter now returns a plain department string (or the
// '__none__' sentinel) instead of a Mongo `{'lines.department': ...}` match fragment —
// see accountingAccess.js.
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { getAccountingAccessLevel, getAccountingDepartmentFilter } = require('../../lib/accounting/accountingAccess');

const round2 = (n) => Math.round(n * 100) / 100;

// Raw ledger detail, same "viewer never sees raw entries" rule as accountingJournalFunctions.
const getGeneralLedgerDetail = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level || level === 'viewer') return returnFunction(res, 403, false, 'Not authorized.');

  // knex.raw binds against `?` markers in order, not literal Postgres $1/$2 placeholders
  // (caught live: the first draft used $1/$2 text directly, which knex's own binding
  // count check rejects with a "expected N bindings, saw 0" mismatch).
  const params = [];
  let where = `status = 'posted'`;
  if (req.query.startDate) { params.push(new Date(req.query.startDate)); where += ` and date >= ?`; }
  if (req.query.endDate) { params.push(new Date(req.query.endDate)); where += ` and date <= ?`; }
  if (req.query.accountId) { params.push(req.query.accountId); where += ` and elem->>'accountId' = ?`; }

  const { rows } = await knex.raw(
    `select "entryNumber", date, description, source, "sourceModule",
            elem->>'accountCode' as "accountCode", elem->>'accountName' as "accountName",
            (elem->>'debit')::numeric as debit, (elem->>'credit')::numeric as credit,
            elem->>'department' as department, elem->>'memo' as memo
     from gl_journal_entries, jsonb_array_elements(lines) as elem
     where ${where}
     order by date, "createdAt"`,
    params
  );
  return returnFunction(res, 200, true, req.locale.success, rows);
};

// The sanity-check report: every account's cumulative balance, footer proving
// Σdebit === Σcredit across the whole ledger (or since balanceCache is itself a live
// running total, this just reads it directly — same number recomputeAccountBalancesFromLedger
// would produce, verified equal by the capstone verification's own explicit check).
const getTrialBalance = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level || level === 'viewer') return returnFunction(res, 403, false, 'Not authorized.');

  const accounts = await knex('gl_accounts').whereNot({ isActive: false }).orderBy('code');
  const rows = accounts.map((a) => {
    const balance = a.balanceCache || 0;
    return {
      accountId: a.id, code: a.code, name: a.name, type: a.type, normalBalance: a.normalBalance,
      debit: a.normalBalance === 'debit' && balance > 0 ? round2(balance) : (a.normalBalance === 'credit' && balance < 0 ? round2(-balance) : 0),
      credit: a.normalBalance === 'credit' && balance > 0 ? round2(balance) : (a.normalBalance === 'debit' && balance < 0 ? round2(-balance) : 0),
    };
  });
  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  return returnFunction(res, 200, true, req.locale.success, { rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
};

const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportTrialBalanceCSV = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level || level === 'viewer') return returnFunction(res, 403, false, 'Not authorized.');

  const accounts = await knex('gl_accounts').whereNot({ isActive: false }).orderBy('code');
  const header = 'Code,Name,Type,Debit,Credit';
  const rows = accounts.map((a) => {
    const balance = a.balanceCache || 0;
    const debit = a.normalBalance === 'debit' && balance > 0 ? round2(balance) : (a.normalBalance === 'credit' && balance < 0 ? round2(-balance) : 0);
    const credit = a.normalBalance === 'credit' && balance > 0 ? round2(balance) : (a.normalBalance === 'debit' && balance < 0 ? round2(-balance) : 0);
    return [a.code, a.name, a.type, debit, credit].map(csvEscape).join(',');
  });
  const csv = [header, ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="trial-balance.csv"');
  return res.send(csv);
};

// Per-account balance, optionally scoped to one department by re-aggregating the ledger
// (rather than trusting the cumulative, all-departments balanceCache) — this is what lets
// a 'viewer' (department_head) get a real department-scoped number instead of the whole
// company's.
const computeAccountBalances = async (departmentFilter) => {
  const accounts = await knex('gl_accounts').whereNot({ isActive: false });
  if (!departmentFilter) return accounts.map((a) => ({ account: a, balance: a.balanceCache || 0 }));

  const { rows: totals } = await knex.raw(
    `select elem->>'accountId' as "accountId",
            sum((elem->>'debit')::numeric) as debit, sum((elem->>'credit')::numeric) as credit
     from gl_journal_entries, jsonb_array_elements(lines) as elem
     where status = 'posted' and elem->>'department' = ?
     group by elem->>'accountId'`,
    [departmentFilter]
  );
  const totalsByAccount = Object.fromEntries(totals.map((t) => [t.accountId, t]));
  return accounts.map((a) => {
    const t = totalsByAccount[a.id] || { debit: 0, credit: 0 };
    const balance = a.normalBalance === 'debit' ? round2(Number(t.debit) - Number(t.credit)) : round2(Number(t.credit) - Number(t.debit));
    return { account: a, balance };
  });
};

// Assets = Liabilities + Equity — a point-in-time snapshot read off balanceCache (or a
// department-scoped re-aggregation for 'viewer'), grouped by account type.
//
// Revenue/expense are "temporary" accounts — this system has no fiscal-year-end closing
// step that zeroes them into Retained Earnings (out of scope), so without an adjustment
// the balance sheet would never balance the moment any sale or expense posts (assets move,
// nothing on the liabilities+equity side does, since revenue/expense aren't equity types).
// Standard practice for a live balance sheet with no closing step: fold cumulative
// (revenue − expenses) in as a computed "Retained Earnings (Current)" equity line — the
// same approach QuickBooks/Xero show as "Current Year Earnings."
const getBalanceSheet = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  const departmentFilter = getAccountingDepartmentFilter(req.user, level);
  const balances = await computeAccountBalances(departmentFilter);

  const group = (type) => balances
    .filter((b) => b.account.type === type && Math.abs(b.balance) > 0.001)
    .map((b) => ({ accountId: b.account.id, code: b.account.code, name: b.account.name, balance: b.balance }));

  const assets = group('asset');
  const liabilities = group('liability');
  const equity = group('equity');

  const revenueTotal = round2(balances.filter((b) => b.account.type === 'revenue').reduce((s, b) => s + b.balance, 0));
  const expenseTotal = round2(balances.filter((b) => b.account.type === 'expense').reduce((s, b) => s + b.balance, 0));
  const retainedEarnings = round2(revenueTotal - expenseTotal);
  if (Math.abs(retainedEarnings) > 0.001) {
    equity.push({ accountId: null, code: '3900', name: 'Retained Earnings (Current)', balance: retainedEarnings });
  }

  const totalAssets = round2(assets.reduce((s, a) => s + a.balance, 0));
  const totalLiabilities = round2(liabilities.reduce((s, a) => s + a.balance, 0));
  const totalEquity = round2(equity.reduce((s, a) => s + a.balance, 0));

  return returnFunction(res, 200, true, req.locale.success, {
    asOf: new Date(), assets, liabilities, equity,
    totalAssets, totalLiabilities, totalEquity,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  });
};

// Date-range P&L — re-aggregates gl_journal_entries for the range rather than trusting
// balanceCache, which is cumulative-since-inception only and would be wrong for "profit
// this month."
const getIncomeStatement = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  const departmentFilter = getAccountingDepartmentFilter(req.user, level);
  const params = [];
  let where = `status = 'posted'`;
  if (req.query.startDate) { params.push(new Date(req.query.startDate)); where += ` and date >= ?`; }
  if (req.query.endDate) { params.push(new Date(req.query.endDate)); where += ` and date <= ?`; }
  if (departmentFilter) { params.push(departmentFilter); where += ` and elem->>'department' = ?`; }

  const { rows: totals } = await knex.raw(
    `select elem->>'accountId' as "accountId",
            sum((elem->>'debit')::numeric) as debit, sum((elem->>'credit')::numeric) as credit
     from gl_journal_entries, jsonb_array_elements(lines) as elem
     where ${where}
     group by elem->>'accountId'`,
    params
  );
  const totalsByAccount = Object.fromEntries(totals.map((t) => [t.accountId, t]));

  const accounts = await knex('gl_accounts').whereNot({ isActive: false }).whereIn('type', ['revenue', 'expense']);
  const rows = accounts.map((a) => {
    const t = totalsByAccount[a.id] || { debit: 0, credit: 0 };
    const amount = a.normalBalance === 'credit' ? round2(Number(t.credit) - Number(t.debit)) : round2(Number(t.debit) - Number(t.credit));
    return { accountId: a.id, code: a.code, name: a.name, type: a.type, amount };
  }).filter((r) => Math.abs(r.amount) > 0.001);

  const revenue = rows.filter((r) => r.type === 'revenue');
  const expenses = rows.filter((r) => r.type === 'expense');
  const totalRevenue = round2(revenue.reduce((s, r) => s + r.amount, 0));
  const totalExpenses = round2(expenses.reduce((s, r) => s + r.amount, 0));

  return returnFunction(res, 200, true, req.locale.success, {
    startDate: req.query.startDate || null, endDate: req.query.endDate || null,
    revenue, expenses, totalRevenue, totalExpenses, netIncome: round2(totalRevenue - totalExpenses),
  });
};

const exportBalanceSheetCSV = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const departmentFilter = getAccountingDepartmentFilter(req.user, level);
  const balances = await computeAccountBalances(departmentFilter);
  const header = 'Type,Code,Name,Balance';
  const rows = balances
    .filter((b) => Math.abs(b.balance) > 0.001)
    .map((b) => [b.account.type, b.account.code, b.account.name, b.balance].map(csvEscape).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="balance-sheet.csv"');
  return res.send([header, ...rows].join('\n'));
};

module.exports = { getGeneralLedgerDetail, getTrialBalance, exportTrialBalanceCSV, getBalanceSheet, getIncomeStatement, exportBalanceSheetCSV };
