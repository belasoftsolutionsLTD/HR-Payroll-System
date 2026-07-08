/**
 * Spend Management (Expenses + Procurement) demo seed.
 * Creates a manager chain (department_head -> manager -> 3 staff) if one doesn't
 * already exist, 2 expense policies (1 default + 1 targeted), 1 procurement policy,
 * 5 vendors, 8 expense claims across statuses (incl. 2 itemized), 4 purchase
 * requisitions across statuses, 2 purchase orders (1 fully through to paid), and
 * 1 vendor invoice with a completed 3-way match. Idempotent — safe to re-run
 * (skips creating fixtures that already exist by their demo marker fields).
 * Run: node scripts/seedSpendManagement.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'school-erp';
const DEPT = 'Finance & Accounts';

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  global.dbo = db; // buildApprovalChain/resolvePolicy read off global.dbo, same as the running server
  console.log('Connected to', DB_NAME);

  const { buildApprovalChain } = require('../src/lib/spend/approvalChain');
  const { resolvePolicy } = require('../src/lib/spend/policyResolver');

  const now = new Date();
  const hashed = await bcrypt.hash('Demo@1234', 12);

  // ── 0. HR user + manager chain (department_head -> manager -> staff x3) ──────
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

  const ensureEmployeeAndUser = async ({ staffNumber, fullName, email, role, department, managerEmpId }) => {
    let emp = await db.collection('employees').findOne({ staffNumber });
    if (!emp) {
      const empId = new ObjectId();
      await db.collection('employees').insertOne({
        _id: empId, staffNumber, fullName, department, email,
        designation: role === 'department_head' ? 'Head of Department' : 'Officer',
        managerId: managerEmpId || null, status: 'active', createdAt: now, updatedAt: now,
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

  const deptHead = await ensureEmployeeAndUser({
    staffNumber: 'DEMO-SPEND-DH', fullName: 'Demo Dept Head (Finance)', email: 'depthead.finance@demo.com',
    role: 'department_head', department: DEPT, managerEmpId: null,
  });
  const manager = await ensureEmployeeAndUser({
    staffNumber: 'DEMO-SPEND-MGR', fullName: 'Demo Finance Manager', email: 'manager.finance@demo.com',
    role: 'staff', department: DEPT, managerEmpId: deptHead.empId,
  });
  const staffMembers = [];
  for (let i = 1; i <= 3; i++) {
    staffMembers.push(await ensureEmployeeAndUser({
      staffNumber: `DEMO-SPEND-STAFF-${i}`, fullName: `Demo Finance Staff ${i}`, email: `staff${i}.finance@demo.com`,
      role: 'staff', department: DEPT, managerEmpId: manager.empId,
    }));
  }
  console.log('✅ Manager chain ensured: dept head -> manager -> 3 staff (all in', DEPT + ')');
  console.log('   Login for any: <email> / Demo@1234');

  // ── 1. Expense Policies (2) ───────────────────────────────────────────────────
  let defaultExpPolicy = await db.collection('expense_policies').findOne({ isDefault: true });
  if (!defaultExpPolicy) {
    const { insertedId } = await db.collection('expense_policies').insertOne({
      name: 'Default Expense Policy', description: 'Org-wide fallback policy', isDefault: true, isActive: true,
      appliesTo: {}, categories: [], approvalChain: [], perDiemRates: [],
      defaultPerDiemRate: 3000, mileageRate: 15,
      categoryLimits: [{ category: 'meals', maxPerClaim: 5000 }, { category: 'entertainment', maxPerClaim: 8000 }],
      autoApproveUnder: 1000, hrApprovalThreshold: 50000, reimbursementCycle: 'withNextPayroll',
      createdBy: hrUser._id, createdAt: now, updatedAt: now,
    });
    defaultExpPolicy = { _id: insertedId };
    console.log('✅ Default expense policy created');
  } else {
    console.log('ℹ️  Default expense policy already exists');
  }
  let targetedExpPolicy = await db.collection('expense_policies').findOne({ name: 'Finance & Accounts Travel Policy' });
  if (!targetedExpPolicy) {
    const { insertedId } = await db.collection('expense_policies').insertOne({
      name: 'Finance & Accounts Travel Policy', description: 'Higher travel rates for Finance', isDefault: false, isActive: true,
      appliesTo: { departments: [DEPT] }, categories: [], approvalChain: [], perDiemRates: [],
      defaultPerDiemRate: 4500, mileageRate: 22, categoryLimits: [], autoApproveUnder: 2000, hrApprovalThreshold: 50000,
      reimbursementCycle: 'withNextPayroll', createdBy: hrUser._id, createdAt: now, updatedAt: now,
    });
    targetedExpPolicy = { _id: insertedId };
    console.log('✅ Targeted expense policy created (Finance & Accounts)');
  } else {
    console.log('ℹ️  Targeted expense policy already exists');
  }

  // ── 2. Procurement Policy (1) ─────────────────────────────────────────────────
  let procPolicy = await db.collection('procurement_policies').findOne({ isDefault: true });
  if (!procPolicy) {
    const { insertedId } = await db.collection('procurement_policies').insertOne({
      name: 'Default Procurement Policy', description: 'Org-wide requisition approval policy', isDefault: true, isActive: true,
      appliesTo: {}, approvalChain: [], hrApprovalThreshold: 30000,
      createdBy: hrUser._id, createdAt: now, updatedAt: now,
    });
    procPolicy = { _id: insertedId };
    console.log('✅ Default procurement policy created');
  } else {
    console.log('ℹ️  Default procurement policy already exists');
  }

  // ── 3. Vendors (5) ─────────────────────────────────────────────────────────────
  const vendorSeeds = [
    { name: 'Nairobi Office Supplies Ltd', category: 'Office Supplies', contactName: 'Grace Wanjiru', email: 'sales@nairobisupplies.co.ke', phone: '0700111222', paymentTerms: 'Net 30' },
    { name: 'TechHub Kenya',               category: 'IT & Equipment',  contactName: 'Brian Otieno',  email: 'orders@techhub.co.ke',        phone: '0700333444', paymentTerms: 'Net 15' },
    { name: 'Advocate & Partners LLP',     category: 'Professional Services', contactName: 'Amina Hassan', email: 'billing@advocatepartners.co.ke', phone: '0700555666', paymentTerms: 'Net 45' },
    { name: 'CleanSpace Facilities',       category: 'Facilities',      contactName: 'Peter Kamau',   email: 'accounts@cleanspace.co.ke',   phone: '0700777888', paymentTerms: 'Net 30' },
    { name: 'SwiftLogistics Co.',          category: 'Logistics',       contactName: 'Mercy Achieng', email: 'ops@swiftlogistics.co.ke',    phone: '0700999000', paymentTerms: 'Net 30' },
  ];
  const vendors = [];
  for (const v of vendorSeeds) {
    let vendor = await db.collection('vendors').findOne({ name: v.name });
    if (!vendor) {
      const { insertedId } = await db.collection('vendors').insertOne({
        ...v, address: 'Nairobi, Kenya', taxId: `P0${Math.floor(Math.random() * 900000000 + 100000000)}X`,
        bankDetails: null, status: 'active', notes: null, createdBy: hrUser._id, createdAt: now, updatedAt: now,
      });
      vendor = { _id: insertedId, ...v };
    }
    vendors.push(vendor);
  }
  console.log(`✅ ${vendors.length} vendors ensured`);

  // ── 4. Expense Claims (8 across statuses, incl. 2 itemized) ──────────────────
  const existingClaims = await db.collection('expense_claims').countDocuments({ notes: 'DEMO_SPEND_SEED' });
  if (existingClaims === 0) {
    const buildClaim = async (empId, overrides) => {
      const policy = await resolvePolicy('expense_policies', { employeeId: empId, role: 'staff', department: DEPT }) ?? {};
      const amount = overrides.amount ?? 3000;
      const approvalChain = await buildApprovalChain(empId, amount, policy);
      return {
        employeeId: empId, department: DEPT, type: 'regular', category: 'travel',
        amount, currency: 'KES', date: now, description: 'Demo expense claim', notes: 'DEMO_SPEND_SEED',
        receiptFile: null, destination: null, startDate: null, endDate: null, perDiemDays: null,
        fromLocation: null, toLocation: null, distanceKm: null, isRoundTrip: false,
        projectId: null, isBillable: false, items: null,
        isPolicyViolation: false, violationReason: null,
        policyId: policy._id || null, approvalChain, currentApprovalLevel: approvalChain[0]?.level ?? 0,
        status: 'submitted', approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null, rejectionReason: null,
        reimbursedAt: null, payrollCycleId: null, createdAt: now, updatedAt: now,
        ...overrides,
      };
    };

    const s1 = staffMembers[0].empId, s2 = staffMembers[1].empId, s3 = staffMembers[2].empId;
    const claims = await Promise.all([
      buildClaim(s1, { status: 'draft', category: 'meals', amount: 1500, description: 'Team lunch (draft)' }),
      buildClaim(s1, { status: 'submitted', category: 'travel', amount: 4200, description: 'Client site visit' }),
      buildClaim(s2, { status: 'approved', category: 'accommodation', amount: 8500, description: 'Conference hotel', approvedBy: manager.userId, approvedAt: now }),
      buildClaim(s2, { status: 'rejected', category: 'entertainment', amount: 9000, description: 'Client dinner', rejectedBy: manager.userId, rejectedAt: now, rejectionReason: 'Exceeds category limit without pre-approval' }),
      buildClaim(s3, { status: 'reimbursed', category: 'office_supplies', amount: 2200, description: 'Printer cartridges', approvedBy: hrUser._id, approvedAt: now, reimbursedAt: now }),
      buildClaim(s3, { status: 'disputed', category: 'travel', amount: 3300, description: 'Taxi fares', rejectedBy: manager.userId, rejectedAt: now, rejectionReason: 'Missing receipt' }),
      buildClaim(s1, {
        status: 'submitted', type: 'itemized', category: null, description: null,
        amount: 6400,
        items: [
          { id: new ObjectId().toString(), categoryId: 'meals', categoryName: 'Meals', description: 'Team breakfast', amount: 2400, currency: 'KES', expenseDate: now, receiptFile: null, merchantName: null, notes: null, policyViolation: null },
          { id: new ObjectId().toString(), categoryId: 'travel', categoryName: 'Travel', description: 'Local transport', amount: 4000, currency: 'KES', expenseDate: now, receiptFile: null, merchantName: null, notes: null, policyViolation: null },
        ],
      }),
      buildClaim(s2, {
        status: 'approved', type: 'itemized', category: null, description: null,
        amount: 12000, approvedBy: manager.userId, approvedAt: now,
        items: [
          { id: new ObjectId().toString(), categoryId: 'accommodation', categoryName: 'Accommodation', description: 'Hotel — 2 nights', amount: 10000, currency: 'KES', expenseDate: now, receiptFile: null, merchantName: null, notes: null, policyViolation: null },
          { id: new ObjectId().toString(), categoryId: 'travel', categoryName: 'Travel', description: 'Flight transfer', amount: 2000, currency: 'KES', expenseDate: now, receiptFile: null, merchantName: null, notes: null, policyViolation: null },
        ],
      }),
    ]);
    await db.collection('expense_claims').insertMany(claims);
    console.log(`✅ ${claims.length} expense claims created (statuses: draft, submitted x2, approved x2, rejected, disputed, reimbursed — 2 itemized)`);
  } else {
    console.log('ℹ️  Expense claims already seeded, skipping');
  }

  // ── 5. Purchase Requisitions (4 across statuses) ──────────────────────────────
  const existingPRs = await db.collection('purchase_requests').countDocuments({ title: { $regex: '^DEMO_SPEND_' } });
  let seededPRs = [];
  if (existingPRs === 0) {
    const buildPR = async (empId, overrides) => {
      const policy = await resolvePolicy('procurement_policies', { employeeId: empId, role: 'staff', department: DEPT }) ?? {};
      const amount = overrides.estimatedCost ?? 10000;
      const approvalChain = await buildApprovalChain(empId, amount, policy);
      return {
        title: 'DEMO_SPEND_' + overrides.title, description: overrides.description || null,
        justification: overrides.justification || 'Needed for department operations',
        estimatedCost: amount, currency: 'KES', priority: overrides.priority || 'normal',
        vendor: null, vendorId: overrides.vendorId || null, department: DEPT, items: overrides.items || [],
        neededBy: null, policyId: policy._id || null, approvalChain, currentApprovalLevel: approvalChain[0]?.level ?? 0,
        requestedBy: overrides.requestedByUserId, employeeId: empId, status: overrides.status,
        convertedToPOId: null, approvedBy: overrides.approvedBy || null, approvedAt: overrides.approvedAt || null,
        rejectedBy: overrides.rejectedBy || null, rejectedAt: overrides.rejectedAt || null, rejectionReason: overrides.rejectionReason || null,
        createdAt: now, updatedAt: now,
      };
    };
    const s1 = staffMembers[0], s2 = staffMembers[1];
    const prDefs = [
      { title: 'title:New office chairs', estimatedCost: 25000, status: 'pending', requestedByUserId: s1.userId,
        items: [{ id: new ObjectId().toString(), description: 'Ergonomic office chair', quantity: 5, estimatedUnitPrice: 5000 }] },
      { title: 'title:Laptops for new hires', estimatedCost: 180000, status: 'approved', requestedByUserId: s2.userId,
        approvedBy: deptHead.userId, approvedAt: now, vendorId: vendors[1]._id,
        items: [{ id: new ObjectId().toString(), description: 'Business laptop', quantity: 3, estimatedUnitPrice: 60000 }] },
      { title: 'title:Legal retainer renewal', estimatedCost: 45000, status: 'rejected', requestedByUserId: s1.userId,
        rejectedBy: deptHead.userId, rejectedAt: now, rejectionReason: 'Budget already allocated this quarter',
        items: [{ id: new ObjectId().toString(), description: 'Quarterly legal retainer', quantity: 1, estimatedUnitPrice: 45000 }] },
      { title: 'title:Office deep cleaning', estimatedCost: 15000, status: 'pending', requestedByUserId: s2.userId,
        items: [{ id: new ObjectId().toString(), description: 'Deep cleaning service', quantity: 1, estimatedUnitPrice: 15000 }] },
    ];
    const prs = [];
    for (const def of prDefs) {
      const empId = def.requestedByUserId === s1.userId ? s1.empId : s2.empId;
      prs.push(await buildPR(empId, { ...def, title: def.title.replace('title:', '') }));
    }
    const result = await db.collection('purchase_requests').insertMany(prs);
    seededPRs = Object.values(result.insertedIds).map((id, i) => ({ _id: id, ...prs[i] }));
    console.log(`✅ ${prs.length} purchase requisitions created (statuses: pending x2, approved, rejected)`);
  } else {
    console.log('ℹ️  Purchase requisitions already seeded, skipping');
    seededPRs = await db.collection('purchase_requests').find({ title: { $regex: '^DEMO_SPEND_' } }).toArray();
  }

  // ── 6. Purchase Orders (2) + Vendor Invoice (1, fully matched & paid) ────────
  const approvedPR = seededPRs.find(pr => pr.status === 'approved' && pr.title.includes('Laptops'));
  let existingPOs = await db.collection('purchase_orders').countDocuments({ poNumber: { $regex: '^DEMO-PO-' } });
  if (existingPOs === 0 && approvedPR) {
    const poItems1 = [{ id: new ObjectId().toString(), description: 'Business laptop', quantity: 3, unitPrice: 60000, currency: 'KES', receivedQuantity: 3, specifications: null }];
    const po1 = {
      requisitionId: approvedPR._id, poNumber: 'DEMO-PO-0001', vendorId: vendors[1]._id, requestedBy: approvedPR.requestedBy,
      departmentId: DEPT, status: 'paid', items: poItems1, totalAmount: 180000, currency: 'KES',
      deliveryAddress: 'HQ Nairobi', expectedDeliveryDate: now, actualDeliveryDate: now,
      paymentTerms: 'Net 15', notes: 'Demo fully-completed PO', attachmentUrls: [], invoiceId: null,
      createdBy: hrUser._id, createdAt: now, updatedAt: now,
    };
    const po2 = {
      requisitionId: null, poNumber: 'DEMO-PO-0002', vendorId: vendors[0]._id, requestedBy: hrUser._id,
      departmentId: DEPT, status: 'sent',
      items: [{ id: new ObjectId().toString(), description: 'A4 paper reams', quantity: 50, unitPrice: 600, currency: 'KES', receivedQuantity: 0, specifications: null }],
      totalAmount: 30000, currency: 'KES', deliveryAddress: 'HQ Nairobi', expectedDeliveryDate: now, actualDeliveryDate: null,
      paymentTerms: 'Net 30', notes: 'Demo in-flight PO', attachmentUrls: [], invoiceId: null,
      createdBy: hrUser._id, createdAt: now, updatedAt: now,
    };
    const poResult = await db.collection('purchase_orders').insertMany([po1, po2]);
    const po1Id = poResult.insertedIds[0];
    await db.collection('purchase_requests').updateOne({ _id: approvedPR._id }, { $set: { status: 'converted', convertedToPOId: po1Id, updatedAt: now } });

    await db.collection('goods_receipts').insertOne({
      purchaseOrderId: po1Id, receivedBy: hrUser._id, receivedAt: now,
      items: [{ poItemId: poItems1[0].id, description: poItems1[0].description, orderedQuantity: 3, receivedQuantity: 3, condition: 'good', notes: null }],
      status: 'complete', notes: 'Demo receipt — all items received in good condition', attachmentUrls: [], createdAt: now,
    });

    const invItems = [{ description: 'Business laptop', quantity: 3, unitPrice: 60000, totalPrice: 180000 }];
    const invResult = await db.collection('vendor_invoices').insertOne({
      purchaseOrderId: po1Id, vendorId: vendors[1]._id, invoiceNumber: 'DEMO-INV-0001',
      invoiceDate: now, dueDate: now, items: invItems, totalAmount: 180000, currency: 'KES',
      status: 'paid', threeWayMatchStatus: 'matched', discrepancyNotes: null, fileUrl: null,
      approvedBy: hrUser._id, approvedAt: now, paidAt: now, createdAt: now, updatedAt: now,
    });
    await db.collection('purchase_orders').updateOne({ _id: po1Id }, { $set: { invoiceId: invResult.insertedId, updatedAt: now } });

    console.log('✅ 2 purchase orders created (1 fully paid with matched invoice + receipt, 1 in-flight)');
  } else {
    console.log('ℹ️  Purchase orders already seeded (or no approved PR to convert), skipping');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  SPEND MANAGEMENT SEED COMPLETE');
  console.log('  Demo logins (all Demo@1234):');
  console.log('    depthead.finance@demo.com  (department_head)');
  console.log('    manager.finance@demo.com   (staff, manages 3 reports)');
  console.log('    staff1.finance@demo.com / staff2.finance@demo.com / staff3.finance@demo.com');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await client.close();
}

seed().catch((err) => { console.error(err); process.exit(1); });
