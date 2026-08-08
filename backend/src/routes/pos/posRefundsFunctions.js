// Postgres migration (Phase 6) — pos_refunds/pos_sales/inventory_locations/
// inventory_stock_movements are all Postgres now. sale.items is a JSONB array (whole
// read-modify-write, incrementing items[].refundedQuantity in JS then writing the whole
// array back — same idiom used throughout this phase).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { returnStockFromSale } = require('../../lib/inventory/inventoryIntegration');
const { getPosAccessLevel } = require('../../lib/pos/posAccess');
const { getMyOpenSession } = require('./posRegisterFunctions');
const { postJournalEntry, resolveSystemAccount } = require('../../lib/accounting/glEngine');
const { logPostingFailure } = require('../accounting/accountingPostingFailuresFunctions');

const round2 = (n) => Math.round(n * 100) / 100;
const POS_PAYMENT_SYSTEM_KEYS = { cash: 'cash', card: 'pos_card_clearing', mpesa: 'pos_mpesa_clearing' };

// refundDoc.amount is derived from the original sale line's lineTotal (post-discount,
// PRE-tax — confirmed by createSale's saleDoc.items[].lineTotal assignment), so no tax
// is actually refunded by this flow today; the journal entry reflects that as-is rather
// than inventing a tax-refund split that doesn't happen. COGS is reversed using the
// ORIGINAL sale's stock-movement unitCost (not the current, possibly-drifted avgCost),
// so the expense reversal matches exactly what was originally recognized.
async function postRefundJournalEntry(refundDoc, refundId, saleId, postedBy) {
  const [location, saleMovements] = await Promise.all([
    knex('inventory_locations').where({ id: refundDoc.locationId }).select('department').first(),
    knex('inventory_stock_movements').where({ referenceId: saleId, referenceModel: 'pos_sale', movementType: 'sale' }),
  ]);
  const unitCostByItem = Object.fromEntries(saleMovements.map((m) => [m.itemId, m.unitCost || 0]));
  const cogsAmount = round2(refundDoc.items.reduce((s, l) => s + l.quantity * (unitCostByItem[l.itemId] || 0), 0));

  const returnsAcct = await resolveSystemAccount('sales_returns');
  const paymentAcct = await resolveSystemAccount(POS_PAYMENT_SYSTEM_KEYS[refundDoc.method] || 'cash');
  const lines = [
    { accountId: returnsAcct._id, debit: refundDoc.amount },
    { accountId: paymentAcct._id, credit: refundDoc.amount },
  ];
  if (cogsAmount > 0) {
    const invAcct = await resolveSystemAccount('inventory_asset');
    const cogsAcct = await resolveSystemAccount('cogs');
    lines.push({ accountId: invAcct._id, debit: cogsAmount });
    lines.push({ accountId: cogsAcct._id, credit: cogsAmount });
  }

  const payload = {
    date: refundDoc.createdAt, description: `POS refund — ${refundDoc.saleNumber}`, source: 'pos_refund', sourceModule: 'pos',
    referenceId: refundId, referenceModel: 'pos_refunds', lines, department: location?.department || null,
  };
  try {
    await postJournalEntry({ ...payload, postedBy });
  } catch (err) {
    await logPostingFailure({ source: 'pos_refund', sourceModule: 'pos', referenceId: refundId, referenceModel: 'pos_refunds', attemptedPayload: payload, error: err });
  }
}

// Full or partial, any day (unlike voidSale, which is same-day-only and reverses
// everything). Manager/admin only — same "the approver performs the action" convention
// as voidSale. Every refunded unit goes back through Inventory's returnStockFromSale;
// nothing here adjusts stock directly.
const createRefund = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'A refund requires manager approval.');

  const { saleId, items, method, reason } = req.body;
  if (!saleId || !Array.isArray(items) || !items.length || !['cash', 'card'].includes(method)) {
    return returnFunction(res, 400, false, 'saleId, items, and a refund method (cash/card) are required.');
  }

  const sale = await knex('pos_sales').where({ id: saleId }).first();
  if (!sale) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['completed', 'partially_refunded'].includes(sale.status)) {
    return returnFunction(res, 400, false, 'Only a completed (or partially refunded) sale can be refunded further.');
  }

  const updatedLines = sale.items.map((l) => ({ ...l }));
  let refundAmount = 0;
  const refundLines = [];

  for (const req_ of items) {
    const idx = updatedLines.findIndex((l) => String(l.itemId) === String(req_.itemId));
    if (idx === -1) return returnFunction(res, 400, false, `Item ${req_.itemId} is not on this sale.`);
    const line = updatedLines[idx];
    const qty = Number(req_.quantity);
    const refundableQty = line.quantity - line.refundedQuantity;
    if (!qty || qty <= 0 || qty > refundableQty) {
      return returnFunction(res, 400, false, `Cannot refund ${qty} of "${line.name}" — only ${refundableQty} refundable.`);
    }
    const perUnit = line.lineTotal / line.quantity;
    const amount = round2(perUnit * qty);
    refundAmount += amount;
    refundLines.push({ itemId: line.itemId, sku: line.sku, name: line.name, quantity: qty, amount });
    line.refundedQuantity += qty;
  }
  refundAmount = round2(refundAmount);

  const session = await getMyOpenSession(req.user.id);
  const refundId = newId();
  const refundRow = {
    id: refundId,
    saleId: sale.id,
    saleNumber: sale.saleNumber,
    locationId: sale.locationId,
    registerSessionId: session?.id || null,
    items: JSON.stringify(refundLines),
    amount: refundAmount,
    method,
    reason: reason || null,
    refundedBy: req.user.id,
    refundedByName: req.user.name,
    createdAt: new Date(),
  };
  await knex('pos_refunds').insert(refundRow);
  const refundDoc = { ...refundRow, items: refundLines };

  for (const line of refundLines) {
    await returnStockFromSale(line.itemId, sale.locationId, line.quantity, sale.id, req.user.id).catch(() => {});
  }

  await postRefundJournalEntry(refundDoc, refundId, sale.id, req.user._id);

  const allRefunded = updatedLines.every((l) => l.refundedQuantity >= l.quantity);
  const status = allRefunded ? 'refunded' : 'partially_refunded';
  await knex('pos_sales').where({ id: sale.id }).update({ items: JSON.stringify(updatedLines), status, updatedAt: new Date() });

  return returnFunction(res, 201, true, 'Refund processed and stock restored.', { ...refundDoc, saleStatus: status });
};

const listRefunds = async (req, res) => {
  const level = await getPosAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  let query = knex('pos_refunds');
  if (req.query.saleId) query = query.where({ saleId: req.query.saleId });
  if (req.query.locationId) query = query.where({ locationId: req.query.locationId });
  const refunds = await query.orderBy('createdAt', 'desc').limit(100);
  return returnFunction(res, 200, true, req.locale.success, refunds);
};

module.exports = { createRefund, listRefunds };
