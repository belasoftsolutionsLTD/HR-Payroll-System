/**
 * Inventory + POS + CRM demo seed — the three-module sales stack built this session.
 *
 * Creates: 2 locations, 4 items (one batch/expiry-tracked, one serial-tracked, one
 * non-tracked service item), 2 suppliers, 1 fully-received purchase order (real stock
 * via the actual movement ledger), 1 inter-location transfer, 2 deliberately-low
 * reorder points (so the low-stock widget has something to show), a demo cashier
 * assigned to the store, 1 register session (open -> 3 sales -> 1 partial refund ->
 * closed, with a small cash variance), 1 promo code, a CRM pipeline with 4 deals
 * spanning New/Qualified/Won/Lost (the Won one confirmed against a real POS sale),
 * 2 companies, 4 contacts (one sourced from that POS sale), a custom contact field,
 * and a handful of activities/tasks (one overdue, one upcoming) so every screen in
 * all three modules has something real to show.
 *
 * Idempotent — safe to re-run, each section skips if its data already exists.
 * Run: node scripts/seedSalesStack.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'school-erp';
const DEPT = 'Retail';

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  global.dbo = db; // every lib/route function below reads off global.dbo, same as the running server
  console.log('Connected to', DB_NAME);

  const { createStockMovement } = require('../src/routes/inventory/inventoryMovementsFunctions');
  const { deductStockForSale, returnStockFromSale } = require('../src/lib/inventory/inventoryIntegration');
  const { receiveLotStock, transferLotStock } = require('../src/routes/inventory/inventoryLotsFunctions');

  const now = new Date();
  const hashed = await bcrypt.hash('Demo@1234', 12);
  const days = (n) => new Date(now.getTime() + n * 86400000);

  // ── 0. HR user + demo cashier + demo sales rep ────────────────────────────────
  let hrUser = await db.collection('users').findOne({ role: { $in: ['hr_manager', 'super_admin'] } });
  if (!hrUser) {
    const hrId = new ObjectId();
    await db.collection('users').insertOne({
      _id: hrId, name: 'Demo HR Manager', email: 'hr@demo.com', password: hashed,
      role: 'hr_manager', employeeId: null, department: null, isActive: true, mustResetPassword: false,
      createdAt: now, updatedAt: now,
    });
    hrUser = { _id: hrId, name: 'Demo HR Manager' };
    console.log('✅ Fallback HR user created  →  hr@demo.com / Demo@1234');
  } else {
    console.log('ℹ️  Using existing HR user:', hrUser.email);
  }

  const ensureEmployeeAndUser = async ({ staffNumber, fullName, email, role, department }) => {
    let emp = await db.collection('employees').findOne({ staffNumber });
    if (!emp) {
      const empId = new ObjectId();
      await db.collection('employees').insertOne({
        _id: empId, staffNumber, fullName, department, email, designation: 'Officer',
        managerId: null, status: 'active', createdAt: now, updatedAt: now,
      });
      emp = { _id: empId };
    }
    let user = await db.collection('users').findOne({ email });
    if (!user) {
      const userId = new ObjectId();
      await db.collection('users').insertOne({
        _id: userId, name: fullName, email, password: hashed, role,
        employeeId: emp._id, department, isActive: true, mustResetPassword: false,
        createdAt: now, updatedAt: now,
      });
      user = { _id: userId };
    }
    return { empId: emp._id, userId: user._id };
  };

  const cashier = await ensureEmployeeAndUser({
    staffNumber: 'DEMO-SALES-CASHIER', fullName: 'Demo Cashier', email: 'cashier.retail@demo.com', role: 'staff', department: DEPT,
  });
  const salesRep = await ensureEmployeeAndUser({
    staffNumber: 'DEMO-SALES-REP', fullName: 'Demo Sales Rep', email: 'salesrep.crm@demo.com', role: 'staff', department: DEPT,
  });
  console.log('✅ Demo cashier + sales rep ensured — login for either: <email> / Demo@1234');

  // ── 1. Locations ───────────────────────────────────────────────────────────────
  const ensureLocation = async (doc) => {
    let loc = await db.collection('inventory_locations').findOne({ name: doc.name });
    if (!loc) {
      const { insertedId } = await db.collection('inventory_locations').insertOne({ ...doc, isActive: true, createdAt: now, updatedAt: now });
      loc = { _id: insertedId, ...doc };
    }
    return loc;
  };
  const warehouse = await ensureLocation({ name: 'Main Warehouse', type: 'warehouse', address: 'Industrial Area, Nairobi', department: null });
  const store = await ensureLocation({ name: 'Nairobi Store', type: 'store', address: 'Westlands, Nairobi', department: DEPT });
  console.log('✅ Locations ensured: Main Warehouse, Nairobi Store');

  // Cashier can only sell at the store — this is POS's own assignment, separate from Inventory.
  await db.collection('users').updateOne({ _id: cashier.userId }, { $set: { posLocationIds: [store._id] } });

  // ── 2. Categories + Items ──────────────────────────────────────────────────────
  for (const name of ['Beverages', 'Snacks', 'Electronics']) {
    const existing = await db.collection('inventory_categories').findOne({ name });
    if (!existing) await db.collection('inventory_categories').insertOne({ name, isActive: true, createdAt: now, updatedAt: now });
  }

  const ensureItem = async (doc) => {
    let item = await db.collection('inventory_items').findOne({ sku: doc.sku });
    if (!item) {
      const full = {
        description: '', barcode: null, expiryTrackingEnabled: false, costingMethod: 'weighted_average',
        avgCost: doc.costPrice, imageUrl: null, customFieldValues: {}, isActive: true,
        createdBy: hrUser._id, createdAt: now, updatedAt: now, ...doc,
      };
      const { insertedId } = await db.collection('inventory_items').insertOne(full);
      item = { _id: insertedId, ...full };
    }
    return item;
  };
  const water = await ensureItem({ sku: 'BEV-001', name: 'Bottled Water 500ml', category: 'Beverages', unitOfMeasure: 'bottle', costPrice: 20, salePrice: 50, isTracked: true, trackingMode: 'none' });
  const milk = await ensureItem({ sku: 'BEV-002', name: 'Fresh Milk 1L', category: 'Beverages', unitOfMeasure: 'litre', costPrice: 80, salePrice: 150, isTracked: true, trackingMode: 'batch', expiryTrackingEnabled: true });
  const chips = await ensureItem({ sku: 'SNK-001', name: 'Potato Chips 150g', category: 'Snacks', unitOfMeasure: 'pack', costPrice: 60, salePrice: 120, isTracked: true, trackingMode: 'none' });
  const mouse = await ensureItem({ sku: 'ELE-001', name: 'Wireless Mouse', category: 'Electronics', unitOfMeasure: 'pcs', costPrice: 800, salePrice: 1500, isTracked: true, trackingMode: 'serial' });
  await ensureItem({ sku: 'SVC-001', name: 'Gift Wrapping Service', category: null, unitOfMeasure: 'service', costPrice: 0, salePrice: 100, isTracked: false, trackingMode: 'none' });
  console.log('✅ 5 items ensured (incl. 1 batch/expiry-tracked, 1 serial-tracked, 1 non-tracked service item)');

  // ── 3. Suppliers ───────────────────────────────────────────────────────────────
  const ensureSupplier = async (doc) => {
    let s = await db.collection('inventory_suppliers').findOne({ name: doc.name });
    if (!s) {
      const full = { contactPerson: '', phone: '', email: '', address: 'Nairobi, Kenya', isActive: true, createdAt: now, updatedAt: now, ...doc };
      const { insertedId } = await db.collection('inventory_suppliers').insertOne(full);
      s = { _id: insertedId, ...full };
    }
    return s;
  };
  const coastalSupplier = await ensureSupplier({ name: 'Coastal Beverages Ltd', contactPerson: 'Fatuma Ali', phone: '0700123456', email: 'sales@coastalbev.co.ke', linkedItemIds: [water._id, milk._id, chips._id], leadTimeDays: 5 });
  await ensureSupplier({ name: 'TechHub Kenya', contactPerson: 'Brian Otieno', phone: '0700333444', email: 'orders@techhub.co.ke', linkedItemIds: [mouse._id], leadTimeDays: 7 });
  console.log('✅ 2 suppliers ensured');

  // ── 4. Purchase order → received (real stock via the movement ledger) ─────────
  let po = await db.collection('inventory_purchase_orders').findOne({ poNumber: 'PO-2026-DEMO01' });
  if (!po) {
    const poDoc = {
      poNumber: 'PO-2026-DEMO01', supplierId: coastalSupplier._id, locationId: warehouse._id,
      items: [
        { itemId: water._id, quantityOrdered: 200, quantityReceived: 200, unitCost: 20 },
        { itemId: milk._id, quantityOrdered: 100, quantityReceived: 100, unitCost: 80 },
        { itemId: chips._id, quantityOrdered: 150, quantityReceived: 150, unitCost: 60 },
      ],
      status: 'received', expectedDeliveryDate: days(-3), createdBy: hrUser._id,
      createdAt: days(-7), updatedAt: now, sentAt: days(-6), receivedAt: days(-3),
    };
    const { insertedId } = await db.collection('inventory_purchase_orders').insertOne(poDoc);
    po = { _id: insertedId, ...poDoc };

    await createStockMovement({ itemId: water._id, locationId: warehouse._id, quantityChange: 200, movementType: 'receipt', referenceId: po._id, referenceModel: 'purchase_order', unitCost: 20, performedBy: hrUser._id });
    const milkLot = await receiveLotStock({ itemId: milk._id, locationId: warehouse._id, lotNumber: 'MILK-2026-A', quantity: 100, expiryDate: days(14), poId: po._id });
    await createStockMovement({ itemId: milk._id, locationId: warehouse._id, quantityChange: 100, movementType: 'receipt', referenceId: po._id, referenceModel: 'purchase_order', unitCost: 80, lotId: milkLot._id, performedBy: hrUser._id });
    await createStockMovement({ itemId: chips._id, locationId: warehouse._id, quantityChange: 150, movementType: 'receipt', referenceId: po._id, referenceModel: 'purchase_order', unitCost: 60, performedBy: hrUser._id });

    // Mouse isn't on this PO — seeded as 2 individually-received serial units, the
    // correct way to receive a serial-tracked item (one lot record per unit).
    for (const serial of ['MOUSE-SN-001', 'MOUSE-SN-002']) {
      const lot = await receiveLotStock({ itemId: mouse._id, locationId: warehouse._id, lotNumber: serial, quantity: 1, poId: null });
      await createStockMovement({ itemId: mouse._id, locationId: warehouse._id, quantityChange: 1, movementType: 'receipt', referenceId: null, referenceModel: null, unitCost: 800, lotId: lot._id, performedBy: hrUser._id });
    }
    console.log('✅ Purchase order PO-2026-DEMO01 received — real stock in Main Warehouse (incl. 1 lot + 2 serial units)');
  } else {
    console.log('ℹ️  Purchase order already seeded, skipping');
  }

  // ── 5. Transfer Warehouse → Store, then set 2 low reorder points ─────────────
  const existingTransfer = await db.collection('inventory_transfers').findOne({ requestNotes: 'DEMO_SEED_TRANSFER' });
  if (!existingTransfer) {
    const transferDoc = {
      fromLocationId: warehouse._id, toLocationId: store._id,
      items: [
        { itemId: water._id, quantity: 80, lotNumber: null },
        { itemId: milk._id, quantity: 40, lotNumber: 'MILK-2026-A' },
        { itemId: chips._id, quantity: 10, lotNumber: null },
        { itemId: mouse._id, quantity: 1, lotNumber: 'MOUSE-SN-001' },
      ],
      status: 'received', requestNotes: 'DEMO_SEED_TRANSFER', requestedBy: hrUser._id,
      approvedBy: hrUser._id, approvedAt: days(-2), receivedBy: hrUser._id, receivedAt: days(-2),
      createdAt: days(-2), updatedAt: days(-2),
    };
    const { insertedId } = await db.collection('inventory_transfers').insertOne(transferDoc);
    const transferId = insertedId;

    for (const line of transferDoc.items) {
      await createStockMovement({ itemId: line.itemId, locationId: warehouse._id, quantityChange: -line.quantity, movementType: 'transfer_out', referenceId: transferId, referenceModel: 'transfer', unitCost: 0, performedBy: hrUser._id });
      await createStockMovement({ itemId: line.itemId, locationId: store._id, quantityChange: line.quantity, movementType: 'transfer_in', referenceId: transferId, referenceModel: 'transfer', unitCost: 0, performedBy: hrUser._id });
      if (line.lotNumber) await transferLotStock({ itemId: line.itemId, lotNumber: line.lotNumber, fromLocationId: warehouse._id, toLocationId: store._id, quantity: line.quantity });
    }

    // Chips (10 in store) and mouse (1 in store) both deliberately below their reorder
    // point — this is what makes the low-stock dashboard widget have something to show.
    await db.collection('inventory_stock_levels').updateOne({ itemId: chips._id, locationId: store._id }, { $set: { reorderPoint: 20 } });
    await db.collection('inventory_stock_levels').updateOne({ itemId: mouse._id, locationId: store._id }, { $set: { reorderPoint: 2 } });
    console.log('✅ Stock transferred Warehouse → Store; chips + mouse left below reorder point on purpose');
  } else {
    console.log('ℹ️  Transfer already seeded, skipping');
  }

  // ── 6. CRM: pipeline, companies, contacts, custom field ───────────────────────
  let pipeline = await db.collection('crm_pipelines').findOne({ name: 'Sales Pipeline' });
  if (!pipeline) {
    const stageNames = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'];
    const stages = stageNames.map((name, i) => ({ id: new ObjectId().toString(), name, order: i, isWon: name === 'Won', isLost: name === 'Lost' }));
    const doc = { name: 'Sales Pipeline', stages, isDefault: true, isActive: true, createdAt: now, updatedAt: now };
    const { insertedId } = await db.collection('crm_pipelines').insertOne(doc);
    pipeline = { _id: insertedId, ...doc };
    console.log('✅ "Sales Pipeline" created (New → Contacted → Qualified → Proposal → Won/Lost)');
  } else {
    console.log('ℹ️  Sales Pipeline already exists');
  }
  const stageId = (name) => pipeline.stages.find((s) => s.name === name).id;

  const ensureCompany = async (doc) => {
    let c = await db.collection('crm_companies').findOne({ name: doc.name });
    if (!c) {
      const full = { customFieldValues: {}, isActive: true, createdBy: hrUser._id, createdAt: now, updatedAt: now, ...doc };
      const { insertedId } = await db.collection('crm_companies').insertOne(full);
      c = { _id: insertedId, ...full };
    }
    return c;
  };
  const acme = await ensureCompany({ name: 'Acme Retail Ltd', industry: 'Retail' });
  const buildRight = await ensureCompany({ name: 'BuildRight Contractors', industry: 'Construction' });
  console.log('✅ 2 companies ensured');

  const existingField = await db.collection('crm_custom_field_defs').findOne({ name: 'Preferred Contact Method' });
  if (!existingField) {
    await db.collection('crm_custom_field_defs').insertOne({
      name: 'Preferred Contact Method', fieldType: 'select', appliesTo: 'contact',
      options: ['Email', 'Phone', 'WhatsApp'], isActive: true, createdAt: now, updatedAt: now,
    });
    console.log('✅ Custom contact field "Preferred Contact Method" created');
  }

  const ensureContact = async (doc) => {
    let c = await db.collection('crm_contacts').findOne({ email: doc.email });
    if (!c) {
      const full = { tags: [], customFieldValues: {}, isActive: true, createdBy: hrUser._id, createdAt: now, updatedAt: now, ...doc };
      const { insertedId } = await db.collection('crm_contacts').insertOne(full);
      c = { _id: insertedId, ...full };
    }
    return c;
  };
  const jane = await ensureContact({ firstName: 'Jane', lastName: 'Mwangi', email: 'jane.mwangi@acmeretail.co.ke', phone: '0711222333', companyId: acme._id, tags: ['vip'], source: 'manual', assignedTo: salesRep.userId });
  const peter = await ensureContact({ firstName: 'Peter', lastName: 'Otieno', email: 'peter.otieno@buildright.co.ke', phone: '0722333444', companyId: buildRight._id, tags: [], source: 'manual', assignedTo: salesRep.userId });
  const grace = await ensureContact({ firstName: 'Grace', lastName: 'Njoroge', email: 'grace.njoroge@gmail.com', phone: '0733444555', companyId: null, tags: ['repeat-customer'], source: 'pos_sale', assignedTo: salesRep.userId });
  const samuel = await ensureContact({ firstName: 'Samuel', lastName: 'Kiprop', email: 'samuel.kiprop@acmeretail.co.ke', phone: '0744555666', companyId: acme._id, tags: ['lead'], source: 'manual', assignedTo: salesRep.userId });
  console.log('✅ 4 contacts ensured (Jane, Peter, Grace, Samuel)');

  // ── 7. POS: register session → sales (one linked to Grace) → partial refund ──
  let saleB;
  const alreadySold = await db.collection('pos_sales').findOne({ saleNumber: 'SALE-2026-DEMO01' });
  if (!alreadySold) {
    const sessionDoc = { locationId: store._id, openedBy: cashier.userId, openedAt: days(-1), openingFloat: 2000, status: 'open', createdAt: days(-1), updatedAt: days(-1) };
    const { insertedId: sessionId } = await db.collection('pos_register_sessions').insertOne(sessionDoc);

    const makeSale = async ({ saleNumber, items, payments, contactId }) => {
      const lines = items.map((l) => ({ ...l, refundedQuantity: 0, lineTotal: l.quantity * l.unitPrice }));
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      const doc = {
        saleNumber, locationId: store._id, registerSessionId: sessionId, contactId: contactId || null,
        items: lines, cartDiscount: null, promoCode: null,
        subtotal, lineDiscountTotal: 0, cartDiscountAmount: 0, total: subtotal,
        payments, status: 'completed', staffId: cashier.userId, staffName: 'Demo Cashier', createdAt: days(-1),
      };
      const { insertedId } = await db.collection('pos_sales').insertOne(doc);
      for (const line of lines) await deductStockForSale(line.itemId, store._id, line.quantity, insertedId, cashier.userId);
      return { _id: insertedId, ...doc };
    };

    await makeSale({
      saleNumber: 'SALE-2026-DEMO00', payments: [{ method: 'cash', amount: 220 }],
      items: [
        { itemId: water._id, sku: water.sku, name: water.name, quantity: 2, unitPrice: 50, discountAmount: 0 },
        { itemId: chips._id, sku: chips.sku, name: chips.name, quantity: 1, unitPrice: 120, discountAmount: 0 },
      ],
    });
    saleB = await makeSale({
      saleNumber: 'SALE-2026-DEMO01', payments: [{ method: 'card', amount: 150 }], contactId: grace._id,
      items: [{ itemId: milk._id, sku: milk.sku, name: milk.name, quantity: 1, unitPrice: 150, discountAmount: 0 }],
    });
    const saleC = await makeSale({
      saleNumber: 'SALE-2026-DEMO02', payments: [{ method: 'cash', amount: 1500 }],
      items: [{ itemId: mouse._id, sku: mouse.sku, name: mouse.name, quantity: 1, unitPrice: 1500, discountAmount: 0 }],
    });

    // A full refund on Sale C — puts the mouse back on the shelf and demonstrates the
    // refund/return path (returnStockFromSale), separate from the same-day void path.
    await returnStockFromSale(mouse._id, store._id, 1, saleC._id, cashier.userId);
    await db.collection('pos_refunds').insertOne({
      saleId: saleC._id, saleNumber: saleC.saleNumber, locationId: store._id, registerSessionId: sessionId,
      items: [{ itemId: mouse._id, sku: mouse.sku, name: mouse.name, quantity: 1, amount: 1500 }],
      amount: 1500, method: 'cash', reason: 'Customer changed their mind', refundedBy: cashier.userId, refundedByName: 'Demo Cashier', createdAt: days(-1),
    });
    await db.collection('pos_sales').updateOne({ _id: saleC._id }, { $set: { status: 'refunded', 'items.0.refundedQuantity': 1 } });

    // Close the register — a small variance on purpose, so that screen has something to show too.
    const expectedCash = 2000 + 220 + 1500 - 1500; // opening float + cash sales - cash refunds
    await db.collection('pos_register_sessions').updateOne({ _id: sessionId }, {
      $set: { status: 'closed', closedBy: cashier.userId, closedAt: days(-1), closingCount: expectedCash - 50, expectedCash, variance: -50, cashSales: 1720, cashRefunds: 1500, updatedAt: days(-1) },
    });

    const promoExisting = await db.collection('pos_promo_codes').findOne({ code: 'WELCOME10' });
    if (!promoExisting) {
      await db.collection('pos_promo_codes').insertOne({ code: 'WELCOME10', discountType: 'percentage', discountValue: 10, expiresAt: null, isActive: true, createdAt: now, updatedAt: now });
    }
    console.log('✅ 3 POS sales made (1 linked to Grace, 1 fully refunded), register closed with a -50 variance, promo code WELCOME10 created');
  } else {
    saleB = alreadySold;
    console.log('ℹ️  POS sales already seeded, skipping');
  }

  // ── 8. CRM: deals + activities/tasks ──────────────────────────────────────────
  const existingDeal = await db.collection('crm_deals').findOne({ title: 'Acme Retail — Bulk Beverage Order' });
  if (!existingDeal) {
    const ensureDeal = async (doc) => {
      const full = { pipelineId: pipeline._id, currency: 'KES', customFieldValues: {}, wonAt: null, lostAt: null, confirmedSaleId: null, createdBy: salesRep.userId, createdAt: now, updatedAt: now, ...doc };
      const { insertedId } = await db.collection('crm_deals').insertOne(full);
      return { _id: insertedId, ...full };
    };
    const dealNew = await ensureDeal({ title: 'Acme Retail — Bulk Beverage Order', contactId: jane._id, companyId: acme._id, stageId: stageId('New'), value: 45000, status: 'open', assignedTo: salesRep.userId, expectedCloseDate: days(21), nextAction: { description: 'Send introductory catalogue', dueDate: days(2) } });
    const dealQualified = await ensureDeal({ title: 'BuildRight — Office Supplies Contract', contactId: peter._id, companyId: buildRight._id, stageId: stageId('Qualified'), value: 120000, status: 'open', assignedTo: salesRep.userId, expectedCloseDate: days(30), nextAction: { description: 'Send formal proposal', dueDate: days(3) } });
    const dealWon = await ensureDeal({ title: 'Grace Njoroge — Repeat Purchase', contactId: grace._id, companyId: null, stageId: stageId('Won'), value: 150, status: 'won', assignedTo: salesRep.userId, wonAt: days(-1), confirmedSaleId: saleB._id, nextAction: null });
    const dealLost = await ensureDeal({ title: 'Samuel Kiprop — Trial Order', contactId: samuel._id, companyId: acme._id, stageId: stageId('Lost'), value: 8000, status: 'lost', assignedTo: salesRep.userId, lostAt: days(-2), lostReason: 'Went with a competitor', nextAction: null });

    const activity = (doc) => ({ notes: null, dueDate: null, completed: null, completedAt: null, assignedTo: null, performedBy: salesRep.userId, performedByName: 'Demo Sales Rep', createdAt: now, ...doc });
    await db.collection('crm_activities').insertMany([
      activity({ type: 'deal_created', contactId: jane._id, dealId: dealNew._id, subject: `Deal "${dealNew.title}" created` }),
      activity({ type: 'call', contactId: jane._id, dealId: dealNew._id, subject: 'Intro call', notes: 'Discussed bulk pricing for beverages, sending catalogue next.' }),
      activity({ type: 'deal_created', contactId: peter._id, dealId: dealQualified._id, subject: `Deal "${dealQualified.title}" created` }),
      activity({ type: 'stage_change', contactId: peter._id, dealId: dealQualified._id, subject: `Deal "${dealQualified.title}" moved from New to Qualified` }),
      activity({ type: 'note', contactId: peter._id, dealId: dealQualified._id, subject: 'Budget confirmed', notes: 'Peter confirmed Q3 budget covers this — ready for a formal proposal.' }),
      activity({ type: 'task', contactId: peter._id, dealId: dealQualified._id, subject: 'Send formal proposal', dueDate: days(3), completed: false, assignedTo: salesRep.userId }),
      activity({ type: 'task', contactId: jane._id, dealId: dealNew._id, subject: 'Follow up on catalogue', dueDate: days(-2), completed: false, assignedTo: salesRep.userId }),
      activity({ type: 'deal_created', contactId: grace._id, dealId: dealWon._id, subject: `Deal "${dealWon.title}" created` }),
      activity({ type: 'deal_won', contactId: grace._id, dealId: dealWon._id, subject: `Deal "${dealWon.title}" won — confirmed against a POS sale` }),
      activity({ type: 'deal_created', contactId: samuel._id, dealId: dealLost._id, subject: `Deal "${dealLost.title}" created` }),
      activity({ type: 'deal_lost', contactId: samuel._id, dealId: dealLost._id, subject: `Deal "${dealLost.title}" lost: Went with a competitor` }),
    ]);
    console.log('✅ 4 deals created (New, Qualified, Won ← confirmed against SALE-2026-DEMO01, Lost) + activities/tasks (1 overdue, 1 upcoming)');
  } else {
    console.log('ℹ️  Deals already seeded, skipping');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  INVENTORY + POS + CRM SEED COMPLETE');
  console.log('  Demo logins (all Demo@1234):');
  console.log('    cashier.retail@demo.com   (staff, assigned to Nairobi Store in POS)');
  console.log('    salesrep.crm@demo.com     (staff, owns the 4 CRM contacts/deals)');
  console.log('  ...or just log in as yourself — super_admin/hr_manager sees everything.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await client.close();
}

seed().catch((err) => { console.error(err); process.exit(1); });
