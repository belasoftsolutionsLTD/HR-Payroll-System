const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, aggregate } = require('../../functions/Database/commonDBFunctions');
const { getPosAccessLevel, getScopedPosLocationIds } = require('../../lib/pos/posAccess');

const dayBounds = (dateStr) => {
  const day = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);
  return { start, end };
};

const buildLocationFilter = async (req, level) => {
  const filter = {};
  if (req.query.locationId) {
    filter.locationId = new ObjectId(req.query.locationId);
  } else {
    const scoped = await getScopedPosLocationIds(req.user, level);
    if (scoped) filter.locationId = { $in: scoped.map((id) => new ObjectId(id)) };
  }
  return filter;
};

// End-of-day summary — total sales, transaction count, payment-method breakdown, top
// items, and discounts given, for one location (or all locations an admin can see).
const getDailySummary = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  // A date range (startDate/endDate) takes priority over the single-day `date` param —
  // the register's "today" view still just passes `date`, while the Reports tab's
  // presets (This Week/This Month/Custom) pass a range instead.
  let start, end;
  if (req.query.startDate || req.query.endDate) {
    start = req.query.startDate ? new Date(req.query.startDate) : new Date(0);
    end = req.query.endDate ? new Date(req.query.endDate) : new Date();
    end.setHours(23, 59, 59, 999);
  } else {
    ({ start, end } = dayBounds(req.query.date));
  }
  const filter = { ...(await buildLocationFilter(req, level)), createdAt: { $gte: start, $lte: end }, status: { $ne: 'failed' } };

  const sales = await findMany('pos_sales', filter, {});
  const totalSales = sales.reduce((sum, s) => sum + s.total, 0);
  const totalDiscounts = sales.reduce((sum, s) => sum + (s.lineDiscountTotal || 0) + (s.cartDiscountAmount || 0), 0);
  // Kept separate from totalDiscounts — a voucher is a company-funded expense, not a
  // margin discount, so it must never be folded into the same reporting line.
  const totalVoucherAmount = sales.reduce((sum, s) => sum + (s.voucherAmount || 0), 0);

  const paymentBreakdown = {};
  for (const s of sales) {
    for (const p of s.payments) paymentBreakdown[p.method] = (paymentBreakdown[p.method] || 0) + p.amount;
  }

  const itemTotals = {};
  for (const s of sales) {
    for (const line of s.items) {
      itemTotals[String(line.itemId)] ??= { itemId: line.itemId, sku: line.sku, name: line.name, quantity: 0, revenue: 0 };
      itemTotals[String(line.itemId)].quantity += line.quantity;
      itemTotals[String(line.itemId)].revenue += line.lineTotal;
    }
  }
  const topItems = Object.values(itemTotals).sort((a, b) => b.quantity - a.quantity).slice(0, 10);

  return returnFunction(res, 200, true, req.locale.success, {
    date: start.toISOString().split('T')[0],
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
    totalSales: Math.round(totalSales * 100) / 100,
    totalTransactions: sales.length,
    totalDiscounts: Math.round(totalDiscounts * 100) / 100,
    totalVoucherAmount: Math.round(totalVoucherAmount * 100) / 100,
    paymentBreakdown,
    topItems,
  });
};

// Sales grouped by cashier — useful for commission tracking, not built into the sale
// record itself since not every business using this system pays commission.
const getSalesByStaff = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  const filter = await buildLocationFilter(req, level);
  filter.status = { $ne: 'failed' };
  if (req.query.startDate || req.query.endDate) {
    filter.createdAt = {};
    if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
  }

  const rows = await aggregate('pos_sales', [
    { $match: filter },
    { $group: { _id: '$staffId', staffName: { $first: '$staffName' }, totalSales: { $sum: '$total' }, transactionCount: { $sum: 1 } } },
    { $sort: { totalSales: -1 } },
  ]);
  return returnFunction(res, 200, true, req.locale.success, rows.map((r) => ({ staffId: r._id, staffName: r.staffName, totalSales: Math.round(r.totalSales * 100) / 100, transactionCount: r.transactionCount })));
};

const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportSalesCSV = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  const filter = await buildLocationFilter(req, level);
  if (req.query.startDate || req.query.endDate) {
    filter.createdAt = {};
    if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
  }

  const sales = await findMany('pos_sales', filter, { sort: { createdAt: -1 } });
  const locIds = [...new Set(sales.map((s) => String(s.locationId)))].map((id) => new ObjectId(id));
  const locations = await findMany('inventory_locations', { _id: { $in: locIds } }, { projection: { name: 1 } });
  const locMap = Object.fromEntries(locations.map((l) => [String(l._id), l]));

  const header = 'SaleNumber,Date,Location,Staff,Subtotal,Discounts,Total,Payments,Status';
  const rows = sales.map((s) => [
    s.saleNumber, s.createdAt.toISOString(), locMap[String(s.locationId)]?.name || '', s.staffName,
    s.subtotal, (s.lineDiscountTotal || 0) + (s.cartDiscountAmount || 0), s.total,
    s.payments.map((p) => `${p.method}:${p.amount}`).join('; '), s.status,
  ].map(csvEscape).join(','));
  const csv = [header, ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="pos-sales.csv"');
  return res.send(csv);
};

module.exports = { getDailySummary, getSalesByStaff, exportSalesCSV };
