const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, aggregate } = require('../../functions/Database/commonDBFunctions');
const { notifyEmployee, notifyByRoles, notifyUser } = require('../../functions/HR/notifyUser');
const { evaluateRulesForUser } = require('../../lib/training/autoEnrollment');
const { sendTemplatedEmail } = require('../../lib/recruitment/emailTemplateHelpers');

// ── Existing appraisal functions (keep) ───────────────────────────────────────

const getEmployeePerformance = async (req, res) => {
  const requested = new ObjectId(req.params.employeeId);
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.some((id) => String(id) === String(requested))) {
    return returnFunction(res, 403, false, "You are not authorized to view this employee's appraisals.");
  }
  const records = await findMany('appraisal_records',
    { employeeId: requested },
    { sort: { createdAt: -1 } }
  );
  return returnFunction(res, 200, true, req.locale.success, records);
};

const VALID_PERIODS = ['Q1', 'Q2', 'Q3', 'Q4'];

const createAppraisal = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'reviewPeriod', 'rating'])) return;
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.some((id) => String(id) === String(req.body.employeeId))) {
    return returnFunction(res, 403, false, "You are not authorized to create an appraisal for this employee.");
  }
  const rating = parseInt(req.body.rating);
  if (rating < 1 || rating > 5) return returnFunction(res, 400, false, 'Rating must be between 1 and 5.');

  const periodBase = req.body.reviewPeriod?.trim().toUpperCase().split(' ')[0];
  if (!VALID_PERIODS.includes(periodBase)) {
    return returnFunction(res, 400, false, 'Review period must be Q1, Q2, Q3, or Q4 (optionally with a year, e.g. "Q1 2025").');
  }

  // Normalize to a dedup key (quarter + year, defaulting to the current year when the
  // caller didn't specify one) so "Q1" and "Q1 2025" for the same actual quarter can't
  // both slip through as separate records.
  const yearMatch = req.body.reviewPeriod.match(/(\d{4})/);
  const periodKey = `${periodBase} ${yearMatch ? yearMatch[1] : new Date().getFullYear()}`;

  // Only one non-rejected appraisal per employee per quarter — a rejected one may be
  // redone, so it doesn't block a resubmission for the same period.
  const duplicate = await findOne('appraisal_records', {
    employeeId: new ObjectId(req.body.employeeId), periodKey, status: { $ne: 'rejected' },
  });
  if (duplicate) return returnFunction(res, 409, false, `An appraisal for ${periodKey} already exists for this employee.`);

  // HR authoring an appraisal directly is final immediately (no one above HR to review
  // it); a department_head's appraisal is submitted for HR review before it counts.
  const status = _isHR(req.user.role) ? 'approved' : 'submitted';

  const doc = {
    employeeId: new ObjectId(req.body.employeeId),
    reviewPeriod: req.body.reviewPeriod,
    periodKey,
    reviewerId: new ObjectId(req.user._id),
    goalsSet: req.body.goalsSet || [],
    goalsAchieved: req.body.goalsAchieved || [],
    rating,
    comments: req.body.comments || null,
    status,
    reviewedBy: null, reviewedAt: null, reviewComment: null,
    createdAt: new Date(),
  };
  const result = await insertOne('appraisal_records', doc);

  const employee = await findOne('employees', { _id: new ObjectId(req.body.employeeId) }, { projection: { fullName: 1 } });
  const empName = employee?.fullName ?? 'An employee';
  const ratingLabel = ['', 'Unsatisfactory', 'Needs Improvement', 'Meets Expectations', 'Exceeds Expectations', 'Outstanding'][doc.rating] ?? `${doc.rating}/5`;
  const employeeMessage = status === 'approved'
    ? `Your appraisal for ${doc.reviewPeriod} has been recorded — ${ratingLabel}.`
    : `Your appraisal for ${doc.reviewPeriod} has been submitted for HR review — ${ratingLabel}.`;

  notifyEmployee(req.body.employeeId, {
    title: 'New Appraisal Recorded',
    body: employeeMessage,
    type: 'general',
  }).catch(() => {});

  notifyByRoles(['hr_manager', 'super_admin'], {
    title: status === 'submitted' ? 'Appraisal Awaiting Review' : 'Appraisal Submitted',
    body: `${req.user.name ?? 'Dept Head'} submitted an appraisal for ${empName} (${doc.reviewPeriod}) — ${ratingLabel}.`,
    type: 'general',
  }).catch(() => {});

  const employeeUser = await findOne('users', { employeeId: new ObjectId(req.body.employeeId) }, { projection: { email: 1 } });
  if (employeeUser?.email) {
    sendTemplatedEmail({
      trigger: 'appraisalSubmitted',
      to: employeeUser.email,
      tokens: { employeeName: empName, period: doc.reviewPeriod, rating: ratingLabel },
      fallbackSubject: `Your Appraisal — ${doc.reviewPeriod}`,
      fallbackHtml: `<p>Dear ${empName},</p><p>${employeeMessage}</p>`,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// HR approves or rejects a department_head's submitted appraisal. A rejected appraisal
// can be resubmitted for the same period (the duplicate guard above excludes 'rejected'),
// an approved one is final.
const reviewAppraisal = async (req, res) => {
  if (!validateRequiredFields(req, res, ['decision'])) return;
  const { decision, comment } = req.body;
  if (!['approved', 'rejected'].includes(decision)) {
    return returnFunction(res, 400, false, 'Decision must be "approved" or "rejected".');
  }

  const existing = await findOne('appraisal_records', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  if (existing.status !== 'submitted') {
    return returnFunction(res, 400, false, 'Only appraisals awaiting review can be approved or rejected.');
  }

  await updateOne('appraisal_records', { _id: existing._id }, {
    $set: { status: decision, reviewedBy: new ObjectId(req.user._id), reviewedAt: new Date(), reviewComment: comment || null },
  });

  const employee = await findOne('employees', { _id: existing.employeeId }, { projection: { fullName: 1 } });
  const empName = employee?.fullName ?? 'the employee';

  notifyEmployee(existing.employeeId, {
    title: decision === 'approved' ? 'Appraisal Approved' : 'Appraisal Rejected',
    body: decision === 'approved'
      ? `Your appraisal for ${existing.reviewPeriod} has been approved by HR.`
      : `Your appraisal for ${existing.reviewPeriod} was rejected by HR and will need to be redone.${comment ? ` Reason: ${comment}` : ''}`,
    type: 'general',
  }).catch(() => {});

  // Let the department_head who submitted it know the outcome of their submission too.
  notifyUser(existing.reviewerId, {
    title: decision === 'approved' ? 'Appraisal Approved' : 'Appraisal Rejected',
    body: `Your submitted appraisal for ${empName} (${existing.reviewPeriod}) was ${decision} by HR.${comment ? ` Comment: ${comment}` : ''}`,
    type: 'general',
  }).catch(() => {});

  return returnFunction(res, 200, true, `Appraisal ${decision}.`);
};

const updateAppraisal = async (req, res) => {
  const existing = await findOne('appraisal_records', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.some((id) => String(id) === String(existing.employeeId))) {
    return returnFunction(res, 403, false, "You are not authorized to edit this employee's appraisal.");
  }
  // An approved appraisal is final — only HR may still correct it (administrative
  // correction, same exception this module already makes elsewhere for HR).
  if (existing.status === 'approved' && !_isHR(req.user.role)) {
    return returnFunction(res, 403, false, 'An approved appraisal can only be edited by HR.');
  }
  const update = { ...req.body };
  // Status transitions are only valid through reviewAppraisal (the HR approve/reject gate)
  // — otherwise a department_head could just PATCH their own submission straight to
  // 'approved' and bypass review entirely. employeeId/reviewerId are stripped too — the
  // scope check above validates against `existing.employeeId` BEFORE the update is
  // applied, so leaving either writable would let the body silently reassign this
  // appraisal to a different employee/reviewer outside the caller's own scope.
  delete update._id; delete update.status; delete update.reviewedBy; delete update.reviewedAt;
  delete update.reviewComment; delete update.periodKey; delete update.employeeId; delete update.reviewerId;
  if (update.rating) update.rating = parseInt(update.rating);
  await updateOne('appraisal_records', { _id: existing._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const getPerformanceAlerts = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);
  const matchStage = scopedIds !== null ? [{ $match: { employeeId: { $in: scopedIds } } }] : [];

  const flagged = await global.dbo.collection('appraisal_records').aggregate([
    ...matchStage,
    { $sort: { employeeId: 1, createdAt: -1 } },
    { $group: { _id: '$employeeId', ratings: { $push: '$rating' } } },
    { $addFields: { lastTwo: { $slice: ['$ratings', 2] } } },
    { $match: { $expr: { $and: [
      { $gte: [{ $size: '$lastTwo' }, 2] },
      { $lte: [{ $arrayElemAt: ['$lastTwo', 0] }, 2] },
      { $lte: [{ $arrayElemAt: ['$lastTwo', 1] }, 2] },
    ]}}},
  ]).toArray();

  const enriched = await Promise.all(flagged.map(async (f) => {
    const emp = await findOne('employees', { _id: f._id }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1 } });
    return { employee: emp, ratings: f.lastTwo };
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── Goals ─────────────────────────────────────────────────────────────────────

const GOAL_STATUSES = ['not_started', 'in_progress', 'at_risk', 'completed'];

const listGoals = async (req, res) => {
  const extra = {};
  if (req.query.status)   extra.status = req.query.status;
  if (req.query.period)   extra.period = req.query.period;
  if (req.query.category) extra.category = req.query.category;

  const scopedIds = await getScopedEmployeeIds(req.user);

  // HR/super_admin — unrestricted (same as before), still honors ?employeeId= narrowing.
  if (scopedIds === null) {
    const filter = { ...extra };
    if (req.query.employeeId) filter.employeeId = new ObjectId(req.query.employeeId);
    const goals = await findMany('goals', filter, { sort: { createdAt: -1 } });
    return returnFunction(res, 200, true, req.locale.success, goals);
  }
  if (!scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);

  // Previously department_head/manager scoping here was role-membership-only (via
  // _isHROrMgmt) with zero actual narrowing — any department_head saw every goal
  // company-wide. Now restricted to: goals belonging to someone in my scope (self, or
  // my direct reports, or my department), plus company-wide-visible goals from anyone,
  // plus team-visible goals within my own department (dept heads only — team visibility
  // for a plain-staff manager isn't worth the extra complexity here).
  const orClauses = [{ employeeId: { $in: scopedIds } }, { visibility: 'company' }];
  if (req.user.role === 'department_head' && req.user.department) {
    orClauses.push({ visibility: 'team', department: req.user.department });
  }

  if (req.query.employeeId) {
    const requested = new ObjectId(req.query.employeeId);
    const inScope = scopedIds.some((id) => String(id) === String(requested));
    const filter = inScope
      ? { employeeId: requested, ...extra }
      : { employeeId: requested, $or: orClauses.filter((c) => !c.employeeId), ...extra };
    const goals = await findMany('goals', filter, { sort: { createdAt: -1 } });
    return returnFunction(res, 200, true, req.locale.success, goals);
  }

  const goals = await findMany('goals', { $or: orClauses, ...extra }, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, goals);
};

const createGoal = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'category', 'period'])) return;

  const keyResults = (req.body.keyResults || []).map(kr => ({
    _id: new ObjectId(),
    description: kr.description,
    type: kr.type || 'number',
    startValue: Number(kr.startValue) || 0,
    targetValue: Number(kr.targetValue) || 0,
    currentValue: Number(kr.startValue) || 0,
    unit: kr.unit || '',
    isCompleted: false,
  }));

  let employeeId = null;
  if (req.body.employeeId) {
    employeeId = new ObjectId(req.body.employeeId);
  } else {
    const emp = await findOne('employees', { userId: new ObjectId(req.user._id) }, { projection: { _id: 1 } });
    if (emp) employeeId = emp._id;
  }

  // department was previously never stamped here despite listGoals filtering on it for
  // 'team' visibility — that visibility tier could never actually match anything.
  const targetEmp = employeeId ? await findOne('employees', { _id: employeeId }, { projection: { department: 1 } }) : null;

  const doc = {
    employeeId,
    department: targetEmp?.department || null,
    createdBy: new ObjectId(req.user._id),
    title: req.body.title,
    description: req.body.description || '',
    category: req.body.category,
    period: req.body.period,
    startDate: req.body.startDate ? new Date(req.body.startDate) : new Date(),
    endDate: req.body.endDate ? new Date(req.body.endDate) : null,
    status: 'not_started',
    progress: 0,
    visibility: req.body.visibility || 'private',
    parentGoalId: req.body.parentGoalId ? new ObjectId(req.body.parentGoalId) : null,
    keyResults,
    checkIns: [],
    comments: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('goals', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const _isHR = (role) => ['super_admin', 'hr_manager'].includes(role);

// Who may author/submit a review for a given employee + reviewType. A 'self' review can
// only ever be written by the employee it's about (HR excepted, for administrative
// corrections) — reviewType alone was previously enough to let any authenticated user
// self-assign as reviewerId for anyone's review, including their self-review. A 'manager'
// review requires being that employee's actual manager (via employees.managerId, since
// this app has no distinct manager role) or their department_head/HR.
const isAuthorizedForReview = async (req, employeeId, reviewType, cycleId) => {
  if (_isHR(req.user.role)) return true;
  if (reviewType === 'self') {
    return !!req.user.employeeId && String(req.user.employeeId) === String(employeeId);
  }
  if (reviewType === 'peer') {
    // Peer authorship isn't managerial — it's whoever HR explicitly nominated as a peer
    // reviewer for this employee in this specific cycle (cycle.participants.$.peersAssigned).
    if (!req.user.employeeId || !cycleId) return false;
    const cycle = await findOne('review_cycles', { _id: new ObjectId(cycleId) }, { projection: { participants: 1 } });
    const participant = cycle?.participants?.find((p) => String(p.employeeId) === String(employeeId));
    return !!participant?.peersAssigned?.some((pa) => String(pa.peerId) === String(req.user.employeeId));
  }
  const employee = await findOne('employees', { _id: new ObjectId(employeeId) }, { projection: { managerId: 1, department: 1 } });
  if (!employee) return false;
  if (req.user.role === 'department_head') return !!req.user.department && employee.department === req.user.department;
  return !!req.user.employeeId && String(employee.managerId || '') === String(req.user.employeeId);
};

// Same convention as the attendance/leave modules' getScopedEmployeeIds: null = no
// restriction (HR/super_admin see everyone), department_head sees their department, and a
// plain "manager" — any employee referenced as someone's managerId, regardless of role —
// sees their direct reports plus themselves. This module previously only did role-level
// access checks (allowRoles(MGMT)) with zero actual data narrowing for department_head,
// which is the bug being fixed by applying this helper everywhere below.
const getScopedEmployeeIds = async (user) => {
  if (_isHR(user.role)) return null;
  if (user.role === 'department_head') {
    if (!user.department) return [];
    const emps = await findMany('employees', { department: user.department }, { projection: { _id: 1 } });
    return emps.map((e) => e._id);
  }
  if (!user.employeeId) return [];
  const directReports = await findMany('employees', { managerId: new ObjectId(user.employeeId) }, { projection: { _id: 1 } });
  const ids = directReports.map((e) => e._id);
  ids.push(new ObjectId(user.employeeId));
  return ids;
};

// Real management authority over a goal — HR, the goal's own employee, their actual
// manager (via managerId), or their department_head. Replaces the previous
// _isHROrMgmt(role) check, which let ANY department_head manage ANY goal company-wide
// with no department narrowing at all.
const canManageGoal = async (req, goal) => {
  if (_isHR(req.user.role)) return true;
  if (goal.employeeId && String(goal.employeeId) === String(req.user.employeeId)) return true;
  if (!goal.employeeId) return false;
  const employee = await findOne('employees', { _id: goal.employeeId }, { projection: { managerId: 1, department: 1 } });
  if (!employee) return false;
  if (req.user.role === 'department_head') return !!req.user.department && employee.department === req.user.department;
  return !!req.user.employeeId && String(employee.managerId || '') === String(req.user.employeeId);
};

// Viewing (vs. managing) is a bit broader — also allow anyone who could legitimately see
// this goal via its own visibility setting (company-wide, or team-wide within the same
// department), matching the same widening applied in listGoals.
const canViewGoal = async (req, goal) => {
  if (await canManageGoal(req, goal)) return true;
  if (goal.visibility === 'company') return true;
  if (goal.visibility === 'team' && req.user.department && goal.department === req.user.department) return true;
  return false;
};

const getGoal = async (req, res) => {
  const goal = await findOne('goals', { _id: new ObjectId(req.params.id) });
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!(await canViewGoal(req, goal))) return returnFunction(res, 403, false, 'Forbidden.');
  return returnFunction(res, 200, true, req.locale.success, goal);
};

const updateGoal = async (req, res) => {
  const goal = await findOne('goals', { _id: new ObjectId(req.params.id) });
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!(await canManageGoal(req, goal))) return returnFunction(res, 403, false, 'Forbidden.');

  const update = { ...req.body };
  delete update._id;
  update.updatedAt = new Date();

  if (update.progress !== undefined) update.progress = Number(update.progress);
  if (update.status && !GOAL_STATUSES.includes(update.status)) {
    return returnFunction(res, 400, false, 'Invalid status.');
  }
  if (update.keyResults) {
    update.keyResults = update.keyResults.map(kr => ({
      ...kr,
      _id: kr._id ? new ObjectId(kr._id) : new ObjectId(),
      startValue: Number(kr.startValue) || 0,
      targetValue: Number(kr.targetValue) || 0,
      currentValue: Number(kr.currentValue) || 0,
    }));
  }

  await updateOne('goals', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteGoal = async (req, res) => {
  const goal = await findOne('goals', { _id: new ObjectId(req.params.id) });
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!(await canManageGoal(req, goal))) return returnFunction(res, 403, false, 'Forbidden.');
  await global.dbo.collection('goals').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const addCheckin = async (req, res) => {
  if (!validateRequiredFields(req, res, ['progress'])) return;

  const goal = await findOne('goals', { _id: new ObjectId(req.params.id) });
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!(await canViewGoal(req, goal))) return returnFunction(res, 403, false, 'Forbidden.');

  const checkin = {
    progress: Number(req.body.progress),
    note: req.body.note || '',
    updatedBy: new ObjectId(req.user._id),
    updatedAt: new Date(),
  };

  await global.dbo.collection('goals').updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $push: { checkIns: checkin },
      $set: { progress: checkin.progress, updatedAt: new Date() },
    }
  );
  return returnFunction(res, 200, true, 'Check-in added.', checkin);
};

const addGoalComment = async (req, res) => {
  if (!validateRequiredFields(req, res, ['text'])) return;

  const goal = await findOne('goals', { _id: new ObjectId(req.params.id) });
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!(await canViewGoal(req, goal))) return returnFunction(res, 403, false, 'Forbidden.');

  const comment = {
    _id: new ObjectId(),
    text: req.body.text.trim(),
    authorId: new ObjectId(req.user._id),
    authorName: req.user.name,
    createdAt: new Date(),
  };

  await global.dbo.collection('goals').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $push: { comments: comment } }
  );
  return returnFunction(res, 200, true, 'Comment added.', comment);
};

// ── Review Templates ────────────────────────────────────────────────────────────
// Named question sets attached to a cycle so self/manager reviews render actual
// structured questions instead of a blank free-text form. Sections/questions get a
// server-assigned id (crypto.randomUUID) so responses can reference them stably even
// if the template's wording is edited later.

const { randomUUID } = require('crypto');

const _normalizeTemplateSections = (sections) => (Array.isArray(sections) ? sections : []).map((s) => ({
  id: s.id || randomUUID(),
  title: s.title || 'Untitled Section',
  questions: (Array.isArray(s.questions) ? s.questions : []).map((q) => ({
    id: q.id || randomUUID(),
    text: q.text || '',
    type: q.type === 'text' ? 'text' : 'rating',
    scaleMax: q.type === 'rating' ? (Number(q.scaleMax) || 5) : null,
  })),
}));

const listTemplates = async (req, res) => {
  const filter = _isHR(req.user.role) && req.query.includeInactive === 'true' ? {} : { isActive: true };
  const templates = await findMany('review_templates', filter, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, templates);
};

const getTemplate = async (req, res) => {
  const template = await findOne('review_templates', { _id: new ObjectId(req.params.id) });
  if (!template) return returnFunction(res, 404, false, 'Template not found.');
  return returnFunction(res, 200, true, req.locale.success, template);
};

const createTemplate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const doc = {
    name: req.body.name,
    description: req.body.description || '',
    cycleTypes: Array.isArray(req.body.cycleTypes) ? req.body.cycleTypes : [],
    sections: _normalizeTemplateSections(req.body.sections),
    isActive: true,
    createdBy: new ObjectId(req.user._id),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('review_templates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateTemplate = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name;
  if (req.body.description !== undefined) update.description = req.body.description;
  if (req.body.cycleTypes !== undefined) update.cycleTypes = Array.isArray(req.body.cycleTypes) ? req.body.cycleTypes : [];
  if (req.body.sections !== undefined) update.sections = _normalizeTemplateSections(req.body.sections);
  if (req.body.isActive !== undefined) update.isActive = !!req.body.isActive;
  await updateOne('review_templates', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Templates may already be referenced by a cycle's templateId — deactivating (rather than
// hard-deleting) keeps those cycles' past reviews interpretable instead of leaving a dangling id.
const deleteTemplate = async (req, res) => {
  await updateOne('review_templates', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Template deactivated.');
};

// ── Review Cycles ─────────────────────────────────────────────────────────────

const listCycles = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const cycles = await findMany('review_cycles', filter, { sort: { createdAt: -1 } });

  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds === null) return returnFunction(res, 200, true, req.locale.success, cycles);

  const scopedSet = new Set(scopedIds.map((id) => String(id)));
  const narrowed = cycles.map((c) => {
    const participants = (c.participants || []).filter((p) => scopedSet.has(String(p.employeeId)));
    return { ...c, participants, total: participants.length, completed: participants.filter((p) => p.selfReviewStatus === 'submitted').length };
  });
  return returnFunction(res, 200, true, req.locale.success, narrowed);
};

const createCycle = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'type'])) return;

  // Audience defaults to every active employee (the original, only behavior) — 'departments'
  // and 'employees' let HR scope a cycle to e.g. one department's annual review instead of
  // forcing every launch to be company-wide.
  const audienceType = ['all', 'departments', 'employees'].includes(req.body.audienceType) ? req.body.audienceType : 'all';
  const doc = {
    name: req.body.name,
    type: req.body.type,
    templateId: req.body.templateId ? new ObjectId(req.body.templateId) : null,
    audience: {
      type: audienceType,
      departments: audienceType === 'departments' && Array.isArray(req.body.departments) ? req.body.departments : [],
      employeeIds: audienceType === 'employees' && Array.isArray(req.body.employeeIds) ? req.body.employeeIds.map((id) => new ObjectId(id)) : [],
    },
    status: 'draft',
    phases: {
      selfReview: {
        startDate: req.body.selfReviewStart ? new Date(req.body.selfReviewStart) : null,
        endDate: req.body.selfReviewEnd ? new Date(req.body.selfReviewEnd) : null,
        isEnabled: req.body.selfReviewEnabled !== false,
      },
      managerReview: {
        startDate: req.body.managerReviewStart ? new Date(req.body.managerReviewStart) : null,
        endDate: req.body.managerReviewEnd ? new Date(req.body.managerReviewEnd) : null,
        isEnabled: req.body.managerReviewEnabled !== false,
      },
      calibration: {
        date: req.body.calibrationDate ? new Date(req.body.calibrationDate) : null,
        isEnabled: req.body.calibrationEnabled === true,
      },
      resultsSharing: {
        date: req.body.resultsSharingDate ? new Date(req.body.resultsSharingDate) : null,
        isEnabled: req.body.resultsSharingEnabled !== false,
      },
    },
    participants: [],
    createdBy: new ObjectId(req.user._id),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('review_cycles', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const getCycle = async (req, res) => {
  const cycle = await findOne('review_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, 'Cycle not found.');

  const scopedIds = await getScopedEmployeeIds(req.user);
  let participants = cycle.participants;
  if (scopedIds !== null) {
    const scopedSet = new Set(scopedIds.map((id) => String(id)));
    participants = participants.filter((p) => scopedSet.has(String(p.employeeId)));
  }

  const total = participants.length;
  const completed = participants.filter(p => p.selfReviewStatus === 'submitted').length;

  return returnFunction(res, 200, true, req.locale.success, { ...cycle, participants, total, completed });
};

const updateCycle = async (req, res) => {
  const update = { ...req.body };
  delete update._id;
  if (update.templateId !== undefined) update.templateId = update.templateId ? new ObjectId(update.templateId) : null;
  if (update.audience?.employeeIds) update.audience.employeeIds = update.audience.employeeIds.map((id) => new ObjectId(id));
  update.updatedAt = new Date();
  await updateOne('review_cycles', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const launchCycle = async (req, res) => {
  const cycle = await findOne('review_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, 'Cycle not found.');
  if (cycle.status === 'active') return returnFunction(res, 400, false, 'Cycle is already active.');

  const audience = cycle.audience || { type: 'all' };
  const employeeFilter = { status: 'active' };
  if (audience.type === 'departments' && audience.departments?.length) {
    employeeFilter.department = { $in: audience.departments };
  } else if (audience.type === 'employees' && audience.employeeIds?.length) {
    employeeFilter._id = { $in: audience.employeeIds };
  }
  const employees = await findMany('employees', employeeFilter, { projection: { _id: 1, userId: 1 } });
  const participants = employees.map(emp => ({
    employeeId: emp._id,
    selfReviewStatus: 'pending',
    managerReviewStatus: 'pending',
    selfReviewSubmittedAt: null,
    managerReviewSubmittedAt: null,
    reviewerId: null,
    peersAssigned: [],
  }));

  await updateOne('review_cycles', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'active', participants, updatedAt: new Date() },
  });

  notifyByRoles(['hr_manager', 'super_admin', 'department_head', 'staff'], {
    title: `Review Cycle Launched: ${cycle.name}`,
    body: 'A new performance review cycle has started. Please complete your self-review.',
    type: 'general',
  });

  return returnFunction(res, 200, true, 'Review cycle launched successfully.');
};

// HR nominates which colleagues owe a peer review for a given participant. Overwriting the
// list preserves any already-in-progress/submitted entries (matched by peerId) rather than
// resetting their status, so re-saving the same set (or adding one more peer) doesn't wipe
// work someone already submitted.
const assignPeerReviewers = async (req, res) => {
  const cycleId = new ObjectId(req.params.id);
  const employeeId = new ObjectId(req.params.employeeId);
  const peerIds = Array.isArray(req.body.peerIds) ? req.body.peerIds : [];

  const cycle = await findOne('review_cycles', { _id: cycleId });
  if (!cycle) return returnFunction(res, 404, false, 'Cycle not found.');
  const participant = (cycle.participants || []).find((p) => String(p.employeeId) === String(employeeId));
  if (!participant) return returnFunction(res, 404, false, 'Employee is not a participant in this cycle.');

  const existingByPeer = new Map((participant.peersAssigned || []).map((pa) => [String(pa.peerId), pa]));
  const peersAssigned = peerIds.map((id) => existingByPeer.get(String(id)) || { peerId: new ObjectId(id), status: 'pending', submittedAt: null });

  await updateOne(
    'review_cycles',
    { _id: cycleId, 'participants.employeeId': employeeId },
    { $set: { 'participants.$.peersAssigned': peersAssigned, updatedAt: new Date() } },
  );

  return returnFunction(res, 200, true, 'Peer reviewers updated.');
};

const closeCycle = async (req, res) => {
  await updateOne('review_cycles', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'completed', updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Review cycle closed.');
};

// ── Reviews ───────────────────────────────────────────────────────────────────

const listReviews = async (req, res) => {
  const filter = {};
  if (req.query.cycleId) filter.cycleId = new ObjectId(req.query.cycleId);
  if (req.query.reviewerId) filter.reviewerId = new ObjectId(req.query.reviewerId);

  // A caller-supplied ?employeeId= previously got applied to the filter unconditionally,
  // regardless of role — any department_head/manager could pass any employeeId and read
  // their reviews. Now validated against real scope first, same pattern as attendance's
  // listAttendance fix earlier this session.
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);
  if (req.query.employeeId) {
    const requested = new ObjectId(req.query.employeeId);
    if (scopedIds !== null && !scopedIds.some((id) => String(id) === String(requested))) {
      return returnFunction(res, 403, false, "You are not authorized to view this employee's reviews.");
    }
    filter.employeeId = requested;
  } else if (scopedIds !== null) {
    filter.employeeId = { $in: scopedIds };
  }

  const reviews = await findMany('reviews', filter, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, reviews);
};

const getReview = async (req, res) => {
  const review = await findOne('reviews', { _id: new ObjectId(req.params.id) });
  if (!review) return returnFunction(res, 404, false, 'Review not found.');

  const isOwnerOrReviewer = String(review.reviewerId) === String(req.user._id) || String(review.employeeId) === String(req.user.employeeId);
  if (!isOwnerOrReviewer && !(await isAuthorizedForReview(req, review.employeeId, review.reviewType, review.cycleId))) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  const [employee, reviewer, cycle] = await Promise.all([
    findOne('employees', { _id: review.employeeId }, { projection: { fullName: 1, designation: 1, department: 1 } }),
    findOne('users', { _id: review.reviewerId }, { projection: { name: 1 } }),
    findOne('review_cycles', { _id: review.cycleId }, { projection: { name: 1, type: 1, phases: 1, templateId: 1 } }),
  ]);

  const template = cycle?.templateId ? await findOne('review_templates', { _id: cycle.templateId }) : null;
  // Only a manager (writing an evaluative review) benefits from attendance context — a
  // self-review doesn't need it, and showing it there would just be noise.
  const attendanceSummary = review.reviewType === 'manager' ? await getAttendanceSummaryForReview(review.employeeId) : null;

  return returnFunction(res, 200, true, req.locale.success, { ...review, employee, reviewer, cycle, template, attendanceSummary });
};

// Trailing-90-day attendance snapshot (present/late/absent counts + rate) for the employee
// being reviewed — gives a manager real, verifiable context (absences, lateness patterns)
// instead of writing a review from memory alone. Reads the same 'attendance_records'
// collection/status enum ('present'|'late'|'absent'|'half_day'|'remote') as the Attendance
// module itself.
const getAttendanceSummaryForReview = async (employeeId) => {
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const sinceStr = since.toISOString().slice(0, 10);

  const records = await global.dbo.collection('attendance_records')
    .find({ employeeId, date: { $gte: sinceStr } })
    .toArray();

  let present = 0, late = 0, absent = 0;
  for (const r of records) {
    if (r.status === 'present' || r.status === 'remote') present++;
    else if (r.status === 'late') late++;
    else if (r.status === 'absent') absent++;
  }
  const total = records.length;
  return {
    periodDays: 90,
    totalRecords: total,
    present,
    late,
    absent,
    attendanceRate: total > 0 ? Math.round(((present + late) / total) * 100) : null,
  };
};

// What review-writing work is on the current user's plate right now: their own
// self-review, plus a manager-review for each direct report/department employee they're
// authorized to review (via getScopedEmployeeIds — same scoping used everywhere else in
// this module), across every active/calibration cycle. Drives the "My Reviews" list so a
// reviewer doesn't have to know cycle/employee ids to find what they owe.
const getMyReviewTasks = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  const myEmployeeId = req.user.employeeId ? String(req.user.employeeId) : null;
  const cycles = await findMany('review_cycles', { status: { $in: ['active', 'calibration'] } }, { sort: { createdAt: -1 } });
  if (!cycles.length) return returnFunction(res, 200, true, req.locale.success, []);

  const scopedSet = scopedIds !== null ? new Set(scopedIds.map((id) => String(id))) : null;
  const employeeIdsNeeded = new Set();
  const rawTasks = [];

  for (const cycle of cycles) {
    for (const p of (cycle.participants || [])) {
      const pid = String(p.employeeId);
      if (myEmployeeId && pid === myEmployeeId && cycle.phases?.selfReview?.isEnabled !== false) {
        rawTasks.push({ cycle, employeeId: p.employeeId, reviewType: 'self', status: p.selfReviewStatus });
        employeeIdsNeeded.add(pid);
      }
      const isManagerCandidate = pid !== myEmployeeId && cycle.phases?.managerReview?.isEnabled !== false
        && scopedSet !== null && scopedSet.has(pid);
      if (isManagerCandidate) {
        rawTasks.push({ cycle, employeeId: p.employeeId, reviewType: 'manager', status: p.managerReviewStatus });
        employeeIdsNeeded.add(pid);
      }
      // Peer review isn't scoped by managerId/department at all — it's whoever HR explicitly
      // nominated in this participant's peersAssigned list, tracked per-peer (not a single
      // cycle-wide status field, since several colleagues can each owe their own review).
      const myPeerEntry = myEmployeeId && pid !== myEmployeeId
        ? (p.peersAssigned || []).find((pa) => String(pa.peerId) === myEmployeeId)
        : null;
      if (myPeerEntry) {
        rawTasks.push({ cycle, employeeId: p.employeeId, reviewType: 'peer', status: myPeerEntry.status });
        employeeIdsNeeded.add(pid);
      }
    }
  }

  if (!rawTasks.length) return returnFunction(res, 200, true, req.locale.success, []);

  const idList = [...employeeIdsNeeded].map((id) => new ObjectId(id));
  const [employees, existingReviews] = await Promise.all([
    findMany('employees', { _id: { $in: idList } }, { projection: { fullName: 1, designation: 1, department: 1 } }),
    // Scoped to reviews authored by the current user — peer reviews can have several
    // draft/submitted docs for the same cycle+employee+type (one per peer reviewer), so
    // without this filter the lookup below could resolve to a different peer's review.
    findMany('reviews', { cycleId: { $in: cycles.map((c) => c._id) }, employeeId: { $in: idList }, reviewerId: new ObjectId(req.user._id) }),
  ]);
  const empMap = new Map(employees.map((e) => [String(e._id), e]));
  const reviewMap = new Map(existingReviews.map((r) => [`${r.cycleId}_${r.employeeId}_${r.reviewType}`, r]));

  const tasks = rawTasks.map((t) => {
    const existing = reviewMap.get(`${t.cycle._id}_${t.employeeId}_${t.reviewType}`);
    return {
      cycleId: t.cycle._id,
      cycleName: t.cycle.name,
      templateId: t.cycle.templateId || null,
      employeeId: t.employeeId,
      employee: empMap.get(String(t.employeeId)) || null,
      reviewType: t.reviewType,
      status: t.status,
      reviewId: existing?._id || null,
    };
  });

  return returnFunction(res, 200, true, req.locale.success, tasks);
};

const upsertReview = async (req, res) => {
  const { cycleId, employeeId, reviewType } = req.body;
  if (!validateRequiredFields(req, res, ['cycleId', 'employeeId', 'reviewType'])) return;
  if (!(await isAuthorizedForReview(req, employeeId, reviewType, cycleId))) {
    return returnFunction(res, 403, false, reviewType === 'self'
      ? 'You can only write your own self-review.'
      : reviewType === 'peer'
        ? 'You are not a nominated peer reviewer for this employee.'
        : 'You can only write a manager review for your own direct reports.');
  }

  const filter = {
    cycleId: new ObjectId(cycleId),
    employeeId: new ObjectId(employeeId),
    reviewType,
    // Peer reviews are many-to-one (several colleagues each write their own about the same
    // employee), so reviewerId must be part of the identity key — self/manager stay 1:1 per
    // cycle+employee, where reviewerId is implied by isAuthorizedForReview and never varies.
    ...(reviewType === 'peer' ? { reviewerId: new ObjectId(req.user._id) } : {}),
  };

  const existing = await findOne('reviews', filter);
  // An existing review's reviewer is fixed at creation — editing someone else's draft
  // (even a legitimately-created one) isn't the same operation as authoring a new one.
  if (existing && !_isHR(req.user.role) && String(existing.reviewerId) !== String(req.user._id)) {
    return returnFunction(res, 403, false, 'Only the assigned reviewer can edit this review.');
  }

  const data = {
    responses: req.body.responses || [],
    overallRating: req.body.overallRating ? Number(req.body.overallRating) : null,
    updatedAt: new Date(),
  };

  if (existing) {
    await updateOne('reviews', { _id: existing._id }, { $set: data });
    return returnFunction(res, 200, true, 'Review saved.', { _id: existing._id });
  }

  const doc = {
    ...filter,
    reviewerId: new ObjectId(req.user._id),
    status: 'draft',
    ...data,
    recommendation: null,
    calibrationBox: null,
    calibrationNotes: null,
    submittedAt: null,
    createdAt: new Date(),
  };
  const result = await insertOne('reviews', doc);
  return returnFunction(res, 201, true, 'Review created.', { _id: result.insertedId });
};

const submitReview = async (req, res) => {
  const review = await findOne('reviews', { _id: new ObjectId(req.params.id) });
  if (!review) return returnFunction(res, 404, false, 'Review not found.');
  if (review.status === 'submitted') return returnFunction(res, 400, false, 'Review already submitted.');
  // HR can submit on a reviewer's behalf for administrative corrections; a department_head
  // has no business submitting a review they didn't author just by virtue of the role —
  // that bypass previously let any department_head submit any employee's review company-wide.
  if (!_isHR(req.user.role) && String(review.reviewerId) !== String(req.user._id)) {
    return returnFunction(res, 403, false, 'Only the assigned reviewer can submit this review.');
  }

  const recommendation = req.body.recommendation || null;
  await updateOne('reviews', { _id: new ObjectId(req.params.id) }, {
    $set: {
      status: 'submitted',
      recommendation,
      overallRating: req.body.overallRating ? Number(req.body.overallRating) : review.overallRating,
      submittedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  // A manager review's promote/PIP recommendation used to just sit on the review doc,
  // inert — nothing ever read it. Now it stamps a visible flag on the employee record (for
  // the profile page to surface) and tells HR directly, so the recommendation actually
  // reaches someone who can act on it instead of being buried in a submitted review.
  if (['promote', 'pip'].includes(recommendation)) {
    const flaggedEmployee = await findOne('employees', { _id: review.employeeId }, { projection: { fullName: 1 } });
    await global.dbo.collection('employees').updateOne(
      { _id: review.employeeId },
      { $set: { pendingPerformanceFlag: { type: recommendation, reviewId: review._id, cycleId: review.cycleId, flaggedBy: new ObjectId(req.user._id), flaggedAt: new Date() } } },
    );
    notifyByRoles(['hr_manager', 'super_admin'], {
      title: recommendation === 'promote' ? 'Promotion Recommended' : 'PIP Recommended',
      body: `${req.user.name || 'A manager'} recommended ${recommendation === 'promote' ? 'a promotion' : 'a performance improvement plan'} for ${flaggedEmployee?.fullName || 'an employee'}.`,
      type: 'general',
      link: `/employees/${review.employeeId}`,
    }).catch(() => {});
  }

  // Previously this always flipped selfReviewStatus regardless of reviewType, so a
  // manager review submission never actually marked managerReviewStatus as done —
  // cycle progress tracking was silently wrong for every manager review ever submitted.
  const now = new Date();
  if (review.reviewType === 'self') {
    await global.dbo.collection('review_cycles').updateOne(
      { _id: review.cycleId, 'participants.employeeId': review.employeeId },
      { $set: { 'participants.$.selfReviewStatus': 'submitted', 'participants.$.selfReviewSubmittedAt': now } }
    );
  } else if (review.reviewType === 'manager') {
    await global.dbo.collection('review_cycles').updateOne(
      { _id: review.cycleId, 'participants.employeeId': review.employeeId },
      { $set: { 'participants.$.managerReviewStatus': 'submitted', 'participants.$.managerReviewSubmittedAt': now } }
    );
  } else if (review.reviewType === 'peer') {
    // Peer reviews are tracked per-reviewer inside participants.$.peersAssigned (several
    // colleagues each have their own entry for the same employee), so this targets the one
    // matching this specific reviewer via arrayFilters rather than a single status field.
    // peersAssigned.peerId is an *employee* id (assigned by HR from the employee list), but
    // review.reviewerId is the reviewer's *user* id — they only coincide by accident, so the
    // reviewer's employeeId must be resolved before it can be matched against peerId.
    const reviewerUser = await findOne('users', { _id: review.reviewerId }, { projection: { employeeId: 1 } });
    if (reviewerUser?.employeeId) {
      await global.dbo.collection('review_cycles').updateOne(
        { _id: review.cycleId, 'participants.employeeId': review.employeeId },
        { $set: { 'participants.$[p].peersAssigned.$[peer].status': 'submitted', 'participants.$[p].peersAssigned.$[peer].submittedAt': now } },
        { arrayFilters: [{ 'p.employeeId': review.employeeId }, { 'peer.peerId': reviewerUser.employeeId }] }
      );
    }
  }

  // Fire the training module's 'onPerformanceScore' auto-enrollment rules the moment a
  // manager review lands with a rating — previously this trigger existed in the rule engine
  // but was never invoked from anywhere in the performance module (and separately queried a
  // collection name that never existed), so a low-scoring review never actually enrolled
  // anyone in remedial training. Best-effort/fire-and-forget, same convention as onHire/
  // onRoleChange in accountFunctions.js.
  const finalRating = req.body.overallRating ? Number(req.body.overallRating) : review.overallRating;
  if (review.reviewType === 'manager' && finalRating != null) {
    findOne('users', { employeeId: review.employeeId })
      .then((targetUser) => {
        if (targetUser) return evaluateRulesForUser('onPerformanceScore', targetUser, { performanceScore: finalRating });
      })
      .catch(() => {});
  }

  return returnFunction(res, 200, true, 'Review submitted successfully.');
};

// ── Calibration ───────────────────────────────────────────────────────────────

const getCalibration = async (req, res) => {
  const cycleId = new ObjectId(req.params.cycleId);
  const reviews = await findMany('reviews', { cycleId, reviewType: 'manager', status: 'submitted' });

  const enriched = await Promise.all(reviews.map(async (r) => {
    const emp = await findOne('employees', { _id: r.employeeId }, {
      projection: { fullName: 1, designation: 1, department: 1 },
    });
    return {
      employeeId: r.employeeId,
      employee: emp,
      overallRating: r.overallRating,
      calibrationBox: r.calibrationBox || 'med_med',
      calibrationNotes: r.calibrationNotes || '',
      recommendation: r.recommendation,
    };
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const updateCalibrationBox = async (req, res) => {
  const cycleId = new ObjectId(req.params.cycleId);
  const employeeId = new ObjectId(req.params.empId);

  await updateOne('reviews',
    { cycleId, employeeId, reviewType: 'manager' },
    { $set: { calibrationBox: req.body.box, calibrationNotes: req.body.notes || '', updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Calibration updated.');
};

// ── Feedback ──────────────────────────────────────────────────────────────────

// Anonymity/visibility are enforced here, at read time — storing the flags alone did
// nothing (any recipient could still see the real giver's name, and isVisibleToEmployee
// wasn't checked anywhere before this fix).
const enrichFeedback = async (feedback, { userId, empId, isHR }) => {
  return Promise.all(feedback.map(async (f) => {
    const giver = await findOne('employees', { _id: f.giverId }, { projection: { fullName: 1 } })
      || await findOne('users', { _id: f.giverId }, { projection: { name: 1 } });
    const recipient = await findOne('employees', { _id: f.recipientId }, { projection: { fullName: 1 } })
      || await findOne('users', { _id: f.recipientId }, { projection: { name: 1 } });
    const isSelfGiver = String(f.giverId) === String(userId) || (empId && String(f.giverId) === String(empId));
    // HR always sees the real identity (oversight/abuse prevention) even for anonymous
    // feedback; a recipient or third party never does.
    const revealGiver = !f.isAnonymous || isSelfGiver || isHR;
    return {
      ...f,
      giverName: revealGiver ? (giver?.fullName || giver?.name || 'Unknown') : 'Anonymous',
      recipientName: recipient?.fullName || recipient?.name || 'Unknown',
    };
  }));
};

const listFeedback = async (req, res) => {
  const userId = new ObjectId(req.user._id);
  const emp = await findOne('employees', { userId }, { projection: { _id: 1 } });
  const empId = emp?._id;

  // Viewing a THIRD PARTY's feedback (e.g. from their profile page) is a distinct case from
  // "my feedback" — only HR or that employee's actual manager/department_head may do it, and
  // it's always scoped to what they received (never their private "given" history).
  if (req.query.employeeId) {
    const targetId = new ObjectId(req.query.employeeId);
    if (!(await isAuthorizedForReview(req, targetId, 'manager'))) {
      return returnFunction(res, 403, false, "You are not authorized to view this employee's feedback.");
    }
    let feedback = await findMany('feedback', { recipientId: targetId }, { sort: { createdAt: -1 } });
    if (!_isHR(req.user.role)) feedback = feedback.filter((f) => f.isVisibleToEmployee !== false);
    const enriched = await enrichFeedback(feedback, { userId: targetId, empId: targetId, isHR: _isHR(req.user.role) });
    return returnFunction(res, 200, true, req.locale.success, enriched);
  }

  const filter = empId
    ? { $or: [{ giverId: userId }, { recipientId: userId }, { giverId: empId }, { recipientId: empId }] }
    : { $or: [{ giverId: userId }, { recipientId: userId }] };

  if (req.query.type === 'received') delete filter.$or, filter.recipientId = empId || userId;
  if (req.query.type === 'given')    delete filter.$or, filter.giverId    = empId || userId;

  let feedback = await findMany('feedback', filter, { sort: { createdAt: -1 } });

  // HR can hold feedback back from the employee it's about until reviewed — hide it from
  // a "received" view unless it's marked visible, but never hide it from the giver's own
  // "given" list or from HR.
  if (req.query.type === 'received' && !_isHR(req.user.role)) {
    feedback = feedback.filter((f) => f.isVisibleToEmployee !== false);
  }

  const enriched = await enrichFeedback(feedback, { userId, empId, isHR: _isHR(req.user.role) });
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// HR-only: every feedback record org-wide, real identities always shown, regardless of
// anonymity or visibility settings.
const listAllFeedback = async (req, res) => {
  const feedback = await findMany('feedback', {}, { sort: { createdAt: -1 } });
  const enriched = await enrichFeedback(feedback, { userId: null, empId: null, isHR: true });
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const updateFeedbackVisibility = async (req, res) => {
  if (req.body.isVisibleToEmployee === undefined) return returnFunction(res, 400, false, 'isVisibleToEmployee is required.');
  const result = await updateOne('feedback', { _id: new ObjectId(req.params.id) }, { $set: { isVisibleToEmployee: !!req.body.isVisibleToEmployee } });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const giveFeedback = async (req, res) => {
  if (!validateRequiredFields(req, res, ['recipientId', 'type', 'message'])) return;

  const doc = {
    giverId: new ObjectId(req.user._id),
    recipientId: new ObjectId(req.body.recipientId),
    type: req.body.type,
    category: req.body.category || 'general',
    message: req.body.message.trim(),
    visibility: req.body.visibility || 'private',
    isAnonymous: req.body.isAnonymous === true,
    isVisibleToEmployee: true,
    relatedCycleId: req.body.relatedCycleId ? new ObjectId(req.body.relatedCycleId) : null,
    createdAt: new Date(),
  };

  const result = await insertOne('feedback', doc);

  notifyEmployee(req.body.recipientId.toString(), {
    title: 'You received new feedback',
    body: doc.isAnonymous ? 'Someone left you anonymous feedback.' : `${req.user.name} gave you ${doc.type} feedback.`,
    type: 'general',
  });

  return returnFunction(res, 201, true, 'Feedback sent.', { _id: result.insertedId });
};

// ── 1-on-1 Check-ins ────────────────────────────────────────────────────────────
// Named 'oneOnOnes' (not 'checkIns') to avoid colliding with goals' existing embedded
// checkIns progress-log field — this is a distinct, standalone collection for recurring
// manager/direct-report meetings, unrelated to goal progress updates.

// Only the two people in the meeting (or HR) may see it — including a real manager
// relationship check, not just role, so a department_head can't browse 1-on-1s for
// employees who aren't actually their reports.
const _isOneOnOneParticipant = async (req, oneOnOne) => {
  if (_isHR(req.user.role)) return true;
  const myEmployeeId = req.user.employeeId ? String(req.user.employeeId) : null;
  if (!myEmployeeId) return false;
  return String(oneOnOne.managerId) === myEmployeeId || String(oneOnOne.employeeId) === myEmployeeId;
};

const listOneOnOnes = async (req, res) => {
  const myEmployeeId = req.user.employeeId ? String(req.user.employeeId) : null;
  let filter = {};
  if (!_isHR(req.user.role)) {
    if (!myEmployeeId) return returnFunction(res, 200, true, req.locale.success, []);
    filter = { $or: [{ managerId: new ObjectId(myEmployeeId) }, { employeeId: new ObjectId(myEmployeeId) }] };
  } else if (req.query.employeeId) {
    filter = { $or: [{ managerId: new ObjectId(req.query.employeeId) }, { employeeId: new ObjectId(req.query.employeeId) }] };
  }
  const oneOnOnes = await findMany('oneOnOnes', filter, { sort: { scheduledAt: -1 } });

  const empIds = [...new Set(oneOnOnes.flatMap((o) => [String(o.managerId), String(o.employeeId)]))].map((id) => new ObjectId(id));
  const employees = await findMany('employees', { _id: { $in: empIds } }, { projection: { fullName: 1, designation: 1 } });
  const empMap = new Map(employees.map((e) => [String(e._id), e]));

  const enriched = oneOnOnes.map((o) => ({
    ...o,
    manager: empMap.get(String(o.managerId)) || null,
    employee: empMap.get(String(o.employeeId)) || null,
    // A manager's private notes never leave the manager's own view of the meeting.
    privateManagerNotes: String(o.managerId) === myEmployeeId || _isHR(req.user.role) ? o.privateManagerNotes : undefined,
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createOneOnOne = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'scheduledAt'])) return;
  const employeeId = new ObjectId(req.body.employeeId);

  // The requester must actually be this employee's manager (or HR) — otherwise anyone could
  // schedule a "1-on-1" with someone they have no management relationship to.
  if (!_isHR(req.user.role)) {
    const employee = await findOne('employees', { _id: employeeId }, { projection: { managerId: 1 } });
    if (!employee || !req.user.employeeId || String(employee.managerId || '') !== String(req.user.employeeId)) {
      return returnFunction(res, 403, false, 'You can only schedule 1-on-1s with your own direct reports.');
    }
  }
  const managerId = req.body.managerId ? new ObjectId(req.body.managerId) : new ObjectId(req.user.employeeId);

  const doc = {
    managerId,
    employeeId,
    scheduledAt: new Date(req.body.scheduledAt),
    status: 'scheduled',
    agendaItems: [],
    sharedNotes: '',
    privateManagerNotes: '',
    createdBy: new ObjectId(req.user._id),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('oneOnOnes', doc);

  notifyEmployee(String(employeeId), {
    title: '1-on-1 Scheduled',
    body: `A 1-on-1 meeting has been scheduled for ${doc.scheduledAt.toLocaleDateString()}.`,
    type: 'general',
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const getOneOnOne = async (req, res) => {
  const oneOnOne = await findOne('oneOnOnes', { _id: new ObjectId(req.params.id) });
  if (!oneOnOne) return returnFunction(res, 404, false, 'One-on-one not found.');
  if (!(await _isOneOnOneParticipant(req, oneOnOne))) return returnFunction(res, 403, false, 'Forbidden.');

  const myEmployeeId = req.user.employeeId ? String(req.user.employeeId) : null;
  const [manager, employee] = await Promise.all([
    findOne('employees', { _id: oneOnOne.managerId }, { projection: { fullName: 1, designation: 1 } }),
    findOne('employees', { _id: oneOnOne.employeeId }, { projection: { fullName: 1, designation: 1 } }),
  ]);

  const isManagerOrHR = String(oneOnOne.managerId) === myEmployeeId || _isHR(req.user.role);
  return returnFunction(res, 200, true, req.locale.success, {
    ...oneOnOne,
    manager,
    employee,
    privateManagerNotes: isManagerOrHR ? oneOnOne.privateManagerNotes : undefined,
  });
};

const updateOneOnOne = async (req, res) => {
  const oneOnOne = await findOne('oneOnOnes', { _id: new ObjectId(req.params.id) });
  if (!oneOnOne) return returnFunction(res, 404, false, 'One-on-one not found.');
  if (!(await _isOneOnOneParticipant(req, oneOnOne))) return returnFunction(res, 403, false, 'Forbidden.');

  const myEmployeeId = req.user.employeeId ? String(req.user.employeeId) : null;
  const isManagerOrHR = String(oneOnOne.managerId) === myEmployeeId || _isHR(req.user.role);

  const update = { updatedAt: new Date() };
  if (req.body.scheduledAt !== undefined) update.scheduledAt = new Date(req.body.scheduledAt);
  if (req.body.status !== undefined) update.status = req.body.status;
  if (req.body.sharedNotes !== undefined) update.sharedNotes = req.body.sharedNotes;
  // Private notes are a manager-only field — an employee's update request simply can't touch it,
  // regardless of what's in the request body.
  if (req.body.privateManagerNotes !== undefined && isManagerOrHR) update.privateManagerNotes = req.body.privateManagerNotes;

  await updateOne('oneOnOnes', { _id: oneOnOne._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const addOneOnOneAgendaItem = async (req, res) => {
  const oneOnOne = await findOne('oneOnOnes', { _id: new ObjectId(req.params.id) });
  if (!oneOnOne) return returnFunction(res, 404, false, 'One-on-one not found.');
  if (!(await _isOneOnOneParticipant(req, oneOnOne))) return returnFunction(res, 403, false, 'Forbidden.');
  if (!req.body.text?.trim()) return returnFunction(res, 400, false, 'Agenda item text is required.');

  const item = { id: randomUUID(), text: req.body.text.trim(), addedBy: new ObjectId(req.user._id), isDone: false, createdAt: new Date() };
  await updateOne('oneOnOnes', { _id: oneOnOne._id }, { $push: { agendaItems: item }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, item);
};

const toggleOneOnOneAgendaItem = async (req, res) => {
  const oneOnOne = await findOne('oneOnOnes', { _id: new ObjectId(req.params.id) });
  if (!oneOnOne) return returnFunction(res, 404, false, 'One-on-one not found.');
  if (!(await _isOneOnOneParticipant(req, oneOnOne))) return returnFunction(res, 403, false, 'Forbidden.');

  const item = (oneOnOne.agendaItems || []).find((a) => a.id === req.params.itemId);
  if (!item) return returnFunction(res, 404, false, 'Agenda item not found.');

  await updateOne(
    'oneOnOnes',
    { _id: oneOnOne._id, 'agendaItems.id': req.params.itemId },
    { $set: { 'agendaItems.$.isDone': !item.isDone, updatedAt: new Date() } },
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const completeOneOnOne = async (req, res) => {
  const oneOnOne = await findOne('oneOnOnes', { _id: new ObjectId(req.params.id) });
  if (!oneOnOne) return returnFunction(res, 404, false, 'One-on-one not found.');
  if (!(await _isOneOnOneParticipant(req, oneOnOne))) return returnFunction(res, 403, false, 'Forbidden.');

  await updateOne('oneOnOnes', { _id: oneOnOne._id }, { $set: { status: 'completed', completedAt: new Date(), updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'One-on-one marked complete.');
};

// ── Performance Improvement Plans ────────────────────────────────────────────

// Same three-way access as reviews/goals: HR always, the employee themself (a PIP is only
// meaningful if the employee can see it), their actual manager (via managerId), or their
// department_head.
const _canAccessPIP = async (req, pip) => {
  if (_isHR(req.user.role)) return true;
  if (req.user.employeeId && String(req.user.employeeId) === String(pip.employeeId)) return true;
  if (req.user.employeeId && String(req.user.employeeId) === String(pip.managerId)) return true;
  if (req.user.role === 'department_head' && req.user.department) {
    const employee = await findOne('employees', { _id: pip.employeeId }, { projection: { department: 1 } });
    return !!employee && employee.department === req.user.department;
  }
  return false;
};

const listPIPs = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  let filter = {};
  if (scopedIds !== null) {
    if (!scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);
    filter = { employeeId: { $in: scopedIds } };
  } else if (req.query.employeeId) {
    filter = { employeeId: new ObjectId(req.query.employeeId) };
  }
  const pips = await findMany('performanceImprovementPlans', filter, { sort: { createdAt: -1 } });

  const empIds = [...new Set(pips.map((p) => String(p.employeeId)))].map((id) => new ObjectId(id));
  const employees = await findMany('employees', { _id: { $in: empIds } }, { projection: { fullName: 1, designation: 1, department: 1 } });
  const empMap = new Map(employees.map((e) => [String(e._id), e]));
  const enriched = pips.map((p) => ({ ...p, employee: empMap.get(String(p.employeeId)) || null }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createPIP = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'reason', 'startDate', 'endDate'])) return;
  const employeeId = new ObjectId(req.body.employeeId);

  // A PIP is a serious, targeted intervention — only started by HR or the employee's actual
  // manager/department_head, never by an unrelated manager just because they hold the role.
  if (!_isHR(req.user.role)) {
    const employee = await findOne('employees', { _id: employeeId }, { projection: { managerId: 1, department: 1 } });
    if (!employee) return returnFunction(res, 404, false, 'Employee not found.');
    const isManager = !!req.user.employeeId && String(employee.managerId || '') === String(req.user.employeeId);
    const isDeptHead = req.user.role === 'department_head' && !!req.user.department && employee.department === req.user.department;
    if (!isManager && !isDeptHead) return returnFunction(res, 403, false, 'You can only start a PIP for your own direct reports.');
  }

  const goals = (Array.isArray(req.body.goals) ? req.body.goals : []).map((g) => ({
    id: randomUUID(),
    description: g.description || '',
    targetDate: g.targetDate ? new Date(g.targetDate) : null,
    status: 'pending',
  }));

  const doc = {
    employeeId,
    managerId: req.body.managerId ? new ObjectId(req.body.managerId) : (req.user.employeeId ? new ObjectId(req.user.employeeId) : null),
    createdBy: new ObjectId(req.user._id),
    reason: req.body.reason,
    startDate: new Date(req.body.startDate),
    endDate: new Date(req.body.endDate),
    status: 'active',
    goals,
    checkIns: [],
    outcome: null,
    relatedReviewId: req.body.relatedReviewId ? new ObjectId(req.body.relatedReviewId) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('performanceImprovementPlans', doc);

  // Starting the PIP IS acting on a prior 'pip' recommendation flag (if there was one) —
  // clear it so it doesn't keep showing as an outstanding recommendation on the profile.
  await global.dbo.collection('employees').updateOne(
    { _id: employeeId, 'pendingPerformanceFlag.type': 'pip' },
    { $unset: { pendingPerformanceFlag: '' } },
  );

  notifyEmployee(String(employeeId), {
    title: 'Performance Improvement Plan Started',
    body: 'A performance improvement plan has been created for you. Please speak with your manager.',
    type: 'general',
  });
  notifyByRoles(['hr_manager', 'super_admin'], {
    title: 'PIP Created',
    body: `${req.user.name || 'A manager'} started a performance improvement plan.`,
    type: 'general',
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const getPIP = async (req, res) => {
  const pip = await findOne('performanceImprovementPlans', { _id: new ObjectId(req.params.id) });
  if (!pip) return returnFunction(res, 404, false, 'PIP not found.');
  if (!(await _canAccessPIP(req, pip))) return returnFunction(res, 403, false, 'Forbidden.');

  const employee = await findOne('employees', { _id: pip.employeeId }, { projection: { fullName: 1, designation: 1, department: 1 } });
  return returnFunction(res, 200, true, req.locale.success, { ...pip, employee });
};

const updatePIP = async (req, res) => {
  const pip = await findOne('performanceImprovementPlans', { _id: new ObjectId(req.params.id) });
  if (!pip) return returnFunction(res, 404, false, 'PIP not found.');
  if (!(await _canAccessPIP(req, pip))) return returnFunction(res, 403, false, 'Forbidden.');
  // The employee can see their own plan, but only their manager/HR can actually edit its
  // terms — otherwise an employee could water down their own improvement goals.
  if (!_isHR(req.user.role) && req.user.employeeId && String(req.user.employeeId) === String(pip.employeeId)) {
    return returnFunction(res, 403, false, 'Only your manager or HR can edit this plan.');
  }

  const update = { updatedAt: new Date() };
  if (req.body.reason !== undefined) update.reason = req.body.reason;
  if (req.body.endDate !== undefined) update.endDate = new Date(req.body.endDate);
  if (req.body.goals !== undefined) {
    update.goals = req.body.goals.map((g) => ({
      id: g.id || randomUUID(),
      description: g.description || '',
      targetDate: g.targetDate ? new Date(g.targetDate) : null,
      status: ['pending', 'met', 'not_met'].includes(g.status) ? g.status : 'pending',
    }));
  }
  await updateOne('performanceImprovementPlans', { _id: pip._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const addPIPCheckIn = async (req, res) => {
  const pip = await findOne('performanceImprovementPlans', { _id: new ObjectId(req.params.id) });
  if (!pip) return returnFunction(res, 404, false, 'PIP not found.');
  if (!(await _canAccessPIP(req, pip))) return returnFunction(res, 403, false, 'Forbidden.');
  if (!req.body.note?.trim()) return returnFunction(res, 400, false, 'Check-in note is required.');

  const entry = { id: randomUUID(), note: req.body.note.trim(), addedBy: new ObjectId(req.user._id), createdAt: new Date() };
  await updateOne('performanceImprovementPlans', { _id: pip._id }, { $push: { checkIns: entry }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, entry);
};

const closePIP = async (req, res) => {
  const pip = await findOne('performanceImprovementPlans', { _id: new ObjectId(req.params.id) });
  if (!pip) return returnFunction(res, 404, false, 'PIP not found.');
  if (!(await _canAccessPIP(req, pip))) return returnFunction(res, 403, false, 'Forbidden.');
  if (!_isHR(req.user.role) && req.user.employeeId && String(req.user.employeeId) === String(pip.employeeId)) {
    return returnFunction(res, 403, false, 'Only your manager or HR can close this plan.');
  }
  const outcome = ['passed', 'failed'].includes(req.body.outcome) ? req.body.outcome : null;
  if (!outcome) return returnFunction(res, 400, false, 'Outcome must be "passed" or "failed".');

  await updateOne('performanceImprovementPlans', { _id: pip._id }, {
    $set: { status: 'completed', outcome, closedAt: new Date(), updatedAt: new Date() },
  });

  notifyEmployee(String(pip.employeeId), {
    title: 'Performance Improvement Plan Closed',
    body: `Your performance improvement plan has been closed. Outcome: ${outcome === 'passed' ? 'Passed' : 'Not Met'}.`,
    type: 'general',
  });
  notifyByRoles(['hr_manager', 'super_admin'], {
    title: 'PIP Closed',
    body: `A performance improvement plan was closed with outcome: ${outcome}.`,
    type: 'general',
  });

  return returnFunction(res, 200, true, 'PIP closed.');
};

// ── Employee profile snapshot ─────────────────────────────────────────────────
// Purpose-built for the employee-profile Performance tab: current cycle participation
// status + the most recent calibrated rating, in one call, instead of the frontend having
// to fetch full cycles/reviews lists and filter them down client-side.
const getEmployeePerformanceSnapshot = async (req, res) => {
  const employeeId = new ObjectId(req.params.employeeId);
  const isSelf = !!req.user.employeeId && String(req.user.employeeId) === String(employeeId);
  if (!isSelf && !(await isAuthorizedForReview(req, employeeId, 'manager'))) {
    return returnFunction(res, 403, false, "You are not authorized to view this employee's performance summary.");
  }

  const [activeCycles, lastManagerReview] = await Promise.all([
    findMany('review_cycles', { status: { $in: ['active', 'calibration'] }, 'participants.employeeId': employeeId }, { sort: { createdAt: -1 } }),
    findOne('reviews', { employeeId, reviewType: 'manager', status: 'submitted' }, { sort: { submittedAt: -1 } }),
  ]);

  const cycleSummaries = activeCycles.map((c) => {
    const p = (c.participants || []).find((pp) => String(pp.employeeId) === String(employeeId));
    return { cycleId: c._id, cycleName: c.name, selfReviewStatus: p?.selfReviewStatus || null, managerReviewStatus: p?.managerReviewStatus || null };
  });

  let lastRating = null;
  if (lastManagerReview) {
    const cycle = await findOne('review_cycles', { _id: lastManagerReview.cycleId }, { projection: { name: 1 } });
    lastRating = {
      overallRating: lastManagerReview.overallRating,
      calibrationBox: lastManagerReview.calibrationBox || null,
      cycleName: cycle?.name || null,
      submittedAt: lastManagerReview.submittedAt,
    };
  }

  return returnFunction(res, 200, true, req.locale.success, { activeCycles: cycleSummaries, lastRating });
};

// ── Analytics ─────────────────────────────────────────────────────────────────

const getAnalytics = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  const scoped = scopedIds !== null;
  if (scoped && !scopedIds.length) {
    return returnFunction(res, 200, true, req.locale.success, {
      goalsCompletionRate: 0, averagePerformanceScore: 0, reviewParticipationRate: 0,
      activeCycles: 0, goalsByStatus: [], ratingDistribution: [], departmentPerformance: [],
    });
  }
  const empFilter = scoped ? { employeeId: { $in: scopedIds } } : {};

  const [
    goalsTotal,
    goalsCompleted,
    goalsAtRisk,
    reviewsTotal,
    reviewsSubmitted,
    cycles,
    recentAppraisals,
  ] = await Promise.all([
    global.dbo.collection('goals').countDocuments({ ...empFilter }),
    global.dbo.collection('goals').countDocuments({ ...empFilter, status: 'completed' }),
    global.dbo.collection('goals').countDocuments({ ...empFilter, status: 'at_risk' }),
    global.dbo.collection('reviews').countDocuments({ ...empFilter }),
    global.dbo.collection('reviews').countDocuments({ ...empFilter, status: 'submitted' }),
    findMany('review_cycles', { status: 'active' }, { sort: { createdAt: -1 } }),
    global.dbo.collection('appraisal_records').aggregate([
      ...(scoped ? [{ $match: { employeeId: { $in: scopedIds } } }] : []),
      { $group: { _id: '$rating', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
  ]);

  const goalsByStatus = await aggregate('goals', [
    ...(scoped ? [{ $match: { employeeId: { $in: scopedIds } } }] : []),
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const appraisalByDept = await global.dbo.collection('appraisal_records').aggregate([
    ...(scoped ? [{ $match: { employeeId: { $in: scopedIds } } }] : []),
    { $lookup: { from: 'employees', localField: 'employeeId', foreignField: '_id', as: 'emp' } },
    { $unwind: '$emp' },
    { $group: { _id: '$emp.department', avgRating: { $avg: '$rating' }, count: { $sum: 1 } } },
    { $sort: { avgRating: -1 } },
    { $limit: 8 },
  ]).toArray();

  let activeCycles = cycles;
  if (scoped) {
    const scopedSet = new Set(scopedIds.map((id) => String(id)));
    activeCycles = cycles.filter((c) => (c.participants || []).some((p) => scopedSet.has(String(p.employeeId))));
  }

  const avgScore = recentAppraisals.reduce((s, r) => s + r._id * r.count, 0) /
    Math.max(1, recentAppraisals.reduce((s, r) => s + r.count, 0));

  return returnFunction(res, 200, true, req.locale.success, {
    goalsCompletionRate: goalsTotal ? Math.round((goalsCompleted / goalsTotal) * 100) : 0,
    averagePerformanceScore: avgScore ? Math.round(avgScore * 10) / 10 : 0,
    reviewParticipationRate: reviewsTotal ? Math.round((reviewsSubmitted / reviewsTotal) * 100) : 0,
    activeCycles: activeCycles.length,
    goalsByStatus,
    ratingDistribution: recentAppraisals,
    departmentPerformance: appraisalByDept,
  });
};

module.exports = {
  // Legacy appraisal
  getEmployeePerformance,
  createAppraisal,
  reviewAppraisal,
  updateAppraisal,
  getPerformanceAlerts,
  // Goals
  listGoals,
  createGoal,
  getGoal,
  updateGoal,
  deleteGoal,
  addCheckin,
  addGoalComment,
  // Review templates
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  // Review cycles
  listCycles,
  createCycle,
  getCycle,
  updateCycle,
  launchCycle,
  closeCycle,
  assignPeerReviewers,
  // Reviews
  listReviews,
  getReview,
  getMyReviewTasks,
  upsertReview,
  submitReview,
  // Calibration
  getCalibration,
  updateCalibrationBox,
  // Feedback
  listFeedback,
  giveFeedback,
  listAllFeedback,
  updateFeedbackVisibility,
  // 1-on-1 Check-ins
  listOneOnOnes,
  createOneOnOne,
  getOneOnOne,
  updateOneOnOne,
  addOneOnOneAgendaItem,
  toggleOneOnOneAgendaItem,
  completeOneOnOne,
  // Performance Improvement Plans
  listPIPs,
  createPIP,
  getPIP,
  updatePIP,
  addPIPCheckIn,
  closePIP,
  // Employee profile snapshot
  getEmployeePerformanceSnapshot,
  // Analytics
  getAnalytics,
};
