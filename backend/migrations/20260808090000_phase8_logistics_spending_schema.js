// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 8) —
// Logistics (vehicle types, service bays, vehicles, routes + stops, shipments,
// maintenance work orders + parts) and Spending/Procurement/Expenses (corporate cards +
// transactions, legacy expenses, legacy invoices, vendors, procurement policies,
// purchase requests, purchase orders, goods receipts, vendor invoices, expense claims,
// expense policies).
//
// Same conventions as every phase so far: ids stay as unchanged Mongo ObjectId-hex TEXT
// primary keys.
//
// Two REAL child tables this phase (not JSONB), both found by reading every handler for
// per-row mutation, not just the base "create" doc shape:
//   - logistics_route_stops: updateStopStatus/uploadProofOfDelivery both do a genuine
//     Mongo arrayFilters positional update (`'stops.$[stop].status'`) — the clearest
//     "real per-row addressability" signal used throughout this migration. Stop ids are
//     safe as the child table's own PK (fresh `new ObjectId()` per stop, never copied
//     across routes).
//   - logistics_work_order_parts: addPartUsed does a real Mongo `$push` (not just a
//     whole-array JS rewrite like every JSONB array elsewhere) — per this migration's
//     own established rule ("$push/$pull/positional update -> child table"). Parts have
//     NO natural id in the original Mongo shape at all, so this gets an auto-increment
//     integer PK (same pattern as Phase 3b's attendance_breaks / Phase 4's
//     onboarding_tasks), not a Mongo-ObjectId-hex one.
//
// Everything else stays JSONB after confirming (by reading every handler, not just
// counting real rows — several of this phase's tables had 0-1 real documents, not
// enough to infer a shape from data alone) that it's always a whole read-modify-JS-
// write-back: purchase_requests/purchase_orders/expense_claims.items,
// purchase_requests/expense_claims.approvalChain, goods_receipts.items,
// vendor_invoices.items, vendors.documents, procurement_policies/expense_policies'
// appliesTo/approvalChain/categoryLimits/perDiemRates/categories.
//
// Two deliberately-UNCONSTRAINED forward references (both a table pointing at another
// table created later in this same file, set once after the fact rather than at
// creation) — breaking what would otherwise be a circular FK dependency, same posture
// as crm_deals.confirmedSaleId in Phase 7: purchase_requests.convertedToPOId (set by
// convertRequisitionToPO after a purchase_orders row exists) and
// purchase_orders.invoiceId (set by createVendorInvoice after a vendor_invoices row
// exists). logistics_shipments.stopId is similarly unconstrained (a route's stops are
// now a real table, but shipments already treats sourceId as a no-FK polymorphic
// pointer, and constraining just stopId while sourceId stays free would be inconsistent
// for no real benefit).
//
// Several "missing column" finds this phase (this migration's 6th+ occurrence of the
// pattern) — fields only ever written by a LATER action on the same record, never
// present in the record's own creation doc, so a few tables with exactly one very old/
// stripped-down real sample document (expense_policies, procurement_policies) would
// have been especially easy to under-specify from data alone: expense_claims'
// reimbursedBy/reimbursementMethod/reimbursementReference/reimbursementEvidenceFilename/
// reimbursementEvidenceOriginalName/disputeReason/disputedAt (all markReimbursed/
// disputeClaim-only), invoices' paymentReference (markPaid-only),
// procurement_policies.updatedAt (updateProcurementPolicy-only). Caught up front this
// time by reading every handler's full write path before finalizing each table's
// column list, not discovered live via a failed request.
//
// Attribution-only fields get no FK (assignedTo, driverId, createdBy, requestedBy,
// approvedBy, rejectedBy, receivedBy, recordedBy, submittedBy, ...), matching every
// earlier phase's convention. Real ownership/reference FKs (vehicleId, routeId,
// employeeId, vendorId, purchaseOrderId, policyId, cardId, workOrderId, itemId,
// locationId, payrollCycleId) all added, all confirmed clean via live orphan-checks —
// except purchase_orders.requisitionId, which a live check found 1/3 real rows
// orphaned against (a demo-seeded PO, poNumber DEMO-PO-0001) and so was left
// unconstrained instead, same call this migration made for gl_journal_entries.postedBy
// in Phase 7 (1/20 orphaned there too).
//
// `expenses` and `invoices` are both explicitly legacy code paths per the app's own
// comments ("Legacy expense routes (preserved)", "Invoices (legacy AP/AR — preserved)")
// — 0 real rows in production for either, but still live, reachable routes, so
// migrated with full schema like every other 0-row table this migration has hit
// (Phase 6's pos_vouchers, Phase 7's crm_feedback/ar_payments/bank_statement_imports).
//
// reportFunctions.js touches expense_claims/purchase_requests/vendor_invoices
// extensively and is, once again, deliberately left un-migrated — its own future phase
// (Phase 10), 6th time this exact exclusion has been confirmed across this migration.

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  // ── Logistics ────────────────────────────────────────────────────────────────

  await knex.schema.createTable('logistics_vehicle_types', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('logistics_service_bays', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.boolean('isActive').defaultTo(true);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('logistics_vehicles', (t) => {
    t.text('id').primary();
    t.text('make');
    t.text('model');
    t.text('licensePlate');
    t.text('vin');
    t.text('vehicleType'); // plain name string, not FK — same convention as inventory_items.category/brand
    t.text('driverId'); // no FK, attribution-style (an assignment, not owned data)
    t.text('status'); // active|maintenance|inactive
    t.text('currentLocation');
    t.decimal('odometer', 12, 1).defaultTo(0);
    t.text('fuelType');
    t.text('department');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
    t.timestamp('locationUpdatedAt', { useTz: true });

    t.index('driverId');
    t.index('status');
    t.index('department');
  });

  await knex.schema.createTable('logistics_routes', (t) => {
    t.text('id').primary();
    t.text('vehicleId').notNullable().references('id').inTable('logistics_vehicles');
    t.text('driverId'); // no FK, same as vehicles.driverId
    t.timestamp('date', { useTz: true });
    t.text('status'); // planned|in_progress|completed
    t.text('department');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('vehicleId');
    t.index('driverId');
    t.index('status');
  });

  await knex.schema.createTable('logistics_shipments', (t) => {
    t.text('id').primary();
    t.text('sourceType').notNullable(); // pos_sale|inventory_transfer|standalone
    t.text('sourceId'); // no FK — polymorphic, matches every other referenceId in this migration
    t.text('status');
    t.text('routeId').references('id').inTable('logistics_routes');
    t.text('stopId'); // no FK — see file header (would break the routes/shipments/stops creation cycle for no real benefit)
    t.timestamp('expectedDeliveryDate', { useTz: true });
    t.timestamp('actualDeliveryDate', { useTz: true });
    t.text('exceptionReason');
    t.text('exceptionResolution');
    t.timestamp('exceptionResolvedAt', { useTz: true });
    t.text('department');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('routeId');
    t.index('status');
    t.index(['sourceType', 'sourceId']);
  });

  // Real child table — see file header. Own id kept as PK (fresh ObjectId per stop).
  await knex.schema.createTable('logistics_route_stops', (t) => {
    t.text('id').primary();
    t.text('routeId').notNullable().references('id').inTable('logistics_routes');
    t.integer('sequence');
    t.text('address');
    t.decimal('lat', 10, 6);
    t.decimal('lng', 10, 6);
    t.text('timeWindowStart');
    t.text('timeWindowEnd');
    t.text('shipmentId').references('id').inTable('logistics_shipments');
    t.text('status'); // pending|delivered|failed|rescheduled
    t.text('proofOfDeliveryUrl');
    t.text('signatureUrl');
    t.text('notes');
    t.timestamp('completedAt', { useTz: true });

    t.index('routeId');
    t.index('shipmentId');
  });

  await knex.schema.createTable('logistics_work_orders', (t) => {
    t.text('id').primary();
    t.text('vehicleId').notNullable().references('id').inTable('logistics_vehicles');
    t.text('type'); // scheduled|unscheduled
    t.text('description');
    t.text('status'); // open|in_progress|completed
    t.timestamp('scheduledDate', { useTz: true });
    t.timestamp('completedDate', { useTz: true });
    t.text('serviceBay'); // plain name string, not FK — same as vehicleType
    t.decimal('laborCost', 12, 2).defaultTo(0);
    t.decimal('otherCost', 12, 2).defaultTo(0);
    t.decimal('totalCost', 12, 2).defaultTo(0);
    t.boolean('postedToAccounting').defaultTo(false);
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('vehicleId');
    t.index('status');
  });

  // Real child table (real Mongo $push found) — see file header. No natural id in the
  // original shape, so auto-increment PK, same pattern as attendance_breaks/onboarding_tasks.
  await knex.schema.createTable('logistics_work_order_parts', (t) => {
    t.increments('id').primary();
    t.text('workOrderId').notNullable().references('id').inTable('logistics_work_orders');
    t.text('itemId').notNullable().references('id').inTable('inventory_items');
    t.text('itemName');
    t.text('sku');
    t.text('locationId').references('id').inTable('inventory_locations');
    t.decimal('quantity', 12, 4);
    t.decimal('unitCost', 14, 4);

    t.index('workOrderId');
  });

  // ── Spending / Procurement / Expenses ──────────────────────────────────────────

  await knex.schema.createTable('vendors', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('contactName');
    t.text('email');
    t.text('phone');
    t.text('address');
    t.text('category');
    t.text('type'); // company|individual
    t.text('taxId');
    t.text('paymentTerms');
    t.jsonb('bankDetails'); // opaque object, whole-replaced
    t.jsonb('documents'); // [{docId, docType, fileName, filePath, uploadedAt}] — set once at creation (company KYC docs), never positionally mutated after
    t.text('status'); // pending_approval|active|rejected|inactive
    t.text('notes');
    t.text('approvedBy');
    t.timestamp('approvedAt', { useTz: true });
    t.text('rejectedBy');
    t.timestamp('rejectedAt', { useTz: true });
    t.text('rejectionReason');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
    t.index('category');
  });

  await knex.schema.createTable('procurement_policies', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.jsonb('appliesTo'); // {roles?, departments?, employeeIds?} — whole-replaced
    t.jsonb('approvalChain'); // policy-level template, whole-replaced — distinct from a live record's own approvalChain
    t.decimal('requiresQuotationAbove', 14, 2);
    t.specificType('preferredVendors', 'text[]');
    t.boolean('isDefault').defaultTo(false);
    t.boolean('isActive').defaultTo(true);
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true }); // only updateProcurementPolicy sets this — see file header

    t.index('isActive');
    t.index('isDefault');
  });

  await knex.schema.createTable('expense_policies', (t) => {
    t.text('id').primary();
    t.text('name');
    t.text('description');
    t.boolean('isDefault').defaultTo(false);
    t.jsonb('appliesTo');
    t.jsonb('categories');
    t.jsonb('approvalChain');
    t.jsonb('perDiemRates'); // [{location, rate}]
    t.decimal('defaultPerDiemRate', 12, 2);
    t.decimal('mileageRate', 10, 2);
    t.jsonb('categoryLimits'); // [{category, maxPerClaim}]
    t.decimal('autoApproveUnder', 14, 2);
    t.decimal('hrApprovalThreshold', 14, 2);
    t.text('reimbursementCycle');
    t.boolean('isActive').defaultTo(true);
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('isActive');
    t.index('isDefault');
  });

  await knex.schema.createTable('purchase_requests', (t) => {
    t.text('id').primary();
    t.text('title').notNullable();
    t.text('description');
    t.text('justification');
    t.decimal('estimatedCost', 14, 2);
    t.text('currency');
    t.text('priority');
    t.text('vendor'); // free-text vendor name, distinct from vendorId
    t.text('vendorId').references('id').inTable('vendors');
    t.text('department');
    t.jsonb('items'); // [{description, quantity, estimatedUnitPrice}] — whole-replaced
    t.timestamp('neededBy', { useTz: true });
    t.text('policyId').references('id').inTable('procurement_policies');
    t.jsonb('approvalChain'); // live per-record chain, whole-replaced (see approveClaim's chain.map())
    t.integer('currentApprovalLevel').defaultTo(0);
    t.text('requestedBy'); // no FK, attribution-style (users._id)
    t.text('employeeId').references('id').inTable('employees');
    t.text('status');
    t.text('convertedToPOId'); // no FK — see file header (forward reference, set after a purchase_orders row exists)
    t.text('approvedBy');
    t.timestamp('approvedAt', { useTz: true });
    t.text('rejectedBy');
    t.timestamp('rejectedAt', { useTz: true });
    t.text('rejectionReason');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('employeeId');
    t.index('department');
    t.index('status');
  });

  await knex.schema.createTable('purchase_orders', (t) => {
    t.text('id').primary();
    // No FK — a live orphan-check found 1/3 real POs (a demo-seeded one, poNumber
    // DEMO-PO-0001) pointing at a requisition that doesn't exist, same "found orphans ->
    // don't constrain" call this migration has made for other attribution/reference
    // fields (e.g. Phase 7's gl_journal_entries.postedBy).
    t.text('requisitionId');
    t.text('poNumber').unique();
    t.text('vendorId').notNullable().references('id').inTable('vendors');
    t.text('requestedBy'); // no FK
    t.text('departmentId'); // plain department NAME string despite the "Id" suffix (matches how the app itself reads/filters it — see file header note under the corresponding ETL section)
    t.text('status');
    t.jsonb('items'); // [{id, description, quantity, unitPrice, currency, receivedQuantity, specifications}] — whole-replaced (receivedQuantity accumulated in JS across multiple goods receipts, never a positional Mongo update)
    t.decimal('totalAmount', 14, 2);
    t.text('currency');
    t.text('deliveryAddress');
    t.timestamp('expectedDeliveryDate', { useTz: true });
    t.timestamp('actualDeliveryDate', { useTz: true });
    t.text('paymentTerms');
    t.text('notes');
    t.specificType('attachmentUrls', 'text[]');
    t.text('invoiceId'); // no FK — see file header (forward reference, set after a vendor_invoices row exists)
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('requisitionId');
    t.index('vendorId');
    t.index('departmentId');
    t.index('status');
  });

  await knex.schema.createTable('goods_receipts', (t) => {
    t.text('id').primary();
    t.text('purchaseOrderId').notNullable().references('id').inTable('purchase_orders');
    t.text('receivedBy'); // no FK
    t.timestamp('receivedAt', { useTz: true });
    t.jsonb('items'); // [{poItemId, description, orderedQuantity, receivedQuantity, condition, notes}] — set once at creation, never mutated after
    t.text('status'); // complete|partial|disputed
    t.text('notes');
    t.specificType('attachmentUrls', 'text[]');
    t.timestamp('createdAt', { useTz: true });

    t.index('purchaseOrderId');
  });

  await knex.schema.createTable('vendor_invoices', (t) => {
    t.text('id').primary();
    t.text('purchaseOrderId').notNullable().references('id').inTable('purchase_orders');
    t.text('vendorId').notNullable().references('id').inTable('vendors');
    t.text('invoiceNumber');
    t.text('poInvoiceNumber'); // this pipeline's own internal reference, distinct from Inventory's PO invoice numbering (separate counter key)
    t.timestamp('invoiceDate', { useTz: true });
    t.timestamp('dueDate', { useTz: true });
    t.jsonb('items'); // [{description, quantity, unitPrice, totalPrice}] — whole-replaced
    t.decimal('totalAmount', 14, 2);
    t.text('currency');
    t.text('status'); // received|underReview|matched|disputed|approved|paid
    t.text('threeWayMatchStatus'); // pending|matched|discrepancy
    t.text('discrepancyNotes');
    t.text('fileUrl');
    t.text('approvedBy');
    t.timestamp('approvedAt', { useTz: true });
    t.timestamp('paidAt', { useTz: true });
    t.text('paymentMethod'); // payVendorInvoice-only, not part of the creation doc
    t.text('paymentReference'); // payVendorInvoice-only
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('purchaseOrderId');
    t.index('vendorId');
    t.index('status');
  });

  await knex.schema.createTable('corporate_cards', (t) => {
    t.text('id').primary();
    t.text('last4');
    t.text('cardHolder');
    t.text('assignedTo'); // no FK, attribution-style (employees._id)
    t.decimal('creditLimit', 14, 2);
    t.text('currency');
    t.timestamp('expiryDate', { useTz: true });
    t.text('network');
    t.text('status');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
  });

  await knex.schema.createTable('card_transactions', (t) => {
    t.text('id').primary();
    t.text('cardId').notNullable().references('id').inTable('corporate_cards');
    t.decimal('amount', 14, 2);
    t.text('description');
    t.timestamp('date', { useTz: true });
    t.text('merchant');
    t.text('category');
    t.text('type'); // debit|credit
    t.timestamp('createdAt', { useTz: true });

    t.index('cardId');
    t.index('type');
  });

  // Legacy — "Legacy expense routes (preserved)" per the app's own comment. 0 real
  // rows, still a live route.
  await knex.schema.createTable('expenses', (t) => {
    t.text('id').primary();
    t.text('description');
    t.text('category');
    t.decimal('amount', 14, 2);
    t.text('currency');
    t.timestamp('date', { useTz: true });
    t.text('vendor');
    t.text('paymentMethod');
    t.text('notes');
    t.text('recordedBy'); // a plain NAME string (req.user.name), not an id — preserved as-is
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  // Legacy — "Invoices (legacy AP/AR — preserved)" per the app's own comment, distinct
  // from Accounting's ar_invoices (Phase 7) and this phase's own vendor_invoices.
  await knex.schema.createTable('invoices', (t) => {
    t.text('id').primary();
    t.text('vendor');
    t.decimal('amount', 14, 2);
    t.text('currency');
    t.timestamp('dueDate', { useTz: true });
    t.text('description');
    t.text('invoiceNumber');
    t.text('type'); // accounts_payable|accounts_receivable
    t.text('projectId'); // no FK — projects module unmigrated
    t.jsonb('items');
    t.text('status');
    t.text('submittedBy');
    t.text('approvedBy');
    t.timestamp('approvedAt', { useTz: true });
    t.text('rejectedBy');
    t.timestamp('rejectedAt', { useTz: true });
    t.text('rejectionReason');
    t.timestamp('paidAt', { useTz: true });
    t.text('paymentReference'); // markPaid-only, not part of the creation doc
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('status');
    t.index('type');
  });

  await knex.schema.createTable('expense_claims', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees');
    t.text('department');
    t.text('type'); // regular|per_diem|mileage|itemized
    t.text('category');
    t.decimal('amount', 14, 2);
    t.text('currency');
    t.timestamp('date', { useTz: true });
    t.text('description');
    t.text('notes');
    t.text('receiptFile');
    t.text('destination');
    t.timestamp('startDate', { useTz: true });
    t.timestamp('endDate', { useTz: true });
    t.integer('perDiemDays');
    t.text('fromLocation');
    t.text('toLocation');
    t.decimal('distanceKm', 10, 2);
    t.boolean('isRoundTrip').defaultTo(false);
    t.text('projectId'); // no FK — projects module unmigrated
    t.boolean('isBillable').defaultTo(false);
    t.jsonb('items'); // itemized-type line items, whole-replaced
    t.boolean('isPolicyViolation').defaultTo(false);
    t.text('violationReason');
    t.text('policyId').references('id').inTable('expense_policies');
    t.jsonb('approvalChain');
    t.integer('currentApprovalLevel').defaultTo(0);
    t.text('status');
    t.text('approvedBy');
    t.timestamp('approvedAt', { useTz: true });
    t.text('rejectedBy');
    t.timestamp('rejectedAt', { useTz: true });
    t.text('rejectionReason');
    // disputeClaim-only fields — not part of submitClaim's own doc, see file header.
    t.text('disputeReason');
    t.timestamp('disputedAt', { useTz: true });
    // markReimbursed-only fields — not part of submitClaim's own doc, see file header.
    t.timestamp('reimbursedAt', { useTz: true });
    t.text('reimbursedBy');
    t.text('reimbursementMethod');
    t.text('reimbursementReference');
    t.text('reimbursementEvidenceFilename');
    t.text('reimbursementEvidenceOriginalName');
    t.text('payrollCycleId').references('id').inTable('payroll_cycles'); // Postgres since Phase 2
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index('employeeId');
    t.index('status');
    t.index('department');
    t.index('policyId');
    t.index('payrollCycleId');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('expense_claims');
  await knex.schema.dropTableIfExists('invoices');
  await knex.schema.dropTableIfExists('expenses');
  await knex.schema.dropTableIfExists('card_transactions');
  await knex.schema.dropTableIfExists('corporate_cards');
  await knex.schema.dropTableIfExists('vendor_invoices');
  await knex.schema.dropTableIfExists('goods_receipts');
  await knex.schema.dropTableIfExists('purchase_orders');
  await knex.schema.dropTableIfExists('purchase_requests');
  await knex.schema.dropTableIfExists('expense_policies');
  await knex.schema.dropTableIfExists('procurement_policies');
  await knex.schema.dropTableIfExists('vendors');

  await knex.schema.dropTableIfExists('logistics_work_order_parts');
  await knex.schema.dropTableIfExists('logistics_work_orders');
  await knex.schema.dropTableIfExists('logistics_route_stops');
  await knex.schema.dropTableIfExists('logistics_shipments');
  await knex.schema.dropTableIfExists('logistics_routes');
  await knex.schema.dropTableIfExists('logistics_vehicles');
  await knex.schema.dropTableIfExists('logistics_service_bays');
  await knex.schema.dropTableIfExists('logistics_vehicle_types');
};
