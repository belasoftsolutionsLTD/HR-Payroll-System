// Postgres migration (Phase 6) — pos_sales/inventory_locations are Postgres now.
// items/payments are JSONB arrays, iterated in JS exactly as before (no $unwind
// aggregation needed for these two reports — getDailySummary/exportSalesCSV already
// read the whole array per sale in JS either way). getSalesByStaff's Mongo $group
// becomes a real SQL GROUP BY.
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { getPosAccessLevel, getScopedPosLocationIds } = require('../../lib/pos/posAccess');

const dayBounds = (dateStr) => {
  const day = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);
  return { start, end };
};

// Resolves the same "explicit locationId, else POS-access-scoped locations" filter used
// throughout this file. Deliberately NOT a "take a query builder, return a query builder"
// helper — an async function that returns a knex builder is a trap: `await`ing its call
// site adopts the builder's own `.then()` (thenable assimilation), which executes the
// query immediately and hands back rows instead of the still-chainable builder, breaking
// every `.select()/.where()/...` call added after it (caught live during Phase 6
// verification — getSalesByStaff crashed with "query.select is not a function").
// Returning a plain array of ids (or null) sidesteps the trap entirely.
const resolveLocationFilterIds = async (req, level) => {
  if (req.query.locationId) return [req.query.locationId];
  return getScopedPosLocationIds(req.user, level); // array, or null = unrestricted
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
  let query = knex('pos_sales').where('createdAt', '>=', start).where('createdAt', '<=', end).whereNot({ status: 'failed' });
  const locationIds = await resolveLocationFilterIds(req, level);
  if (locationIds) query = query.whereIn('locationId', locationIds);

  const sales = await query;
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
      itemTotals[line.itemId] ??= { itemId: line.itemId, sku: line.sku, name: line.name, quantity: 0, revenue: 0 };
      itemTotals[line.itemId].quantity += line.quantity;
      itemTotals[line.itemId].revenue += line.lineTotal;
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

  let query = knex('pos_sales').whereNot({ status: 'failed' });
  const locationIds = await resolveLocationFilterIds(req, level);
  if (locationIds) query = query.whereIn('locationId', locationIds);
  if (req.query.startDate) query = query.where('createdAt', '>=', new Date(req.query.startDate));
  if (req.query.endDate) query = query.where('createdAt', '<=', new Date(req.query.endDate));

  const rows = await query
    .select('staffId')
    .max('staffName as staffName')
    .sum('total as totalSales')
    .count('* as transactionCount')
    .groupBy('staffId')
    .orderBy('totalSales', 'desc');
  return returnFunction(res, 200, true, req.locale.success, rows.map((r) => ({
    staffId: r.staffId, staffName: r.staffName, totalSales: Math.round(Number(r.totalSales) * 100) / 100, transactionCount: Number(r.transactionCount),
  })));
};

const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportSalesCSV = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  let query = knex('pos_sales');
  const locationIds = await resolveLocationFilterIds(req, level);
  if (locationIds) query = query.whereIn('locationId', locationIds);
  if (req.query.startDate) query = query.where('createdAt', '>=', new Date(req.query.startDate));
  if (req.query.endDate) query = query.where('createdAt', '<=', new Date(req.query.endDate));

  const sales = await query.orderBy('createdAt', 'desc');
  const locIds = [...new Set(sales.map((s) => s.locationId))];
  const locations = await knex('inventory_locations').whereIn('id', locIds).select('id', 'name');
  const locMap = Object.fromEntries(locations.map((l) => [l.id, l]));

  const header = 'SaleNumber,Date,Location,Staff,Subtotal,Discounts,Total,Payments,Status';
  const rows = sales.map((s) => [
    s.saleNumber, s.createdAt.toISOString(), locMap[s.locationId]?.name || '', s.staffName,
    s.subtotal, (s.lineDiscountTotal || 0) + (s.cartDiscountAmount || 0), s.total,
    s.payments.map((p) => `${p.method}:${p.amount}`).join('; '), s.status,
  ].map(csvEscape).join(','));
  const csv = [header, ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="pos-sales.csv"');
  return res.send(csv);
};

module.exports = { getDailySummary, getSalesByStaff, exportSalesCSV };
