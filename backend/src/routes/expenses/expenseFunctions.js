// Postgres migration (Phase 8) — the legacy `expenses` collection/table (0 real rows,
// still a live route — see migration file header).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');

const getPagination = (query) => {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, parseInt(query.limit) || 25);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

// ── List expenses with filters + summary stats ────────────────────────────────
const listExpenses = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  let query = knex('expenses');
  if (req.query.category)      query = query.where({ category: req.query.category });
  if (req.query.paymentMethod) query = query.where({ paymentMethod: req.query.paymentMethod });
  if (req.query.search)        query = query.whereILike('description', `%${req.query.search}%`);
  if (req.query.from) query = query.where('date', '>=', req.query.from);
  if (req.query.to)   query = query.where('date', '<=', req.query.to);

  const [{ count }] = await query.clone().count('* as count');
  const data = await query.clone().orderBy('date', 'desc').orderBy('createdAt', 'desc').limit(limit).offset(skip);
  const summary = await query.clone().select('category').sum('amount as total').count('* as count').groupBy('category');

  const summaryOut = summary.map((g) => ({ _id: g.category, total: Number(g.total) || 0, count: Number(g.count) }));
  const grandTotal = summaryOut.reduce((s, g) => s + g.total, 0);
  return returnFunction(res, 200, true, 'OK', { data, total: Number(count), page, limit, summary: summaryOut, grandTotal });
};

// ── Record multiple expenses at once (batch insert) ───────────────────────────
const recordExpenses = async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0)
    return returnFunction(res, 400, false, 'entries array is required.');

  const docs = [];
  for (const e of entries) {
    if (!e.description || !e.amount || !e.date || !e.category)
      return returnFunction(res, 400, false, `Each entry needs description, amount, date and category.`);
    const amount = parseFloat(e.amount);
    if (isNaN(amount) || amount <= 0)
      return returnFunction(res, 400, false, `Amount must be a positive number.`);

    docs.push({
      id: newId(),
      description: e.description.trim(),
      category: e.category,
      amount,
      currency: 'KES',
      date: new Date(e.date),
      vendor: e.vendor?.trim() || '',
      paymentMethod: e.paymentMethod || 'cash',
      notes: e.notes?.trim() || '',
      recordedBy: req.user?.name || 'HR',
      createdAt: new Date(),
    });
  }

  await knex('expenses').insert(docs);
  return returnFunction(res, 201, true, `${docs.length} expense(s) recorded successfully.`);
};

// ── Update a single expense record ────────────────────────────────────────────
const updateExpense = async (req, res) => {
  const { id } = req.params;
  const existing = await knex('expenses').where({ id }).first();
  if (!existing) return returnFunction(res, 400, false, 'Invalid ID.');

  const ALLOWED = ['description', 'category', 'amount', 'date', 'vendor', 'paymentMethod', 'notes'];
  const patch = { updatedAt: new Date() };
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (patch.amount) patch.amount = parseFloat(patch.amount);
  if (patch.date) patch.date = new Date(patch.date);

  await knex('expenses').where({ id }).update(patch);
  return returnFunction(res, 200, true, 'Expense updated.');
};

// ── Delete a single expense record ────────────────────────────────────────────
const deleteExpense = async (req, res) => {
  const { id } = req.params;
  const existing = await knex('expenses').where({ id }).first();
  if (!existing) return returnFunction(res, 400, false, 'Invalid ID.');
  await knex('expenses').where({ id }).delete();
  return returnFunction(res, 200, true, 'Expense deleted.');
};

module.exports = { listExpenses, recordExpenses, updateExpense, deleteExpense };
