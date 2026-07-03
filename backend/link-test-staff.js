/**
 * One-time script: creates an employee record for the "Test Staff" user
 * and links the user account to it.
 *
 * Run from the backend directory:
 *   node link-test-staff.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

async function main() {
  const client = new MongoClient(process.env.MONGO_DB_URI);
  await client.connect();
  const db = client.db('school-erp');

  // Find the Test Staff user
  const user = await db.collection('users').findOne({ role: 'staff' });
  if (!user) { console.log('No staff user found.'); process.exit(1); }

  console.log(`Found user: ${user.email} (${user._id})`);

  // Check if already linked
  if (user.employeeId) {
    console.log(`Already linked to employee ${user.employeeId}. Nothing to do.`);
    await client.close(); return;
  }

  // Check for an existing employee with the same email
  let employee = await db.collection('employees').findOne({ email: user.email });

  if (!employee) {
    // Create a minimal employee record
    const result = await db.collection('employees').insertOne({
      fullName:       user.name || 'Test Staff',
      email:          user.email,
      staffNumber:    'EMP-TEST-001',
      designation:    'Staff Member',
      department:     'Administration',
      employmentType: 'full_time',
      staffCategory:  'teaching',
      status:         'active',
      dateOfHire:     new Date().toISOString().slice(0, 10),
      paymentMethod:  'bank_transfer',
      createdAt:      new Date(),
      updatedAt:      new Date(),
    });
    employee = { _id: result.insertedId };
    console.log(`Created employee record: ${employee._id}`);
  } else {
    console.log(`Found existing employee: ${employee._id}`);
  }

  // Link user → employee
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { employeeId: employee._id } }
  );

  console.log(`Linked user ${user.email} → employee ${employee._id}. Done.`);
  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
