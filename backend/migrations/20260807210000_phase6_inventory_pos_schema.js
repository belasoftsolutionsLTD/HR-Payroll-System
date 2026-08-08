// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 6) —
// Inventory (categories, brands, units_of_measure, custom_field_defs, locations,
// suppliers, items, lots, stock_levels, stock_movements, purchase_orders, transfers)
// and POS (sales, refunds, register_sessions, promo_codes, vouchers), plus 2 new
// columns on Phase 1's users table (isInventoryClerk, posLocationIds — this module's
// own access-control flags, found missing while sweeping its staff-access files).
//
// Same conventions as every phase so far: ids stay as unchanged Mongo ObjectId-hex
// TEXT primary keys. Line-item arrays (purchase_orders.items, transfers.items,
// pos_sales.items/payments, pos_refunds.items) stay JSONB — confirmed via grep that
// none of them ever use $push/$pull/arrayFilters, always a whole read-modify-JS-write-
// back (e.g. posRefundsFunctions.js increments items[].refundedQuantity in JS then
// writes the whole array back), same idiom as every other JSONB call in this
// migration. gl_journal_entries (Accounting, Phase 7) stays Mongo — POS/Inventory's
// posting-hook writes into it are deliberately left alone, same "don't reach into a
// later phase's collection" boundary as every earlier phase. Attribution-only fields
// get no FK by default, added back only where a live orphan-check confirmed the real
// data is clean (all of them, this phase — real data is small and clean throughout).
//
// category/brand/unitOfMeasure on inventory_items are plain name strings, not FK ids
// — confirmed via the app's own code, which manages categories/brands/UOM as simple
// name-keyed lookup lists (findOne by {name} for dedup) and stores the name directly
// on the item, never an id. Preserved as-is, no FK (matches how a deleted/renamed
// category was already handled before this migration — nothing enforced referential
// integrity there either).

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  // ── Lookup tables ────────────────────────────────────────────────────────────

  await knex.schema.createTable('inventory_categories', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('inventory_brands', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('inventory_units_of_measure', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('inventory_custom_field_defs', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('fieldType');
    t.specificType('options', 'text[]');
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('inventory_locations', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('type');
    t.text('address');
    t.text('department');
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('inventory_suppliers', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('contactPerson');
    t.text('phone');
    t.text('email');
    t.text('address');
    t.specificType('linkedItemIds', 'text[]'); // whole-replaced on edit, no FK (item order independent of supplier lifecycle)
    t.integer('leadTimeDays');
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  // ── Items ────────────────────────────────────────────────────────────────────

  await knex.schema.createTable('inventory_items', (t) => {
    t.text('id').primary();
    t.text('sku');
    t.text('name').notNullable();
    t.text('description');
    t.text('barcode');
    t.text('category'); // plain name string, not FK — see file header
    t.text('brand');    // plain name string, not FK
    t.text('unitOfMeasure'); // plain name string, not FK
    t.decimal('costPrice', 14, 4);
    t.decimal('salePrice', 14, 4);
    t.decimal('avgCost', 14, 4);
    t.text('costingMethod');
    t.boolean('expiryTrackingEnabled').defaultTo(false);
    t.boolean('isTracked').defaultTo(true);
    t.text('trackingMode');
    t.text('discountType');
    t.decimal('discountValue', 14, 4);
    t.text('taxCategory');
    t.decimal('taxRate', 8, 4);
    t.text('imageUrl');
    t.jsonb('customFieldValues'); // {defId: value} — whole-replaced on edit
    t.boolean('isActive').defaultTo(true);
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('sku');
    t.index('category');
  });

  await knex.schema.createTable('inventory_purchase_orders', (t) => {
    t.text('id').primary();
    t.text('poNumber');
    t.text('supplierId').notNullable().references('id').inTable('inventory_suppliers');
    t.text('locationId').notNullable().references('id').inTable('inventory_locations');
    t.jsonb('items'); // [{itemId, quantityOrdered, quantityReceived, unitCost}] — whole-replaced, never per-line updates
    t.text('status');
    t.timestamp('expectedDeliveryDate', { useTz: true });
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
    t.timestamp('sentAt', { useTz: true });
    t.timestamp('receivedAt', { useTz: true });
    t.timestamp('closedAt', { useTz: true });
    t.text('invoiceNumber');
    t.text('poInvoiceNumber'); // a second, separate invoice-number field the app itself keeps distinct from invoiceNumber — preserved as-is
    t.decimal('invoiceAmount', 14, 2);
    t.timestamp('invoiceDueDate', { useTz: true });
    t.timestamp('invoiceReceivedAt', { useTz: true });
    t.text('paymentStatus');
    t.text('paymentMethod');
    t.text('paymentReference');
    t.timestamp('paidAt', { useTz: true });
    t.text('paymentEvidenceFilename');
    t.text('paymentEvidenceOriginalName');
    // The rest of the payment-request/approve/reject workflow — missed on the first pass
    // of this table, found while rewriting inventoryPurchaseOrdersFunctions.js's
    // requestPoPayment and (Accounting, Phase 7 — but it writes this same now-Postgres
    // table, so fixed now rather than left broken until that phase) accountingPoPaymentsFunctions.js's
    // approvePoPayment/rejectPoPayment.
    t.text('paymentRequestedBy');
    t.timestamp('paymentRequestedAt', { useTz: true });
    t.text('paymentRejectionReason');
    t.text('paymentApprovedBy');
    t.timestamp('paymentApprovedAt', { useTz: true });
    t.text('paymentRejectedBy');
    t.timestamp('paymentRejectedAt', { useTz: true });

    t.index('supplierId');
    t.index('locationId');
    t.index('status');
  });

  await knex.schema.createTable('inventory_lots', (t) => {
    t.text('id').primary();
    t.text('itemId').notNullable().references('id').inTable('inventory_items');
    t.text('locationId').notNullable().references('id').inTable('inventory_locations');
    t.text('lotNumber');
    t.decimal('quantityRemaining', 14, 4);
    t.timestamp('expiryDate', { useTz: true });
    t.text('poId').references('id').inTable('inventory_purchase_orders'); // 0/6 orphans
    t.timestamp('receivedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('itemId');
    t.index('locationId');
  });

  await knex.schema.createTable('inventory_stock_levels', (t) => {
    t.text('id').primary();
    t.text('locationId').notNullable().references('id').inTable('inventory_locations');
    t.text('itemId').notNullable().references('id').inTable('inventory_items');
    t.decimal('quantity', 14, 4).defaultTo(0);
    t.decimal('reorderPoint', 14, 4);
    t.timestamp('updatedAt', { useTz: true });
    t.timestamp('lastLowStockAlertAt', { useTz: true });

    t.unique(['locationId', 'itemId']);
  });

  await knex.schema.createTable('inventory_stock_movements', (t) => {
    t.text('id').primary();
    t.text('itemId').notNullable().references('id').inTable('inventory_items');
    t.text('locationId').notNullable().references('id').inTable('inventory_locations');
    t.decimal('quantityChange', 14, 4);
    t.text('movementType');
    t.text('referenceId'); // no FK — polymorphic (purchase_order | transfer | pos_sale | manual), matches referenceModel
    t.text('referenceModel');
    t.decimal('unitCost', 14, 4);
    t.text('lotId').references('id').inTable('inventory_lots'); // 0/4 orphans among rows that set it
    t.decimal('balanceAfter', 14, 4);
    t.text('performedBy'); // no FK, attribution-style
    t.text('notes');
    t.timestamp('createdAt', { useTz: true });

    t.index('itemId');
    t.index('locationId');
    t.index(['referenceId', 'referenceModel']);
  });

  await knex.schema.createTable('inventory_transfers', (t) => {
    t.text('id').primary();
    t.text('fromLocationId').notNullable().references('id').inTable('inventory_locations');
    t.text('toLocationId').notNullable().references('id').inTable('inventory_locations');
    t.jsonb('items'); // [{itemId, quantity, lotNumber}] — whole-replaced
    t.text('status');
    t.text('requestNotes');
    t.text('requestedBy');
    t.text('approvedBy');
    t.timestamp('approvedAt', { useTz: true });
    t.text('rejectedBy');
    t.text('rejectionReason');
    t.text('receivedBy');
    t.timestamp('receivedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('fromLocationId');
    t.index('toLocationId');
    t.index('status');
  });

  // ── POS ──────────────────────────────────────────────────────────────────────

  await knex.schema.createTable('pos_register_sessions', (t) => {
    t.text('id').primary();
    t.text('locationId').notNullable().references('id').inTable('inventory_locations');
    t.text('openedBy'); // no FK, attribution-style
    t.timestamp('openedAt', { useTz: true });
    t.decimal('openingFloat', 14, 2);
    t.text('status');
    t.decimal('cashRefunds', 14, 2);
    t.decimal('cashSales', 14, 2);
    t.timestamp('closedAt', { useTz: true });
    t.text('closedBy');
    t.decimal('closingCount', 14, 2);
    t.decimal('expectedCash', 14, 2);
    t.decimal('variance', 14, 2);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('locationId');
  });

  await knex.schema.createTable('pos_sales', (t) => {
    t.text('id').primary();
    t.text('saleNumber');
    t.text('locationId').notNullable().references('id').inTable('inventory_locations');
    t.text('registerSessionId').notNullable().references('id').inTable('pos_register_sessions');
    t.text('contactId'); // no FK — CRM contacts table doesn't exist yet (Phase 7)
    t.jsonb('items'); // whole-replaced (refund flow increments items[].refundedQuantity in JS, writes whole array back)
    t.jsonb('cartDiscount');
    t.text('promoCode');
    t.decimal('subtotal', 14, 2);
    t.decimal('lineDiscountTotal', 14, 2);
    t.decimal('cartDiscountAmount', 14, 2);
    t.decimal('autoDiscountTotal', 14, 2);
    t.decimal('taxTotal', 14, 2);
    t.decimal('total', 14, 2);
    t.jsonb('payments'); // [{method, amount}] — whole-replaced
    t.text('voucherCode');
    t.decimal('voucherAmount', 14, 2);
    t.text('status');
    t.text('staffId'); // no FK, attribution-style
    t.text('staffName');
    t.text('voidReason');
    t.timestamp('voidedAt', { useTz: true });
    t.text('voidedBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('locationId');
    t.index('registerSessionId');
    t.index('status');
  });

  await knex.schema.createTable('pos_refunds', (t) => {
    t.text('id').primary();
    t.text('saleId').notNullable().references('id').inTable('pos_sales');
    t.text('saleNumber');
    t.text('locationId').notNullable().references('id').inTable('inventory_locations');
    t.text('registerSessionId').references('id').inTable('pos_register_sessions');
    t.jsonb('items'); // [{itemId, sku, name, quantity, amount}] — whole-replaced
    t.decimal('amount', 14, 2);
    t.text('method');
    t.text('reason');
    t.text('refundedBy'); // no FK, attribution-style
    t.text('refundedByName');
    t.timestamp('createdAt', { useTz: true });

    t.index('saleId');
    t.index('locationId');
  });

  await knex.schema.createTable('pos_promo_codes', (t) => {
    t.text('id').primary();
    t.text('code').notNullable();
    t.text('discountType');
    t.decimal('discountValue', 14, 4);
    t.timestamp('expiresAt', { useTz: true });
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('code');
  });

  await knex.schema.createTable('pos_vouchers', (t) => {
    t.text('id').primary();
    t.text('code').notNullable();
    t.decimal('value', 14, 2);
    t.timestamp('expiresAt', { useTz: true });
    t.boolean('isActive').defaultTo(true);
    t.timestamp('redeemedAt', { useTz: true });
    t.text('redeemedSaleId'); // no FK — a voucher can be redeemed against a sale that's later voided, kept for audit either way
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('code');
  });

  // ── Phase 1's users table — this module's own access-control flags ────────────
  // Found missing while sweeping inventoryStaffAccessFunctions.js/
  // posStaffAccessFunctions.js: both were still reading/writing these two fields
  // through the Mongo helper even though users has been Postgres since Phase 1 —
  // silently broken (any grant/revoke since Phase 1 wrote to a dead Mongo doc,
  // never taking effect in the real Postgres-backed app) until now.
  await knex.schema.alterTable('users', (t) => {
    t.boolean('isInventoryClerk').defaultTo(false);
    t.specificType('posLocationIds', 'text[]');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('isInventoryClerk');
    t.dropColumn('posLocationIds');
  });

  await knex.schema.dropTableIfExists('pos_vouchers');
  await knex.schema.dropTableIfExists('pos_promo_codes');
  await knex.schema.dropTableIfExists('pos_refunds');
  await knex.schema.dropTableIfExists('pos_sales');
  await knex.schema.dropTableIfExists('pos_register_sessions');

  await knex.schema.dropTableIfExists('inventory_transfers');
  await knex.schema.dropTableIfExists('inventory_stock_movements');
  await knex.schema.dropTableIfExists('inventory_stock_levels');
  await knex.schema.dropTableIfExists('inventory_lots');
  await knex.schema.dropTableIfExists('inventory_purchase_orders');
  await knex.schema.dropTableIfExists('inventory_items');
  await knex.schema.dropTableIfExists('inventory_suppliers');
  await knex.schema.dropTableIfExists('inventory_locations');
  await knex.schema.dropTableIfExists('inventory_custom_field_defs');
  await knex.schema.dropTableIfExists('inventory_units_of_measure');
  await knex.schema.dropTableIfExists('inventory_brands');
  await knex.schema.dropTableIfExists('inventory_categories');
};
