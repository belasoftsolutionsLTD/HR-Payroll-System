/**
 * Leave Management demo seed.
 * Creates 6 leave types (Annual, Sick, Maternity, Paternity, Compassionate, Unpaid),
 * 3 accrual policies, a leave_balances doc per active employee per leave type for
 * the current year, 8 public holidays for the current year, 10 leave requests
 * spread across statuses (draft/pending/approved/rejected/cancelled/disputed),
 * and matching leave_audit_log entries. Idempotent — safe to re-run (skips
 * fixtures that already exist by name/code, skips balances that already exist
 * for the year, and only tops up requests up to 10 demo-marked ones).
 * Run: node scripts/seedLeave.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'school-erp';
const YEAR = new Date().getFullYear();

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  global.dbo = db; // leave lib helpers (resolveApprovalChain, calculateLeaveDays) read off global.dbo
  console.log('Connected to', DB_NAME);

  const { resolveApprovalChain } = require('../src/lib/leave/approvalChain');
  const { calculateLeaveDays } = require('../src/lib/leave/dayCalculator');

  const now = new Date();
  const hashed = await bcrypt.hash('Demo@1234', 12);

  // ── 0. HR user + a manager chain fallback if the DB has too few employees ────
  let hrUser = await db.collection('users').findOne({ role: { $in: ['hr_manager', 'super_admin'] } });
  if (!hrUser) {
    const hrId = new ObjectId();
    await db.collection('users').insertOne({
      _id: hrId, name: 'Demo HR Manager', email: 'hr@demo.com', password: hashed,
      role: 'hr_manager', employeeId: null, department: null, isActive: true, mustResetPassword: false,
      createdAt: now, updatedAt: now,
    });
    hrUser = { _id: hrId, name: 'Demo HR Manager' };
    console.log('Fallback HR user created  ->  hr@demo.com / Demo@1234');
  }

  const ensureEmployeeAndUser = async ({ staffNumber, fullName, email, role, department, managerEmpId }) => {
    let emp = await db.collection('employees').findOne({ staffNumber });
    if (!emp) {
      const empId = new ObjectId();
      await db.collection('employees').insertOne({
        _id: empId, staffNumber, fullName, department, email,
        designation: role === 'department_head' ? 'Head of Department' : 'Officer',
        managerId: managerEmpId || null, dateOfHire: new Date(now.getFullYear() - 2, 0, 15),
        status: 'active', createdAt: now, updatedAt: now,
      });
      emp = { _id: empId, managerId: managerEmpId || null, department, fullName, staffNumber };
    }
    let user = await db.collection('users').findOne({ email });
    if (!user) {
      const userId = new ObjectId();
      await db.collection('users').insertOne({
        _id: userId, name: fullName, email, password: hashed, role, employeeId: emp._id,
        department, isActive: true, mustResetPassword: false, createdAt: now, updatedAt: now,
      });
    }
    return emp;
  };

  let employees = await db.collection('employees').find({ status: 'active' }).toArray();
  if (employees.length < 4) {
    const dept = 'Leave Demo';
    const head = await ensureEmployeeAndUser({ staffNumber: 'LVD-001', fullName: 'Demo Dept Head', email: 'leavehead@demo.com', role: 'department_head', department: dept });
    const mgr = await ensureEmployeeAndUser({ staffNumber: 'LVD-002', fullName: 'Demo Manager', email: 'leavemgr@demo.com', role: 'staff', department: dept, managerEmpId: head._id });
    for (let i = 1; i <= 3; i++) {
      await ensureEmployeeAndUser({ staffNumber: `LVD-00${2 + i}`, fullName: `Demo Staff ${i}`, email: `leavestaff${i}@demo.com`, role: 'staff', department: dept, managerEmpId: mgr._id });
    }
    employees = await db.collection('employees').find({ status: 'active' }).toArray();
    console.log(`Fallback manager chain created (password: Demo@1234) — ${employees.length} active employees now available`);
  } else {
    console.log(`Using ${employees.length} existing active employees`);
  }

  // ── 1. Leave Types ────────────────────────────────────────────────────────────
  const LEAVE_TYPE_SEEDS = [
    { name: 'Annual Leave', code: 'AL', description: 'Standard yearly paid leave.', isPaid: true, isCarryOverAllowed: true, maxCarryOverDays: 5, carryOverExpiryMonths: 3, requiresApproval: true, requiresAttachment: false, minNoticeDays: 3, maxConsecutiveDays: 30, eligibilityMonths: 3, countPublicHolidays: false, color: '#3b82f6' },
    { name: 'Sick Leave', code: 'SL', description: 'Paid leave for illness or medical appointments.', isPaid: true, isCarryOverAllowed: false, maxCarryOverDays: null, carryOverExpiryMonths: null, requiresApproval: true, requiresAttachment: true, minNoticeDays: 0, maxConsecutiveDays: 14, eligibilityMonths: 0, countPublicHolidays: false, color: '#ef4444' },
    { name: 'Maternity Leave', code: 'ML', description: 'Paid leave for childbirth and postnatal recovery.', isPaid: true, isCarryOverAllowed: false, maxCarryOverDays: null, carryOverExpiryMonths: null, requiresApproval: true, requiresAttachment: true, minNoticeDays: 30, maxConsecutiveDays: 90, eligibilityMonths: 12, countPublicHolidays: true, color: '#ec4899' },
    { name: 'Paternity Leave', code: 'PL', description: 'Paid leave for new fathers.', isPaid: true, isCarryOverAllowed: false, maxCarryOverDays: null, carryOverExpiryMonths: null, requiresApproval: true, requiresAttachment: false, minNoticeDays: 7, maxConsecutiveDays: 14, eligibilityMonths: 12, countPublicHolidays: true, color: '#8b5cf6' },
    { name: 'Compassionate Leave', code: 'CL', description: 'Leave for bereavement or family emergencies.', isPaid: true, isCarryOverAllowed: false, maxCarryOverDays: null, carryOverExpiryMonths: null, requiresApproval: true, requiresAttachment: false, minNoticeDays: 0, maxConsecutiveDays: 5, eligibilityMonths: 0, countPublicHolidays: true, color: '#f59e0b' },
    { name: 'Unpaid Leave', code: 'UL', description: 'Leave without pay for extended personal circumstances.', isPaid: false, isCarryOverAllowed: false, maxCarryOverDays: null, carryOverExpiryMonths: null, requiresApproval: true, requiresAttachment: false, minNoticeDays: 14, maxConsecutiveDays: 30, eligibilityMonths: 0, countPublicHolidays: false, color: '#64748b' },
  ];
  const leaveTypeIds = {};
  for (const seedType of LEAVE_TYPE_SEEDS) {
    let type = await db.collection('leave_types').findOne({ code: seedType.code });
    if (!type) {
      const result = await db.collection('leave_types').insertOne({
        ...seedType, isActive: true, appliesTo: {}, createdBy: hrUser._id, createdAt: now, updatedAt: now,
      });
      type = { _id: result.insertedId };
      console.log(`Leave type created: ${seedType.name}`);
    }
    leaveTypeIds[seedType.code] = type._id;
  }

  // ── 2. Accrual Policies ───────────────────────────────────────────────────────
  const ACCRUAL_SEEDS = [
    { name: 'Annual Leave - Standard', code: 'AL', accrualFrequency: 'monthly', accrualAmount: 1.75, maxAnnualEntitlement: 21, appliesTo: {} },
    { name: 'Sick Leave - Standard', code: 'SL', accrualFrequency: 'annual', accrualAmount: 14, maxAnnualEntitlement: 14, appliesTo: {} },
    { name: 'Annual Leave - Management', code: 'AL', accrualFrequency: 'monthly', accrualAmount: 2.25, maxAnnualEntitlement: 27, appliesTo: { roles: ['department_head', 'hr_manager', 'super_admin'] } },
  ];
  const entitlementByCode = { AL: 21, SL: 14, ML: 90, PL: 14, CL: 5, UL: 100 };
  for (const p of ACCRUAL_SEEDS) {
    const exists = await db.collection('leave_accrual_policies').findOne({ name: p.name });
    if (!exists) {
      await db.collection('leave_accrual_policies').insertOne({
        name: p.name, leaveTypeId: leaveTypeIds[p.code], accrualFrequency: p.accrualFrequency,
        accrualAmount: p.accrualAmount, maxAnnualEntitlement: p.maxAnnualEntitlement,
        appliesTo: p.appliesTo, isActive: true, createdBy: hrUser._id, createdAt: now,
      });
      console.log(`Accrual policy created: ${p.name}`);
    }
  }

  // ── 3. Public Holidays ────────────────────────────────────────────────────────
  const HOLIDAY_SEEDS = [
    { name: "New Year's Day", date: `${YEAR}-01-01` },
    { name: 'Good Friday', date: `${YEAR}-04-18` },
    { name: 'Easter Monday', date: `${YEAR}-04-21` },
    { name: 'Labour Day', date: `${YEAR}-05-01` },
    { name: 'Madaraka Day', date: `${YEAR}-06-01` },
    { name: 'Mashujaa Day', date: `${YEAR}-10-20` },
    { name: 'Jamhuri Day', date: `${YEAR}-12-12` },
    { name: 'Christmas Day', date: `${YEAR}-12-25` },
  ];
  for (const h of HOLIDAY_SEEDS) {
    const exists = await db.collection('public_holidays').findOne({ name: h.name, date: h.date });
    if (!exists) {
      await db.collection('public_holidays').insertOne({
        name: h.name, date: h.date, isRecurringAnnually: true, appliesTo: [], createdBy: hrUser._id, createdAt: now,
      });
      console.log(`Public holiday created: ${h.name}`);
    }
  }

  // ── 4. Leave Balances — one per employee per leave type for the current year ──
  let balancesCreated = 0;
  for (const emp of employees) {
    for (const code of Object.keys(leaveTypeIds)) {
      const leaveTypeId = leaveTypeIds[code];
      const exists = await db.collection('leave_balances').findOne({ employeeId: emp._id, leaveTypeId, year: YEAR });
      if (exists) continue;
      const accrued = entitlementByCode[code] || 0;
      await db.collection('leave_balances').insertOne({
        employeeId: emp._id, leaveTypeId, year: YEAR,
        openingBalance: 0, accrued, used: 0, pending: 0, carriedOver: 0, carryOverExpiry: null,
        closingBalance: accrued, lastAccrualDate: now, updatedAt: now,
      });
      balancesCreated++;
    }
  }
  console.log(`${balancesCreated} leave balance record(s) created`);

  // ── 5. Leave Requests across statuses + audit log ─────────────────────────────
  const applyDelta = async (employeeId, leaveTypeId, { pending = 0, used = 0 }) => {
    await db.collection('leave_balances').updateOne(
      { employeeId, leaveTypeId, year: YEAR },
      { $inc: { pending, used }, $set: { updatedAt: new Date() } }
    );
    const bal = await db.collection('leave_balances').findOne({ employeeId, leaveTypeId, year: YEAR });
    if (bal) {
      const closingBalance = bal.openingBalance + bal.accrued + bal.carriedOver - bal.used - bal.pending;
      await db.collection('leave_balances').updateOne({ _id: bal._id }, { $set: { closingBalance } });
    }
  };
  const audit = (leaveRequestId, employeeId, action, performedByName, comment) =>
    db.collection('leave_audit_log').insertOne({
      leaveRequestId, employeeId, action, performedBy: null, performedByName: performedByName || null,
      previousValue: null, newValue: null, comment: comment || null, timestamp: new Date(),
    });

  const existingDemoCount = await db.collection('leave_requests').countDocuments({ isDemoSeed: true });
  if (existingDemoCount >= 10) {
    console.log('10 demo leave requests already exist — skipping request creation.');
  } else {
    const staffPool = employees.filter(e => e.department !== undefined);
    const pick = (i) => staffPool[i % staffPool.length];
    const dateStr = (d) => d.toISOString().slice(0, 10);
    const addDays = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };

    const REQUEST_PLAN = [
      { status: 'draft',     code: 'AL', offset: 20, span: 3 },
      { status: 'draft',     code: 'SL', offset: 15, span: 1 },
      { status: 'pending',   code: 'AL', offset: 10, span: 4 },
      { status: 'pending',   code: 'CL', offset: 5,  span: 2 },
      { status: 'approved',  code: 'AL', offset: -30, span: 5 },
      { status: 'approved',  code: 'SL', offset: -15, span: 2 },
      { status: 'approved',  code: 'PL', offset: -60, span: 3 },
      { status: 'rejected',  code: 'UL', offset: -20, span: 10 },
      { status: 'cancelled', code: 'AL', offset: -10, span: 3 },
      { status: 'disputed',  code: 'SL', offset: -25, span: 2 },
    ];

    let created = 0;
    for (let i = 0; i < REQUEST_PLAN.length; i++) {
      const plan = REQUEST_PLAN[i];
      const emp = pick(i);
      if (!emp) break;
      const leaveTypeId = leaveTypeIds[plan.code];
      const leaveType = await db.collection('leave_types').findOne({ _id: leaveTypeId });
      const startDate = addDays(now, plan.offset);
      const endDate = addDays(startDate, plan.span - 1);
      const totalDays = await calculateLeaveDays({ startDate: dateStr(startDate), endDate: dateStr(endDate), countPublicHolidays: leaveType.countPublicHolidays });
      if (totalDays <= 0) continue;

      let approvalChain = [];
      let currentApprovalLevel = 0;
      if (plan.status !== 'draft') {
        approvalChain = await resolveApprovalChain(emp, totalDays);
        currentApprovalLevel = approvalChain.length ? 1 : 0;
        if (plan.status !== 'pending') {
          approvalChain = approvalChain.map((step, idx) => idx === 0 ? { ...step, status: plan.status === 'rejected' || plan.status === 'disputed' ? 'rejected' : 'approved', actedAt: now } : step);
        }
      }

      const doc = {
        employeeId: emp._id, leaveTypeId, startDate, endDate, totalDays,
        halfDay: null, reason: `Demo seed ${plan.status} request`, attachmentUrl: null,
        status: plan.status === 'disputed' ? 'disputed' : plan.status,
        approvalChain, currentApprovalLevel,
        rejectionReason: (plan.status === 'rejected' || plan.status === 'disputed') ? 'Insufficient coverage during requested period.' : null,
        cancelledAt: plan.status === 'cancelled' ? now : null, cancelledBy: plan.status === 'cancelled' ? emp._id : null,
        revokedAt: null, revokedBy: null,
        disputeReason: plan.status === 'disputed' ? 'I was not given a reason for this rejection.' : null,
        disputeResolvedAt: null, disputeResolvedBy: null,
        payrollRunId: null, createdAt: now, updatedAt: now, isDemoSeed: true,
      };
      const result = await db.collection('leave_requests').insertOne(doc);
      created++;

      if (plan.status === 'draft') continue;

      await applyDelta(emp._id, leaveTypeId, { pending: totalDays });
      await audit(result.insertedId, emp._id, 'submitted', emp.fullName, null);

      if (plan.status === 'pending') continue;

      if (plan.status === 'approved') {
        await applyDelta(emp._id, leaveTypeId, { pending: -totalDays, used: totalDays });
        await audit(result.insertedId, emp._id, 'approved', 'Demo Approver', 'Approved via demo seed');
      } else if (plan.status === 'rejected' || plan.status === 'disputed') {
        await applyDelta(emp._id, leaveTypeId, { pending: -totalDays });
        await audit(result.insertedId, emp._id, 'rejected', 'Demo Approver', 'Rejected via demo seed');
        if (plan.status === 'disputed') {
          await audit(result.insertedId, emp._id, 'disputed', emp.fullName, 'Disputed via demo seed');
        }
      } else if (plan.status === 'cancelled') {
        await applyDelta(emp._id, leaveTypeId, { pending: -totalDays });
        await audit(result.insertedId, emp._id, 'cancelled', emp.fullName, 'Cancelled via demo seed');
      }
    }
    console.log(`${created} demo leave request(s) created`);
  }

  console.log('Leave seed complete.');
  await client.close();
}

seed().catch((err) => { console.error(err); process.exit(1); });
