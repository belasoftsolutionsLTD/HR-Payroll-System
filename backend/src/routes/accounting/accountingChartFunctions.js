const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { getAccountingAccessLevel } = require('../../lib/accounting/accountingAccess');

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
// Assets/expenses normally increase on the debit side; liabilities/equity/revenue on the
// credit side. Contra accounts (e.g. Sales Returns, a revenue-type account that reduces
// revenue) explicitly override this via their own normalBalance rather than being inferred.
const DEFAULT_NORMAL_BALANCE = { asset: 'debit', liability: 'credit', equity: 'credit', revenue: 'credit', expense: 'debit' };

const listAccounts = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const filter = { isActive: { $ne: false } };
  if (req.query.type) filter.type = req.query.type;
  const accounts = await findMany('gl_accounts', filter, { sort: { code: 1 } });
  return returnFunction(res, 200, true, req.locale.success, accounts);
};

const getAccount = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const account = await findOne('gl_accounts', { _id: new ObjectId(req.params.id) });
  if (!account) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, account);
};

const createAccount = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only an accounting admin can change the Chart of Accounts.');
  if (!validateRequiredFields(req, res, ['code', 'name', 'type'])) return;
  if (!ACCOUNT_TYPES.includes(req.body.type)) return returnFunction(res, 400, false, `type must be one of: ${ACCOUNT_TYPES.join(', ')}.`);
  const existing = await findOne('gl_accounts', { code: req.body.code.trim() });
  if (existing) return returnFunction(res, 409, false, 'An account with this code already exists.');

  const doc = {
    code: req.body.code.trim(),
    name: req.body.name.trim(),
    type: req.body.type,
    subType: req.body.subType?.trim() || null,
    parentId: req.body.parentId ? new ObjectId(req.body.parentId) : null,
    normalBalance: ['debit', 'credit'].includes(req.body.normalBalance) ? req.body.normalBalance : DEFAULT_NORMAL_BALANCE[req.body.type],
    isSystemAccount: false,
    systemKey: null, // only ever set by the seed script — never user-assignable, so automation targets stay stable
    linkedExpenseCategories: Array.isArray(req.body.linkedExpenseCategories) ? req.body.linkedExpenseCategories.map(String) : [],
    isActive: true,
    balanceCache: 0,
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('gl_accounts', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateAccount = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only an accounting admin can change the Chart of Accounts.');
  const existing = await findOne('gl_accounts', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);

  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.subType !== undefined) update.subType = req.body.subType?.trim() || null;
  if (req.body.parentId !== undefined) update.parentId = req.body.parentId ? new ObjectId(req.body.parentId) : null;
  if (Array.isArray(req.body.linkedExpenseCategories)) update.linkedExpenseCategories = req.body.linkedExpenseCategories.map(String);
  // code/type/normalBalance/systemKey are deliberately not editable after creation —
  // changing them would silently break every automatic-posting call site and any
  // already-posted journal entry's stored accountCode/accountName snapshot.
  await updateOne('gl_accounts', { _id: existing._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const archiveAccount = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only an accounting admin can change the Chart of Accounts.');
  const account = await findOne('gl_accounts', { _id: new ObjectId(req.params.id) });
  if (!account) return returnFunction(res, 404, false, req.locale.notFound);
  if (account.isSystemAccount) return returnFunction(res, 400, false, 'A system account (used by automatic posting) cannot be archived.');
  await updateOne('gl_accounts', { _id: account._id }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Archived.');
};

// Idempotent — safe to call more than once, only inserts accounts whose `code` doesn't
// already exist. `systemKey` accounts are what every automatic-posting hook across
// POS/Inventory/Payroll/Spending resolves by, via glEngine.resolveSystemAccount.
const STARTER_TEMPLATE = [
  { code: '1000', name: 'Cash', type: 'asset', systemKey: 'cash' },
  { code: '1010', name: 'Bank', type: 'asset', systemKey: 'bank' },
  { code: '1020', name: 'POS Card Clearing', type: 'asset', systemKey: 'pos_card_clearing' },
  { code: '1030', name: 'POS M-Pesa Clearing', type: 'asset', systemKey: 'pos_mpesa_clearing' },
  { code: '1200', name: 'Accounts Receivable', type: 'asset', systemKey: 'accounts_receivable' },
  { code: '1300', name: 'Inventory Asset', type: 'asset', systemKey: 'inventory_asset' },
  { code: '1500', name: 'Fixed Assets', type: 'asset' },
  { code: '1510', name: 'Accumulated Depreciation', type: 'asset', normalBalance: 'credit' },
  { code: '2000', name: 'Accounts Payable', type: 'liability', systemKey: 'accounts_payable' },
  { code: '2100', name: 'Salary Payable', type: 'liability', systemKey: 'salary_payable' },
  { code: '2200', name: 'VAT / Tax Payable', type: 'liability', systemKey: 'tax_payable' },
  { code: '3000', name: "Owner's Equity / Retained Earnings", type: 'equity' },
  { code: '4000', name: 'Sales Revenue', type: 'revenue', systemKey: 'sales_revenue' },
  // Contra-revenue — reduces revenue, so its normal balance is flipped to debit.
  { code: '4100', name: 'Sales Returns & Allowances', type: 'revenue', normalBalance: 'debit', systemKey: 'sales_returns' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', systemKey: 'cogs' },
  { code: '5100', name: 'Salary Expense', type: 'expense', systemKey: 'salary_expense' },
  { code: '5200', name: 'Rent Expense', type: 'expense' },
  { code: '5210', name: 'Utilities Expense', type: 'expense' },
  { code: '5220', name: 'Office Supplies Expense', type: 'expense' },
  { code: '5230', name: 'Travel Expense', type: 'expense' },
  { code: '5500', name: 'Inventory Shrinkage Expense', type: 'expense', systemKey: 'inventory_shrinkage' },
  // A voucher is company-funded (per the product decision, tracked separately from
  // margin discounts) — redeeming one means the business is covering part of the
  // customer's bill as a promotional cost, not simply earning less revenue, so it's
  // booked as its own expense rather than netted against Sales Revenue.
  { code: '5850', name: 'Voucher & Promotional Expense', type: 'expense', systemKey: 'voucher_expense' },
  { code: '5800', name: 'Procurement Expense', type: 'expense', systemKey: 'procurement_expense' },
  // Combined fuel + vehicle maintenance + third-party delivery costs — kept as one
  // account rather than three to avoid Chart-of-Accounts sprawl (product decision).
  { code: '5820', name: 'Logistics Expense', type: 'expense', systemKey: 'logistics_expense' },
  { code: '5900', name: 'Other Operating Expense', type: 'expense', systemKey: 'other_expense' },
];

const seedDefaultChartOfAccounts = async (req, res) => {
  const level = await getAccountingAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Only an accounting admin can seed the Chart of Accounts.');

  const existingCodes = new Set((await findMany('gl_accounts', {}, { projection: { code: 1 } })).map((a) => a.code));
  let inserted = 0;
  for (const acct of STARTER_TEMPLATE) {
    if (existingCodes.has(acct.code)) continue;
    await insertOne('gl_accounts', {
      code: acct.code,
      name: acct.name,
      type: acct.type,
      subType: null,
      parentId: null,
      normalBalance: acct.normalBalance || DEFAULT_NORMAL_BALANCE[acct.type],
      isSystemAccount: Boolean(acct.systemKey),
      systemKey: acct.systemKey || null,
      linkedExpenseCategories: [],
      isActive: true,
      balanceCache: 0,
      createdBy: req.user._id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    inserted += 1;
  }
  return returnFunction(res, 200, true, `Seeded ${inserted} new account(s).`, { inserted, skipped: STARTER_TEMPLATE.length - inserted });
};

module.exports = { listAccounts, getAccount, createAccount, updateAccount, archiveAccount, seedDefaultChartOfAccounts };
