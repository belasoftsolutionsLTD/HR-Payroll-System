const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');

const getPagination = (query) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(100, parseInt(query.limit) || 25);
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
};

// ── List expenses with filters + summary stats ────────────────────────────────
const listExpenses = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.category)      filter.category      = req.query.category;
  if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
  if (req.query.search)        filter.description   = { $regex: req.query.search, $options: 'i' };
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = req.query.from;
    if (req.query.to)   filter.date.$lte = req.query.to;
  }

  const [total, data, summary] = await Promise.all([
    countDocuments('expenses', filter),
    findMany('expenses', filter, { sort: { date: -1, createdAt: -1 }, skip, limit }),
    global.dbo.collection('expenses').aggregate([
      { $match: filter },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]).toArray(),
    ]);

  const grandTotal = summary.reduce((s, g) => s + g.total, 0);
  return returnFunction(res, 200, true, 'OK', { data, total, page, limit, summary, grandTotal });
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
      description:   e.description.trim(),
      category:      e.category,
      amount,
      currency:      'KES',
      date:          e.date,
      vendor:        e.vendor?.trim() || '',
      paymentMethod: e.paymentMethod || 'cash',
      notes:         e.notes?.trim() || '',
      recordedBy:    req.user?.name || 'HR',
      createdAt:     new Date(),
    });
  }

  await global.dbo.collection('expenses').insertMany(docs);
  return returnFunction(res, 201, true, `${docs.length} expense(s) recorded successfully.`);
};

// ── Update a single expense record ────────────────────────────────────────────
const updateExpense = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID.');

  const ALLOWED = ['description', 'category', 'amount', 'date', 'vendor', 'paymentMethod', 'notes'];
  const patch = { updatedAt: new Date() };
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (patch.amount) patch.amount = parseFloat(patch.amount);

  await updateOne('expenses', { _id: new ObjectId(id) }, { $set: patch });
  return returnFunction(res, 200, true, 'Expense updated.');
};

// ── Delete a single expense record ────────────────────────────────────────────
const deleteExpense = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID.');
  await global.dbo.collection('expenses').deleteOne({ _id: new ObjectId(id) });
  return returnFunction(res, 200, true, 'Expense deleted.');
};

module.exports = { listExpenses, recordExpenses, updateExpense, deleteExpense };
