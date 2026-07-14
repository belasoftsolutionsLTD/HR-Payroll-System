/**
 * Onboarding & Offboarding demo seed.
 * Creates 2 onboarding templates (Software Engineer, Operations Staff), 3 onboarding
 * records (preboarding, active-midway, completed), 1 offboarding template (Standard
 * Resignation), and 2 offboarding records (active-with-assets-outstanding, completed
 * with exit interview + generated documents). Reuses the real initiateOnboarding/
 * initiateOffboarding lib functions so seeded records match exactly what the live
 * app produces. Idempotent — safe to re-run (skips fixtures that already exist).
 * Run: node scripts/seedOnboardingOffboarding.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'school-erp';
const IT_DEPT = 'Information Technology';
const OPS_DEPT = 'Operations';

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  global.dbo = db; // initiateOnboarding/initiateOffboarding read off global.dbo, same as the running server
  console.log('Connected to', DB_NAME);

  const { initiateOnboarding } = require('../src/lib/onboarding/autoAssignTasks');
  const { initiateOffboarding } = require('../src/lib/offboarding/autoAssignTasks');

  const now = new Date();
  const hashed = await bcrypt.hash('Demo@1234', 12);
  const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

  // ── 0. HR user + demo employees ───────────────────────────────────────────────
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

  const ensureEmployeeAndUser = async ({ staffNumber, fullName, email, department, designation, dateOfHire, status }) => {
    let emp = await db.collection('employees').findOne({ staffNumber });
    if (!emp) {
      const empId = new ObjectId();
      await db.collection('employees').insertOne({
        _id: empId, staffNumber, fullName, department, email, designation: designation || 'Officer',
        managerId: null, status: status || 'active', dateOfHire: dateOfHire || now, createdAt: now, updatedAt: now,
      });
      emp = { _id: empId };
    }
    let user = await db.collection('users').findOne({ email });
    if (!user) {
      const userId = new ObjectId();
      await db.collection('users').insertOne({
        _id: userId, name: fullName, email, password: hashed, role: 'staff',
        employeeId: emp._id, department, isActive: true, mustResetPassword: false,
        createdAt: now, updatedAt: now,
      });
      user = { _id: userId };
    }
    return emp._id;
  };

  const preboardingEmp = await ensureEmployeeAndUser({
    staffNumber: 'DEMO-ONB-1', fullName: 'Demo New Hire (Preboarding)', email: 'newhire.preboarding@demo.com',
    department: IT_DEPT, designation: 'Software Engineer', dateOfHire: daysFromNow(5),
  });
  const midwayEmp = await ensureEmployeeAndUser({
    staffNumber: 'DEMO-ONB-2', fullName: 'Demo New Hire (Midway)', email: 'newhire.midway@demo.com',
    department: OPS_DEPT, designation: 'Operations Staff', dateOfHire: daysFromNow(-5),
  });
  const completedOnbEmp = await ensureEmployeeAndUser({
    staffNumber: 'DEMO-ONB-3', fullName: 'Demo New Hire (Completed)', email: 'newhire.completed@demo.com',
    department: IT_DEPT, designation: 'Software Engineer', dateOfHire: daysFromNow(-20),
  });
  const activeOffbEmp = await ensureEmployeeAndUser({
    staffNumber: 'DEMO-OFB-1', fullName: 'Demo Exiting Employee (Active)', email: 'exiting.active@demo.com',
    department: OPS_DEPT, designation: 'Operations Staff',
  });
  const completedOffbEmp = await ensureEmployeeAndUser({
    staffNumber: 'DEMO-OFB-2', fullName: 'Demo Exiting Employee (Completed)', email: 'exiting.completed@demo.com',
    department: IT_DEPT, designation: 'Software Engineer', status: 'inactive',
  });
  console.log('✅ 5 demo employees ensured (3 onboarding, 2 offboarding)');

  // ── 1. Onboarding Templates (2) ────────────────────────────────────────────────
  const buildOnbTaskList = (id, name, assignedTo, tasks) => ({ id, name, assignedTo, tasks });
  const buildOnbTask = (id, title, description, dueOffsetDays, opts = {}) => ({
    id, title, description, dueOffsetDays, isRequired: opts.isRequired !== false, requiresDocument: !!opts.requiresDocument,
  });

  let swEngTemplate = await db.collection('onboarding_templates').findOne({ name: 'Software Engineer Onboarding' });
  if (!swEngTemplate) {
    const { insertedId } = await db.collection('onboarding_templates').insertOne({
      name: 'Software Engineer Onboarding',
      description: 'Standard onboarding checklist for new engineering hires.',
      targetRoles: ['Software Engineer'], targetDepartments: [IT_DEPT],
      welcomeMessage: "Welcome to the team! We're thrilled to have you on board — here's everything you need for your first week.",
      firstDayDetails: { location: 'HQ Nairobi, 3rd Floor', reportingTime: '8:30 AM', whatToBring: 'National ID, bank details, passport photo', additionalNotes: 'Ask for reception, they will direct you to IT.' },
      taskLists: [
        buildOnbTaskList('list-hr', 'HR Paperwork', 'hr', [
          buildOnbTask('t-contract', 'Sign employment contract', 'Review and sign your employment contract', 1, { requiresDocument: true }),
          buildOnbTask('t-bank', 'Submit bank details', 'For payroll processing', 2),
        ]),
        buildOnbTaskList('list-it', 'IT Setup', 'it', [
          buildOnbTask('t-laptop', 'Issue laptop & accounts', 'Set up laptop, email and dev tools access', 1),
          buildOnbTask('t-vpn', 'Configure VPN access', 'Set up VPN for remote access', 2),
        ]),
        buildOnbTaskList('list-mgr', 'Manager Check-ins', 'manager', [
          buildOnbTask('t-1on1', 'Schedule first 1:1', 'Set up an introductory 1:1 meeting', 3),
        ]),
        buildOnbTaskList('list-newhire', 'Getting Started', 'newHire', [
          buildOnbTask('t-handbook', 'Read employee handbook', 'Review company policies', 3),
          buildOnbTask('t-workstation', 'Set up workstation', 'Set up your desk and dev environment', 1),
        ]),
      ],
      meetTheTeam: [],
      createdBy: hrUser._id, createdAt: now, updatedAt: now,
    });
    swEngTemplate = { _id: insertedId };
    console.log('✅ "Software Engineer Onboarding" template created');
  } else {
    console.log('ℹ️  "Software Engineer Onboarding" template already exists');
  }

  let opsTemplate = await db.collection('onboarding_templates').findOne({ name: 'Operations Staff Onboarding' });
  if (!opsTemplate) {
    const { insertedId } = await db.collection('onboarding_templates').insertOne({
      name: 'Operations Staff Onboarding',
      description: 'Standard onboarding checklist for new operations hires.',
      targetRoles: ['Operations Staff'], targetDepartments: [OPS_DEPT],
      welcomeMessage: 'Welcome aboard! Looking forward to having you on the operations team.',
      firstDayDetails: { location: 'HQ Nairobi, Ground Floor', reportingTime: '8:00 AM', whatToBring: 'National ID, bank details', additionalNotes: 'Report to the Operations desk.' },
      taskLists: [
        buildOnbTaskList('list-hr', 'HR Paperwork', 'hr', [
          buildOnbTask('t-contract', 'Sign employment contract', 'Review and sign your employment contract', 1, { requiresDocument: true }),
        ]),
        buildOnbTaskList('list-mgr', 'Manager Check-ins', 'manager', [
          buildOnbTask('t-1on1', 'Schedule first 1:1', 'Set up an introductory 1:1 meeting', 2),
          buildOnbTask('t-shadow', 'Shadow a team member', 'Spend a day shadowing operations', 3),
        ]),
        buildOnbTaskList('list-newhire', 'Getting Started', 'newHire', [
          buildOnbTask('t-handbook', 'Read employee handbook', 'Review company policies', 2),
        ]),
      ],
      meetTheTeam: [],
      createdBy: hrUser._id, createdAt: now, updatedAt: now,
    });
    opsTemplate = { _id: insertedId };
    console.log('✅ "Operations Staff Onboarding" template created');
  } else {
    console.log('ℹ️  "Operations Staff Onboarding" template already exists');
  }

  // ── 2. Onboarding Records (3) ──────────────────────────────────────────────────
  const completeOnbTask = async (recordId, listId, taskId) => {
    await db.collection('onboarding_records').updateOne(
      { _id: recordId },
      { $set: {
        'taskLists.$[list].tasks.$[task].status': 'completed',
        'taskLists.$[list].tasks.$[task].completedAt': now,
        'taskLists.$[list].tasks.$[task].completedBy': hrUser._id,
      } },
      { arrayFilters: [{ 'list.id': listId }, { 'task.id': taskId }] }
    );
  };

  const existingPreboarding = await db.collection('onboarding_records').findOne({ employeeId: preboardingEmp });
  if (!existingPreboarding) {
    await initiateOnboarding(preboardingEmp, swEngTemplate._id, daysFromNow(5), hrUser._id);
    console.log('✅ Onboarding record created — preboarding (starts in 5 days)');
  } else {
    console.log('ℹ️  Preboarding onboarding record already exists');
  }

  const existingMidway = await db.collection('onboarding_records').findOne({ employeeId: midwayEmp });
  if (!existingMidway) {
    const record = await initiateOnboarding(midwayEmp, opsTemplate._id, daysFromNow(-5), hrUser._id);
    // Half the tasks done — realistic "active, in progress" state
    await completeOnbTask(record._id, 'list-hr', 't-contract');
    await completeOnbTask(record._id, 'list-mgr', 't-1on1');
    console.log('✅ Onboarding record created — active, midway (2 of 4 tasks done)');
  } else {
    console.log('ℹ️  Midway onboarding record already exists');
  }

  const existingCompletedOnb = await db.collection('onboarding_records').findOne({ employeeId: completedOnbEmp });
  if (!existingCompletedOnb) {
    const record = await initiateOnboarding(completedOnbEmp, swEngTemplate._id, daysFromNow(-20), hrUser._id);
    for (const [listId, taskId] of [['list-hr', 't-contract'], ['list-hr', 't-bank'], ['list-it', 't-laptop'], ['list-it', 't-vpn'], ['list-mgr', 't-1on1'], ['list-newhire', 't-handbook'], ['list-newhire', 't-workstation']]) {
      await completeOnbTask(record._id, listId, taskId);
    }
    await db.collection('onboarding_records').updateOne({ _id: record._id }, { $set: { status: 'completed', completedAt: daysFromNow(-15), updatedAt: now } });
    console.log('✅ Onboarding record created — completed (all tasks done)');
  } else {
    console.log('ℹ️  Completed onboarding record already exists');
  }

  // ── 3. Offboarding Template (1) ────────────────────────────────────────────────
  let offbTemplate = await db.collection('offboarding_templates').findOne({ name: 'Standard Resignation Offboarding' });
  if (!offbTemplate) {
    const { insertedId } = await db.collection('offboarding_templates').insertOne({
      name: 'Standard Resignation Offboarding',
      exitTypes: ['resignation', 'contract_end'],
      taskLists: [
        { id: 'list-hr', name: 'HR Clearance', assignedTo: 'hr', tasks: [
          { id: 't-exit-docs', title: 'Prepare exit documentation', description: 'Prepare experience & relieving letters', dueOffsetDays: -2, isRequired: true, category: 'documentation' },
        ] },
        { id: 'list-it', name: 'IT Offboarding', assignedTo: 'it', tasks: [
          { id: 't-revoke-access', title: 'Revoke system access', description: 'Disable email and system accounts', dueOffsetDays: 0, isRequired: true, category: 'accessRevocation' },
        ] },
        { id: 'list-mgr', name: 'Knowledge Transfer', assignedTo: 'manager', tasks: [
          { id: 't-handover', title: 'Complete handover notes', description: 'Document ongoing work for successor', dueOffsetDays: -3, isRequired: true, category: 'knowledgeTransfer' },
        ] },
        { id: 'list-fin', name: 'Finance Clearance', assignedTo: 'finance', tasks: [
          { id: 't-finance-clear', title: 'Clear outstanding expenses/purchases', description: 'Ensure no open expense claims or purchase requests', dueOffsetDays: -1, isRequired: true, category: 'finalPay', taskType: 'spend_clearance' },
        ] },
        { id: 'list-emp', name: 'Employee Checklist', assignedTo: 'employee', tasks: [
          { id: 't-exit-interview', title: 'Complete exit interview', description: 'Share your feedback before you leave', dueOffsetDays: -1, isRequired: true, category: 'exitInterview' },
        ] },
      ],
      assetChecklist: [
        { id: 'asset-laptop', item: 'Company Laptop', category: 'device' },
        { id: 'asset-badge', item: 'Access Card', category: 'accessCard' },
      ],
      accessRevocationList: [
        { id: 'access-email', system: 'Company Email', category: 'email' },
        { id: 'access-vpn', system: 'VPN', category: 'vpn' },
      ],
      documentsToGenerate: ['experienceLetter', 'relievingLetter', 'clearanceCertificate'],
      createdBy: hrUser._id, createdAt: now,
    });
    offbTemplate = { _id: insertedId };
    console.log('✅ "Standard Resignation Offboarding" template created');
  } else {
    console.log('ℹ️  "Standard Resignation Offboarding" template already exists');
  }

  // ── 4. Offboarding Records (2) ─────────────────────────────────────────────────
  const completeOffbTask = async (recordId, listId, taskId) => {
    await db.collection('offboarding_records').updateOne(
      { _id: recordId },
      { $set: {
        'taskLists.$[list].tasks.$[task].status': 'completed',
        'taskLists.$[list].tasks.$[task].completedAt': now,
        'taskLists.$[list].tasks.$[task].completedBy': hrUser._id,
      } },
      { arrayFilters: [{ 'list.id': listId }, { 'task.id': taskId }] }
    );
  };

  const existingActiveOffb = await db.collection('offboarding_records').findOne({ employeeId: activeOffbEmp });
  if (!existingActiveOffb) {
    const record = await initiateOffboarding(activeOffbEmp, offbTemplate._id, daysFromNow(7), 'resignation', 'Pursuing an opportunity elsewhere', hrUser._id);
    await completeOffbTask(record._id, 'list-mgr', 't-handover');
    // Assets/access intentionally left outstanding to demonstrate the dashboard's "outstanding" counters
    console.log('✅ Offboarding record created — active, assets/access outstanding (last day in 7 days)');
  } else {
    console.log('ℹ️  Active offboarding record already exists');
  }

  const existingCompletedOffb = await db.collection('offboarding_records').findOne({ employeeId: completedOffbEmp });
  if (!existingCompletedOffb) {
    const record = await initiateOffboarding(completedOffbEmp, offbTemplate._id, daysFromNow(-10), 'resignation', 'Relocating to another city', hrUser._id);
    for (const [listId, taskId] of [['list-hr', 't-exit-docs'], ['list-it', 't-revoke-access'], ['list-mgr', 't-handover'], ['list-fin', 't-finance-clear'], ['list-emp', 't-exit-interview']]) {
      await completeOffbTask(record._id, listId, taskId);
    }
    await db.collection('offboarding_records').updateOne(
      { _id: record._id },
      { $set: {
        status: 'completed', completedAt: daysFromNow(-1), updatedAt: now,
        'assetChecklist.$[].returned': true, 'assetChecklist.$[].returnedAt': daysFromNow(-2), 'assetChecklist.$[].returnedTo': hrUser._id,
        'accessRevocationList.$[].revoked': true, 'accessRevocationList.$[].revokedAt': daysFromNow(-3), 'accessRevocationList.$[].revokedBy': hrUser._id,
        finalPayTriggered: true, finalPayTriggeredAt: daysFromNow(-4),
        exitInterview: {
          completedAt: daysFromNow(-5), reasonForLeaving: 'Relocating to another city for family reasons',
          jobSatisfactionRating: 4, managementRating: 5, wouldRecommendCompany: true,
          suggestions: 'More remote work flexibility would be great.', additionalComments: 'Had a great experience overall, thank you!',
        },
        generatedDocuments: [
          { type: 'experienceLetter', generatedAt: daysFromNow(-3), fileUrl: '/uploads/offboarding-documents/demo-experience-letter.pdf' },
          { type: 'relievingLetter', generatedAt: daysFromNow(-3), fileUrl: '/uploads/offboarding-documents/demo-relieving-letter.pdf' },
          { type: 'clearanceCertificate', generatedAt: daysFromNow(-2), fileUrl: '/uploads/offboarding-documents/demo-clearance-certificate.pdf' },
        ],
      } }
    );
    await db.collection('employees').updateOne({ _id: completedOffbEmp }, { $set: { status: 'inactive', updatedAt: now } });
    console.log('✅ Offboarding record created — completed (with exit interview + generated documents)');
  } else {
    console.log('ℹ️  Completed offboarding record already exists');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ONBOARDING & OFFBOARDING SEED COMPLETE');
  console.log('  Demo logins (all Demo@1234):');
  console.log('    newhire.preboarding@demo.com / newhire.midway@demo.com / newhire.completed@demo.com');
  console.log('    exiting.active@demo.com / exiting.completed@demo.com');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await client.close();
}

seed().catch((err) => { console.error(err); process.exit(1); });
