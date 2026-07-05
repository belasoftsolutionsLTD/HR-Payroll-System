/**
 * Recruitment module demo seed.
 * Creates 3 requisitions, 10 candidates, 15 applications, 8 scorecards,
 * 2 nurture campaigns, and 3 email templates. Idempotent — safe to re-run.
 * Run: node scripts/seedRecruitment.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'school-erp';

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log('Connected to', DB_NAME);

  const now = new Date();

  // ── 0. Recruiter user (hiring manager / approver / interviewer / scorecard author) ──
  let recruiter = await db.collection('users').findOne({ role: { $in: ['hr_manager', 'super_admin'] } });
  if (!recruiter) {
    const hashed = await bcrypt.hash('Demo@1234', 12);
    const recruiterId = new ObjectId();
    await db.collection('users').insertOne({
      _id: recruiterId, name: 'Demo Recruiter', email: 'recruiter@demo.com', password: hashed,
      role: 'hr_manager', employeeId: null, isActive: true, mustResetPassword: false,
      createdAt: now, updatedAt: now,
    });
    recruiter = { _id: recruiterId, name: 'Demo Recruiter' };
    console.log('✅ Fallback recruiter user created  →  recruiter@demo.com / Demo@1234');
  } else {
    console.log('ℹ️  Using existing HR user as recruiter:', recruiter.email);
  }
  const recruiterId = recruiter._id;
  const recruiterName = recruiter.name || 'Recruiter';

  // ── 1. Job Requisitions ──────────────────────────────────────────────────────
  const draftReq = {
    title: 'Marketing Assistant',
    department: 'Sales & Marketing',
    location: 'Nairobi',
    employmentType: 'fullTime',
    headcount: 1,
    salaryRange: { min: 45000, max: 60000, currency: 'KES' },
    description: 'Support the marketing team with campaigns, social media, and content creation.',
    competencies: [
      { id: 'c-comm', name: 'Communication', description: 'Clear written and verbal communication', weight: 4 },
      { id: 'c-creative', name: 'Creativity', description: 'Original campaign ideas', weight: 3 },
    ],
    pipelineStages: [
      { id: 's-applied', name: 'Applied', type: 'sourcing', requiresScorecard: false, autoActions: [] },
      { id: 's-screen', name: 'Screening', type: 'screening', requiresScorecard: false, autoActions: [] },
      { id: 's-interview', name: 'Interview', type: 'interview', requiresScorecard: true, autoActions: [] },
      { id: 's-hired', name: 'Hired', type: 'hired', requiresScorecard: false, autoActions: [] },
    ],
    approvalChain: [{ approverId: recruiterId, approverName: recruiterName, status: 'pending', actedAt: null, comment: null }],
    status: 'draft',
    hiringManagerId: recruiterId,
    createdBy: recruiterId,
    createdAt: now,
    updatedAt: now,
  };

  const openReq = {
    title: 'Senior Software Engineer',
    department: 'Information Technology',
    location: 'Remote',
    employmentType: 'fullTime',
    headcount: 2,
    salaryRange: { min: 180000, max: 260000, currency: 'KES' },
    description: 'Build and maintain core platform services. 5+ years experience with Node.js and React.',
    competencies: [
      { id: 'c-tech', name: 'Technical Depth', description: 'System design and coding proficiency', weight: 5 },
      { id: 'c-collab', name: 'Collaboration', description: 'Works well cross-functionally', weight: 3 },
      { id: 'c-ownership', name: 'Ownership', description: 'Drives projects to completion', weight: 4 },
    ],
    pipelineStages: [
      { id: 's-sourced', name: 'Sourced', type: 'sourcing', requiresScorecard: false, autoActions: [] },
      { id: 's-screen', name: 'Recruiter Screen', type: 'screening', requiresScorecard: false, autoActions: [{ trigger: 'onEnter', action: 'notifyHiringManager' }] },
      { id: 's-tech', name: 'Technical Interview', type: 'interview', requiresScorecard: true, autoActions: [] },
      { id: 's-onsite', name: 'Onsite Interview', type: 'interview', requiresScorecard: true, autoActions: [] },
      { id: 's-offer', name: 'Offer', type: 'offer', requiresScorecard: false, autoActions: [{ trigger: 'onEnter', action: 'notifyHiringManager' }] },
      { id: 's-hired', name: 'Hired', type: 'hired', requiresScorecard: false, autoActions: [] },
    ],
    approvalChain: [{ approverId: recruiterId, approverName: recruiterName, status: 'approved', actedAt: now, comment: 'Approved — critical hire' }],
    status: 'open',
    hiringManagerId: recruiterId,
    createdBy: recruiterId,
    createdAt: now,
    updatedAt: now,
  };

  const filledReq = {
    title: 'Accountant',
    department: 'Finance & Accounts',
    location: 'Nairobi',
    employmentType: 'fullTime',
    headcount: 0,
    salaryRange: { min: 70000, max: 90000, currency: 'KES' },
    description: 'Manage day-to-day bookkeeping, reconciliations, and monthly reporting.',
    competencies: [
      { id: 'c-accuracy', name: 'Accuracy', description: 'Attention to detail in financial records', weight: 5 },
    ],
    pipelineStages: [
      { id: 's-applied', name: 'Applied', type: 'sourcing', requiresScorecard: false, autoActions: [] },
      { id: 's-interview', name: 'Interview', type: 'interview', requiresScorecard: true, autoActions: [] },
      { id: 's-hired', name: 'Hired', type: 'hired', requiresScorecard: false, autoActions: [] },
    ],
    approvalChain: [{ approverId: recruiterId, approverName: recruiterName, status: 'approved', actedAt: now, comment: null }],
    status: 'filled',
    hiringManagerId: recruiterId,
    createdBy: recruiterId,
    createdAt: now,
    updatedAt: now,
  };

  const requisitionIds = {};
  for (const [key, doc] of Object.entries({ draft: draftReq, open: openReq, filled: filledReq })) {
    const existing = await db.collection('jobRequisitions').findOne({ title: doc.title });
    if (existing) {
      requisitionIds[key] = existing._id;
      console.log(`ℹ️  Requisition "${doc.title}" already exists`);
    } else {
      const result = await db.collection('jobRequisitions').insertOne(doc);
      requisitionIds[key] = result.insertedId;
      console.log(`✅ Requisition created: ${doc.title}`);
    }
  }

  // ── 2. Candidates ────────────────────────────────────────────────────────────
  const candidateSeeds = [
    { firstName: 'Amina', lastName: 'Hassan', email: 'amina.hassan@example.com', source: 'careerSite', tags: ['engineering'], isPassiveTalent: false },
    { firstName: 'Brian', lastName: 'Otieno', email: 'brian.otieno@example.com', source: 'referral', tags: ['engineering', 'senior'], isPassiveTalent: false },
    { firstName: 'Catherine', lastName: 'Wanjiru', email: 'catherine.wanjiru@example.com', source: 'agency', tags: ['finance'], isPassiveTalent: false },
    { firstName: 'David', lastName: 'Kimani', email: 'david.kimani@example.com', source: 'sourced', tags: ['engineering', 'senior'], isPassiveTalent: true },
    { firstName: 'Esther', lastName: 'Achieng', email: 'esther.achieng@example.com', source: 'inbound', tags: ['marketing'], isPassiveTalent: false },
    { firstName: 'Felix', lastName: 'Mwangi', email: 'felix.mwangi@example.com', source: 'careerSite', tags: ['finance'], isPassiveTalent: false },
    { firstName: 'Grace', lastName: 'Njoroge', email: 'grace.njoroge@example.com', source: 'referral', tags: ['marketing'], isPassiveTalent: false },
    { firstName: 'Hassan', lastName: 'Ali', email: 'hassan.ali@example.com', source: 'sourced', tags: ['engineering'], isPassiveTalent: true },
    { firstName: 'Irene', lastName: 'Chebet', email: 'irene.chebet@example.com', source: 'agency', tags: ['engineering', 'senior'], isPassiveTalent: true },
    { firstName: 'James', lastName: 'Mutua', email: 'james.mutua@example.com', source: 'careerSite', tags: ['finance'], isPassiveTalent: false },
  ];

  const candidateIds = [];
  for (const c of candidateSeeds) {
    const existing = await db.collection('candidates').findOne({ email: c.email });
    if (existing) {
      candidateIds.push(existing._id);
      continue;
    }
    const result = await db.collection('candidates').insertOne({
      ...c,
      phone: '+2547' + Math.floor(10000000 + Math.random() * 9999999),
      location: 'Nairobi',
      resumeUrl: null,
      linkedInUrl: null,
      referredBy: null,
      consentGivenAt: now,
      consentVersion: '1.0',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    candidateIds.push(result.insertedId);
  }
  console.log(`✅ ${candidateSeeds.length} candidates ensured`);

  // ── 3. Applications (distributed across the open + filled requisitions) ────
  const openStages = openReq.pipelineStages;
  const filledStages = filledReq.pipelineStages;

  const applicationPlan = [
    // Open requisition — Senior Software Engineer (all 10 candidates apply)
    { candidateIdx: 0, req: 'open', stageId: openStages[0].id, status: 'active' },
    { candidateIdx: 1, req: 'open', stageId: openStages[1].id, status: 'active' },
    { candidateIdx: 2, req: 'open', stageId: openStages[2].id, status: 'active' },
    { candidateIdx: 3, req: 'open', stageId: openStages[2].id, status: 'active' },
    { candidateIdx: 4, req: 'open', stageId: openStages[3].id, status: 'active' },
    { candidateIdx: 5, req: 'open', stageId: openStages[3].id, status: 'active' },
    { candidateIdx: 6, req: 'open', stageId: openStages[1].id, status: 'rejected' },
    { candidateIdx: 7, req: 'open', stageId: openStages[0].id, status: 'active' },
    { candidateIdx: 8, req: 'open', stageId: openStages[4].id, status: 'active' },
    { candidateIdx: 9, req: 'open', stageId: openStages[0].id, status: 'active' },
    // Filled requisition — Accountant (5 additional distinct applications)
    { candidateIdx: 0, req: 'filled', stageId: filledStages[2].id, status: 'hired' },
    { candidateIdx: 1, req: 'filled', stageId: filledStages[1].id, status: 'rejected' },
    { candidateIdx: 2, req: 'filled', stageId: filledStages[1].id, status: 'rejected' },
    { candidateIdx: 3, req: 'filled', stageId: filledStages[0].id, status: 'withdrawn' },
    { candidateIdx: 4, req: 'filled', stageId: filledStages[1].id, status: 'rejected' },
  ];

  const buildStageHistory = (stages, targetStageId, enteredAt) => {
    const firstStage = stages[0];
    if (targetStageId === firstStage.id) {
      return [{ stageId: firstStage.id, stageName: firstStage.name, enteredAt, movedBy: recruiterId }];
    }
    const targetStage = stages.find((s) => s.id === targetStageId);
    return [
      { stageId: firstStage.id, stageName: firstStage.name, enteredAt, exitedAt: enteredAt, movedBy: recruiterId },
      { stageId: targetStage.id, stageName: targetStage.name, enteredAt: now, movedBy: recruiterId },
    ];
  };

  const applicationIds = [];
  for (const plan of applicationPlan) {
    const candidateId = candidateIds[plan.candidateIdx];
    const requisitionId = requisitionIds[plan.req];
    const stages = plan.req === 'open' ? openStages : filledStages;
    const existing = await db.collection('applications').findOne({ candidateId, requisitionId });
    if (existing) {
      if (existing.currentStageId !== plan.stageId || existing.status !== plan.status) {
        const enteredAt = new Date(now.getTime() - 10 * 86400000);
        await db.collection('applications').updateOne({ _id: existing._id }, {
          $set: {
            currentStageId: plan.stageId,
            stageHistory: buildStageHistory(stages, plan.stageId, enteredAt),
            status: plan.status,
            rejectionReason: plan.status === 'rejected' ? 'Not proceeding at this time' : null,
            updatedAt: now,
          },
        });
      }
      applicationIds.push({ _id: existing._id, req: plan.req, stageId: plan.stageId });
      continue;
    }
    const enteredAt = new Date(now.getTime() - 10 * 86400000);
    const result = await db.collection('applications').insertOne({
      candidateId,
      requisitionId,
      currentStageId: plan.stageId,
      stageHistory: buildStageHistory(stages, plan.stageId, enteredAt),
      status: plan.status,
      rejectionReason: plan.status === 'rejected' ? 'Not proceeding at this time' : null,
      offerDetails: null,
      coverLetter: null,
      answers: [],
      scorecards: [],
      overallScore: null,
      createdAt: enteredAt,
      updatedAt: now,
    });
    applicationIds.push({ _id: result.insertedId, req: plan.req, stageId: plan.stageId });
  }
  console.log(`✅ ${applicationIds.length} applications ensured`);

  // ── 4. Scorecards (8, with varied ratings, on interview-stage applications) ─
  const interviewApplications = applicationIds.filter((a) => a.req === 'open' && [openStages[2].id, openStages[3].id].includes(a.stageId)).slice(0, 4);
  const scorecardRatingSets = [
    [5, 4, 4], [3, 3, 4], [4, 5, 3], [2, 3, 3],
    [5, 5, 4], [3, 4, 2], [4, 4, 4], [2, 2, 3],
  ];
  let scorecardCount = 0;
  for (let i = 0; i < interviewApplications.length && scorecardCount < 8; i++) {
    const app = interviewApplications[i];
    for (const stageId of [openStages[2].id, openStages[3].id]) {
      if (scorecardCount >= 8) break;
      const existing = await db.collection('scorecards').findOne({ applicationId: app._id, stageId, interviewerId: recruiterId });
      if (existing) { scorecardCount++; continue; }
      const ratings = scorecardRatingSets[scorecardCount];
      const competencyRatings = openReq.competencies.map((c, ci) => ({
        competencyId: c.id, competencyName: c.name, rating: ratings[ci] || 3, notes: '',
      }));
      const doc = {
        applicationId: app._id,
        requisitionId: requisitionIds.open,
        stageId,
        interviewerId: recruiterId,
        interviewerName: recruiterName,
        competencyRatings,
        overallRecommendation: ['strongYes', 'yes', 'neutral', 'no'][scorecardCount % 4],
        strengths: 'Strong problem solving and clear communication.',
        concerns: 'Limited exposure to distributed systems.',
        submittedAt: now,
      };
      const scResult = await db.collection('scorecards').insertOne(doc);

      const avgRating = competencyRatings.reduce((s, r) => s + r.rating, 0) / competencyRatings.length;
      await db.collection('applications').updateOne(
        { _id: app._id },
        { $push: { scorecards: scResult.insertedId }, $set: { overallScore: Math.round(avgRating * 100) / 100 } }
      );
      scorecardCount++;
    }
  }
  console.log(`✅ ${scorecardCount} scorecards ensured`);

  // ── 5. Nurture Campaigns ──────────────────────────────────────────────────────
  const campaignSeeds = [
    { name: 'Senior Engineers Pipeline', description: 'Stay in touch with strong senior engineering candidates for future openings.', targetTags: ['engineering', 'senior'] },
    { name: 'Finance Talent Pool', description: 'Nurture finance candidates for upcoming Accounts roles.', targetTags: ['finance'] },
  ];
  for (const c of campaignSeeds) {
    const existing = await db.collection('nurtureCampaigns').findOne({ name: c.name });
    if (existing) continue;
    const matchedCandidateId = candidateIds[candidateSeeds.findIndex((s) => s.tags.some((t) => c.targetTags.includes(t)) && s.isPassiveTalent)];
    await db.collection('nurtureCampaigns').insertOne({
      ...c,
      touchpoints: matchedCandidateId ? [{
        candidateId: matchedCandidateId, channel: 'email', note: 'Reached out to gauge interest in future roles.',
        sentAt: now, byUserId: recruiterId, response: null,
      }] : [],
      status: 'active',
      createdBy: recruiterId,
      createdAt: now,
    });
  }
  console.log(`✅ ${campaignSeeds.length} nurture campaigns ensured`);

  // ── 6. Email Templates ────────────────────────────────────────────────────────
  const templateSeeds = [
    {
      name: 'Application Received', trigger: 'applicationReceived',
      subject: 'We received your application for {{jobTitle}}',
      body: '<p>Dear {{candidateName}},</p><p>Thank you for applying to {{jobTitle}} at {{companyName}}. Our team will review your application and be in touch soon.</p><p>Regards,<br/>{{companyName}} Talent Team</p>',
    },
    {
      name: 'Rejection', trigger: 'rejection',
      subject: 'Update on your application for {{jobTitle}}',
      body: '<p>Dear {{candidateName}},</p><p>Thank you for your interest in {{jobTitle}} at {{companyName}}. After careful consideration, we will not be proceeding with your application at this time.</p><p>Regards,<br/>{{companyName}} Talent Team</p>',
    },
    {
      name: 'Offer Extended', trigger: 'offerExtended',
      subject: 'Your offer from {{companyName}}',
      body: '<p>Dear {{candidateName}},</p><p>Congratulations! We are delighted to extend an offer for {{jobTitle}} at {{companyName}}. Details will follow shortly.</p><p>Regards,<br/>{{companyName}} Talent Team</p>',
    },
  ];
  for (const t of templateSeeds) {
    const existing = await db.collection('emailTemplates').findOne({ name: t.name });
    if (existing) continue;
    await db.collection('emailTemplates').insertOne({ ...t, createdBy: recruiterId });
  }
  console.log(`✅ ${templateSeeds.length} email templates ensured`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  RECRUITMENT SEED COMPLETE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await client.close();
}

seed().catch((err) => { console.error(err); process.exit(1); });
