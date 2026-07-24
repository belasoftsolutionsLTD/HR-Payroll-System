/**
 * Demo seed — creates demo staff and department_head accounts with linked employees.
 * Run: node seed-demo.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME   = 'school-erp';
const PASSWORD  = 'Demo@1234';

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log('Connected to', DB_NAME);

  const hashed = await bcrypt.hash(PASSWORD, 12);
  const now = new Date();

  // ── 1. Demo Staff ────────────────────────────────────────────────────────────
  const staffEmpId = new ObjectId();
  const staffUserId = new ObjectId();

  // Ensure employee doesn't already exist
  const existingStaffEmp = await db.collection('employees').findOne({ staffNumber: 'DEMO-001' });
  const existingStaffUser = await db.collection('users').findOne({ email: 'staff@demo.com' });

  if (!existingStaffEmp) {
    await db.collection('employees').insertOne({
      _id: staffEmpId,
      fullName:       'Demo Staff',
      staffNumber:    'DEMO-001',
      email:          'staff@demo.com',
      phone:          '+254700000001',
      designation:    'Software Developer',
      department:     'Technology',
      status:         'active',
      employmentType: 'permanent',
      grossPay:       80000,
      dateOfHire:     '2024-01-15',
      paymentMethod:  'mpesa',
      mpesaNumber:    '254700000001',
      createdAt:      now,
      updatedAt:      now,
    });
    console.log('✅ Demo staff employee created');
  } else {
    console.log('ℹ️  Demo staff employee already exists');
  }

  if (!existingStaffUser) {
    const empId = existingStaffEmp?._id ?? staffEmpId;
    await db.collection('users').insertOne({
      _id:               staffUserId,
      name:              'Demo Staff',
      email:             'staff@demo.com',
      password:          hashed,
      role:              'staff',
      employeeId:        empId,
      department:        'Technology',
      isActive:          true,
      mustResetPassword: false,
      createdAt:         now,
      updatedAt:         now,
    });
    console.log('✅ Demo staff user created  →  staff@demo.com / Demo@1234');
  } else {
    // Reset password in case it changed
    await db.collection('users').updateOne(
      { email: 'staff@demo.com' },
      { $set: { password: hashed, mustResetPassword: false, isActive: true } }
    );
    console.log('ℹ️  Demo staff user already exists — password reset to Demo@1234');
  }

  // ── 2. Demo Department Head ──────────────────────────────────────────────────
  const deptEmpId  = new ObjectId();
  const deptUserId = new ObjectId();

  const existingDeptEmp  = await db.collection('employees').findOne({ staffNumber: 'DEMO-002' });
  const existingDeptUser = await db.collection('users').findOne({ email: 'depthead@demo.com' });

  if (!existingDeptEmp) {
    await db.collection('employees').insertOne({
      _id: deptEmpId,
      fullName:       'Demo Dept Head',
      staffNumber:    'DEMO-002',
      email:          'depthead@demo.com',
      phone:          '+254700000002',
      designation:    'Head of Technology',
      department:     'Technology',
      status:         'active',
      employmentType: 'permanent',
      grossPay:       120000,
      dateOfHire:     '2022-06-01',
      paymentMethod:  'bank_transfer',
      bankName:       'KCB',
      bankAccountNumber: '1234567890',
      createdAt:      now,
      updatedAt:      now,
    });
    console.log('✅ Demo dept head employee created');
  } else {
    console.log('ℹ️  Demo dept head employee already exists');
  }

  if (!existingDeptUser) {
    const empId = existingDeptEmp?._id ?? deptEmpId;
    await db.collection('users').insertOne({
      _id:               deptUserId,
      name:              'Demo Dept Head',
      email:             'depthead@demo.com',
      password:          hashed,
      role:              'department_head',
      employeeId:        empId,
      department:        'Technology',
      isActive:          true,
      mustResetPassword: false,
      createdAt:         now,
      updatedAt:         now,
    });
    console.log('✅ Demo dept head user created  →  depthead@demo.com / Demo@1234');
  } else {
    await db.collection('users').updateOne(
      { email: 'depthead@demo.com' },
      { $set: { password: hashed, mustResetPassword: false, isActive: true } }
    );
    console.log('ℹ️  Demo dept head user already exists — password reset to Demo@1234');
  }

  // ── 3. Demo Super Admin ───────────────────────────────────────────────────────
  // Not linked to an employee record — super_admin is a system/HR-operator role,
  // not a managed staff member, same convention this app already uses (the normal
  // account-creation flow only ever issues hr_manager/department_head/staff roles).
  const existingAdminUser = await db.collection('users').findOne({ email: 'admin@demo.com' });

  if (!existingAdminUser) {
    await db.collection('users').insertOne({
      _id:               new ObjectId(),
      name:              'Demo Super Admin',
      email:             'admin@demo.com',
      password:          hashed,
      role:              'super_admin',
      employeeId:        null,
      isActive:          true,
      mustResetPassword: false,
      createdAt:         now,
      updatedAt:         now,
    });
    console.log('✅ Demo super admin user created  →  admin@demo.com / Demo@1234');
  } else {
    await db.collection('users').updateOne(
      { email: 'admin@demo.com' },
      { $set: { password: hashed, mustResetPassword: false, isActive: true } }
    );
    console.log('ℹ️  Demo super admin user already exists — password reset to Demo@1234');
  }

  // ── 4. Summary ───────────────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  DEMO CREDENTIALS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Super Admin');
  console.log('    Email:    admin@demo.com');
  console.log('    Password: Demo@1234');
  console.log('');
  console.log('  Staff Portal');
  console.log('    Email:    staff@demo.com');
  console.log('    Password: Demo@1234');
  console.log('');
  console.log('  Department Portal');
  console.log('    Email:    depthead@demo.com');
  console.log('    Password: Demo@1234');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await client.close();
}

seed().catch(err => { console.error(err); process.exit(1); });
