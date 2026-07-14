/**
 * Performance & Appraisals demo seed.
 * Creates 2 review templates, 1 completed review cycle (with submitted self + manager
 * reviews), 1 active review cycle (mixed submitted/pending participants), a handful of
 * goals per active employee (with check-ins), some feedback exchanges, and 1 performance
 * improvement plan. Idempotent — safe to re-run (matches by name/title before inserting,
 * marks every doc it creates with isDemoSeed: true).
 * Run: node scripts/seedPerformance.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const { randomUUID } = require('crypto');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'school-erp';

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const TEMPLATES = [
  {
    name: 'Standard Quarterly Review',
    description: 'General-purpose review used for most quarterly cycles.',
    cycleTypes: ['self_manager'],
    sections: [
      {
        id: randomUUID(),
        title: 'Core Performance',
        questions: [
          { id: randomUUID(), text: 'Rate overall job performance this quarter.', type: 'rating', scaleMax: 5 },
          { id: randomUUID(), text: 'Rate communication and collaboration.', type: 'rating', scaleMax: 5 },
          { id: randomUUID(), text: 'What went well this quarter?', type: 'text', scaleMax: null },
          { id: randomUUID(), text: 'What could be improved?', type: 'text', scaleMax: null },
        ],
      },
    ],
  },
  {
    name: 'Engineering Review',
    description: 'Adds technical-delivery questions on top of the core set, for engineering roles.',
    cycleTypes: ['self_manager', '360'],
    sections: [
      {
        id: randomUUID(),
        title: 'Technical Delivery',
        questions: [
          { id: randomUUID(), text: 'Rate code quality and technical judgment.', type: 'rating', scaleMax: 5 },
          { id: randomUUID(), text: 'Rate ownership of delivered work.', type: 'rating', scaleMax: 5 },
          { id: randomUUID(), text: 'Describe a notable technical contribution this quarter.', type: 'text', scaleMax: null },
        ],
      },
    ],
  },
];

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log('Connected to', DB_NAME);

  const now = new Date();

  const employees = await db.collection('employees').find({ status: 'active' }).toArray();
  if (!employees.length) {
    console.log('No active employees found — seed the employees module first (or run seed-demo.js).');
    await client.close();
    return;
  }
  console.log(`Seeding performance data for ${employees.length} active employee(s)`);

  const hrUser = await db.collection('users').findOne({ role: { $in: ['super_admin', 'hr_manager'] } });
  const createdBy = hrUser?._id || null;

  // ── 1. Review templates ───────────────────────────────────────────────────────
  const templateIds = [];
  for (const t of TEMPLATES) {
    let doc = await db.collection('review_templates').findOne({ name: t.name });
    if (!doc) {
      const result = await db.collection('review_templates').insertOne({
        name: t.name, description: t.description, cycleTypes: t.cycleTypes, sections: t.sections,
        isActive: true, createdBy, createdAt: now, updatedAt: now, isDemoSeed: true,
      });
      doc = { _id: result.insertedId, ...t };
      console.log(`Created review template: ${t.name}`);
    }
    templateIds.push(doc);
  }

  // ── 2. Completed cycle (all reviews submitted) ────────────────────────────────
  let completedCycle = await db.collection('review_cycles').findOne({ name: '_SEED_ Q1 2026 Review' });
  if (!completedCycle) {
    const participants = employees.map((emp) => ({
      employeeId: emp._id,
      selfReviewStatus: 'submitted',
      managerReviewStatus: 'submitted',
      selfReviewSubmittedAt: now,
      managerReviewSubmittedAt: now,
      reviewerId: null,
      peersAssigned: [],
    }));
    const result = await db.collection('review_cycles').insertOne({
      name: '_SEED_ Q1 2026 Review',
      type: 'self_manager',
      templateId: templateIds[0]._id,
      status: 'completed',
      phases: {
        selfReview: { startDate: null, endDate: null, isEnabled: true },
        managerReview: { startDate: null, endDate: null, isEnabled: true },
        calibration: { date: null, isEnabled: false },
        resultsSharing: { date: null, isEnabled: true },
      },
      audience: { type: 'all', departments: [], employeeIds: [] },
      participants,
      createdBy, createdAt: now, updatedAt: now, isDemoSeed: true,
    });
    completedCycle = { _id: result.insertedId };
    console.log('Created completed review cycle: _SEED_ Q1 2026 Review');

    for (const emp of employees) {
      const rand = seededRandom(emp._id.toString().split('').reduce((s, c) => s + c.charCodeAt(0), 0));
      const rating = 3 + Math.round(rand() * 2); // 3-5
      const responses = templateIds[0].sections.flatMap((section) =>
        section.questions.map((q) => ({
          sectionId: section.id,
          questionId: q.id,
          value: q.type === 'rating' ? rating : 'Solid quarter overall — steady progress on goals.',
        })));
      await db.collection('reviews').insertOne({
        cycleId: completedCycle._id, employeeId: emp._id, reviewerId: emp.userId || emp._id,
        reviewType: 'self', status: 'submitted', responses, overallRating: rating,
        recommendation: null, calibrationBox: null, calibrationNotes: null,
        submittedAt: now, createdAt: now, updatedAt: now, isDemoSeed: true,
      });
      await db.collection('reviews').insertOne({
        cycleId: completedCycle._id, employeeId: emp._id, reviewerId: createdBy || emp._id,
        reviewType: 'manager', status: 'submitted', responses, overallRating: rating,
        recommendation: null, calibrationBox: 'med_med', calibrationNotes: 'Consistent performer.',
        submittedAt: now, createdAt: now, updatedAt: now, isDemoSeed: true,
      });
    }
    console.log(`Created ${employees.length * 2} submitted review(s) for the completed cycle`);
  }

  // ── 3. Active cycle (mixed participant progress) ──────────────────────────────
  let activeCycle = await db.collection('review_cycles').findOne({ name: '_SEED_ Q2 2026 Review' });
  if (!activeCycle) {
    const participants = employees.map((emp, i) => ({
      employeeId: emp._id,
      selfReviewStatus: i % 2 === 0 ? 'submitted' : 'pending',
      managerReviewStatus: 'pending',
      selfReviewSubmittedAt: i % 2 === 0 ? now : null,
      managerReviewSubmittedAt: null,
      reviewerId: null,
      peersAssigned: [],
    }));
    const result = await db.collection('review_cycles').insertOne({
      name: '_SEED_ Q2 2026 Review',
      type: 'self_manager',
      templateId: templateIds[0]._id,
      status: 'active',
      phases: {
        selfReview: { startDate: null, endDate: null, isEnabled: true },
        managerReview: { startDate: null, endDate: null, isEnabled: true },
        calibration: { date: null, isEnabled: false },
        resultsSharing: { date: null, isEnabled: true },
      },
      audience: { type: 'all', departments: [], employeeIds: [] },
      participants,
      createdBy, createdAt: now, updatedAt: now, isDemoSeed: true,
    });
    activeCycle = { _id: result.insertedId };
    console.log('Created active review cycle: _SEED_ Q2 2026 Review');

    for (let i = 0; i < employees.length; i += 2) {
      const emp = employees[i];
      await db.collection('reviews').insertOne({
        cycleId: activeCycle._id, employeeId: emp._id, reviewerId: emp.userId || emp._id,
        reviewType: 'self', status: 'submitted',
        responses: [{ sectionId: templateIds[0].sections[0].id, questionId: templateIds[0].sections[0].questions[0].id, value: 4 }],
        overallRating: 4, recommendation: null, calibrationBox: null, calibrationNotes: null,
        submittedAt: now, createdAt: now, updatedAt: now, isDemoSeed: true,
      });
    }
  }

  // ── 4. Goals (with check-ins) ──────────────────────────────────────────────────
  const goalTitles = ['Complete leadership training', 'Improve sprint delivery predictability', 'Mentor a junior team member', 'Reduce customer escalation rate'];
  let goalsCreated = 0;
  for (const emp of employees) {
    const rand = seededRandom(emp._id.toString().split('').reduce((s, c) => s + c.charCodeAt(0) * 7, 0));
    for (let i = 0; i < 2; i++) {
      const title = goalTitles[Math.floor(rand() * goalTitles.length)];
      const existing = await db.collection('goals').findOne({ employeeId: emp._id, title });
      if (existing) continue;
      const progress = Math.round(rand() * 100);
      const status = progress >= 100 ? 'completed' : progress < 20 ? 'at_risk' : 'in_progress';
      await db.collection('goals').insertOne({
        employeeId: emp._id, department: emp.department || null, createdBy,
        title, description: 'Seeded demo goal for performance module walkthroughs.',
        category: 'okr', period: 'q2_2026',
        startDate: now, endDate: null, status, progress,
        visibility: 'private', parentGoalId: null,
        keyResults: [],
        checkIns: [
          { progress: Math.max(0, progress - 20), note: 'Early progress, on track.', updatedBy: String(emp._id), updatedAt: now },
          { progress, note: 'Latest check-in.', updatedBy: String(emp._id), updatedAt: now },
        ],
        comments: [],
        createdAt: now, updatedAt: now, isDemoSeed: true,
      });
      goalsCreated++;
    }
  }
  console.log(`${goalsCreated} goal(s) created`);

  // ── 5. Feedback ────────────────────────────────────────────────────────────────
  let feedbackCreated = 0;
  if (createdBy) {
    for (const emp of employees) {
      const existing = await db.collection('feedback').findOne({ recipientId: emp._id, isDemoSeed: true });
      if (existing) continue;
      await db.collection('feedback').insertOne({
        giverId: createdBy, recipientId: emp._id,
        type: 'recognition', category: 'general',
        message: 'Great work handling the recent workload spike — much appreciated.',
        visibility: 'private', isAnonymous: false, isVisibleToEmployee: true,
        relatedCycleId: null, createdAt: now, isDemoSeed: true,
      });
      feedbackCreated++;
    }
  }
  console.log(`${feedbackCreated} feedback entr(y/ies) created`);

  // ── 6. One performance improvement plan ───────────────────────────────────────
  const pipTarget = employees[employees.length - 1];
  const existingPip = await db.collection('performanceImprovementPlans').findOne({ employeeId: pipTarget._id, isDemoSeed: true });
  if (!existingPip) {
    const start = new Date(now); start.setDate(start.getDate() - 14);
    const end = new Date(now); end.setDate(end.getDate() + 30);
    await db.collection('performanceImprovementPlans').insertOne({
      employeeId: pipTarget._id,
      managerId: pipTarget.managerId || null,
      createdBy,
      reason: 'Missed delivery deadlines on two consecutive sprints.',
      startDate: start, endDate: end, status: 'active',
      goals: [
        { id: randomUUID(), description: 'Deliver all assigned sprint tasks on time for 4 consecutive sprints.', targetDate: end, status: 'pending' },
        { id: randomUUID(), description: 'Attend weekly check-ins with manager.', targetDate: null, status: 'pending' },
      ],
      checkIns: [
        { id: randomUUID(), note: 'First check-in — on track so far.', addedBy: createdBy, createdAt: now },
      ],
      outcome: null, relatedReviewId: null,
      createdAt: now, updatedAt: now, isDemoSeed: true,
    });
    console.log(`Created performance improvement plan for ${pipTarget.fullName}`);
  }

  console.log('Performance seed complete.');
  await client.close();
}

seed().catch((err) => { console.error(err); process.exit(1); });
