const { ObjectId } = require('mongodb');
const { findOne, insertOne, insertMany } = require('../../functions/Database/commonDBFunctions');

// Sales-demo data for the "View Demo" button on the login page — a single,
// fully-fabricated requisition + pipeline so a prospective customer can click
// around a realistic-looking Recruitment kanban without ever touching real
// company/candidate data. Everything here is tagged isDemoData:true; the demo
// API routes (see demoFunctions.js) hard-filter on that flag and never accept
// a caller-supplied id, so there is no path from a guest session to real data.
//
// Idempotent — safe to call on every /api/demo/login hit; only seeds once.
const ensureDemoRecruitmentData = async () => {
  const existing = await findOne('jobRequisitions', { isDemoData: true }, { projection: { _id: 1 } });
  if (existing) return existing._id;

  const stages = [
    { id: 's-sourced', name: 'Sourced', type: 'sourcing', requiresScorecard: false, autoActions: [] },
    { id: 's-screen', name: 'Screening', type: 'screening', requiresScorecard: false, autoActions: [] },
    { id: 's-interview', name: 'Interview', type: 'interview', requiresScorecard: true, autoActions: [] },
    { id: 's-offer', name: 'Offer', type: 'offer', requiresScorecard: false, autoActions: [] },
    { id: 's-hired', name: 'Hired', type: 'hired', requiresScorecard: false, autoActions: [] },
  ];

  const competencies = [
    { id: 'c-craft', name: 'Product Craft', description: 'Quality and rigor of design/engineering output', weight: 5 },
    { id: 'c-collab', name: 'Collaboration', description: 'Works effectively across teams', weight: 4 },
    { id: 'c-comm', name: 'Communication', description: 'Explains ideas clearly to technical and non-technical audiences', weight: 3 },
  ];

  const requisitionResult = await insertOne('jobRequisitions', {
    isDemoData: true,
    title: 'Senior Product Designer',
    department: 'Product',
    location: 'Nairobi, Kenya',
    branchId: null,
    employmentType: 'fullTime',
    headcount: 1,
    salaryRange: { min: 180000, max: 240000, currency: 'KES' },
    description: 'Zenith Retail Group is hiring a Senior Product Designer to lead design across our customer-facing storefront and internal operations tools.',
    applicationDeadline: null,
    competencies,
    pipelineStages: stages,
    screeningQuestions: [],
    approvalChain: [],
    status: 'open',
    hiringManagerId: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const requisitionId = requisitionResult.insertedId;

  const candidateDefs = [
    { firstName: 'Amara', lastName: 'Chege', source: 'careerSite' },
    { firstName: 'David', lastName: 'Kimani', source: 'referral' },
    { firstName: 'Fatima', lastName: 'Noor', source: 'careerSite' },
    { firstName: 'Brian', lastName: 'Otieno', source: 'sourced' },
    { firstName: 'Grace', lastName: 'Wanjiru', source: 'agency' },
    { firstName: 'Peter', lastName: 'Mwangi', source: 'referral' },
    { firstName: 'Linda', lastName: 'Achieng', source: 'careerSite' },
    { firstName: 'Samuel', lastName: 'Kiptoo', source: 'sourced' },
  ];
  const candidates = candidateDefs.map((c) => ({
    isDemoData: true,
    firstName: c.firstName,
    lastName: c.lastName,
    email: `${c.firstName.toLowerCase()}.${c.lastName.toLowerCase()}@example-demo.com`,
    phone: null,
    location: 'Nairobi, Kenya',
    resumeUrl: null,
    linkedInUrl: null,
    source: c.source,
    referredBy: null,
    tags: [],
    isPassiveTalent: false,
    consentGivenAt: new Date(),
    consentVersion: 'v1',
    notes: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const candidateResult = await insertMany('candidates', candidates);
  const candidateIds = Object.values(candidateResult.insertedIds);

  const now = new Date();
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000);
  const daysFromNow = (n) => new Date(now.getTime() + n * 86400000);
  const historyFor = (stageId, stageName, enteredDaysAgo, exited) => ([{
    stageId, stageName, enteredAt: daysAgo(enteredDaysAgo), exitedAt: exited ? daysAgo(exited) : undefined, movedBy: null,
  }]);
  const fakeInterviewer = (name) => ({
    stageId: 's-interview',
    interviewerId: new ObjectId(),
    interviewerName: name,
    scheduledAt: daysAgo(2),
    meetingLink: 'https://meet.example-demo.com/panel',
    location: null,
    requiredDocuments: null,
    assignedAt: daysAgo(4),
  });

  const applications = [
    { candidateId: candidateIds[0], currentStageId: 's-sourced', status: 'active', stageHistory: historyFor('s-sourced', 'Sourced', 1) },
    { candidateId: candidateIds[1], currentStageId: 's-screen', status: 'active', stageHistory: [...historyFor('s-sourced', 'Sourced', 6, 3), ...historyFor('s-screen', 'Screening', 3)] },
    { candidateId: candidateIds[2], currentStageId: 's-screen', status: 'active', stageHistory: [...historyFor('s-sourced', 'Sourced', 5, 2), ...historyFor('s-screen', 'Screening', 2)] },
    {
      candidateId: candidateIds[3], currentStageId: 's-interview', status: 'active',
      stageHistory: [...historyFor('s-sourced', 'Sourced', 10, 7), ...historyFor('s-screen', 'Screening', 7, 4), ...historyFor('s-interview', 'Interview', 4)],
      interviewAssignments: [fakeInterviewer('Panel Member A')],
      overallScore: 4.2,
    },
    {
      candidateId: candidateIds[4], currentStageId: 's-interview', status: 'active',
      stageHistory: [...historyFor('s-sourced', 'Sourced', 9, 6), ...historyFor('s-screen', 'Screening', 6, 3), ...historyFor('s-interview', 'Interview', 3)],
      interviewAssignments: [fakeInterviewer('Panel Member A'), fakeInterviewer('Panel Member B')],
      overallScore: 3.6,
    },
    {
      candidateId: candidateIds[5], currentStageId: 's-offer', status: 'active',
      stageHistory: [...historyFor('s-sourced', 'Sourced', 20, 16), ...historyFor('s-screen', 'Screening', 16, 12), ...historyFor('s-interview', 'Interview', 12, 2), ...historyFor('s-offer', 'Offer', 2)],
      offerDetails: { salary: 220000, currency: 'KES', startDate: daysFromNow(21).toISOString(), expiresAt: daysFromNow(7).toISOString(), status: 'pending' },
      overallScore: 4.6,
    },
    {
      candidateId: candidateIds[6], currentStageId: 's-hired', status: 'hired',
      stageHistory: [...historyFor('s-sourced', 'Sourced', 35, 30), ...historyFor('s-screen', 'Screening', 30, 25), ...historyFor('s-interview', 'Interview', 25, 15), ...historyFor('s-offer', 'Offer', 15, 8), ...historyFor('s-hired', 'Hired', 8)],
      offerDetails: { salary: 235000, currency: 'KES', startDate: daysAgo(1).toISOString(), expiresAt: daysAgo(8).toISOString(), status: 'accepted' },
      overallScore: 4.8,
    },
    {
      candidateId: candidateIds[7], currentStageId: 's-screen', status: 'rejected', rejectionReason: 'Not enough e-commerce design experience for this role.',
      stageHistory: [...historyFor('s-sourced', 'Sourced', 14, 10), ...historyFor('s-screen', 'Screening', 10)],
    },
  ].map((a) => ({
    isDemoData: true,
    requisitionId,
    candidateId: a.candidateId,
    currentStageId: a.currentStageId,
    stageHistory: a.stageHistory,
    status: a.status,
    rejectionReason: a.rejectionReason,
    offerDetails: a.offerDetails,
    coverLetter: '',
    answers: [],
    scorecards: [],
    interviewAssignments: a.interviewAssignments || [],
    overallScore: a.overallScore,
    createdAt: a.stageHistory[0].enteredAt,
    updatedAt: now,
  }));

  await insertMany('applications', applications);
  return requisitionId;
};

module.exports = { ensureDemoRecruitmentData };
