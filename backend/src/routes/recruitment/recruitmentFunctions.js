const crypto = require('crypto');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 4) — job_requisitions, candidates, applications (+ application_interview_
// assignments), scorecards, interview_kits, nurture_campaigns (+ touchpoints),
// email_templates, employees, users, leave_types/leave_balances (Phase 3a) all now
// live in Postgres.
const pgDB = require('../../functions/Database/pgDBFunctions');
const { knex, newId, insertOne, updateOne } = pgDB;
const { ObjectId } = require('mongodb');
const { notifyUser, notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');
const { generateStaffNumber } = require('../../functions/HR/staffNumberGenerator');
const { initiateOnboarding, resolveDefaultTemplate } = require('../../lib/onboarding/autoAssignTasks');
const { fireAutoActions } = require('../../lib/recruitment/autoActions');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

const REQUISITION_STATUSES = ['draft', 'pendingApproval', 'open', 'onHold', 'filled', 'closed'];
const APPLICATION_STATUSES = ['active', 'rejected', 'withdrawn', 'hired'];
const MAX_APPLICATIONS_PER_REQUISITION = 2;

const candidateTokens = (candidate, requisition) => ({
  candidateName: candidate ? `${candidate.firstName} ${candidate.lastName}` : '',
  jobTitle: requisition?.title || '',
  companyName: process.env.COMPANY_NAME || 'Workfola',
});

// Reconstructs the Mongo-shaped `interviewAssignments[]` array from its real child
// table (application_interview_assignments) — a real $push/$pull-per-row entity in
// the original code, unlike stageHistory/answers/offerDetails (JSONB, whole-replaced).
const attachInterviewAssignments = async (application) => {
  if (!application) return application;
  const assignments = await knex('application_interview_assignments').where({ applicationId: application.id }).orderBy('id');
  return { ...application, interviewAssignments: assignments };
};
const attachInterviewAssignmentsMany = (applications) => Promise.all(applications.map(attachInterviewAssignments));

// ── Requisitions ───────────────────────────────────────────────────────────────

const createRequisition = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'department', 'location', 'employmentType', 'headcount', 'salaryRange', 'description'])) return;

  const doc = {
    id: newId(),
    title: req.body.title.trim(),
    department: req.body.department,
    location: req.body.location,
    // Optional — which of the company's configured branches this role is based at.
    // null means "no specific branch" — the public careers page falls back to
    // showing "Headquarters" for these, same as when the company has no branches at all.
    branchId: req.body.branchId ? String(req.body.branchId) : null,
    employmentType: req.body.employmentType,
    headcount: Number(req.body.headcount),
    salaryRange: JSON.stringify({
      min: Number(req.body.salaryRange?.min) || 0,
      max: Number(req.body.salaryRange?.max) || 0,
      currency: req.body.salaryRange?.currency || 'KES',
    }),
    description: req.body.description,
    applicationDeadline: req.body.applicationDeadline ? new Date(req.body.applicationDeadline) : null,
    competencies: JSON.stringify(Array.isArray(req.body.competencies) ? req.body.competencies : []),
    pipelineStages: JSON.stringify(Array.isArray(req.body.pipelineStages) ? req.body.pipelineStages : []),
    screeningQuestions: JSON.stringify(Array.isArray(req.body.screeningQuestions) ? req.body.screeningQuestions : []),
    approvalChain: JSON.stringify(Array.isArray(req.body.approvalChain)
      ? req.body.approvalChain.map((a) => ({
        approverId: a.approverId,
        approverName: a.approverName,
        status: 'pending',
        actedAt: null,
        comment: null,
      }))
      : []),
    status: 'draft',
    hiringManagerId: String(req.body.hiringManagerId),
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('job_requisitions', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listRequisitions = async (req, res) => {
  let query = knex('job_requisitions');
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.department) query = query.where({ department: req.query.department });
  if (req.query.location) query = query.where({ location: req.query.location });

  const { page, limit, skip } = getPagination(req.query);
  const [{ count }] = await query.clone().count('* as count');
  const data = await query.orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const ids = data.map((r) => r.id);
  const counts = ids.length
    ? await knex('applications').whereIn('requisitionId', ids).select('requisitionId').count('* as count').groupBy('requisitionId')
    : [];
  const countMap = Object.fromEntries(counts.map((c) => [c.requisitionId, Number(c.count)]));
  const enriched = data.map((r) => ({ ...r, applicantCount: countMap[r.id] || 0 }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getRequisition = async (req, res) => {
  const requisition = await knex('job_requisitions').where({ id: req.params.id }).first();
  if (!requisition) return returnFunction(res, 404, false, req.locale.notFound);

  const [{ count }] = await knex('applications').where({ requisitionId: requisition.id }).count('* as count');
  return returnFunction(res, 200, true, req.locale.success, { ...requisition, applicantCount: Number(count) });
};

const updateRequisition = async (req, res) => {
  const allowed = [
    'title', 'department', 'location', 'branchId', 'employmentType', 'headcount', 'salaryRange',
    'description', 'applicationDeadline', 'competencies', 'pipelineStages', 'screeningQuestions', 'approvalChain', 'hiringManagerId',
  ];
  const JSONB_FIELDS = new Set(['salaryRange', 'competencies', 'pipelineStages', 'screeningQuestions', 'approvalChain']);
  const update = { updatedAt: new Date() };
  allowed.forEach((f) => {
    if (req.body[f] === undefined) return;
    if (f === 'hiringManagerId') update[f] = String(req.body[f]);
    else if (f === 'branchId') update[f] = req.body[f] ? String(req.body[f]) : null;
    else if (f === 'applicationDeadline') update[f] = req.body[f] ? new Date(req.body[f]) : null;
    else if (JSONB_FIELDS.has(f)) update[f] = JSON.stringify(req.body[f]);
    else update[f] = req.body[f];
  });

  const [updated] = await knex('job_requisitions').where({ id: req.params.id }).update(update).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const submitRequisition = async (req, res) => {
  const requisition = await knex('job_requisitions').where({ id: req.params.id }).first();
  if (!requisition) return returnFunction(res, 404, false, req.locale.notFound);
  if (requisition.status !== 'draft') return returnFunction(res, 400, false, 'Only draft requisitions can be submitted for approval.');
  if (!requisition.pipelineStages?.length) return returnFunction(res, 400, false, 'Add at least one pipeline stage before submitting.');
  if (!requisition.approvalChain?.length) return returnFunction(res, 400, false, 'Add at least one approver before submitting.');

  await knex('job_requisitions').where({ id: requisition.id }).update({ status: 'pendingApproval', updatedAt: new Date() });

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

  const requisition = await knex('job_requisitions').where({ id: req.params.id }).first();
  if (!requisition) return returnFunction(res, 404, false, req.locale.notFound);
  if (requisition.status !== 'pendingApproval') return returnFunction(res, 400, false, 'Requisition is not awaiting approval.');

  const userId = String(req.user.id);
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

  await knex('job_requisitions').where({ id: requisition.id }).update({
    approvalChain: JSON.stringify(approvalChain), status: overallStatus, updatedAt: new Date(),
  });

  notifyByRoles(['super_admin', 'hr_manager'], {
    title: `Requisition ${req.body.status === 'approved' ? 'Approved' : 'Rejected'}`,
    body: `"${requisition.title}" was ${req.body.status} by an approver.`,
    type: 'recruitment',
  }).catch(() => {});

  return returnFunction(res, 200, true, `Requisition ${req.body.status}.`, { status: overallStatus });
};

const deleteRequisition = async (req, res) => {
  const [updated] = await knex('job_requisitions').where({ id: req.params.id }).update({ status: 'closed', updatedAt: new Date() }).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Applications / Pipeline ──────────────────────────────────────────────────────

const listApplicationsForRequisition = async (req, res) => {
  const requisitionId = req.params.id;
  const applications = await attachInterviewAssignmentsMany(
    await knex('applications').where({ requisitionId }).orderBy('createdAt', 'desc')
  );

  const candidateIds = [...new Set(applications.map((a) => a.candidateId))];
  const candidates = candidateIds.length ? await knex('candidates').whereIn('id', candidateIds) : [];
  const candidateMap = Object.fromEntries(candidates.map((c) => [c.id, c]));

  // Batch-load scorecards for every application's *current* stage so the kanban card can
  // show "2 of 3 panelists submitted" without an extra request per card.
  const allScorecards = applications.length
    ? await knex('scorecards').whereIn('applicationId', applications.map((a) => a.id)).select('applicationId', 'stageId', 'interviewerId')
    : [];
  const submittedByAppStage = {};
  allScorecards.forEach((sc) => {
    const key = `${sc.applicationId}_${sc.stageId}`;
    if (!submittedByAppStage[key]) submittedByAppStage[key] = new Set();
    submittedByAppStage[key].add(String(sc.interviewerId));
  });

  const enriched = applications.map((a) => {
    const key = `${a.id}_${a.currentStageId}`;
    const submittedInterviewerIds = submittedByAppStage[key] || new Set();
    const stageAssignments = (a.interviewAssignments || []).filter((asg) => asg.stageId === a.currentStageId);
    return {
      ...a,
      candidate: candidateMap[a.candidateId] || null,
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
  const candidate = await knex('candidates').where({ id: application.candidateId }).first();
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
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const empResult = await pgDB.insertOne('employees', empDoc);

  // documents is its own child table now, not an embedded array — see Phase 1.
  if (candidate?.resumeUrl) {
    await pgDB.addChildRow('employee_documents', {
      employeeId: empResult.id, docType: 'CV', fileName: 'resume', filePath: candidate.resumeUrl, uploadedAt: new Date(),
    });
  }

  // One leave_balances record per active leave type — builds up via the monthly
  // accrual cron (lib/leave/accrualEngine.js), same as direct employee creation.
  // leave_types/leave_balances now live in Postgres (Phase 3a).
  const activeLeaveTypes = await knex('leave_types').where({ isActive: true }).select('id');
  if (activeLeaveTypes.length) {
    await pgDB.insertMany('leave_balances', activeLeaveTypes.map(lt => ({
      employeeId: empResult.id, leaveTypeId: lt.id, year: hireDate.getFullYear(),
      openingBalance: 0, accrued: 0, used: 0, pending: 0, carriedOver: 0, carryOverExpiry: null,
      closingBalance: 0, lastAccrualDate: null, updatedAt: new Date(),
    })));
  }

  const onboardingTemplate = await resolveDefaultTemplate(empDoc.department);
  if (onboardingTemplate) {
    await initiateOnboarding(empResult.id, onboardingTemplate.id, hireDate, null).catch(() => {});
  }

  await knex('applications').where({ id: application.id }).update({ status: 'hired', updatedAt: new Date() });

  // Atomic decrement (Postgres gives this for free — no findOneAndUpdate/$inc
  // workaround needed).
  const [updatedReq] = await knex('job_requisitions').where({ id: requisition.id })
    .update({ headcount: knex.raw('"headcount" - 1'), updatedAt: new Date() }).returning('*');
  if (updatedReq && updatedReq.headcount <= 0) {
    await knex('job_requisitions').where({ id: requisition.id }).update({ status: 'filled' });
  }

  notifyHR({
    type: 'recruitment', subType: 'new_hire',
    title: 'New Hire',
    subtitle: `${fullName} has been hired as ${empDoc.designation}. Staff #: ${staffNumber}`,
    referenceId: new ObjectId(empResult.id), referenceModel: 'employees',
    requiresAction: false, triggeredBy: actingUser?._id ?? null,
  }).catch(() => {});
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'New Hire',
    body: `${fullName} has been hired as ${empDoc.designation}.`,
    type: 'recruitment',
  }).catch(() => {});

  return empResult.id;
};

// Shared by the plain HR-authenticated move route AND assignInterviewer, which also
// performs the move as a side effect when it targets a stage the candidate isn't at
// yet — mirrors extendOffer's existing pattern for the Offer stage: the action that
// collects the required details (interviewer+schedule / salary+start date) IS what
// moves the candidate, so there's no path that enters that stage with nothing set.
// Returns { error } on failure, or { toStage, hiredEmployeeId } on success.
const moveApplicationStageCore = async (application, requisition, toStageId, actingUser) => {
  const fromIndex = requisition.pipelineStages.findIndex((s) => s.id === application.currentStageId);
  const toIndex = requisition.pipelineStages.findIndex((s) => s.id === toStageId);
  const fromStage = requisition.pipelineStages[fromIndex];
  const toStage = requisition.pipelineStages[toIndex];
  if (!toStage) return { error: 'Invalid target stage.' };
  if (toStage.id === application.currentStageId) return { error: 'Application is already at this stage.' };

  const isForwardMove = fromIndex === -1 || toIndex > fromIndex;
  if (isForwardMove && fromStage?.requiresScorecard) {
    const stageAssignments = (application.interviewAssignments || []).filter((a) => a.stageId === fromStage.id);
    const stageScorecards = await knex('scorecards').where({ applicationId: application.id, stageId: fromStage.id }).select('interviewerId');

    if (stageAssignments.length > 0) {
      // Panel interview — every assigned interviewer must have submitted their own scorecard.
      const submittedIds = new Set(stageScorecards.map((sc) => String(sc.interviewerId)));
      const missing = stageAssignments.filter((a) => !submittedIds.has(String(a.interviewerId)));
      if (missing.length > 0) {
        return { error: `Waiting on a scorecard from ${missing.map((m) => m.interviewerName).join(', ')} before moving this candidate forward.` };
      }
    } else if (stageScorecards.length === 0) {
      return { error: `A scorecard must be submitted for "${fromStage.name}" before moving this candidate forward.` };
    }
  }

  const now = new Date();
  const stageHistory = application.stageHistory.map((h, i) => (
    i === application.stageHistory.length - 1 && !h.exitedAt ? { ...h, exitedAt: now } : h
  ));
  stageHistory.push({ stageId: toStage.id, stageName: toStage.name, enteredAt: now, movedBy: actingUser?.id || null });

  await knex('applications').where({ id: application.id }).update({
    currentStageId: toStage.id, stageHistory: JSON.stringify(stageHistory), updatedAt: now,
  });

  if (fromStage) await fireAutoActions(application, fromStage, 'onExit');
  await fireAutoActions({ ...application, currentStageId: toStage.id }, toStage, 'onEnter');

  let hiredEmployeeId = null;
  if (toStage.type === 'hired') {
    hiredEmployeeId = await hireCandidate(application, requisition, actingUser);
  }

  return { toStage, hiredEmployeeId };
};

const moveApplicationStage = async (req, res) => {
  if (!validateRequiredFields(req, res, ['stageId'])) return;

  const application = await attachInterviewAssignments(await knex('applications').where({ id: req.params.id }).first());
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);
  if (application.status !== 'active') return returnFunction(res, 400, false, 'Only active applications can be moved.');

  const requisition = await knex('job_requisitions').where({ id: application.requisitionId }).first();
  if (!requisition) return returnFunction(res, 404, false, 'Requisition not found.');

  const targetStage = requisition.pipelineStages.find((s) => s.id === req.body.stageId);
  if (targetStage?.type === 'offer') {
    return returnFunction(res, 400, false, 'Use "Extend Offer" to move a candidate into the Offer stage — it collects the salary and start date at the same time, instead of leaving them unset.');
  }
  if (targetStage?.type === 'interview') {
    return returnFunction(res, 400, false, 'Use "Assign Interviewer" to move a candidate into an Interview stage — it collects the interviewer, date/time, and location at the same time, instead of leaving them unset.');
  }

  const result = await moveApplicationStageCore(application, requisition, req.body.stageId, req.user);
  if (result.error) return returnFunction(res, 400, false, result.error);

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, result.hiredEmployeeId ? { employeeId: result.hiredEmployeeId } : undefined);
};

const updateApplicationStatus = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  if (!APPLICATION_STATUSES.includes(req.body.status)) return returnFunction(res, 400, false, 'Invalid status.');

  const update = { status: req.body.status, updatedAt: new Date() };
  if (req.body.status === 'rejected') update.rejectionReason = req.body.rejectionReason || null;
  if (req.body.status === 'active') update.rejectionReason = null;

  const [updated] = await knex('applications').where({ id: req.params.id }).update(update).returning('*');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);

  if (req.body.status === 'rejected') {
    const [candidate, requisition] = await Promise.all([
      knex('candidates').where({ id: updated.candidateId }).first(),
      knex('job_requisitions').where({ id: updated.requisitionId }).first(),
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

// ── Bulk Applicant Actions ────────────────────────────────────────────────────
// POST /recruitment/requisitions/:id/applications/bulk-action
// Lets HR select several applicants at once and shortlist/reject/hire them together
// instead of one at a time. Each application is processed independently — one bad
// item (wrong stage, missing scorecard, etc.) is reported in `failed` rather than
// aborting the whole batch, matching this file's existing per-item error isolation
// (see hireCandidate's callers and payroll/attendance's own bulk-tolerant patterns).

const BULK_APPLICATION_ACTIONS = ['shortlist', 'reject', 'hire'];

const bulkApplicationAction = async (req, res) => {
  if (!validateRequiredFields(req, res, ['applicationIds', 'action'])) return;
  const { applicationIds, action, stageId, rejectionReason } = req.body;

  if (!Array.isArray(applicationIds) || !applicationIds.length) {
    return returnFunction(res, 400, false, 'applicationIds must be a non-empty array.');
  }
  if (!BULK_APPLICATION_ACTIONS.includes(action)) {
    return returnFunction(res, 400, false, `action must be one of: ${BULK_APPLICATION_ACTIONS.join(', ')}`);
  }

  const requisition = await knex('job_requisitions').where({ id: req.params.id }).first();
  if (!requisition) return returnFunction(res, 404, false, 'Requisition not found.');

  // 'shortlist' moves to an HR-chosen stage; 'hire' always targets the requisition's
  // designated hired-type stage (same as a single moveApplicationStage hire).
  let targetStage = null;
  if (action === 'shortlist') {
    if (!stageId) return returnFunction(res, 400, false, 'stageId is required for the shortlist action.');
    targetStage = requisition.pipelineStages.find((s) => s.id === stageId);
    if (!targetStage) return returnFunction(res, 400, false, 'Invalid target stage.');
    // Same rule as the single-application move — Offer/Interview stages need their
    // details collected per-candidate (salary+start date / interviewer+schedule), which
    // a bulk action can't do, so bulk-shortlisting into either isn't offered here.
    if (targetStage.type === 'offer') return returnFunction(res, 400, false, 'Bulk shortlist can\'t target the Offer stage — extend an offer to each candidate individually.');
    if (targetStage.type === 'interview') return returnFunction(res, 400, false, 'Bulk shortlist can\'t target an Interview stage — assign an interviewer to each candidate individually.');
  } else if (action === 'hire') {
    targetStage = requisition.pipelineStages.find((s) => s.type === 'hired');
    if (!targetStage) return returnFunction(res, 400, false, 'This requisition has no "hired" stage configured.');
  }

  const succeeded = [];
  const failed = [];

  for (const id of applicationIds) {
    try {
      const application = await attachInterviewAssignments(
        await knex('applications').where({ id, requisitionId: requisition.id }).first()
      );
      if (!application) throw new Error('Application not found in this requisition.');
      if (application.status !== 'active') throw new Error('Only active applications can be updated.');

      if (action === 'reject') {
        await knex('applications').where({ id: application.id }).update({
          status: 'rejected', rejectionReason: rejectionReason || null, updatedAt: new Date(),
        });
        const candidate = await knex('candidates').where({ id: application.candidateId }).first();
        if (candidate?.email) {
          const tokens = candidateTokens(candidate, requisition);
          sendTemplatedEmail({
            trigger: 'rejection', to: candidate.email, tokens,
            fallbackSubject: 'Application Update',
            fallbackHtml: `<p>Dear ${tokens.candidateName},</p><p>Thank you for your interest. After careful consideration, we are unable to proceed with your application at this time.</p><p>Regards,<br/>${tokens.companyName}</p>`,
          }).catch(() => {});
        }
      } else {
        // shortlist / hire — both are a stage move; same forward-move scorecard gate
        // (and the same 'hired'-type auto-hire) as the single-application move, via the
        // shared core. This also sends any stage-configured candidate email for free,
        // same as a single drag-and-drop move already does.
        const moveResult = await moveApplicationStageCore(application, requisition, targetStage.id, req.user);
        if (moveResult.error) throw new Error(moveResult.error);
      }

      succeeded.push(id);
    } catch (err) {
      failed.push({ id, reason: err.message });
    }
  }

  return returnFunction(res, 200, true,
    `Bulk ${action}: ${succeeded.length} succeeded, ${failed.length} failed.`,
    { succeeded, failed });
};

const extendOffer = async (req, res) => {
  if (!validateRequiredFields(req, res, ['salary', 'startDate', 'expiresAt'])) return;

  // Neither date is meaningful in the past — a start date already gone by, or a response
  // deadline that's already expired the moment the offer goes out, both silently made no
  // sense before this check existed.
  const startDate = new Date(req.body.startDate);
  const expiresAt = new Date(req.body.expiresAt);
  const todayStart = new Date(new Date().toDateString());
  if (Number.isNaN(startDate.getTime()) || startDate < todayStart) {
    return returnFunction(res, 400, false, 'Start date cannot be in the past.');
  }
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return returnFunction(res, 400, false, 'Offer expiry must be in the future.');
  }
  if (expiresAt > startDate) {
    return returnFunction(res, 400, false, 'Offer expiry cannot be after the start date.');
  }

  const application = await attachInterviewAssignments(await knex('applications').where({ id: req.params.id }).first());
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);

  // A candidate must actively confirm their own offer — HR extending it doesn't count as
  // acceptance. The raw token goes out in the email only; we store just its hash, same
  // pattern as the password-reset flow (authFunctions.js).
  const rawResponseToken = crypto.randomBytes(32).toString('hex');
  const offerDetails = {
    salary: Number(req.body.salary),
    currency: req.body.currency || 'KES',
    startDate,
    expiresAt,
    status: 'pending',
    responseTokenHash: crypto.createHash('sha256').update(rawResponseToken).digest('hex'),
  };
  await knex('applications').where({ id: application.id }).update({ offerDetails: JSON.stringify(offerDetails), updatedAt: new Date() });

  const [candidate, requisition] = await Promise.all([
    knex('candidates').where({ id: application.candidateId }).first(),
    knex('job_requisitions').where({ id: application.requisitionId }).first(),
  ]);

  // Extending an offer IS the action that moves a candidate into the "Offer" stage —
  // there is no separate manual drag for it, so offer details can never be missing for
  // someone sitting in that stage (matches the same auto-move-on-accept pattern in
  // respondToOffer below, just for entering the stage instead of moving past it).
  const offerStage = requisition?.pipelineStages.find((s) => s.type === 'offer');
  if (offerStage && offerStage.id !== application.currentStageId) {
    const fromStage = requisition.pipelineStages.find((s) => s.id === application.currentStageId);
    const now = new Date();
    const stageHistory = (application.stageHistory || []).map((h, i) => (
      i === application.stageHistory.length - 1 && !h.exitedAt ? { ...h, exitedAt: now } : h
    ));
    stageHistory.push({ stageId: offerStage.id, stageName: offerStage.name, enteredAt: now, movedBy: req.user.id });
    await knex('applications').where({ id: application.id }).update({ currentStageId: offerStage.id, stageHistory: JSON.stringify(stageHistory), updatedAt: now });

    if (fromStage) await fireAutoActions(application, fromStage, 'onExit');
    await fireAutoActions({ ...application, currentStageId: offerStage.id }, offerStage, 'onEnter');
  }

  if (candidate?.email) {
    const tokens = candidateTokens(candidate, requisition);
    const offerUrl = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/en/offer/${rawResponseToken}`;
    sendTemplatedEmail({
      trigger: 'offerExtended',
      to: candidate.email,
      tokens: { ...tokens, offerUrl },
      fallbackSubject: 'Offer of Employment',
      fallbackHtml: `<p>Dear ${tokens.candidateName},</p><p>We are pleased to extend an offer with a gross salary of ${offerDetails.currency} ${offerDetails.salary.toLocaleString()}, starting ${offerDetails.startDate.toDateString()}. This offer expires on ${offerDetails.expiresAt.toDateString()}.</p><p>Please review and respond to your offer here: <a href="${offerUrl}">${offerUrl}</a></p><p>Regards,<br/>${tokens.companyName}</p>`,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, 'Offer extended.');
};

// Shared core so both the HR-authenticated route and the candidate-facing public
// token route (see publicRoutes.js) apply identical accept/decline logic — actingUser
// is null for candidate self-service, since there's no logged-in user in that flow.
const respondToOfferCore = async (application, status, actingUser) => {
  const offerDetails = { ...application.offerDetails, status };
  await knex('applications').where({ id: application.id }).update({ offerDetails: JSON.stringify(offerDetails), updatedAt: new Date() });

  // Accepting the offer moves the candidate straight into the requisition's "hired" stage
  // (if one is configured) instead of leaving that as a separate manual drag.
  let hiredEmployeeId = null;
  if (status === 'accepted' && application.status === 'active') {
    const requisition = await knex('job_requisitions').where({ id: application.requisitionId }).first();
    const fromStage = requisition?.pipelineStages.find((s) => s.id === application.currentStageId);
    const hiredStage = requisition?.pipelineStages.find((s) => s.type === 'hired');

    if (hiredStage && hiredStage.id !== application.currentStageId) {
      const now = new Date();
      const stageHistory = application.stageHistory.map((h, i) => (
        i === application.stageHistory.length - 1 && !h.exitedAt ? { ...h, exitedAt: now } : h
      ));
      stageHistory.push({ stageId: hiredStage.id, stageName: hiredStage.name, enteredAt: now, movedBy: actingUser?.id || null });
      await knex('applications').where({ id: application.id }).update({ currentStageId: hiredStage.id, stageHistory: JSON.stringify(stageHistory), updatedAt: now });

      if (fromStage) await fireAutoActions(application, fromStage, 'onExit');
      await fireAutoActions({ ...application, currentStageId: hiredStage.id }, hiredStage, 'onEnter');

      hiredEmployeeId = await hireCandidate({ ...application, currentStageId: hiredStage.id }, requisition, actingUser);
    }
  }

  return hiredEmployeeId;
};

const respondToOffer = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  if (!['accepted', 'declined'].includes(req.body.status)) return returnFunction(res, 400, false, 'status must be accepted or declined.');

  const application = await attachInterviewAssignments(await knex('applications').where({ id: req.params.id }).first());
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);

  const hiredEmployeeId = await respondToOfferCore(application, req.body.status, req.user);

  return returnFunction(res, 200, true, `Offer ${req.body.status}.`, hiredEmployeeId ? { employeeId: hiredEmployeeId } : undefined);
};

// ── Interviewer assignments ───────────────────────────────────────────────────

const assignInterviewer = async (req, res) => {
  // scheduledAt is mandatory — an interview/assessment stage assignment with no date/time
  // is exactly the gap that left HR unable to remind candidates ahead of time.
  if (!validateRequiredFields(req, res, ['stageId', 'interviewerId', 'scheduledAt'])) return;

  // A 5-minute buffer rather than a bare "> now" check — an interview scheduled for
  // 30 seconds from now is functionally already a past-dated one nobody can prepare for.
  const scheduledAt = new Date(req.body.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 5 * 60 * 1000) {
    return returnFunction(res, 400, false, 'Interview time must be at least 5 minutes from now.');
  }

  const application = await attachInterviewAssignments(await knex('applications').where({ id: req.params.id }).first());
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);

  const requisition = await knex('job_requisitions').where({ id: application.requisitionId }).first();
  if (!requisition) return returnFunction(res, 404, false, 'Requisition not found.');

  const interviewer = await knex('users').where({ id: String(req.body.interviewerId) }).first();
  if (!interviewer) return returnFunction(res, 404, false, 'Interviewer account not found.');

  const already = application.interviewAssignments.some(
    (a) => a.stageId === req.body.stageId && String(a.interviewerId) === req.body.interviewerId
  );
  if (already) return returnFunction(res, 409, false, 'This interviewer is already assigned to this stage.');

  // Assigning an interviewer to a stage the candidate isn't at yet IS the move into that
  // stage (see moveApplicationStage, which now refuses to move into an Interview stage any
  // other way) — no candidate ever reaches an Interview stage with zero interviewer/schedule set.
  let hiredEmployeeId = null;
  if (req.body.stageId !== application.currentStageId) {
    const moveResult = await moveApplicationStageCore(application, requisition, req.body.stageId, req.user);
    if (moveResult.error) return returnFunction(res, 400, false, moveResult.error);
    hiredEmployeeId = moveResult.hiredEmployeeId;
  }

  const assignment = {
    applicationId: application.id,
    stageId: req.body.stageId,
    interviewerId: String(req.body.interviewerId),
    interviewerName: interviewer.name,
    scheduledAt,
    // Candidate-facing logistics — deliberately separate from interviewerId/interviewerName
    // above, which must never be sent to the candidate (see the email below).
    meetingLink: req.body.meetingLink || null,
    location: req.body.location || null,
    requiredDocuments: req.body.requiredDocuments || null,
    assignedAt: new Date(),
  };
  await knex('application_interview_assignments').insert(assignment);
  await knex('applications').where({ id: application.id }).update({ updatedAt: new Date() });

  notifyUser(interviewer.id, {
    title: 'Interview Assigned',
    body: `You've been assigned to interview a candidate at the "${req.body.stageId}" stage, scheduled ${assignment.scheduledAt.toLocaleString()}.`,
    type: 'recruitment',
  }).catch(() => {});

  // Tell the candidate their interview is scheduled, with every logistical detail they
  // need (meeting link, location, time, required documents) — but never who is
  // interviewing them, which is HR/internal-only information.
  const candidate = await knex('candidates').where({ id: application.candidateId }).first();
  if (candidate?.email) {
    const tokens = candidateTokens(candidate, requisition);
    const when = assignment.scheduledAt.toLocaleString('en-KE', { dateStyle: 'full', timeStyle: 'short' });
    sendTemplatedEmail({
      trigger: 'interviewScheduled',
      to: candidate.email,
      tokens: {
        ...tokens,
        interviewDateTime: when,
        meetingLink: assignment.meetingLink || '',
        location: assignment.location || '',
        requiredDocuments: assignment.requiredDocuments || '',
      },
      fallbackSubject: `Interview Scheduled — ${tokens.jobTitle}`,
      fallbackHtml: `<p>Dear ${tokens.candidateName},</p>`
        + `<p>Your interview for ${tokens.jobTitle} has been scheduled for <strong>${when}</strong>.</p>`
        + (assignment.location ? `<p><strong>Location:</strong> ${assignment.location}</p>` : '')
        + (assignment.meetingLink ? `<p><strong>Meeting link:</strong> <a href="${assignment.meetingLink}">${assignment.meetingLink}</a></p>` : '')
        + (assignment.requiredDocuments ? `<p><strong>Please bring:</strong> ${assignment.requiredDocuments}</p>` : '')
        + `<p>We look forward to speaking with you.</p><p>Regards,<br/>${tokens.companyName}</p>`,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, 'Interviewer assigned.', { ...assignment, employeeId: hiredEmployeeId });
};

// HR-triggered reminder email to the candidate ahead of their scheduled interview/assessment
// — a deliberate manual action (not an automated cron job) so HR decides when to reach out.
const sendInterviewReminder = async (req, res) => {
  const application = await knex('applications').where({ id: req.params.id }).first();
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);

  const assignment = await knex('application_interview_assignments').where({ applicationId: application.id, stageId: req.params.stageId }).first();
  if (!assignment) return returnFunction(res, 404, false, 'No interview assignment found for this stage.');

  const [candidate, requisition] = await Promise.all([
    knex('candidates').where({ id: application.candidateId }).first(),
    knex('job_requisitions').where({ id: application.requisitionId }).first(),
  ]);
  if (!candidate?.email) return returnFunction(res, 400, false, 'This candidate has no email on file.');

  const tokens = candidateTokens(candidate, requisition);
  const when = assignment.scheduledAt ? new Date(assignment.scheduledAt).toLocaleString('en-KE', { dateStyle: 'full', timeStyle: 'short' }) : 'the scheduled time';
  await sendTemplatedEmail({
    trigger: 'interviewReminder',
    to: candidate.email,
    tokens: {
      ...tokens, interviewDateTime: when,
      meetingLink: assignment.meetingLink || '', location: assignment.location || '', requiredDocuments: assignment.requiredDocuments || '',
    },
    fallbackSubject: 'Reminder: Upcoming Interview',
    fallbackHtml: `<p>Dear ${tokens.candidateName},</p><p>This is a reminder of your upcoming interview on ${when}.</p>`
      + (assignment.location ? `<p><strong>Location:</strong> ${assignment.location}</p>` : '')
      + (assignment.meetingLink ? `<p><strong>Meeting link:</strong> <a href="${assignment.meetingLink}">${assignment.meetingLink}</a></p>` : '')
      + (assignment.requiredDocuments ? `<p><strong>Please bring:</strong> ${assignment.requiredDocuments}</p>` : '')
      + `<p>We look forward to speaking with you.</p><p>Regards,<br/>${tokens.companyName}</p>`,
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Reminder sent to candidate.');
};

const unassignInterviewer = async (req, res) => {
  await knex('application_interview_assignments').where({
    applicationId: req.params.id, stageId: req.params.stageId, interviewerId: String(req.params.interviewerId),
  }).del();
  await knex('applications').where({ id: req.params.id }).update({ updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Interviewer unassigned.');
};

// Self-scoped view for an interviewer (any role, including plain staff) to see
// their own upcoming/past interview assignments and jump straight to the scorecard
// form — deliberately filtered server-side to req.user.id so this is safe to expose
// broadly, unlike listScorecardsForApplication/getScorecard which return other
// interviewers' assessments and candidate PII and must stay MGMT-only.
const getMyInterviews = async (req, res) => {
  const interviewerId = String(req.user.id);

  const myAssignmentRows = await knex('application_interview_assignments').where({ interviewerId }).orderBy('assignedAt', 'desc');
  if (!myAssignmentRows.length) return returnFunction(res, 200, true, 'OK', []);

  const applicationIds = [...new Set(myAssignmentRows.map((a) => a.applicationId))];
  const applications = await knex('applications').whereIn('id', applicationIds);
  const applicationById = Object.fromEntries(applications.map((a) => [a.id, a]));

  const candidateIds = [...new Set(applications.map((a) => a.candidateId))];
  const requisitionIds = [...new Set(applications.map((a) => a.requisitionId))];
  const [candidates, requisitions, myScorecards] = await Promise.all([
    candidateIds.length ? knex('candidates').whereIn('id', candidateIds).select('id', 'firstName', 'lastName') : [],
    requisitionIds.length ? knex('job_requisitions').whereIn('id', requisitionIds).select('id', 'title', 'pipelineStages', 'competencies') : [],
    knex('scorecards').where({ interviewerId }).whereIn('applicationId', applicationIds).select('applicationId', 'stageId'),
  ]);
  const candidateById = Object.fromEntries(candidates.map((c) => [c.id, c]));
  const requisitionById = Object.fromEntries(requisitions.map((r) => [r.id, r]));
  const submittedKeys = new Set(myScorecards.map((s) => `${s.applicationId}:${s.stageId}`));

  const rows = myAssignmentRows.map((assignment) => {
    const application = applicationById[assignment.applicationId];
    const requisition = application && requisitionById[application.requisitionId];
    const candidate = application && candidateById[application.candidateId];
    const stage = requisition?.pipelineStages?.find((s) => s.id === assignment.stageId);
    return {
      applicationId: assignment.applicationId,
      candidateName: candidate ? `${candidate.firstName} ${candidate.lastName}` : 'Unknown candidate',
      jobTitle: requisition?.title || 'Unknown role',
      stageId: assignment.stageId,
      stageName: stage?.name || assignment.stageId,
      scheduledAt: assignment.scheduledAt,
      meetingLink: assignment.meetingLink,
      location: assignment.location,
      requiredDocuments: assignment.requiredDocuments,
      // Denormalized here (rather than requiring the frontend to fetch the requisition
      // separately) because GET /requisitions/:id is MGMT-gated and this endpoint is
      // the one thing a plain-staff interviewer is allowed to call.
      competencies: requisition?.competencies || [],
      scorecardSubmitted: submittedKeys.has(`${assignment.applicationId}:${assignment.stageId}`),
    };
  });

  rows.sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
  return returnFunction(res, 200, true, 'OK', rows);
};

// ── Scorecards ────────────────────────────────────────────────────────────────

const recomputeOverallScore = async (applicationId) => {
  const scorecards = await knex('scorecards').where({ applicationId });
  if (!scorecards.length) return;
  const perScorecardAvgs = scorecards.map((sc) => {
    const ratings = sc.competencyRatings.map((r) => r.rating);
    return ratings.reduce((a, b) => a + b, 0) / ratings.length;
  });
  const overallScore = perScorecardAvgs.reduce((a, b) => a + b, 0) / perScorecardAvgs.length;
  await knex('applications').where({ id: applicationId }).update({ overallScore: Math.round(overallScore * 100) / 100 });
};

const submitScorecard = async (req, res) => {
  if (!validateRequiredFields(req, res, ['stageId', 'competencyRatings', 'overallRecommendation', 'strengths', 'concerns'])) return;
  if (!Array.isArray(req.body.competencyRatings) || !req.body.competencyRatings.length) {
    return returnFunction(res, 400, false, 'Rate at least one competency.');
  }

  const applicationId = req.params.id;
  const application = await attachInterviewAssignments(await knex('applications').where({ id: applicationId }).first());
  if (!application) return returnFunction(res, 404, false, req.locale.notFound);

  const stageAssignments = application.interviewAssignments.filter((a) => a.stageId === req.body.stageId);
  const isAssigned = stageAssignments.some((a) => String(a.interviewerId) === String(req.user.id));
  if (stageAssignments.length > 0 && !isAssigned && req.user.role !== 'super_admin') {
    return returnFunction(res, 403, false, 'This interview is assigned to a different interviewer.');
  }

  const existing = await knex('scorecards').where({
    applicationId, stageId: req.body.stageId, interviewerId: String(req.user.id),
  }).first();
  if (existing) return returnFunction(res, 409, false, 'You have already submitted a scorecard for this stage.');

  const doc = {
    id: newId(),
    applicationId,
    requisitionId: application.requisitionId,
    stageId: req.body.stageId,
    interviewerId: String(req.user.id),
    interviewerName: req.user.name || 'Interviewer',
    competencyRatings: JSON.stringify(req.body.competencyRatings.map((r) => ({
      competencyId: r.competencyId,
      competencyName: r.competencyName,
      rating: Number(r.rating),
      notes: r.notes || '',
    }))),
    overallRecommendation: req.body.overallRecommendation,
    strengths: req.body.strengths,
    concerns: req.body.concerns,
    submittedAt: new Date(),
  };
  const result = await insertOne('scorecards', doc);

  // NOTE: the old Mongo code also $push'd this scorecard's id onto
  // applications.scorecards[] — dropped here since that field was write-only and
  // never read anywhere (see the migration file's own comment on why).
  await knex('applications').where({ id: applicationId }).update({ updatedAt: new Date() });
  await recomputeOverallScore(applicationId);

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listScorecardsForApplication = async (req, res) => {
  const scorecards = await knex('scorecards').where({ applicationId: req.params.id }).orderBy('submittedAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, scorecards);
};

const getScorecard = async (req, res) => {
  const scorecard = await knex('scorecards').where({ id: req.params.id }).first();
  if (!scorecard) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, scorecard);
};

// ── Candidates / CRM ──────────────────────────────────────────────────────────

const createCandidate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['firstName', 'lastName', 'email', 'source'])) return;

  const email = req.body.email.toLowerCase().trim();
  const existing = await knex('candidates').where({ email }).first();
  if (existing) return returnFunction(res, 409, false, 'A candidate with this email already exists.');

  const doc = {
    id: newId(),
    firstName: req.body.firstName.trim(),
    lastName: req.body.lastName.trim(),
    email,
    phone: req.body.phone || null,
    location: req.body.location || null,
    resumeUrl: req.body.resumeUrl || null,
    linkedInUrl: req.body.linkedInUrl || null,
    source: req.body.source,
    referredBy: req.body.referredBy ? String(req.body.referredBy) : null,
    tags: Array.isArray(req.body.tags) ? req.body.tags : [],
    isPassiveTalent: !!req.body.isPassiveTalent,
    consentGivenAt: new Date(),
    consentVersion: req.body.consentVersion || '1.0',
    notes: req.body.notes || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('candidates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listCandidates = async (req, res) => {
  let query = knex('candidates');
  if (req.query.source) query = query.where({ source: req.query.source });
  if (req.query.tags) {
    const tags = [].concat(req.query.tags);
    query = query.whereRaw('"tags" && ?::text[]', [tags]);
  }
  if (req.query.isPassiveTalent !== undefined) query = query.where({ isPassiveTalent: req.query.isPassiveTalent === 'true' });

  const { page, limit, skip } = getPagination(req.query);
  const [{ count }] = await query.clone().count('* as count');
  const data = await query.orderBy('createdAt', 'desc').limit(limit).offset(skip);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, Number(count), page, limit));
};

const getCandidate = async (req, res) => {
  const candidate = await knex('candidates').where({ id: req.params.id }).first();
  if (!candidate) return returnFunction(res, 404, false, req.locale.notFound);

  const applications = await knex('applications').where({ candidateId: candidate.id }).orderBy('createdAt', 'desc');
  const requisitionIds = [...new Set(applications.map((a) => a.requisitionId))];
  const requisitions = requisitionIds.length
    ? await knex('job_requisitions').whereIn('id', requisitionIds).select('id', 'title', 'department')
    : [];
  const reqMap = Object.fromEntries(requisitions.map((r) => [r.id, r]));
  const enrichedApplications = applications.map((a) => ({ ...a, requisition: reqMap[a.requisitionId] || null }));

  return returnFunction(res, 200, true, req.locale.success, { ...candidate, applications: enrichedApplications });
};

const updateCandidate = async (req, res) => {
  const allowed = ['firstName', 'lastName', 'phone', 'location', 'resumeUrl', 'linkedInUrl', 'tags', 'isPassiveTalent', 'notes'];
  const update = { updatedAt: new Date() };
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

  const [updated] = await knex('candidates').where({ id: req.params.id }).update(update).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const convertCandidate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['requisitionId'])) return;

  const candidate = await knex('candidates').where({ id: req.params.id }).first();
  if (!candidate) return returnFunction(res, 404, false, req.locale.notFound);

  const requisition = await knex('job_requisitions').where({ id: req.body.requisitionId }).first();
  if (!requisition) return returnFunction(res, 404, false, 'Requisition not found.');
  if (!requisition.pipelineStages?.length) return returnFunction(res, 400, false, 'Requisition has no pipeline stages configured.');

  const existingActive = await knex('applications').where({ candidateId: candidate.id, requisitionId: requisition.id, status: 'active' }).first();
  if (existingActive) return returnFunction(res, 409, false, 'This candidate already has an active application for this requisition.');

  const [{ count: priorApplicationCount }] = await knex('applications').where({ candidateId: candidate.id, requisitionId: requisition.id }).count('* as count');
  if (Number(priorApplicationCount) >= MAX_APPLICATIONS_PER_REQUISITION) {
    return returnFunction(res, 409, false, `This candidate has already applied for this position the maximum number of times (${MAX_APPLICATIONS_PER_REQUISITION}).`);
  }

  const firstStage = requisition.pipelineStages[0];
  const now = new Date();
  const doc = {
    id: newId(),
    candidateId: candidate.id,
    requisitionId: requisition.id,
    currentStageId: firstStage.id,
    stageHistory: JSON.stringify([{ stageId: firstStage.id, stageName: firstStage.name, enteredAt: now, movedBy: req.user.id }]),
    status: 'active',
    rejectionReason: null,
    offerDetails: null,
    coverLetter: req.body.coverLetter || null,
    answers: JSON.stringify([]),
    overallScore: null,
    createdAt: now,
    updatedAt: now,
  };
  const result = await insertOne('applications', doc);

  if (candidate.isPassiveTalent) {
    await knex('candidates').where({ id: candidate.id }).update({ isPassiveTalent: false, updatedAt: now });
  }

  return returnFunction(res, 201, true, 'Candidate moved into active pipeline.', { _id: result.id });
};

// ── Nurture Campaigns (passive talent CRM) ───────────────────────────────────

const createNurtureCampaign = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'targetTags'])) return;
  const doc = {
    id: newId(),
    name: req.body.name.trim(),
    description: req.body.description || '',
    targetTags: Array.isArray(req.body.targetTags) ? req.body.targetTags : [],
    status: 'active',
    createdBy: req.user.id,
    createdAt: new Date(),
  };
  const result = await insertOne('nurture_campaigns', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listNurtureCampaigns = async (req, res) => {
  let query = knex('nurture_campaigns');
  if (req.query.status) query = query.where({ status: req.query.status });
  const campaigns = await query.orderBy('createdAt', 'desc');

  const enriched = await Promise.all(campaigns.map(async (c) => {
    let matchedCandidateCount = 0;
    if (c.targetTags?.length) {
      const [{ count }] = await knex('candidates')
        .whereRaw('"tags" && ?::text[]', [c.targetTags]).where({ isPassiveTalent: true }).count('* as count');
      matchedCandidateCount = Number(count);
    }
    return { ...c, matchedCandidateCount };
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const addNurtureTouchpoint = async (req, res) => {
  if (!validateRequiredFields(req, res, ['candidateId', 'channel', 'note'])) return;
  const campaign = await knex('nurture_campaigns').where({ id: req.params.id }).first();
  if (!campaign) return returnFunction(res, 404, false, req.locale.notFound);

  const touchpoint = {
    campaignId: campaign.id,
    candidateId: String(req.body.candidateId),
    channel: req.body.channel,
    note: req.body.note,
    sentAt: new Date(),
    byUserId: req.user.id,
    response: req.body.response || null,
  };
  await knex('nurture_campaign_touchpoints').insert(touchpoint);
  return returnFunction(res, 201, true, 'Touchpoint logged.', touchpoint);
};

const listNurtureCandidates = async (req, res) => {
  let query = knex('candidates').where({ isPassiveTalent: true });
  if (req.query.tags) {
    const tags = [].concat(req.query.tags);
    query = query.whereRaw('"tags" && ?::text[]', [tags]);
  }

  const candidates = await query.orderBy('createdAt', 'desc');
  const touchpoints = await knex('nurture_campaign_touchpoints');

  const lastTouchpointMap = {};
  touchpoints.forEach((t) => {
    const key = t.candidateId;
    const sentAt = new Date(t.sentAt);
    if (!lastTouchpointMap[key] || sentAt > lastTouchpointMap[key]) lastTouchpointMap[key] = sentAt;
  });

  const enriched = candidates
    .map((c) => ({ ...c, lastTouchpointAt: lastTouchpointMap[c.id] || null }))
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

  const [[{ count: openRequisitions }], [{ count: activeCandidates }], [{ count: offersOut }], [{ count: hiresThisMonth }]] = await Promise.all([
    knex('job_requisitions').where({ status: 'open' }).count('* as count'),
    knex('applications').where({ status: 'active' }).count('* as count'),
    knex('applications').whereRaw("\"offerDetails\"->>'status' = ?", ['pending']).count('* as count'),
    knex('applications').where({ status: 'hired' }).where('updatedAt', '>=', startOfMonth).count('* as count'),
  ]);

  return returnFunction(res, 200, true, req.locale.success, {
    openRequisitions: Number(openRequisitions), activeCandidates: Number(activeCandidates),
    offersOut: Number(offersOut), hiresThisMonth: Number(hiresThisMonth),
  });
};

const getRequisitionFunnel = async (req, res) => {
  const requisitionId = req.params.requisitionId;
  const requisition = await knex('job_requisitions').where({ id: requisitionId }).first();
  if (!requisition) return returnFunction(res, 404, false, req.locale.notFound);

  const applications = await knex('applications').where({ requisitionId });
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
  const hiredApplications = await knex('applications').where({ status: 'hired' });
  if (!hiredApplications.length) return returnFunction(res, 200, true, req.locale.success, []);

  const requisitionIds = [...new Set(hiredApplications.map((a) => a.requisitionId))];
  const requisitions = await knex('job_requisitions').whereIn('id', requisitionIds);
  const reqMap = Object.fromEntries(requisitions.map((r) => [r.id, r]));

  const byDept = {};
  hiredApplications.forEach((a) => {
    const requisition = reqMap[a.requisitionId];
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
  const applications = await knex('applications');
  const stageDurations = {};

  applications.forEach((a) => {
    (a.stageHistory || []).forEach((h) => {
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
  const candidates = await knex('candidates').select('id', 'source');
  const applications = await knex('applications').select('candidateId', 'status');

  const candidateSourceMap = Object.fromEntries(candidates.map((c) => [c.id, c.source]));
  const bySource = {};

  applications.forEach((a) => {
    const source = candidateSourceMap[a.candidateId] || 'unknown';
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
  const applications = await knex('applications').whereNotNull('offerDetails');

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
    id: newId(),
    name: req.body.name.trim(),
    competencies: JSON.stringify(Array.isArray(req.body.competencies) ? req.body.competencies : []),
    createdBy: req.user.id,
    createdAt: new Date(),
  };
  const result = await insertOne('interview_kits', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listInterviewKits = async (req, res) => {
  const kits = await knex('interview_kits').orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, kits);
};

const updateInterviewKit = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name;
  if (req.body.competencies !== undefined) update.competencies = JSON.stringify(req.body.competencies);
  const [updated] = await knex('interview_kits').where({ id: req.params.id }).update(update).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteInterviewKit = async (req, res) => {
  const deleted = await knex('interview_kits').where({ id: req.params.id }).del();
  if (!deleted) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Email Templates ───────────────────────────────────────────────────────────
// Recruitment's own direct CRUD on email_templates, keyed by real id (not by
// trigger) — shared with the Settings module's trigger-catalog override pattern
// on the same table (see settings/emailTemplatesFunctions.js).

const EMAIL_TRIGGERS = ['applicationReceived', 'stageAdvance', 'rejection', 'offerExtended', 'nurture', 'interviewReminder', 'interviewScheduled'];

const createEmailTemplate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'trigger', 'subject', 'body'])) return;
  if (!EMAIL_TRIGGERS.includes(req.body.trigger)) return returnFunction(res, 400, false, `trigger must be one of: ${EMAIL_TRIGGERS.join(', ')}`);
  const doc = {
    id: newId(),
    name: req.body.name.trim(),
    trigger: req.body.trigger,
    subject: req.body.subject,
    body: req.body.body,
    createdBy: req.user.id,
    createdAt: new Date(),
  };
  const result = await insertOne('email_templates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listEmailTemplates = async (req, res) => {
  let query = knex('email_templates');
  if (req.query.trigger) query = query.where({ trigger: req.query.trigger });
  const templates = await query;
  return returnFunction(res, 200, true, req.locale.success, templates);
};

const updateEmailTemplate = async (req, res) => {
  const allowed = ['name', 'trigger', 'subject', 'body'];
  const update = { updatedAt: new Date() };
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
  if (update.trigger && !EMAIL_TRIGGERS.includes(update.trigger)) {
    return returnFunction(res, 400, false, `trigger must be one of: ${EMAIL_TRIGGERS.join(', ')}`);
  }
  const [updated] = await knex('email_templates').where({ id: req.params.id }).update(update).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteEmailTemplate = async (req, res) => {
  const deleted = await knex('email_templates').where({ id: req.params.id }).del();
  if (!deleted) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

module.exports = {
  createRequisition, listRequisitions, getRequisition, updateRequisition,
  submitRequisition, approveRequisition, deleteRequisition,
  REQUISITION_STATUSES,
  listApplicationsForRequisition, moveApplicationStage, updateApplicationStatus,
  bulkApplicationAction,
  extendOffer, respondToOffer, respondToOfferCore,
  assignInterviewer, unassignInterviewer, sendInterviewReminder,
  submitScorecard, listScorecardsForApplication, getScorecard, getMyInterviews,
  createCandidate, listCandidates, getCandidate, updateCandidate, convertCandidate,
  createNurtureCampaign, listNurtureCampaigns, addNurtureTouchpoint, listNurtureCandidates,
  getRecruitmentOverview, getRequisitionFunnel, getTimeToFill, getTimeInStage,
  getSourceEffectiveness, getOfferAcceptanceRate,
  createInterviewKit, listInterviewKits, updateInterviewKit, deleteInterviewKit,
  createEmailTemplate, listEmailTemplates, updateEmailTemplate, deleteEmailTemplate,
};
