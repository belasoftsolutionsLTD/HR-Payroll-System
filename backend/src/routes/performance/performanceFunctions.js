const { randomUUID } = require('crypto');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 5) — appraisal_records, review_templates, review_cycles, reviews, goals (+
// check-ins/comments), feedback, one_on_ones (+ agenda items),
// performance_improvement_plans (+ check-ins), employees, users,
// attendance_records (Phase 3b) all now live in Postgres.
const pgDB = require('../../functions/Database/pgDBFunctions');
const { knex, newId, insertOne, updateOne } = pgDB;
const { evaluateRulesForUser } = require('../../lib/training/autoEnrollment');
const { notifyEmployee, notifyByRoles, notifyUser } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

const emailEmployeeByTrigger = async (employeeId, trigger, tokens, fallbackSubject, fallbackHtml) => {
  const user = await knex('users').where({ employeeId: String(employeeId) }).select('email').first();
  if (!user?.email) return;
  return sendTemplatedEmail({ trigger, to: user.email, tokens, fallbackSubject, fallbackHtml }).catch(() => {});
};
const emailUserByTrigger = async (userId, trigger, tokens, fallbackSubject, fallbackHtml) => {
  const user = await knex('users').where({ id: String(userId) }).select('email').first();
  if (!user?.email) return;
  return sendTemplatedEmail({ trigger, to: user.email, tokens, fallbackSubject, fallbackHtml }).catch(() => {});
};

// ── Existing appraisal functions (keep) ───────────────────────────────────────

const getEmployeePerformance = async (req, res) => {
  const requested = String(req.params.employeeId);
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.includes(requested)) {
    return returnFunction(res, 403, false, "You are not authorized to view this employee's appraisals.");
  }
  const records = await knex('appraisal_records').where({ employeeId: requested }).orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, records);
};

const VALID_PERIODS = ['Q1', 'Q2', 'Q3', 'Q4'];

const createAppraisal = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'reviewPeriod', 'rating'])) return;
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.includes(String(req.body.employeeId))) {
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
  const duplicate = await knex('appraisal_records').where({ employeeId: String(req.body.employeeId), periodKey }).whereNot({ status: 'rejected' }).first();
  if (duplicate) return returnFunction(res, 409, false, `An appraisal for ${periodKey} already exists for this employee.`);

  // HR authoring an appraisal directly is final immediately (no one above HR to review
  // it); a department_head's appraisal is submitted for HR review before it counts.
  const status = _isHR(req.user.role) ? 'approved' : 'submitted';

  const doc = {
    id: newId(),
    employeeId: String(req.body.employeeId),
    reviewPeriod: req.body.reviewPeriod,
    periodKey,
    reviewerId: req.user.id,
    goalsSet: req.body.goalsSet || [],
    goalsAchieved: req.body.goalsAchieved || [],
    rating,
    comments: req.body.comments || null,
    status,
    reviewedBy: null, reviewedAt: null, reviewComment: null,
    createdAt: new Date(),
  };
  const result = await insertOne('appraisal_records', doc);

  const employee = await knex('employees').where({ id: String(req.body.employeeId) }).select('fullName').first();
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

  const employeeUser = await knex('users').where({ employeeId: String(req.body.employeeId) }).select('email').first();
  if (employeeUser?.email) {
    sendTemplatedEmail({
      trigger: 'appraisalSubmitted',
      to: employeeUser.email,
      tokens: { employeeName: empName, period: doc.reviewPeriod, rating: ratingLabel },
      fallbackSubject: `Your Appraisal — ${doc.reviewPeriod}`,
      fallbackHtml: `<p>Dear ${empName},</p><p>${employeeMessage}</p>`,
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
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

  const existing = await knex('appraisal_records').where({ id: req.params.id }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  if (existing.status !== 'submitted') {
    return returnFunction(res, 400, false, 'Only appraisals awaiting review can be approved or rejected.');
  }

  await knex('appraisal_records').where({ id: existing.id }).update({
    status: decision, reviewedBy: req.user.id, reviewedAt: new Date(), reviewComment: comment || null,
  });

  const employee = await knex('employees').where({ id: existing.employeeId }).select('fullName').first();
  const empName = employee?.fullName ?? 'the employee';

  notifyEmployee(existing.employeeId, {
    title: decision === 'approved' ? 'Appraisal Approved' : 'Appraisal Rejected',
    body: decision === 'approved'
      ? `Your appraisal for ${existing.reviewPeriod} has been approved by HR.`
      : `Your appraisal for ${existing.reviewPeriod} was rejected by HR and will need to be redone.${comment ? ` Reason: ${comment}` : ''}`,
    type: 'general',
  }).catch(() => {});
  emailEmployeeByTrigger(existing.employeeId, 'appraisalDecision',
    { reviewPeriod: existing.reviewPeriod, decision, comment: comment || '' },
    decision === 'approved' ? 'Appraisal Approved' : 'Appraisal Rejected',
    decision === 'approved'
      ? `<p>Your appraisal for ${existing.reviewPeriod} has been approved by HR.</p>`
      : `<p>Your appraisal for ${existing.reviewPeriod} was rejected by HR and will need to be redone.${comment ? ` Reason: ${comment}` : ''}</p>`);

  // Let the department_head who submitted it know the outcome of their submission too.
  notifyUser(existing.reviewerId, {
    title: decision === 'approved' ? 'Appraisal Approved' : 'Appraisal Rejected',
    body: `Your submitted appraisal for ${empName} (${existing.reviewPeriod}) was ${decision} by HR.${comment ? ` Comment: ${comment}` : ''}`,
    type: 'general',
  }).catch(() => {});
  emailUserByTrigger(existing.reviewerId, 'appraisalDecisionReviewer',
    { empName, reviewPeriod: existing.reviewPeriod, decision, comment: comment || '' },
    decision === 'approved' ? 'Appraisal Approved' : 'Appraisal Rejected',
    `<p>Your submitted appraisal for ${empName} (${existing.reviewPeriod}) was ${decision} by HR.${comment ? ` Comment: ${comment}` : ''}</p>`);

  return returnFunction(res, 200, true, `Appraisal ${decision}.`);
};

const updateAppraisal = async (req, res) => {
  const existing = await knex('appraisal_records').where({ id: req.params.id }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.includes(existing.employeeId)) {
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
  await knex('appraisal_records').where({ id: existing.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const getPerformanceAlerts = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);

  // Ported from a Mongo $sort+$group($push)+$slice+$expr pipeline (flags an employee
  // whose last two appraisal ratings were both <=2) to a plain JS reduction — same
  // idiom used for every other Mongo aggregate() ported in this migration.
  let query = knex('appraisal_records').orderBy('employeeId').orderBy('createdAt', 'desc');
  if (scopedIds !== null) query = query.whereIn('employeeId', scopedIds);
  const records = await query;

  const ratingsByEmployee = new Map();
  for (const r of records) {
    if (!ratingsByEmployee.has(r.employeeId)) ratingsByEmployee.set(r.employeeId, []);
    const arr = ratingsByEmployee.get(r.employeeId);
    if (arr.length < 2) arr.push(r.rating);
  }
  const flagged = [...ratingsByEmployee.entries()]
    .filter(([, lastTwo]) => lastTwo.length >= 2 && lastTwo[0] <= 2 && lastTwo[1] <= 2)
    .map(([employeeId, lastTwo]) => ({ employeeId, ratings: lastTwo }));

  const enriched = await Promise.all(flagged.map(async (f) => {
    const emp = await knex('employees').where({ id: f.employeeId }).select('fullName', 'staffNumber', 'department', 'designation').first();
    return { employee: emp, ratings: f.ratings };
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── Goals ─────────────────────────────────────────────────────────────────────

const GOAL_STATUSES = ['not_started', 'in_progress', 'at_risk', 'completed'];

// Reconstructs the Mongo-shaped `checkIns[]`/`comments[]` arrays from their real
// child tables — same idiom as onboarding's attachTaskLists (Phase 4).
const attachGoalChildren = async (goal) => {
  if (!goal) return goal;
  const [checkIns, comments] = await Promise.all([
    knex('goal_check_ins').where({ goalId: goal.id }).orderBy('id'),
    knex('goal_comments').where({ goalId: goal.id }).orderBy('createdAt'),
  ]);
  return { ...goal, checkIns, comments: comments.map((c) => ({ _id: c.id, ...c })) };
};

const listGoals = async (req, res) => {
  const extra = {};
  if (req.query.status)   extra.status = req.query.status;
  if (req.query.period)   extra.period = req.query.period;
  if (req.query.category) extra.category = req.query.category;

  const scopedIds = await getScopedEmployeeIds(req.user);

  // HR/super_admin — unrestricted (same as before), still honors ?employeeId= narrowing.
  if (scopedIds === null) {
    let query = knex('goals').where(extra);
    if (req.query.employeeId) query = query.where({ employeeId: String(req.query.employeeId) });
    const goals = await query.orderBy('createdAt', 'desc');
    return returnFunction(res, 200, true, req.locale.success, goals);
  }
  if (!scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);

  // Previously department_head/manager scoping here was role-membership-only (via
  // _isHROrMgmt) with zero actual narrowing — any department_head saw every goal
  // company-wide. Now restricted to: goals belonging to someone in my scope (self, or
  // my direct reports, or my department), plus company-wide-visible goals from anyone,
  // plus team-visible goals within my own department (dept heads only — team visibility
  // for a plain-staff manager isn't worth the extra complexity here).
  const visibleOutsideScope = (qb) => {
    qb.where({ visibility: 'company' });
    if (req.user.role === 'department_head' && req.user.department) {
      qb.orWhere((qb2) => qb2.where({ visibility: 'team', department: req.user.department }));
    }
  };

  if (req.query.employeeId) {
    const requested = String(req.query.employeeId);
    const inScope = scopedIds.includes(requested);
    let query = knex('goals').where({ employeeId: requested }).where(extra);
    if (!inScope) query = query.where(visibleOutsideScope);
    const goals = await query.orderBy('createdAt', 'desc');
    return returnFunction(res, 200, true, req.locale.success, goals);
  }

  const goals = await knex('goals')
    .where((qb) => { qb.whereIn('employeeId', scopedIds).orWhere(visibleOutsideScope); })
    .where(extra)
    .orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, goals);
};

const createGoal = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'category', 'period'])) return;

  const keyResults = (req.body.keyResults || []).map(kr => ({
    _id: newId(),
    description: kr.description,
    type: kr.type || 'number',
    startValue: Number(kr.startValue) || 0,
    targetValue: Number(kr.targetValue) || 0,
    currentValue: Number(kr.startValue) || 0,
    unit: kr.unit || '',
    isCompleted: false,
  }));

  // req.body.employeeId wins when given (HR/manager creating a goal for someone else);
  // otherwise this is a self-authored goal — req.user.employeeId (already resolved by
  // AuthMiddleware) is the real link, not a query. This used to look employees up by
  // `employees.userId`, a field that has never existed in this schema (confirmed via a
  // live check — 0/N documents have it), so the fallback path always silently produced
  // employeeId: null for anyone creating their own goal without explicitly passing one.
  const employeeId = req.body.employeeId ? String(req.body.employeeId) : (req.user.employeeId ? String(req.user.employeeId) : null);

  // department was previously never stamped here despite listGoals filtering on it for
  // 'team' visibility — that visibility tier could never actually match anything.
  const targetEmp = employeeId ? await knex('employees').where({ id: employeeId }).select('department').first() : null;

  const doc = {
    id: newId(),
    employeeId,
    department: targetEmp?.department || null,
    createdBy: req.user.id,
    title: req.body.title,
    description: req.body.description || '',
    category: req.body.category,
    period: req.body.period,
    startDate: req.body.startDate ? new Date(req.body.startDate) : new Date(),
    endDate: req.body.endDate ? new Date(req.body.endDate) : null,
    status: 'not_started',
    progress: 0,
    visibility: req.body.visibility || 'private',
    parentGoalId: req.body.parentGoalId ? String(req.body.parentGoalId) : null,
    keyResults: JSON.stringify(keyResults),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('goals', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
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
    const cycle = await knex('review_cycles').where({ id: String(cycleId) }).select('participants').first();
    const participant = cycle?.participants?.find((p) => String(p.employeeId) === String(employeeId));
    return !!participant?.peersAssigned?.some((pa) => String(pa.peerId) === String(req.user.employeeId));
  }
  const employee = await knex('employees').where({ id: String(employeeId) }).select('managerId', 'department').first();
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
    const emps = await knex('employees').where({ department: user.department }).select('id');
    return emps.map((e) => e.id);
  }
  if (!user.employeeId) return [];
  const directReports = await knex('employees').where({ managerId: String(user.employeeId) }).select('id');
  const ids = directReports.map((e) => e.id);
  ids.push(String(user.employeeId));
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
  const employee = await knex('employees').where({ id: goal.employeeId }).select('managerId', 'department').first();
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
  const goal = await knex('goals').where({ id: req.params.id }).first();
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!(await canViewGoal(req, goal))) return returnFunction(res, 403, false, 'Forbidden.');
  return returnFunction(res, 200, true, req.locale.success, await attachGoalChildren(goal));
};

const updateGoal = async (req, res) => {
  const goal = await knex('goals').where({ id: req.params.id }).first();
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
    update.keyResults = JSON.stringify(update.keyResults.map(kr => ({
      ...kr,
      _id: kr._id || newId(),
      startValue: Number(kr.startValue) || 0,
      targetValue: Number(kr.targetValue) || 0,
      currentValue: Number(kr.currentValue) || 0,
    })));
  }

  await knex('goals').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteGoal = async (req, res) => {
  const goal = await knex('goals').where({ id: req.params.id }).first();
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!(await canManageGoal(req, goal))) return returnFunction(res, 403, false, 'Forbidden.');
  await knex('goals').where({ id: req.params.id }).del();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const addCheckin = async (req, res) => {
  if (!validateRequiredFields(req, res, ['progress'])) return;

  const goal = await knex('goals').where({ id: req.params.id }).first();
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!(await canViewGoal(req, goal))) return returnFunction(res, 403, false, 'Forbidden.');

  const checkin = {
    goalId: goal.id,
    progress: Number(req.body.progress),
    note: req.body.note || '',
    updatedBy: req.user.id,
    updatedAt: new Date(),
  };

  await knex('goal_check_ins').insert(checkin);
  await knex('goals').where({ id: goal.id }).update({ progress: checkin.progress, updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Check-in added.', checkin);
};

const addGoalComment = async (req, res) => {
  if (!validateRequiredFields(req, res, ['text'])) return;

  const goal = await knex('goals').where({ id: req.params.id }).first();
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!(await canViewGoal(req, goal))) return returnFunction(res, 403, false, 'Forbidden.');

  const comment = {
    id: newId(),
    goalId: goal.id,
    text: req.body.text.trim(),
    authorId: req.user.id,
    authorName: req.user.name,
    createdAt: new Date(),
  };

  await knex('goal_comments').insert(comment);
  return returnFunction(res, 200, true, 'Comment added.', { ...comment, _id: comment.id });
};

// ── Review Templates ────────────────────────────────────────────────────────────
// Named question sets attached to a cycle so self/manager reviews render actual
// structured questions instead of a blank free-text form. Sections/questions get a
// server-assigned id (crypto.randomUUID) so responses can reference them stably even
// if the template's wording is edited later.

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
  let query = knex('review_templates');
  if (!(_isHR(req.user.role) && req.query.includeInactive === 'true')) query = query.where({ isActive: true });
  const templates = await query.orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, templates);
};

const getTemplate = async (req, res) => {
  const template = await knex('review_templates').where({ id: req.params.id }).first();
  if (!template) return returnFunction(res, 404, false, 'Template not found.');
  return returnFunction(res, 200, true, req.locale.success, template);
};

const createTemplate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const doc = {
    id: newId(),
    name: req.body.name,
    description: req.body.description || '',
    cycleTypes: Array.isArray(req.body.cycleTypes) ? req.body.cycleTypes : [],
    sections: JSON.stringify(_normalizeTemplateSections(req.body.sections)),
    isActive: true,
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('review_templates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const updateTemplate = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name;
  if (req.body.description !== undefined) update.description = req.body.description;
  if (req.body.cycleTypes !== undefined) update.cycleTypes = Array.isArray(req.body.cycleTypes) ? req.body.cycleTypes : [];
  if (req.body.sections !== undefined) update.sections = JSON.stringify(_normalizeTemplateSections(req.body.sections));
  if (req.body.isActive !== undefined) update.isActive = !!req.body.isActive;
  await knex('review_templates').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Templates may already be referenced by a cycle's templateId — deactivating (rather than
// hard-deleting) keeps those cycles' past reviews interpretable instead of leaving a dangling id.
const deleteTemplate = async (req, res) => {
  await knex('review_templates').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Template deactivated.');
};

// ── Review Cycles ─────────────────────────────────────────────────────────────

const listCycles = async (req, res) => {
  let query = knex('review_cycles');
  if (req.query.status) query = query.where({ status: req.query.status });
  const cycles = await query.orderBy('createdAt', 'desc');

  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds === null) return returnFunction(res, 200, true, req.locale.success, cycles);

  const scopedSet = new Set(scopedIds);
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
    id: newId(),
    name: req.body.name,
    type: req.body.type,
    templateId: req.body.templateId ? String(req.body.templateId) : null,
    audience: JSON.stringify({
      type: audienceType,
      departments: audienceType === 'departments' && Array.isArray(req.body.departments) ? req.body.departments : [],
      employeeIds: audienceType === 'employees' && Array.isArray(req.body.employeeIds) ? req.body.employeeIds.map(String) : [],
    }),
    status: 'draft',
    phases: JSON.stringify({
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
    }),
    participants: JSON.stringify([]),
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('review_cycles', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const getCycle = async (req, res) => {
  const cycle = await knex('review_cycles').where({ id: req.params.id }).first();
  if (!cycle) return returnFunction(res, 404, false, 'Cycle not found.');

  const scopedIds = await getScopedEmployeeIds(req.user);
  let participants = cycle.participants || [];
  if (scopedIds !== null) {
    const scopedSet = new Set(scopedIds);
    participants = participants.filter((p) => scopedSet.has(String(p.employeeId)));
  }

  const total = participants.length;
  const completed = participants.filter(p => p.selfReviewStatus === 'submitted').length;

  return returnFunction(res, 200, true, req.locale.success, { ...cycle, participants, total, completed });
};

const updateCycle = async (req, res) => {
  const update = { ...req.body };
  delete update._id;
  if (update.templateId !== undefined) { update.templateId = update.templateId ? String(update.templateId) : null; }
  if (update.audience) {
    if (update.audience.employeeIds) update.audience.employeeIds = update.audience.employeeIds.map(String);
    update.audience = JSON.stringify(update.audience);
  }
  if (update.phases) update.phases = JSON.stringify(update.phases);
  if (update.participants) update.participants = JSON.stringify(update.participants);
  update.updatedAt = new Date();
  await knex('review_cycles').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const launchCycle = async (req, res) => {
  const cycle = await knex('review_cycles').where({ id: req.params.id }).first();
  if (!cycle) return returnFunction(res, 404, false, 'Cycle not found.');
  if (cycle.status === 'active') return returnFunction(res, 400, false, 'Cycle is already active.');

  const audience = cycle.audience || { type: 'all' };
  let employeeQuery = knex('employees').where({ status: 'active' });
  if (audience.type === 'departments' && audience.departments?.length) {
    employeeQuery = employeeQuery.whereIn('department', audience.departments);
  } else if (audience.type === 'employees' && audience.employeeIds?.length) {
    employeeQuery = employeeQuery.whereIn('id', audience.employeeIds);
  }
  const employees = await employeeQuery.select('id');
  const participants = employees.map(emp => ({
    employeeId: emp.id,
    selfReviewStatus: 'pending',
    managerReviewStatus: 'pending',
    selfReviewSubmittedAt: null,
    managerReviewSubmittedAt: null,
    reviewerId: null,
    peersAssigned: [],
  }));

  await knex('review_cycles').where({ id: req.params.id }).update({
    status: 'active', participants: JSON.stringify(participants), updatedAt: new Date(),
  });

  notifyByRoles(['hr_manager', 'super_admin', 'department_head', 'staff'], {
    title: `Review Cycle Launched: ${cycle.name}`,
    body: 'A new performance review cycle has started. Please complete your self-review.',
    type: 'general',
  });

  {
    const allUsers = await knex('users').whereNot({ isActive: false }).select('email');
    const tokens = { cycleName: cycle.name };
    allUsers.filter(u => u.email).forEach(u => sendTemplatedEmail({
      trigger: 'reviewCycleLaunched', to: u.email, tokens,
      fallbackSubject: `Review Cycle Launched: ${cycle.name}`,
      fallbackHtml: `<p>A new performance review cycle, "${cycle.name}", has started. Please complete your self-review.</p>`,
    }).catch(() => {}));
  }

  return returnFunction(res, 200, true, 'Review cycle launched successfully.');
};

// HR nominates which colleagues owe a peer review for a given participant. Overwriting the
// list preserves any already-in-progress/submitted entries (matched by peerId) rather than
// resetting their status, so re-saving the same set (or adding one more peer) doesn't wipe
// work someone already submitted.
const assignPeerReviewers = async (req, res) => {
  const cycleId = req.params.id;
  const employeeId = req.params.employeeId;
  const peerIds = Array.isArray(req.body.peerIds) ? req.body.peerIds : [];

  const cycle = await knex('review_cycles').where({ id: cycleId }).first();
  if (!cycle) return returnFunction(res, 404, false, 'Cycle not found.');
  const participants = cycle.participants || [];
  const participantIdx = participants.findIndex((p) => String(p.employeeId) === String(employeeId));
  if (participantIdx === -1) return returnFunction(res, 404, false, 'Employee is not a participant in this cycle.');

  const existingByPeer = new Map((participants[participantIdx].peersAssigned || []).map((pa) => [String(pa.peerId), pa]));
  const peersAssigned = peerIds.map((id) => existingByPeer.get(String(id)) || { peerId: String(id), status: 'pending', submittedAt: null });

  participants[participantIdx] = { ...participants[participantIdx], peersAssigned };
  await knex('review_cycles').where({ id: cycleId }).update({ participants: JSON.stringify(participants), updatedAt: new Date() });

  return returnFunction(res, 200, true, 'Peer reviewers updated.');
};

const closeCycle = async (req, res) => {
  await knex('review_cycles').where({ id: req.params.id }).update({ status: 'completed', updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Review cycle closed.');
};

// ── Reviews ───────────────────────────────────────────────────────────────────

const listReviews = async (req, res) => {
  let query = knex('reviews');
  if (req.query.cycleId) query = query.where({ cycleId: req.query.cycleId });
  if (req.query.reviewerId) query = query.where({ reviewerId: String(req.query.reviewerId) });

  // A caller-supplied ?employeeId= previously got applied to the filter unconditionally,
  // regardless of role — any department_head/manager could pass any employeeId and read
  // their reviews. Now validated against real scope first, same pattern as attendance's
  // listAttendance fix earlier this session.
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);
  if (req.query.employeeId) {
    const requested = String(req.query.employeeId);
    if (scopedIds !== null && !scopedIds.includes(requested)) {
      return returnFunction(res, 403, false, "You are not authorized to view this employee's reviews.");
    }
    query = query.where({ employeeId: requested });
  } else if (scopedIds !== null) {
    query = query.whereIn('employeeId', scopedIds);
  }

  const reviews = await query.orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, reviews);
};

const getReview = async (req, res) => {
  const review = await knex('reviews').where({ id: req.params.id }).first();
  if (!review) return returnFunction(res, 404, false, 'Review not found.');

  const isOwnerOrReviewer = String(review.reviewerId) === String(req.user.id) || String(review.employeeId) === String(req.user.employeeId);
  if (!isOwnerOrReviewer && !(await isAuthorizedForReview(req, review.employeeId, review.reviewType, review.cycleId))) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  const [employee, reviewer, cycle] = await Promise.all([
    knex('employees').where({ id: review.employeeId }).select('fullName', 'designation', 'department').first(),
    knex('users').where({ id: review.reviewerId }).select('name').first(),
    knex('review_cycles').where({ id: review.cycleId }).select('name', 'type', 'phases', 'templateId').first(),
  ]);

  const template = cycle?.templateId ? await knex('review_templates').where({ id: cycle.templateId }).first() : null;
  // Only a manager (writing an evaluative review) benefits from attendance context — a
  // self-review doesn't need it, and showing it there would just be noise.
  const attendanceSummary = review.reviewType === 'manager' ? await getAttendanceSummaryForReview(review.employeeId) : null;

  return returnFunction(res, 200, true, req.locale.success, { ...review, employee, reviewer, cycle, template, attendanceSummary });
};

// Trailing-90-day attendance snapshot (present/late/absent counts + rate) for the employee
// being reviewed — gives a manager real, verifiable context (absences, lateness patterns)
// instead of writing a review from memory alone. Reads the same 'attendance_records'
// table/status enum ('present'|'late'|'absent'|'half_day'|'remote') as the Attendance
// module itself (Phase 3b).
const getAttendanceSummaryForReview = async (employeeId) => {
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const sinceStr = since.toISOString().slice(0, 10);

  const records = await pgDB.knex('attendance_records').where({ employeeId: String(employeeId) }).where('date', '>=', sinceStr);

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
  const cycles = await knex('review_cycles').whereIn('status', ['active', 'calibration']).orderBy('createdAt', 'desc');
  if (!cycles.length) return returnFunction(res, 200, true, req.locale.success, []);

  const scopedSet = scopedIds !== null ? new Set(scopedIds) : null;
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

  const idList = [...employeeIdsNeeded];
  const [employees, existingReviews] = await Promise.all([
    knex('employees').whereIn('id', idList).select('id', 'fullName', 'designation', 'department'),
    // Scoped to reviews authored by the current user — peer reviews can have several
    // draft/submitted docs for the same cycle+employee+type (one per peer reviewer), so
    // without this filter the lookup below could resolve to a different peer's review.
    knex('reviews').whereIn('cycleId', cycles.map((c) => c.id)).whereIn('employeeId', idList).where({ reviewerId: req.user.id }),
  ]);
  const empMap = new Map(employees.map((e) => [e.id, e]));
  const reviewMap = new Map(existingReviews.map((r) => [`${r.cycleId}_${r.employeeId}_${r.reviewType}`, r]));

  const tasks = rawTasks.map((t) => {
    const existing = reviewMap.get(`${t.cycle.id}_${t.employeeId}_${t.reviewType}`);
    return {
      cycleId: t.cycle.id,
      cycleName: t.cycle.name,
      templateId: t.cycle.templateId || null,
      employeeId: t.employeeId,
      employee: empMap.get(String(t.employeeId)) || null,
      reviewType: t.reviewType,
      status: t.status,
      reviewId: existing?.id || null,
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
    cycleId: String(cycleId),
    employeeId: String(employeeId),
    reviewType,
    // Peer reviews are many-to-one (several colleagues each write their own about the same
    // employee), so reviewerId must be part of the identity key — self/manager stay 1:1 per
    // cycle+employee, where reviewerId is implied by isAuthorizedForReview and never varies.
    ...(reviewType === 'peer' ? { reviewerId: req.user.id } : {}),
  };

  const existing = await knex('reviews').where(filter).first();
  // An existing review's reviewer is fixed at creation — editing someone else's draft
  // (even a legitimately-created one) isn't the same operation as authoring a new one.
  if (existing && !_isHR(req.user.role) && String(existing.reviewerId) !== String(req.user.id)) {
    return returnFunction(res, 403, false, 'Only the assigned reviewer can edit this review.');
  }

  const data = {
    responses: JSON.stringify(req.body.responses || []),
    overallRating: req.body.overallRating ? Number(req.body.overallRating) : null,
    updatedAt: new Date(),
  };

  if (existing) {
    await knex('reviews').where({ id: existing.id }).update(data);
    return returnFunction(res, 200, true, 'Review saved.', { _id: existing.id });
  }

  const doc = {
    id: newId(),
    ...filter,
    reviewerId: req.user.id,
    status: 'draft',
    ...data,
    recommendation: null,
    calibrationBox: null,
    calibrationNotes: null,
    submittedAt: null,
    createdAt: new Date(),
  };
  const result = await insertOne('reviews', doc);
  return returnFunction(res, 201, true, 'Review created.', { _id: result.id });
};

const submitReview = async (req, res) => {
  const review = await knex('reviews').where({ id: req.params.id }).first();
  if (!review) return returnFunction(res, 404, false, 'Review not found.');
  if (review.status === 'submitted') return returnFunction(res, 400, false, 'Review already submitted.');
  // HR can submit on a reviewer's behalf for administrative corrections; a department_head
  // has no business submitting a review they didn't author just by virtue of the role —
  // that bypass previously let any department_head submit any employee's review company-wide.
  if (!_isHR(req.user.role) && String(review.reviewerId) !== String(req.user.id)) {
    return returnFunction(res, 403, false, 'Only the assigned reviewer can submit this review.');
  }

  const recommendation = req.body.recommendation || null;
  await knex('reviews').where({ id: req.params.id }).update({
    status: 'submitted',
    recommendation,
    overallRating: req.body.overallRating ? Number(req.body.overallRating) : review.overallRating,
    submittedAt: new Date(),
    updatedAt: new Date(),
  });

  // A manager review's promote/PIP recommendation used to just sit on the review doc,
  // inert — nothing ever read it. Now it stamps a visible flag on the employee record (for
  // the profile page to surface) and tells HR directly, so the recommendation actually
  // reaches someone who can act on it instead of being buried in a submitted review.
  if (['promote', 'pip'].includes(recommendation)) {
    const flaggedEmployee = await knex('employees').where({ id: review.employeeId }).select('fullName').first();
    await knex('employees').where({ id: review.employeeId }).update({
      pendingPerformanceFlag: JSON.stringify({ type: recommendation, reviewId: review.id, cycleId: review.cycleId, flaggedBy: req.user.id, flaggedAt: new Date() }),
    });
    notifyByRoles(['hr_manager', 'super_admin'], {
      title: recommendation === 'promote' ? 'Promotion Recommended' : 'PIP Recommended',
      body: `${req.user.name || 'A manager'} recommended ${recommendation === 'promote' ? 'a promotion' : 'a performance improvement plan'} for ${flaggedEmployee?.fullName || 'an employee'}.`,
      type: 'general',
      link: `/employees/${review.employeeId}`,
    }).catch(() => {});

    const hrUsers = await knex('users').whereIn('role', ['hr_manager', 'super_admin']).whereNot({ isActive: false }).select('email');
    const tokens = {
      managerName: req.user.name || 'A manager', recommendationLabel: recommendation === 'promote' ? 'a promotion' : 'a performance improvement plan',
      employeeName: flaggedEmployee?.fullName || 'an employee',
    };
    hrUsers.filter(u => u.email).forEach(u => sendTemplatedEmail({
      trigger: 'performanceRecommendation', to: u.email, tokens,
      fallbackSubject: recommendation === 'promote' ? 'Promotion Recommended' : 'PIP Recommended',
      fallbackHtml: `<p>${tokens.managerName} recommended ${tokens.recommendationLabel} for ${tokens.employeeName}.</p>`,
    }).catch(() => {}));
  }

  // Previously this always flipped selfReviewStatus regardless of reviewType, so a
  // manager review submission never actually marked managerReviewStatus as done —
  // cycle progress tracking was silently wrong for every manager review ever submitted.
  const now = new Date();
  if (review.reviewType === 'self') {
    const cycle = await knex('review_cycles').where({ id: review.cycleId }).first();
    if (cycle) {
      const participants = (cycle.participants || []).map((p) => String(p.employeeId) === String(review.employeeId)
        ? { ...p, selfReviewStatus: 'submitted', selfReviewSubmittedAt: now } : p);
      await knex('review_cycles').where({ id: review.cycleId }).update({ participants: JSON.stringify(participants) });
    }
  } else if (review.reviewType === 'manager') {
    const cycle = await knex('review_cycles').where({ id: review.cycleId }).first();
    if (cycle) {
      const participants = (cycle.participants || []).map((p) => String(p.employeeId) === String(review.employeeId)
        ? { ...p, managerReviewStatus: 'submitted', managerReviewSubmittedAt: now } : p);
      await knex('review_cycles').where({ id: review.cycleId }).update({ participants: JSON.stringify(participants) });
    }
  } else if (review.reviewType === 'peer') {
    // Peer reviews are tracked per-reviewer inside participants[].peersAssigned (several
    // colleagues each have their own entry for the same employee), so this targets the one
    // matching this specific reviewer. peersAssigned.peerId is an *employee* id (assigned by
    // HR from the employee list), but review.reviewerId is the reviewer's *user* id — they
    // only coincide by accident, so the reviewer's employeeId must be resolved before it can
    // be matched against peerId.
    const reviewerUser = await knex('users').where({ id: review.reviewerId }).select('employeeId').first();
    if (reviewerUser?.employeeId) {
      const cycle = await knex('review_cycles').where({ id: review.cycleId }).first();
      if (cycle) {
        const participants = (cycle.participants || []).map((p) => {
          if (String(p.employeeId) !== String(review.employeeId)) return p;
          const peersAssigned = (p.peersAssigned || []).map((pa) => String(pa.peerId) === String(reviewerUser.employeeId)
            ? { ...pa, status: 'submitted', submittedAt: now } : pa);
          return { ...p, peersAssigned };
        });
        await knex('review_cycles').where({ id: review.cycleId }).update({ participants: JSON.stringify(participants) });
      }
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
    knex('users').where({ employeeId: review.employeeId }).first()
      .then((targetUser) => {
        if (targetUser) return evaluateRulesForUser('onPerformanceScore', targetUser, { performanceScore: finalRating });
      })
      .catch(() => {});
  }

  return returnFunction(res, 200, true, 'Review submitted successfully.');
};

// ── Calibration ───────────────────────────────────────────────────────────────

const getCalibration = async (req, res) => {
  const reviews = await knex('reviews').where({ cycleId: req.params.cycleId, reviewType: 'manager', status: 'submitted' });

  const enriched = await Promise.all(reviews.map(async (r) => {
    const emp = await knex('employees').where({ id: r.employeeId }).select('fullName', 'designation', 'department').first();
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
  await knex('reviews')
    .where({ cycleId: req.params.cycleId, employeeId: req.params.empId, reviewType: 'manager' })
    .update({ calibrationBox: req.body.box, calibrationNotes: req.body.notes || '', updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Calibration updated.');
};

// ── Feedback ──────────────────────────────────────────────────────────────────

// Anonymity/visibility are enforced here, at read time — storing the flags alone did
// nothing (any recipient could still see the real giver's name, and isVisibleToEmployee
// wasn't checked anywhere before this fix).
const enrichFeedback = async (feedback, { userId, empId, isHR }) => {
  return Promise.all(feedback.map(async (f) => {
    const giver = await knex('employees').where({ id: f.giverId }).select('fullName').first()
      || await knex('users').where({ id: f.giverId }).select('name').first();
    const recipient = await knex('employees').where({ id: f.recipientId }).select('fullName').first()
      || await knex('users').where({ id: f.recipientId }).select('name').first();
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
  const userId = req.user.id;
  // employees.userId has never existed in this schema (same dead-field lookup fixed in
  // createGoal above) — req.user.employeeId (already resolved by AuthMiddleware) is the
  // real link.
  const empId = req.user.employeeId ? String(req.user.employeeId) : null;

  // Viewing a THIRD PARTY's feedback (e.g. from their profile page) is a distinct case from
  // "my feedback" — only HR or that employee's actual manager/department_head may do it, and
  // it's always scoped to what they received (never their private "given" history).
  if (req.query.employeeId) {
    const targetId = String(req.query.employeeId);
    if (!(await isAuthorizedForReview(req, targetId, 'manager'))) {
      return returnFunction(res, 403, false, "You are not authorized to view this employee's feedback.");
    }
    let feedback = await knex('feedback').where({ recipientId: targetId }).orderBy('createdAt', 'desc');
    if (!_isHR(req.user.role)) feedback = feedback.filter((f) => f.isVisibleToEmployee !== false);
    const enriched = await enrichFeedback(feedback, { userId: targetId, empId: targetId, isHR: _isHR(req.user.role) });
    return returnFunction(res, 200, true, req.locale.success, enriched);
  }

  const idsToMatch = empId ? [userId, empId] : [userId];
  let query = knex('feedback');
  if (req.query.type === 'received') {
    query = query.whereIn('recipientId', idsToMatch);
  } else if (req.query.type === 'given') {
    query = query.whereIn('giverId', idsToMatch);
  } else {
    query = query.where((qb) => qb.whereIn('giverId', idsToMatch).orWhereIn('recipientId', idsToMatch));
  }

  let feedback = await query.orderBy('createdAt', 'desc');

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
  const feedback = await knex('feedback').orderBy('createdAt', 'desc');
  const enriched = await enrichFeedback(feedback, { userId: null, empId: null, isHR: true });
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const updateFeedbackVisibility = async (req, res) => {
  if (req.body.isVisibleToEmployee === undefined) return returnFunction(res, 400, false, 'isVisibleToEmployee is required.');
  const [updated] = await knex('feedback').where({ id: req.params.id }).update({ isVisibleToEmployee: !!req.body.isVisibleToEmployee }).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const giveFeedback = async (req, res) => {
  if (!validateRequiredFields(req, res, ['recipientId', 'type', 'message'])) return;

  const doc = {
    id: newId(),
    giverId: req.user.id,
    recipientId: String(req.body.recipientId),
    type: req.body.type,
    category: req.body.category || 'general',
    message: req.body.message.trim(),
    visibility: req.body.visibility || 'private',
    isAnonymous: req.body.isAnonymous === true,
    isVisibleToEmployee: true,
    relatedCycleId: req.body.relatedCycleId ? String(req.body.relatedCycleId) : null,
    createdAt: new Date(),
  };

  const result = await insertOne('feedback', doc);

  notifyEmployee(req.body.recipientId.toString(), {
    title: 'You received new feedback',
    body: doc.isAnonymous ? 'Someone left you anonymous feedback.' : `${req.user.name} gave you ${doc.type} feedback.`,
    type: 'general',
  });
  emailEmployeeByTrigger(req.body.recipientId, 'feedbackReceived',
    { fromLabel: doc.isAnonymous ? 'Someone' : req.user.name, feedbackType: doc.type },
    'You received new feedback',
    `<p>${doc.isAnonymous ? 'Someone left you anonymous feedback.' : `${req.user.name} gave you ${doc.type} feedback.`}</p>`);

  return returnFunction(res, 201, true, 'Feedback sent.', { _id: result.id });
};

// ── 1-on-1 Check-ins ────────────────────────────────────────────────────────────
// Named 'one_on_ones' (not 'checkIns') to avoid colliding with goals' existing
// checkIns progress-log child table — this is a distinct, standalone table for
// recurring manager/direct-report meetings, unrelated to goal progress updates.

// Reconstructs the Mongo-shaped `agendaItems[]` array from its real child table.
const attachAgendaItems = async (oneOnOne) => {
  if (!oneOnOne) return oneOnOne;
  const agendaItems = await knex('one_on_one_agenda_items').where({ oneOnOneId: oneOnOne.id }).orderBy('createdAt');
  return { ...oneOnOne, agendaItems };
};

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
  let query = knex('one_on_ones');
  if (!_isHR(req.user.role)) {
    if (!myEmployeeId) return returnFunction(res, 200, true, req.locale.success, []);
    query = query.where((qb) => qb.where({ managerId: myEmployeeId }).orWhere({ employeeId: myEmployeeId }));
  } else if (req.query.employeeId) {
    const qid = String(req.query.employeeId);
    query = query.where((qb) => qb.where({ managerId: qid }).orWhere({ employeeId: qid }));
  }
  const oneOnOnes = await query.orderBy('scheduledAt', 'desc');

  const empIds = [...new Set(oneOnOnes.flatMap((o) => [o.managerId, o.employeeId]))];
  const employees = empIds.length ? await knex('employees').whereIn('id', empIds).select('id', 'fullName', 'designation') : [];
  const empMap = new Map(employees.map((e) => [e.id, e]));

  const enriched = oneOnOnes.map((o) => ({
    ...o,
    manager: empMap.get(o.managerId) || null,
    employee: empMap.get(o.employeeId) || null,
    // A manager's private notes never leave the manager's own view of the meeting.
    privateManagerNotes: o.managerId === myEmployeeId || _isHR(req.user.role) ? o.privateManagerNotes : undefined,
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createOneOnOne = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'scheduledAt'])) return;
  const employeeId = String(req.body.employeeId);

  // The requester must actually be this employee's manager (or HR) — otherwise anyone could
  // schedule a "1-on-1" with someone they have no management relationship to.
  if (!_isHR(req.user.role)) {
    const employee = await knex('employees').where({ id: employeeId }).select('managerId').first();
    if (!employee || !req.user.employeeId || String(employee.managerId || '') !== String(req.user.employeeId)) {
      return returnFunction(res, 403, false, 'You can only schedule 1-on-1s with your own direct reports.');
    }
  }
  const managerId = req.body.managerId ? String(req.body.managerId) : String(req.user.employeeId);

  const doc = {
    id: newId(),
    managerId,
    employeeId,
    scheduledAt: new Date(req.body.scheduledAt),
    status: 'scheduled',
    sharedNotes: '',
    privateManagerNotes: '',
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('one_on_ones', doc);

  notifyEmployee(employeeId, {
    title: '1-on-1 Scheduled',
    body: `A 1-on-1 meeting has been scheduled for ${doc.scheduledAt.toLocaleDateString()}.`,
    type: 'general',
  });
  emailEmployeeByTrigger(employeeId, 'oneOnOneScheduled', { scheduledDate: doc.scheduledAt.toLocaleDateString() },
    '1-on-1 Scheduled', `<p>A 1-on-1 meeting has been scheduled for ${doc.scheduledAt.toLocaleDateString()}.</p>`);

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const getOneOnOne = async (req, res) => {
  const oneOnOne = await knex('one_on_ones').where({ id: req.params.id }).first();
  if (!oneOnOne) return returnFunction(res, 404, false, 'One-on-one not found.');
  if (!(await _isOneOnOneParticipant(req, oneOnOne))) return returnFunction(res, 403, false, 'Forbidden.');

  const myEmployeeId = req.user.employeeId ? String(req.user.employeeId) : null;
  const [manager, employee] = await Promise.all([
    knex('employees').where({ id: oneOnOne.managerId }).select('fullName', 'designation').first(),
    knex('employees').where({ id: oneOnOne.employeeId }).select('fullName', 'designation').first(),
  ]);

  const isManagerOrHR = oneOnOne.managerId === myEmployeeId || _isHR(req.user.role);
  return returnFunction(res, 200, true, req.locale.success, {
    ...(await attachAgendaItems(oneOnOne)),
    manager,
    employee,
    privateManagerNotes: isManagerOrHR ? oneOnOne.privateManagerNotes : undefined,
  });
};

const updateOneOnOne = async (req, res) => {
  const oneOnOne = await knex('one_on_ones').where({ id: req.params.id }).first();
  if (!oneOnOne) return returnFunction(res, 404, false, 'One-on-one not found.');
  if (!(await _isOneOnOneParticipant(req, oneOnOne))) return returnFunction(res, 403, false, 'Forbidden.');

  const myEmployeeId = req.user.employeeId ? String(req.user.employeeId) : null;
  const isManagerOrHR = oneOnOne.managerId === myEmployeeId || _isHR(req.user.role);

  const update = { updatedAt: new Date() };
  if (req.body.scheduledAt !== undefined) update.scheduledAt = new Date(req.body.scheduledAt);
  if (req.body.status !== undefined) update.status = req.body.status;
  if (req.body.sharedNotes !== undefined) update.sharedNotes = req.body.sharedNotes;
  // Private notes are a manager-only field — an employee's update request simply can't touch it,
  // regardless of what's in the request body.
  if (req.body.privateManagerNotes !== undefined && isManagerOrHR) update.privateManagerNotes = req.body.privateManagerNotes;

  await knex('one_on_ones').where({ id: oneOnOne.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const addOneOnOneAgendaItem = async (req, res) => {
  const oneOnOne = await knex('one_on_ones').where({ id: req.params.id }).first();
  if (!oneOnOne) return returnFunction(res, 404, false, 'One-on-one not found.');
  if (!(await _isOneOnOneParticipant(req, oneOnOne))) return returnFunction(res, 403, false, 'Forbidden.');
  if (!req.body.text?.trim()) return returnFunction(res, 400, false, 'Agenda item text is required.');

  const item = { id: randomUUID(), oneOnOneId: oneOnOne.id, text: req.body.text.trim(), addedBy: req.user.id, isDone: false, createdAt: new Date() };
  await knex('one_on_one_agenda_items').insert(item);
  await knex('one_on_ones').where({ id: oneOnOne.id }).update({ updatedAt: new Date() });
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, item);
};

const toggleOneOnOneAgendaItem = async (req, res) => {
  const oneOnOne = await knex('one_on_ones').where({ id: req.params.id }).first();
  if (!oneOnOne) return returnFunction(res, 404, false, 'One-on-one not found.');
  if (!(await _isOneOnOneParticipant(req, oneOnOne))) return returnFunction(res, 403, false, 'Forbidden.');

  const item = await knex('one_on_one_agenda_items').where({ id: req.params.itemId, oneOnOneId: oneOnOne.id }).first();
  if (!item) return returnFunction(res, 404, false, 'Agenda item not found.');

  await knex('one_on_one_agenda_items').where({ id: item.id }).update({ isDone: !item.isDone });
  await knex('one_on_ones').where({ id: oneOnOne.id }).update({ updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const completeOneOnOne = async (req, res) => {
  const oneOnOne = await knex('one_on_ones').where({ id: req.params.id }).first();
  if (!oneOnOne) return returnFunction(res, 404, false, 'One-on-one not found.');
  if (!(await _isOneOnOneParticipant(req, oneOnOne))) return returnFunction(res, 403, false, 'Forbidden.');

  await knex('one_on_ones').where({ id: oneOnOne.id }).update({ status: 'completed', completedAt: new Date(), updatedAt: new Date() });
  return returnFunction(res, 200, true, 'One-on-one marked complete.');
};

// ── Performance Improvement Plans ────────────────────────────────────────────

// Reconstructs the Mongo-shaped `checkIns[]` array from its real child table.
const attachPipCheckIns = async (pip) => {
  if (!pip) return pip;
  const checkIns = await knex('pip_check_ins').where({ pipId: pip.id }).orderBy('createdAt');
  return { ...pip, checkIns };
};

// Same three-way access as reviews/goals: HR always, the employee themself (a PIP is only
// meaningful if the employee can see it), their actual manager (via managerId), or their
// department_head.
const _canAccessPIP = async (req, pip) => {
  if (_isHR(req.user.role)) return true;
  if (req.user.employeeId && String(req.user.employeeId) === String(pip.employeeId)) return true;
  if (req.user.employeeId && String(req.user.employeeId) === String(pip.managerId)) return true;
  if (req.user.role === 'department_head' && req.user.department) {
    const employee = await knex('employees').where({ id: pip.employeeId }).select('department').first();
    return !!employee && employee.department === req.user.department;
  }
  return false;
};

const listPIPs = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  let query = knex('performance_improvement_plans');
  if (scopedIds !== null) {
    if (!scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);
    query = query.whereIn('employeeId', scopedIds);
  } else if (req.query.employeeId) {
    query = query.where({ employeeId: String(req.query.employeeId) });
  }
  const pips = await query.orderBy('createdAt', 'desc');

  const empIds = [...new Set(pips.map((p) => p.employeeId))];
  const employees = empIds.length ? await knex('employees').whereIn('id', empIds).select('id', 'fullName', 'designation', 'department') : [];
  const empMap = new Map(employees.map((e) => [e.id, e]));
  const enriched = pips.map((p) => ({ ...p, employee: empMap.get(p.employeeId) || null }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createPIP = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'reason', 'startDate', 'endDate'])) return;
  const employeeId = String(req.body.employeeId);

  // A PIP is a serious, targeted intervention — only started by HR or the employee's actual
  // manager/department_head, never by an unrelated manager just because they hold the role.
  if (!_isHR(req.user.role)) {
    const employee = await knex('employees').where({ id: employeeId }).select('managerId', 'department').first();
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
    id: newId(),
    employeeId,
    managerId: req.body.managerId ? String(req.body.managerId) : (req.user.employeeId ? String(req.user.employeeId) : null),
    createdBy: req.user.id,
    reason: req.body.reason,
    startDate: new Date(req.body.startDate),
    endDate: new Date(req.body.endDate),
    status: 'active',
    goals: JSON.stringify(goals),
    outcome: null,
    relatedReviewId: req.body.relatedReviewId ? String(req.body.relatedReviewId) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('performance_improvement_plans', doc);

  // Starting the PIP IS acting on a prior 'pip' recommendation flag (if there was one) —
  // clear it so it doesn't keep showing as an outstanding recommendation on the profile.
  await knex('employees').where({ id: employeeId }).whereRaw("\"pendingPerformanceFlag\"->>'type' = 'pip'").update({ pendingPerformanceFlag: null });

  notifyEmployee(employeeId, {
    title: 'Performance Improvement Plan Started',
    body: 'A performance improvement plan has been created for you. Please speak with your manager.',
    type: 'general',
  });
  emailEmployeeByTrigger(employeeId, 'pipStarted', {},
    'Performance Improvement Plan Started',
    '<p>A performance improvement plan has been created for you. Please speak with your manager.</p>');
  notifyByRoles(['hr_manager', 'super_admin'], {
    title: 'PIP Created',
    body: `${req.user.name || 'A manager'} started a performance improvement plan.`,
    type: 'general',
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const getPIP = async (req, res) => {
  const pip = await knex('performance_improvement_plans').where({ id: req.params.id }).first();
  if (!pip) return returnFunction(res, 404, false, 'PIP not found.');
  if (!(await _canAccessPIP(req, pip))) return returnFunction(res, 403, false, 'Forbidden.');

  const employee = await knex('employees').where({ id: pip.employeeId }).select('fullName', 'designation', 'department').first();
  return returnFunction(res, 200, true, req.locale.success, { ...(await attachPipCheckIns(pip)), employee });
};

const updatePIP = async (req, res) => {
  const pip = await knex('performance_improvement_plans').where({ id: req.params.id }).first();
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
    update.goals = JSON.stringify(req.body.goals.map((g) => ({
      id: g.id || randomUUID(),
      description: g.description || '',
      targetDate: g.targetDate ? new Date(g.targetDate) : null,
      status: ['pending', 'met', 'not_met'].includes(g.status) ? g.status : 'pending',
    })));
  }
  await knex('performance_improvement_plans').where({ id: pip.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const addPIPCheckIn = async (req, res) => {
  const pip = await knex('performance_improvement_plans').where({ id: req.params.id }).first();
  if (!pip) return returnFunction(res, 404, false, 'PIP not found.');
  if (!(await _canAccessPIP(req, pip))) return returnFunction(res, 403, false, 'Forbidden.');
  if (!req.body.note?.trim()) return returnFunction(res, 400, false, 'Check-in note is required.');

  const entry = { id: randomUUID(), pipId: pip.id, note: req.body.note.trim(), addedBy: req.user.id, createdAt: new Date() };
  await knex('pip_check_ins').insert(entry);
  await knex('performance_improvement_plans').where({ id: pip.id }).update({ updatedAt: new Date() });
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, entry);
};

const closePIP = async (req, res) => {
  const pip = await knex('performance_improvement_plans').where({ id: req.params.id }).first();
  if (!pip) return returnFunction(res, 404, false, 'PIP not found.');
  if (!(await _canAccessPIP(req, pip))) return returnFunction(res, 403, false, 'Forbidden.');
  if (!_isHR(req.user.role) && req.user.employeeId && String(req.user.employeeId) === String(pip.employeeId)) {
    return returnFunction(res, 403, false, 'Only your manager or HR can close this plan.');
  }
  const outcome = ['passed', 'failed'].includes(req.body.outcome) ? req.body.outcome : null;
  if (!outcome) return returnFunction(res, 400, false, 'Outcome must be "passed" or "failed".');

  await knex('performance_improvement_plans').where({ id: pip.id }).update({
    status: 'completed', outcome, closedAt: new Date(), updatedAt: new Date(),
  });

  notifyEmployee(pip.employeeId, {
    title: 'Performance Improvement Plan Closed',
    body: `Your performance improvement plan has been closed. Outcome: ${outcome === 'passed' ? 'Passed' : 'Not Met'}.`,
    type: 'general',
  });
  emailEmployeeByTrigger(pip.employeeId, 'pipClosed', { outcomeLabel: outcome === 'passed' ? 'Passed' : 'Not Met' },
    'Performance Improvement Plan Closed',
    `<p>Your performance improvement plan has been closed. Outcome: ${outcome === 'passed' ? 'Passed' : 'Not Met'}.</p>`);
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
  const employeeId = String(req.params.employeeId);
  const isSelf = !!req.user.employeeId && String(req.user.employeeId) === String(employeeId);
  if (!isSelf && !(await isAuthorizedForReview(req, employeeId, 'manager'))) {
    return returnFunction(res, 403, false, "You are not authorized to view this employee's performance summary.");
  }

  const [candidateCycles, lastManagerReview] = await Promise.all([
    knex('review_cycles').whereIn('status', ['active', 'calibration']).orderBy('createdAt', 'desc'),
    knex('reviews').where({ employeeId, reviewType: 'manager', status: 'submitted' }).orderBy('submittedAt', 'desc').first(),
  ]);
  // Filtered in JS rather than a JSONB @> containment query — participants[] elements
  // carry many more fields than just employeeId, and array-of-object @> containment in
  // Postgres doesn't reliably do the "any element with this one field" partial match a
  // naive query would assume; a plain JS filter over a small, already-fetched result set
  // is simpler and unambiguously correct.
  const activeCycles = candidateCycles.filter((c) => (c.participants || []).some((p) => String(p.employeeId) === employeeId));

  const cycleSummaries = activeCycles.map((c) => {
    const p = (c.participants || []).find((pp) => String(pp.employeeId) === String(employeeId));
    return { cycleId: c.id, cycleName: c.name, selfReviewStatus: p?.selfReviewStatus || null, managerReviewStatus: p?.managerReviewStatus || null };
  });

  let lastRating = null;
  if (lastManagerReview) {
    const cycle = await knex('review_cycles').where({ id: lastManagerReview.cycleId }).select('name').first();
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

  const scopeGoals = (q) => (scoped ? q.whereIn('employeeId', scopedIds) : q);
  const scopeReviews = (q) => (scoped ? q.whereIn('employeeId', scopedIds) : q);
  const scopeAppraisals = (q) => (scoped ? q.whereIn('employeeId', scopedIds) : q);

  const [
    [{ count: goalsTotal }],
    [{ count: goalsCompleted }],
    [{ count: reviewsTotal }],
    [{ count: reviewsSubmitted }],
    cycles,
    recentAppraisals,
    goalsForStatus,
  ] = await Promise.all([
    scopeGoals(knex('goals')).count('* as count'),
    scopeGoals(knex('goals')).where({ status: 'completed' }).count('* as count'),
    scopeReviews(knex('reviews')).count('* as count'),
    scopeReviews(knex('reviews')).where({ status: 'submitted' }).count('* as count'),
    knex('review_cycles').where({ status: 'active' }).orderBy('createdAt', 'desc'),
    scopeAppraisals(knex('appraisal_records')).select('rating'),
    scopeGoals(knex('goals')).select('status'),
  ]);

  // Ported from Mongo $group pipelines to plain JS reductions.
  const goalsByStatusMap = {};
  for (const g of goalsForStatus) goalsByStatusMap[g.status] = (goalsByStatusMap[g.status] || 0) + 1;
  const goalsByStatus = Object.entries(goalsByStatusMap).map(([_id, count]) => ({ _id, count }));

  const ratingCounts = {};
  for (const a of recentAppraisals) ratingCounts[a.rating] = (ratingCounts[a.rating] || 0) + 1;
  const ratingDistribution = Object.entries(ratingCounts).map(([rating, count]) => ({ _id: Number(rating), count })).sort((a, b) => a._id - b._id);

  // Ported from a Mongo $lookup+$unwind+$group pipeline (join appraisal_records to
  // employees on department, average rating per department).
  const empIdsForAppraisals = [...new Set(recentAppraisals.map((a) => a.employeeId).filter(Boolean))];
  // recentAppraisals above only selected `rating` — re-fetch with employeeId for the join.
  const appraisalsForDept = await scopeAppraisals(knex('appraisal_records')).select('employeeId', 'rating');
  const deptIds = [...new Set(appraisalsForDept.map((a) => a.employeeId))];
  const deptByEmployee = deptIds.length
    ? Object.fromEntries((await knex('employees').whereIn('id', deptIds).select('id', 'department')).map((e) => [e.id, e.department]))
    : {};
  const deptAgg = {};
  for (const a of appraisalsForDept) {
    const dept = deptByEmployee[a.employeeId];
    if (!dept) continue;
    if (!deptAgg[dept]) deptAgg[dept] = { total: 0, count: 0 };
    deptAgg[dept].total += a.rating;
    deptAgg[dept].count += 1;
  }
  const appraisalByDept = Object.entries(deptAgg)
    .map(([_id, v]) => ({ _id, avgRating: v.total / v.count, count: v.count }))
    .sort((a, b) => b.avgRating - a.avgRating)
    .slice(0, 8);
  void empIdsForAppraisals;

  let activeCycles = cycles;
  if (scoped) {
    const scopedSet = new Set(scopedIds);
    activeCycles = cycles.filter((c) => (c.participants || []).some((p) => scopedSet.has(String(p.employeeId))));
  }

  const avgScore = recentAppraisals.reduce((s, r) => s + r.rating, 0) / Math.max(1, recentAppraisals.length);

  return returnFunction(res, 200, true, req.locale.success, {
    goalsCompletionRate: Number(goalsTotal) ? Math.round((Number(goalsCompleted) / Number(goalsTotal)) * 100) : 0,
    averagePerformanceScore: avgScore ? Math.round(avgScore * 10) / 10 : 0,
    reviewParticipationRate: Number(reviewsTotal) ? Math.round((Number(reviewsSubmitted) / Number(reviewsTotal)) * 100) : 0,
    activeCycles: activeCycles.length,
    goalsByStatus,
    ratingDistribution,
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
