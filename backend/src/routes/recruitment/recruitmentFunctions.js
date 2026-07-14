const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const {
  findOne, findMany, insertOne, updateOne, deleteOne, countDocuments, aggregate,
} = require('../../functions/Database/commonDBFunctions');
const { notifyUser, notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');
const { generateStaffNumber } = require('../../functions/HR/staffNumberGenerator');
const { initiateOnboarding, resolveDefaultTemplate } = require('../../lib/onboarding/autoAssignTasks');
const { sendEmail } = require('../../services/emailService');
const { fireAutoActions } = require('../../lib/recruitment/autoActions');
const { sendTemplatedEmail } = require('../../lib/recruitment/emailTemplateHelpers');

const REQUISITION_STATUSES = ['draft', 'pendingApproval', 'open', 'onHold', 'filled', 'closed'];
const APPLICATION_STATUSES = ['active', 'rejected', 'withdrawn', 'hired'];
const MAX_APPLICATIONS_PER_REQUISITION = 2;

const candidateTokens = (candidate, requisition) => ({
  candidateName: candidate ? `${candidate.firstName} ${candidate.lastName}` : '',
  jobTitle: requisition?.title || '',
  companyName: process.env.COMPANY_NAME || 'Bella ERP',
});

// ── Requisitions ───────────────────────────────────────────────────────────────

const createRequisition = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'department', 'location', 'employmentType', 'headcount', 'salaryRange', 'description'])) return;

  const doc = {
    title: req.body.title.trim(),
    department: req.body.department,
    location: req.body.location,
    employmentType: req.body.employmentType,
    headcount: Number(req.body.headcount),
    salaryRange: {
      min: Number(req.body.salaryRange?.min) || 0,
      max: Number(req.body.salaryRange?.max) || 0,
      currency: req.body.salaryRange?.currency || 'KES',
    },
    description: req.body.description,
    competencies: Array.isArray(req.body.competencies) ? req.body.competencies : [],
    pipelineStages: Array.isArray(req.body.pipelineStages) ? req.body.pipelineStages : [],
    screeningQuestions: Array.isArray(req.body.screeningQuestions) ? req.body.screeningQuestions : [],
    approvalChain: Array.isArray(req.body.approvalChain)
      ? req.body.approvalChain.map((a) => ({
        approverId: a.approverId,
        approverName: a.approverName,
        status: 'pending',
        actedAt: null,
        comment: null,
      }))
      : [],
    status: 'draft',
    hiringManagerId: new ObjectId(req.body.hiringManagerId),
    createdBy: new ObjectId(req.user._id),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('jobRequisitions', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listRequisitions = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.department) filter.department = req.query.department;
  if (req.query.location) filter.location = req.query.location;

  const { page, limit, skip } = getPagination(req.query);
  const [total, data] = await Promise.all([
    countDocuments('jobRequisitions', filter),
    findMany('jobRequisitions', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const ids = data.map((r) => r._id);
  const counts = ids.length
    ? await aggregate('applications', [
      { $match: { requisitionId: { $in: ids } } },
      { $group: { _id: '$requisitionId', count: { $sum: 1 } } },
    ])
    : [];
  const countMap = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));
  const enriched = data.map((r) => ({ ...r, applicantCount: countMap[String(r._id)] || 0 }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getRequisition = async (req, res) => {
  const requisition = await findOne('jobRequisitions', { _id: new ObjectId(req.params.id) });
  if (!requisition) return returnFunction(res, 404, false, req.locale.notFound);

  const applicantCount = await countDocuments('applications', { requisitionId: requisition._id });
  return returnFunction(res, 200, true, req.locale.success, { ...requisition, applicantCount });
};

const updateRequisition = async (req, res) => {
  const allowed = [
    'title', 'department', 'location', 'employmentType', 'headcount', 'salaryRange',
    'description', 'competencies', 'pipelineStages', 'screeningQuestions', 'approvalChain', 'hiringManagerId',
  ];
  const update = { updatedAt: new Date() };
  allowed.forEach((f) => {
    if (req.body[f] !== undefined) update[f] = f === 'hiringManagerId' ? new ObjectId(req.body[f]) : req.body[f];
  });

  const result = await updateOne('jobRequisitions', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const submitRequisition = async (req, res) => {
  const requisition = await findOne('jobRequisitions', { _id: new ObjectId(req.params.id) });
  if (!requisition) return returnFunction(res, 404, false, req.locale.notFound);
  if (requisition.status !== 'draft') return returnFunction(res, 400, false, 'Only draft requisitions can be submitted for approval.');
  if (!requisition.pipelineStages?.length) return returnFunction(res, 400, false, 'Add at least one pipeline stage before submitting.');
  if (!requisition.approvalChain?.length) return returnFunction(res, 400, false, 'Add at least one approver before submitting.');

  await updateOne('jobRequisitions', { _id: requisition._id }, { $set: { status: 'pendingApproval', updatedAt: new Date() } });

  await Promise.all(requisition.approvalChain.map((a) => notifyUser(a.approverId, {
    title: 'Requisition Approval Needed',
    body: `"${requisition.title}" (${requisition.department}) needs your approval.`,
    type: 'recruitment',
  }).catch(() => {})));

  return returnFunction(res, 200, true, 'Requisition submitted for approval.');
};

const approveRequisition = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  if (!['approved', 'rejected'].includes(req.body.status)) return returnFunction(res, 400, false, 'status must be approved or rejected.');

  const requisition = await findOne('jobRequisitions', { _id: new ObjectId(req.params.id) });
  if (!requisition) return returnFunction(res, 404, false, req.locale.notFound);
  if (requisition.status !== 'pendingApproval') return returnFunction(res, 400, false, 'Requisition is not awaiting approval.');

  const userId = String(req.user._id);
  const isSuperAdmin = req.user.role === 'super_admin';
  const stepIndex = requisition.approvalChain.findIndex((a) => String(a.approverId) === userId);
  if (stepIndex === -1 && !isSuperAdmin) {
    return returnFunction(res, 403, false, 'You are not an approver on this requisition.');
  }
  const targetIndex = stepIndex === -1 ? 0 : stepIndex;

  const approvalChain = [...requisition.approvalChain];
  approvalChain[targetIndex] = {
    ...approvalChain[targetIndex],
    status: req.body.status,
    actedAt: new Date(),
    comment: req.body.comment || null,
  };

  const overallStatus = req.body.status === 'rejected'
    ? 'draft'
    : (approvalChain.every((a) => a.status === 'approved') ? 'open' : 'pendingApproval');

  await updateOne('jobRequisitions', { _id: requisition._id }, {
    $set: { approvalChain, status: overallStatus, updatedAt: new Date() },
  });

  notifyByRoles(['super_admin', 'hr_manager'], {
    title: `Requisition ${req.body.status === 'approved' ? 'Approved' : 'Rejected'}`,
    body: `"${requisition.title}" was ${req.body.status} by an approver.`,
    type: 'recruitment',
  }).catch(() => {});

  return returnFunction(res, 200, true, `Requisition ${req.body.status}.`, { status: overallStatus });
};

const deleteRequisition = async (req, res) => {
  const result = await updateOne('jobRequisitions', { _id: new ObjectId(req.params.id) }, { $set: { status: 'closed', updatedAt: new Date() } });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Applications / Pipeline ──────────────────────────────────────────────────────

const listApplicationsForRequisition = async (req, res) => {
  const requisitionId = new ObjectId(req.params.id);
  const applications = await findMany('applications', { requisitionId }, { sort: { createdAt: -1 } });

  const candidateIds = [...new Set(applications.map((a) => String(a.candidateId)))].map((id) => new ObjectId(id));
  const candidates = candidateIds.length ? await findMany('candidates', { _id: { $in: candidateIds } }) : [];
  const candidateMap = Object.fromEntries(candidates.map((c) => [String(c._id), c]));

  // Batch-load scorecards for every application's *current* stage so the kanban card can
  // show "2 of 3 panelists submitted" without an extra request per card.
  const allScorecards = applications.length
    ? await findMany('scorecards', { applicationId: { $in: applications.map((a) => a._id) } }, { projection: { applicationId: 1, stageId: 1, interviewerId: 1 } })
    : [];
  const submittedByAppStage = {};
  allScorecards.forEach((sc) => {
    const key = `${sc.applicationId}_${sc.stageId}`;
    if (!submittedByAppStage[key]) submittedByAppStage[key] = new Set();
    submittedByAppStage[key].add(String(sc.interviewerId));
  });

  const enriched = applications.map((a) => {
    const key = `${a._id}_${a.currentStageId}`;
    const submittedInterviewerIds = submittedByAppStage[key] || new Set();
    const stageAssignments = (a.interviewAssignments || []).filter((asg) => asg.stageId === a.currentStageId);
    return {
      ...a,
      candidate: candidateMap[String(a.candidateId)] || null,
      currentStageScorecards: {
        submitted: submittedInterviewerIds.size,
        required: stageAssignments.length || null, // null = no one specifically assigned yet
      },
    };
  });
  const byStage = {};
  enriched.forEach((a) => {
    if (!byStage[a.currentStageId]) byStage[a.currentStageId] = [];
    byStage[a.currentStageId].push(a);
  });

  return returnFunction(res, 200, true, req.locale.success, { applications: enriched, byStage });
};

// Replicates the legacy hire flow: creates the employee record, seeds leave balances
// and onboarding tasks, and decrements the requisition's remaining headcount.
const hireCandidate = async (application, requisition, actingUser) => {
  const candidate = await findOne('candidates', { _id: application.candidateId });
  const hireDate = new Date();
  const staffNumber = await generateStaffNumber(hireDate.getFullYear());
  const fullName = candidate ? `${candidate.firstName} ${candidate.lastName}` : 'New Employee';

  const empDoc = {
    fullName,
    email: candidate?.email || null,
    phone: candidate?.phone || null,
    nationalId: null,
    staffNumber,
    designation: requisition.title,
    employmentType: requisition.employmentType === 'fullTime' ? 'permanent' : requisition.employmentType,
    department: requisition.department,
    dateOfHire: hireDate,
    contractEndDate: null,
    jobGroupId: null, // HR assigns a job group post-hire via the employee's Work tab — flagged by the payroll readiness check until then
    grossPay: application.offerDetails?.salary || requisition.salaryRange?.min || null,
    nextOfKin: null,
    profilePhoto: null,
    documents: candidate?.resumeUrl
      ? [{ docId: new ObjectId(), docType: 'CV', fileName: 'resume', filePath: candidate.resumeUrl, uploadedAt: new Date() }]
      : [],
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const empResult = await insertOne('employees', empDoc);

  // One leave_balances record per active leave type — builds up via the monthly
  // accrual cron (lib/leave/accrualEngine.js), same as direct employee creation.
  const activeLeaveTypes = await global.dbo.collection('leave_types').find({ isActive: true }, { projection: { _id: 1 } }).toArray();
  if (activeLeaveTypes.length) {
    await global.dbo.collection('leave_balances').insertMany(activeLeaveTypes.map(lt => ({
      employeeId: empResult.insertedId, leaveTypeId: lt._id, year: hireDate.getFullYear(),
      openingBalance: 0, accrued: 0, used: 0, pending: 0, carriedOver: 0, carryOverExpiry: null,
      closingBalance: 0, lastAccrualDate: null, updatedAt: new Date(),
    })));
  }

  const onboardingTemplate = await resolveDefaultTemplate(empDoc.department);
  if (onboardingTemplate) {
    await initiateOnboarding(empResult.insertedId, onboardingTemplate._id, hireDate, null).catch(() => {});
  }

  await updateOne('applications', { _id: application._id }, { $set: { status: 'hired', updatedAt: new Date() } });

  const updatedReq = await global.dbo.collection('jobRequisitions').findOneAndUpdate(
    { _id: requisition._id },
    { $inc: { headcount: -1 }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (updatedReq && updatedReq.headcount <= 0) {
    await updateOne('jobRequisitions', { _id: requisition._id }, { $set: { status: 'filled' } });
  }

  notifyHR({
    type: 'recruitment', subType: 'new_hire',
    title: 'New Hire',
    subtitle: `${fullName} has been hired as ${empDoc.designation}. Staff #: ${staffNumber}`,
    referenceId: empResult.insertedId, referenceModel: 'employees',
    requiresAction: false, triggeredBy: actingUser._id,
  }).catch(() => {});
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'New Hire',
    body: `${fullName} has been hired as ${empDoc.designation}.`,
    type: 'recruitment',
  }).catch(() => {});

  return empResult.insertedId.toString();
};

const moveApplicationStage = async (req, res) => {
  if (!validateRequiredFields(req, res, ['stageId'])) return;

  const application = await findOne('applications', { _id: new ObjectId(req.params.id) });
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);
  if (application.status !== 'active') return returnFunction(res, 400, false, 'Only active applications can be moved.');

  const requisition = await findOne('jobRequisitions', { _id: application.requisitionId });
  if (!requisition) return returnFunction(res, 404, false, 'Requisition not found.');

  const fromIndex = requisition.pipelineStages.findIndex((s) => s.id === application.currentStageId);
  const toIndex = requisition.pipelineStages.findIndex((s) => s.id === req.body.stageId);
  const fromStage = requisition.pipelineStages[fromIndex];
  const toStage = requisition.pipelineStages[toIndex];
  if (!toStage) return returnFunction(res, 400, false, 'Invalid target stage.');
  if (toStage.id === application.currentStageId) return returnFunction(res, 400, false, 'Application is already at this stage.');

  const isForwardMove = fromIndex === -1 || toIndex > fromIndex;
  if (isForwardMove && fromStage?.requiresScorecard) {
    const stageAssignments = (application.interviewAssignments || []).filter((a) => a.stageId === fromStage.id);
    const stageScorecards = await findMany('scorecards', { applicationId: application._id, stageId: fromStage.id }, { projection: { interviewerId: 1 } });

    if (stageAssignments.length > 0) {
      // Panel interview — every assigned interviewer must have submitted their own scorecard.
      const submittedIds = new Set(stageScorecards.map((sc) => String(sc.interviewerId)));
      const missing = stageAssignments.filter((a) => !submittedIds.has(String(a.interviewerId)));
      if (missing.length > 0) {
        return returnFunction(
          res, 400, false,
          `Waiting on a scorecard from ${missing.map((m) => m.interviewerName).join(', ')} before moving this candidate forward.`
        );
      }
    } else if (stageScorecards.length === 0) {
      return returnFunction(res, 400, false, `A scorecard must be submitted for "${fromStage.name}" before moving this candidate forward.`);
    }
  }

  const now = new Date();
  const stageHistory = application.stageHistory.map((h, i) => (
    i === application.stageHistory.length - 1 && !h.exitedAt ? { ...h, exitedAt: now } : h
  ));
  stageHistory.push({ stageId: toStage.id, stageName: toStage.name, enteredAt: now, movedBy: new ObjectId(req.user._id) });

  await updateOne('applications', { _id: application._id }, {
    $set: { currentStageId: toStage.id, stageHistory, updatedAt: now },
  });

  if (fromStage) await fireAutoActions(application, fromStage, global.dbo, 'onExit');
  await fireAutoActions({ ...application, currentStageId: toStage.id }, toStage, global.dbo, 'onEnter');

  let hiredEmployeeId = null;
  if (toStage.type === 'hired') {
    hiredEmployeeId = await hireCandidate(application, requisition, req.user);
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, hiredEmployeeId ? { employeeId: hiredEmployeeId } : undefined);
};

const updateApplicationStatus = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  if (!APPLICATION_STATUSES.includes(req.body.status)) return returnFunction(res, 400, false, 'Invalid status.');

  const update = { status: req.body.status, updatedAt: new Date() };
  if (req.body.status === 'rejected') update.rejectionReason = req.body.rejectionReason || null;
  if (req.body.status === 'active') update.rejectionReason = null;

  const result = await updateOne('applications', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);

  if (req.body.status === 'rejected') {
    const application = await findOne('applications', { _id: new ObjectId(req.params.id) });
    const [candidate, requisition] = await Promise.all([
      findOne('candidates', { _id: application.candidateId }),
      findOne('jobRequisitions', { _id: application.requisitionId }),
    ]);
    if (candidate?.email) {
      const tokens = candidateTokens(candidate, requisition);
      sendTemplatedEmail({
        trigger: 'rejection',
        to: candidate.email,
        tokens,
        fallbackSubject: 'Application Update',
        fallbackHtml: `<p>Dear ${tokens.candidateName},</p><p>Thank you for your interest. After careful consideration, we are unable to proceed with your application at this time.</p><p>Regards,<br/>${tokens.companyName}</p>`,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const extendOffer = async (req, res) => {
  if (!validateRequiredFields(req, res, ['salary', 'startDate', 'expiresAt'])) return;

  const application = await findOne('applications', { _id: new ObjectId(req.params.id) });
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);

  const offerDetails = {
    salary: Number(req.body.salary),
    currency: req.body.currency || 'KES',
    startDate: new Date(req.body.startDate),
    expiresAt: new Date(req.body.expiresAt),
    status: 'pending',
  };
  await updateOne('applications', { _id: application._id }, { $set: { offerDetails, updatedAt: new Date() } });

  const [candidate, requisition] = await Promise.all([
    findOne('candidates', { _id: application.candidateId }),
    findOne('jobRequisitions', { _id: application.requisitionId }),
  ]);
  if (candidate?.email) {
    const tokens = candidateTokens(candidate, requisition);
    sendTemplatedEmail({
      trigger: 'offerExtended',
      to: candidate.email,
      tokens,
      fallbackSubject: 'Offer of Employment',
      fallbackHtml: `<p>Dear ${tokens.candidateName},</p><p>We are pleased to extend an offer with a gross salary of ${offerDetails.currency} ${offerDetails.salary.toLocaleString()}, starting ${offerDetails.startDate.toDateString()}. This offer expires on ${offerDetails.expiresAt.toDateString()}.</p><p>Regards,<br/>${tokens.companyName}</p>`,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, 'Offer extended.');
};

const respondToOffer = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  if (!['accepted', 'declined'].includes(req.body.status)) return returnFunction(res, 400, false, 'status must be accepted or declined.');

  const application = await findOne('applications', { _id: new ObjectId(req.params.id) });
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);

  await updateOne('applications', { _id: application._id }, {
    $set: { 'offerDetails.status': req.body.status, updatedAt: new Date() },
  });

  // Accepting the offer moves the candidate straight into the requisition's "hired" stage
  // (if one is configured) instead of leaving that as a separate manual drag.
  let hiredEmployeeId = null;
  if (req.body.status === 'accepted' && application.status === 'active') {
    const requisition = await findOne('jobRequisitions', { _id: application.requisitionId });
    const fromStage = requisition?.pipelineStages.find((s) => s.id === application.currentStageId);
    const hiredStage = requisition?.pipelineStages.find((s) => s.type === 'hired');

    if (hiredStage && hiredStage.id !== application.currentStageId) {
      const now = new Date();
      const stageHistory = application.stageHistory.map((h, i) => (
        i === application.stageHistory.length - 1 && !h.exitedAt ? { ...h, exitedAt: now } : h
      ));
      stageHistory.push({ stageId: hiredStage.id, stageName: hiredStage.name, enteredAt: now, movedBy: new ObjectId(req.user._id) });
      await updateOne('applications', { _id: application._id }, { $set: { currentStageId: hiredStage.id, stageHistory, updatedAt: now } });

      if (fromStage) await fireAutoActions(application, fromStage, global.dbo, 'onExit');
      await fireAutoActions({ ...application, currentStageId: hiredStage.id }, hiredStage, global.dbo, 'onEnter');

      hiredEmployeeId = await hireCandidate({ ...application, currentStageId: hiredStage.id }, requisition, req.user);
    }
  }

  return returnFunction(res, 200, true, `Offer ${req.body.status}.`, hiredEmployeeId ? { employeeId: hiredEmployeeId } : undefined);
};

// ── Interviewer assignments ───────────────────────────────────────────────────

const assignInterviewer = async (req, res) => {
  if (!validateRequiredFields(req, res, ['stageId', 'interviewerId'])) return;

  const application = await findOne('applications', { _id: new ObjectId(req.params.id) });
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);

  const interviewer = await findOne('users', { _id: new ObjectId(req.body.interviewerId) });
  if (!interviewer) return returnFunction(res, 404, false, 'Interviewer account not found.');

  const already = (application.interviewAssignments || []).some(
    (a) => a.stageId === req.body.stageId && String(a.interviewerId) === req.body.interviewerId
  );
  if (already) return returnFunction(res, 409, false, 'This interviewer is already assigned to this stage.');

  const assignment = {
    stageId: req.body.stageId,
    interviewerId: new ObjectId(req.body.interviewerId),
    interviewerName: interviewer.name,
    assignedAt: new Date(),
  };
  await updateOne('applications', { _id: application._id }, {
    $push: { interviewAssignments: assignment },
    $set: { updatedAt: new Date() },
  });

  notifyUser(interviewer._id, {
    title: 'Interview Assigned',
    body: `You've been assigned to interview a candidate at the "${req.body.stageId}" stage.`,
    type: 'recruitment',
  }).catch(() => {});

  return returnFunction(res, 201, true, 'Interviewer assigned.', assignment);
};

const unassignInterviewer = async (req, res) => {
  await updateOne('applications', { _id: new ObjectId(req.params.id) }, {
    $pull: { interviewAssignments: { stageId: req.params.stageId, interviewerId: new ObjectId(req.params.interviewerId) } },
    $set: { updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Interviewer unassigned.');
};

// ── Scorecards ────────────────────────────────────────────────────────────────

const recomputeOverallScore = async (applicationId) => {
  const scorecards = await findMany('scorecards', { applicationId });
  if (!scorecards.length) return;
  const perScorecardAvgs = scorecards.map((sc) => {
    const ratings = sc.competencyRatings.map((r) => r.rating);
    return ratings.reduce((a, b) => a + b, 0) / ratings.length;
  });
  const overallScore = perScorecardAvgs.reduce((a, b) => a + b, 0) / perScorecardAvgs.length;
  await updateOne('applications', { _id: applicationId }, { $set: { overallScore: Math.round(overallScore * 100) / 100 } });
};

const submitScorecard = async (req, res) => {
  if (!validateRequiredFields(req, res, ['stageId', 'competencyRatings', 'overallRecommendation', 'strengths', 'concerns'])) return;
  if (!Array.isArray(req.body.competencyRatings) || !req.body.competencyRatings.length) {
    return returnFunction(res, 400, false, 'Rate at least one competency.');
  }

  const applicationId = new ObjectId(req.params.id);
  const application = await findOne('applications', { _id: applicationId });
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);

  const stageAssignments = (application.interviewAssignments || []).filter((a) => a.stageId === req.body.stageId);
  const isAssigned = stageAssignments.some((a) => String(a.interviewerId) === String(req.user._id));
  if (stageAssignments.length > 0 && !isAssigned && req.user.role !== 'super_admin') {
    return returnFunction(res, 403, false, 'This interview is assigned to a different interviewer.');
  }

  const existing = await findOne('scorecards', {
    applicationId, stageId: req.body.stageId, interviewerId: new ObjectId(req.user._id),
  });
  if (existing) return returnFunction(res, 409, false, 'You have already submitted a scorecard for this stage.');

  const doc = {
    applicationId,
    requisitionId: application.requisitionId,
    stageId: req.body.stageId,
    interviewerId: new ObjectId(req.user._id),
    interviewerName: req.user.name || 'Interviewer',
    competencyRatings: req.body.competencyRatings.map((r) => ({
      competencyId: r.competencyId,
      competencyName: r.competencyName,
      rating: Number(r.rating),
      notes: r.notes || '',
    })),
    overallRecommendation: req.body.overallRecommendation,
    strengths: req.body.strengths,
    concerns: req.body.concerns,
    submittedAt: new Date(),
  };
  const result = await insertOne('scorecards', doc);

  await updateOne('applications', { _id: applicationId }, {
    $push: { scorecards: result.insertedId },
    $set: { updatedAt: new Date() },
  });
  await recomputeOverallScore(applicationId);

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listScorecardsForApplication = async (req, res) => {
  const scorecards = await findMany('scorecards', { applicationId: new ObjectId(req.params.id) }, { sort: { submittedAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, scorecards);
};

const getScorecard = async (req, res) => {
  const scorecard = await findOne('scorecards', { _id: new ObjectId(req.params.id) });
  if (!scorecard) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, scorecard);
};

// ── Candidates / CRM ──────────────────────────────────────────────────────────

const createCandidate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['firstName', 'lastName', 'email', 'source'])) return;

  const email = req.body.email.toLowerCase().trim();
  const existing = await findOne('candidates', { email });
  if (existing) return returnFunction(res, 409, false, 'A candidate with this email already exists.');

  const doc = {
    firstName: req.body.firstName.trim(),
    lastName: req.body.lastName.trim(),
    email,
    phone: req.body.phone || null,
    location: req.body.location || null,
    resumeUrl: req.body.resumeUrl || null,
    linkedInUrl: req.body.linkedInUrl || null,
    source: req.body.source,
    referredBy: req.body.referredBy ? new ObjectId(req.body.referredBy) : null,
    tags: Array.isArray(req.body.tags) ? req.body.tags : [],
    isPassiveTalent: !!req.body.isPassiveTalent,
    consentGivenAt: new Date(),
    consentVersion: req.body.consentVersion || '1.0',
    notes: req.body.notes || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('candidates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listCandidates = async (req, res) => {
  const filter = {};
  if (req.query.source) filter.source = req.query.source;
  if (req.query.tags) filter.tags = { $in: [].concat(req.query.tags) };
  if (req.query.isPassiveTalent !== undefined) filter.isPassiveTalent = req.query.isPassiveTalent === 'true';

  const { page, limit, skip } = getPagination(req.query);
  const [total, data] = await Promise.all([
    countDocuments('candidates', filter),
    findMany('candidates', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

const getCandidate = async (req, res) => {
  const candidate = await findOne('candidates', { _id: new ObjectId(req.params.id) });
  if (!candidate) return returnFunction(res, 404, false, req.locale.notFound);

  const applications = await findMany('applications', { candidateId: candidate._id }, { sort: { createdAt: -1 } });
  const requisitionIds = [...new Set(applications.map((a) => String(a.requisitionId)))].map((id) => new ObjectId(id));
  const requisitions = requisitionIds.length
    ? await findMany('jobRequisitions', { _id: { $in: requisitionIds } }, { projection: { title: 1, department: 1 } })
    : [];
  const reqMap = Object.fromEntries(requisitions.map((r) => [String(r._id), r]));
  const enrichedApplications = applications.map((a) => ({ ...a, requisition: reqMap[String(a.requisitionId)] || null }));

  return returnFunction(res, 200, true, req.locale.success, { ...candidate, applications: enrichedApplications });
};

const updateCandidate = async (req, res) => {
  const allowed = ['firstName', 'lastName', 'phone', 'location', 'resumeUrl', 'linkedInUrl', 'tags', 'isPassiveTalent', 'notes'];
  const update = { updatedAt: new Date() };
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

  const result = await updateOne('candidates', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const convertCandidate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['requisitionId'])) return;

  const candidate = await findOne('candidates', { _id: new ObjectId(req.params.id) });
  if (!candidate) return returnFunction(res, 404, false, req.locale.notFound);

  const requisition = await findOne('jobRequisitions', { _id: new ObjectId(req.body.requisitionId) });
  if (!requisition) return returnFunction(res, 404, false, 'Requisition not found.');
  if (!requisition.pipelineStages?.length) return returnFunction(res, 400, false, 'Requisition has no pipeline stages configured.');

  const existingActive = await findOne('applications', { candidateId: candidate._id, requisitionId: requisition._id, status: 'active' });
  if (existingActive) return returnFunction(res, 409, false, 'This candidate already has an active application for this requisition.');

  const priorApplicationCount = await countDocuments('applications', { candidateId: candidate._id, requisitionId: requisition._id });
  if (priorApplicationCount >= MAX_APPLICATIONS_PER_REQUISITION) {
    return returnFunction(res, 409, false, `This candidate has already applied for this position the maximum number of times (${MAX_APPLICATIONS_PER_REQUISITION}).`);
  }

  const firstStage = requisition.pipelineStages[0];
  const now = new Date();
  const doc = {
    candidateId: candidate._id,
    requisitionId: requisition._id,
    currentStageId: firstStage.id,
    stageHistory: [{ stageId: firstStage.id, stageName: firstStage.name, enteredAt: now, movedBy: new ObjectId(req.user._id) }],
    status: 'active',
    rejectionReason: null,
    offerDetails: null,
    coverLetter: req.body.coverLetter || null,
    answers: [],
    scorecards: [],
    overallScore: null,
    createdAt: now,
    updatedAt: now,
  };
  const result = await insertOne('applications', doc);

  if (candidate.isPassiveTalent) {
    await updateOne('candidates', { _id: candidate._id }, { $set: { isPassiveTalent: false, updatedAt: now } });
  }

  return returnFunction(res, 201, true, 'Candidate moved into active pipeline.', { _id: result.insertedId });
};

// ── Nurture Campaigns (passive talent CRM) ───────────────────────────────────

const createNurtureCampaign = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'targetTags'])) return;
  const doc = {
    name: req.body.name.trim(),
    description: req.body.description || '',
    targetTags: Array.isArray(req.body.targetTags) ? req.body.targetTags : [],
    touchpoints: [],
    status: 'active',
    createdBy: new ObjectId(req.user._id),
    createdAt: new Date(),
  };
  const result = await insertOne('nurtureCampaigns', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listNurtureCampaigns = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const campaigns = await findMany('nurtureCampaigns', filter, { sort: { createdAt: -1 } });

  const enriched = await Promise.all(campaigns.map(async (c) => {
    const matchedCandidateCount = c.targetTags?.length
      ? await countDocuments('candidates', { tags: { $in: c.targetTags }, isPassiveTalent: true })
      : 0;
    return { ...c, matchedCandidateCount };
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const addNurtureTouchpoint = async (req, res) => {
  if (!validateRequiredFields(req, res, ['candidateId', 'channel', 'note'])) return;
  const touchpoint = {
    candidateId: new ObjectId(req.body.candidateId),
    channel: req.body.channel,
    note: req.body.note,
    sentAt: new Date(),
    byUserId: new ObjectId(req.user._id),
    response: req.body.response || null,
  };
  const result = await updateOne('nurtureCampaigns', { _id: new ObjectId(req.params.id) }, { $push: { touchpoints: touchpoint } });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 201, true, 'Touchpoint logged.', touchpoint);
};

const listNurtureCandidates = async (req, res) => {
  const filter = { isPassiveTalent: true };
  if (req.query.tags) filter.tags = { $in: [].concat(req.query.tags) };

  const candidates = await findMany('candidates', filter, { sort: { createdAt: -1 } });
  const campaigns = await findMany('nurtureCampaigns', {});

  const lastTouchpointMap = {};
  campaigns.forEach((c) => {
    (c.touchpoints || []).forEach((t) => {
      const key = String(t.candidateId);
      const sentAt = new Date(t.sentAt);
      if (!lastTouchpointMap[key] || sentAt > lastTouchpointMap[key]) lastTouchpointMap[key] = sentAt;
    });
  });

  const enriched = candidates
    .map((c) => ({ ...c, lastTouchpointAt: lastTouchpointMap[String(c._id)] || null }))
    .sort((a, b) => {
      if (!a.lastTouchpointAt && !b.lastTouchpointAt) return 0;
      if (!a.lastTouchpointAt) return -1;
      if (!b.lastTouchpointAt) return 1;
      return a.lastTouchpointAt - b.lastTouchpointAt;
    });

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── Analytics ─────────────────────────────────────────────────────────────────

const getRecruitmentOverview = async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [openRequisitions, activeCandidates, offersOut, hiresThisMonth] = await Promise.all([
    countDocuments('jobRequisitions', { status: 'open' }),
    countDocuments('applications', { status: 'active' }),
    countDocuments('applications', { 'offerDetails.status': 'pending' }),
    countDocuments('applications', { status: 'hired', updatedAt: { $gte: startOfMonth } }),
  ]);

  return returnFunction(res, 200, true, req.locale.success, {
    openRequisitions, activeCandidates, offersOut, hiresThisMonth,
  });
};

const getRequisitionFunnel = async (req, res) => {
  const requisitionId = new ObjectId(req.params.requisitionId);
  const requisition = await findOne('jobRequisitions', { _id: requisitionId });
  if (!requisition) return returnFunction(res, 404, false, req.locale.notFound);

  const applications = await findMany('applications', { requisitionId });
  const totalApplicants = applications.length;

  const funnel = requisition.pipelineStages.map((stage) => {
    const reached = applications.filter((a) => a.stageHistory.some((h) => h.stageId === stage.id)).length;
    return {
      stageId: stage.id,
      stageName: stage.name,
      count: reached,
      conversionRate: totalApplicants > 0 ? Math.round((reached / totalApplicants) * 100) : 0,
    };
  });

  return returnFunction(res, 200, true, req.locale.success, { totalApplicants, funnel });
};

const getTimeToFill = async (req, res) => {
  const hiredApplications = await findMany('applications', { status: 'hired' });
  if (!hiredApplications.length) return returnFunction(res, 200, true, req.locale.success, []);

  const requisitionIds = [...new Set(hiredApplications.map((a) => String(a.requisitionId)))].map((id) => new ObjectId(id));
  const requisitions = await findMany('jobRequisitions', { _id: { $in: requisitionIds } });
  const reqMap = Object.fromEntries(requisitions.map((r) => [String(r._id), r]));

  const byDept = {};
  hiredApplications.forEach((a) => {
    const requisition = reqMap[String(a.requisitionId)];
    if (!requisition) return;
    const hiredEntry = a.stageHistory.find((h) => h.stageId === a.currentStageId);
    const endDate = hiredEntry?.enteredAt ? new Date(hiredEntry.enteredAt) : new Date(a.updatedAt);
    const daysToFill = Math.max(0, (endDate - new Date(requisition.createdAt)) / 86400000);
    if (!byDept[requisition.department]) byDept[requisition.department] = [];
    byDept[requisition.department].push(daysToFill);
  });

  const result = Object.entries(byDept).map(([department, days]) => ({
    department,
    avgDaysToFill: Math.round(days.reduce((a, b) => a + b, 0) / days.length),
    hires: days.length,
  }));

  return returnFunction(res, 200, true, req.locale.success, result);
};

const getTimeInStage = async (req, res) => {
  const applications = await findMany('applications', {});
  const stageDurations = {};

  applications.forEach((a) => {
    a.stageHistory.forEach((h) => {
      if (!h.exitedAt) return;
      const days = (new Date(h.exitedAt) - new Date(h.enteredAt)) / 86400000;
      if (!stageDurations[h.stageName]) stageDurations[h.stageName] = [];
      stageDurations[h.stageName].push(days);
    });
  });

  const result = Object.entries(stageDurations).map(([stageName, days]) => ({
    stageName,
    avgDays: Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10,
    sampleSize: days.length,
  }));

  return returnFunction(res, 200, true, req.locale.success, result);
};

const getSourceEffectiveness = async (req, res) => {
  const candidates = await findMany('candidates', {}, { projection: { source: 1 } });
  const applications = await findMany('applications', {}, { projection: { candidateId: 1, status: 1 } });

  const candidateSourceMap = Object.fromEntries(candidates.map((c) => [String(c._id), c.source]));
  const bySource = {};

  applications.forEach((a) => {
    const source = candidateSourceMap[String(a.candidateId)] || 'unknown';
    if (!bySource[source]) bySource[source] = { source, applications: 0, hires: 0 };
    bySource[source].applications += 1;
    if (a.status === 'hired') bySource[source].hires += 1;
  });

  const result = Object.values(bySource).map((s) => ({
    ...s,
    conversionRate: s.applications > 0 ? Math.round((s.hires / s.applications) * 100) : 0,
  }));

  return returnFunction(res, 200, true, req.locale.success, result);
};

const getOfferAcceptanceRate = async (req, res) => {
  const applications = await findMany('applications', { offerDetails: { $ne: null } });

  const byMonth = {};
  applications.forEach((a) => {
    const d = new Date(a.offerDetails.startDate || a.updatedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[key]) byMonth[key] = { month: key, offered: 0, accepted: 0, declined: 0 };
    byMonth[key].offered += 1;
    if (a.offerDetails.status === 'accepted') byMonth[key].accepted += 1;
    if (a.offerDetails.status === 'declined') byMonth[key].declined += 1;
  });

  const result = Object.values(byMonth)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, acceptanceRate: m.offered > 0 ? Math.round((m.accepted / m.offered) * 100) : 0 }));

  return returnFunction(res, 200, true, req.locale.success, result);
};

// ── Interview Kits ────────────────────────────────────────────────────────────

const createInterviewKit = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const doc = {
    name: req.body.name.trim(),
    competencies: Array.isArray(req.body.competencies) ? req.body.competencies : [],
    createdBy: new ObjectId(req.user._id),
    createdAt: new Date(),
  };
  const result = await insertOne('interviewKits', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listInterviewKits = async (req, res) => {
  const kits = await findMany('interviewKits', {}, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, kits);
};

const updateInterviewKit = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name;
  if (req.body.competencies !== undefined) update.competencies = req.body.competencies;
  const result = await updateOne('interviewKits', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteInterviewKit = async (req, res) => {
  const result = await deleteOne('interviewKits', { _id: new ObjectId(req.params.id) });
  if (!result.deletedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Email Templates ───────────────────────────────────────────────────────────

const EMAIL_TRIGGERS = ['applicationReceived', 'stageAdvance', 'rejection', 'offerExtended', 'nurture'];

const createEmailTemplate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'trigger', 'subject', 'body'])) return;
  if (!EMAIL_TRIGGERS.includes(req.body.trigger)) return returnFunction(res, 400, false, `trigger must be one of: ${EMAIL_TRIGGERS.join(', ')}`);
  const doc = {
    name: req.body.name.trim(),
    trigger: req.body.trigger,
    subject: req.body.subject,
    body: req.body.body,
    createdBy: new ObjectId(req.user._id),
  };
  const result = await insertOne('emailTemplates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listEmailTemplates = async (req, res) => {
  const filter = {};
  if (req.query.trigger) filter.trigger = req.query.trigger;
  const templates = await findMany('emailTemplates', filter);
  return returnFunction(res, 200, true, req.locale.success, templates);
};

const updateEmailTemplate = async (req, res) => {
  const allowed = ['name', 'trigger', 'subject', 'body'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
  if (update.trigger && !EMAIL_TRIGGERS.includes(update.trigger)) {
    return returnFunction(res, 400, false, `trigger must be one of: ${EMAIL_TRIGGERS.join(', ')}`);
  }
  const result = await updateOne('emailTemplates', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteEmailTemplate = async (req, res) => {
  const result = await deleteOne('emailTemplates', { _id: new ObjectId(req.params.id) });
  if (!result.deletedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

module.exports = {
  createRequisition, listRequisitions, getRequisition, updateRequisition,
  submitRequisition, approveRequisition, deleteRequisition,
  REQUISITION_STATUSES,
  listApplicationsForRequisition, moveApplicationStage, updateApplicationStatus,
  extendOffer, respondToOffer,
  assignInterviewer, unassignInterviewer,
  submitScorecard, listScorecardsForApplication, getScorecard,
  createCandidate, listCandidates, getCandidate, updateCandidate, convertCandidate,
  createNurtureCampaign, listNurtureCampaigns, addNurtureTouchpoint, listNurtureCandidates,
  getRecruitmentOverview, getRequisitionFunnel, getTimeToFill, getTimeInStage,
  getSourceEffectiveness, getOfferAcceptanceRate,
  createInterviewKit, listInterviewKits, updateInterviewKit, deleteInterviewKit,
  createEmailTemplate, listEmailTemplates, updateEmailTemplate, deleteEmailTemplate,
};
