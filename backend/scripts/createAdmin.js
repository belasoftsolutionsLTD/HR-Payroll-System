// Creates a super_admin or hr_manager account directly in the database — the only
// legitimate way to get a super_admin account onto the system, since the web app's
// create-account UI deliberately excludes that role (ALLOWED_CREATE_ROLES in
// accountFunctions.js) to prevent any HR user from self-escalating. Requires actual
// server/DB access to run, same trust boundary as the app enforces, just as a real,
// repeatable tool instead of an ad-hoc database query typed out fresh each time.
//
// Usage:
//   node scripts/createAdmin.js --name="Jane Doe" --email=jane@company.com --role=super_admin
//   node scripts/createAdmin.js --name="Jane Doe" --email=jane@company.com --role=hr_manager --password=SomeStrongPass1!
//
// If --password is omitted, a random one is generated and printed once — save it,
// it isn't shown again. The account is created with mustResetPassword:false since
// there's no email-based credential delivery here (unlike the web UI's createAccount).

require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const ALLOWED_ROLES = ['super_admin', 'hr_manager'];

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function main() {
  const { name, email, role = 'super_admin', password } = parseArgs();

  if (!name || !email) {
    console.error('Usage: node scripts/createAdmin.js --name="Full Name" --email=you@company.com [--role=super_admin|hr_manager] [--password=...]');
    process.exit(1);
  }
  if (!ALLOWED_ROLES.includes(role)) {
    console.error(`Error: --role must be one of: ${ALLOWED_ROLES.join(', ')}`);
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGO_DB_URI);
  await client.connect();
  const db = client.db('school-erp');

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await db.collection('users').findOne({ email: normalizedEmail });
  if (existing) {
    console.error(`Error: a user with email ${normalizedEmail} already exists (role: ${existing.role}).`);
    await client.close();
    process.exit(1);
  }

  const rawPassword = password || generatePassword();
  const hashed = await bcrypt.hash(rawPassword, 12);
  const now = new Date();

  await db.collection('users').insertOne({
    _id: new ObjectId(),
    name: name.trim(),
    email: normalizedEmail,
    password: hashed,
    role,
    employeeId: null,
    isActive: true,
    mustResetPassword: false,
    createdAt: now,
    updatedAt: now,
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${role === 'super_admin' ? 'Super Admin' : 'HR Manager'} account created`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Email:    ${normalizedEmail}`);
  if (!password) console.log(`  Password: ${rawPassword}   (generated — save this, it will not be shown again)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await client.close();
}

main().catch((err) => {
  console.error('Failed to create account:', err.message);
  process.exit(1);
});
