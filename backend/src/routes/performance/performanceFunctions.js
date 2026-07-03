const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, aggregate } = require('../../functions/Database/commonDBFunctions');
const { notifyEmployee, notifyByRoles } = require('../../functions/HR/notifyUser');

// ── Existing appraisal functions (keep) ───────────────────────────────────────

const getEmployeePerformance = async (req, res) => {
  const records = await findMany('appraisal_records',
    { employeeId: new ObjectId(req.params.employeeId) },
    { sort: { createdAt: -1 } }
  );
  return returnFunction(res, 200, true, req.locale.success, records);
};

const VALID_PERIODS = ['Q1', 'Q2', 'Q3', 'Q4'];

const createAppraisal = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'reviewPeriod', 'rating'])) return;
  const rating = parseInt(req.body.rating);
  if (rating < 1 || rating > 5) return returnFunction(res, 400, false, 'Rating must be between 1 and 5.');

  const periodBase = req.body.reviewPeriod?.trim().toUpperCase().split(' ')[0];
  if (!VALID_PERIODS.includes(periodBase)) {
    return returnFunction(res, 400, false, 'Review period must be Q1, Q2, Q3, or Q4 (optionally with a year, e.g. "Q1 2025").');
  }

  const doc = {
    employeeId: new ObjectId(req.body.employeeId),
    reviewPeriod: req.body.reviewPeriod,
    reviewerId: new ObjectId(req.user._id),
    goalsSet: req.body.goalsSet || [],
    goalsAchieved: req.body.goalsAchieved || [],
    rating,
    comments: req.body.comments || null,
    createdAt: new Date(),
  };
  const result = await insertOne('appraisal_records', doc);

  const employee = await findOne('employees', { _id: new ObjectId(req.body.employeeId) }, { projection: { fullName: 1 } });
  const empName = employee?.fullName ?? 'An employee';
  const ratingLabel = ['', 'Unsatisfactory', 'Needs Improvement', 'Meets Expectations', 'Exceeds Expectations', 'Outstanding'][doc.rating] ?? `${doc.rating}/5`;

  notifyEmployee(req.body.employeeId, {
    title: 'New Appraisal Recorded',
    body: `Your appraisal for ${doc.reviewPeriod} has been submitted — ${ratingLabel}.`,
    type: 'general',
  });

  notifyByRoles(['hr_manager', 'super_admin'], {
    title: 'Appraisal Submitted',
    body: `${req.user.name ?? 'Dept Head'} submitted an appraisal for ${empName} (${doc.reviewPeriod}) — ${ratingLabel}.`,
    type: 'general',
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateAppraisal = async (req, res) => {
  const update = { ...req.body };
  delete update._id;
  if (update.rating) update.rating = parseInt(update.rating);
  await updateOne('appraisal_records', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const getPerformanceAlerts = async (req, res) => {
  const flagged = await global.dbo.collection('appraisal_records').aggregate([
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
  const filter = {};
  const role = req.user.role;

  if (role === 'staff') {
    const emp = await findOne('employees', { userId: new ObjectId(req.user._id) }, { projection: { _id: 1, department: 1 } });
    // Staff see goals set explicitly for them OR goals visible to their team/company
    if (emp) {
      filter.$or = [
        { employeeId: emp._id },
        { visibility: { $in: ['team', 'company'] }, department: emp.department },
        { visibility: 'company' },
      ];
    }
  } else if (role === 'department_head') {
    if (req.query.employeeId) {
      filter.employeeId = new ObjectId(req.query.employeeId);
      // Dept heads cannot see private goals of other employees
      filter.visibility = { $in: ['team', 'company'] };
    }
    // No employeeId filter → dept head viewing team overview, still exclude private goals of others
    else {
      filter.$or = [
        { createdBy: new ObjectId(req.user._id) },
        { visibility: { $in: ['team', 'company'] } },
      ];
    }
  } else {
    // HR/super_admin see everything
    if (req.query.employeeId) filter.employeeId = new ObjectId(req.query.employeeId);
  }

  if (req.query.status) filter.status = req.query.status;
  if (req.query.period) filter.period = req.query.period;
  if (req.query.category) filter.category = req.query.category;

  const goals = await findMany('goals', filter, { sort: { createdAt: -1 } });
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

  const doc = {
    employeeId,
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

const _isHROrMgmt = (role) => ['super_admin', 'hr_manager', 'department_head'].includes(role);

const getGoal = async (req, res) => {
  const goal = await findOne('goals', { _id: new ObjectId(req.params.id) });
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!_isHROrMgmt(req.user.role) && String(goal.employeeId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }
  return returnFunction(res, 200, true, req.locale.success, goal);
};

const updateGoal = async (req, res) => {
  const goal = await findOne('goals', { _id: new ObjectId(req.params.id) });
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!_isHROrMgmt(req.user.role) && String(goal.employeeId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

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
  if (!_isHROrMgmt(req.user.role) && String(goal.employeeId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }
  await global.dbo.collection('goals').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const addCheckin = async (req, res) => {
  if (!validateRequiredFields(req, res, ['progress'])) return;

  const goal = await findOne('goals', { _id: new ObjectId(req.params.id) });
  if (!goal) return returnFunction(res, 404, false, 'Goal not found.');
  if (!_isHROrMgmt(req.user.role) && String(goal.employeeId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

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
  if (!_isHROrMgmt(req.user.role) && String(goal.employeeId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

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

// ── Review Cycles ─────────────────────────────────────────────────────────────

const listCycles = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const cycles = await findMany('review_cycles', filter, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, cycles);
};

const createCycle = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'type'])) return;

  const doc = {
    name: req.body.name,
    type: req.body.type,
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

  const total = cycle.participants.length;
  const completed = cycle.participants.filter(p => p.selfReviewStatus === 'submitted').length;

  return returnFunction(res, 200, true, req.locale.success, { ...cycle, total, completed });
};

const updateCycle = async (req, res) => {
  const update = { ...req.body };
  delete update._id;
  update.updatedAt = new Date();
  await updateOne('review_cycles', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const launchCycle = async (req, res) => {
  const cycle = await findOne('review_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, 'Cycle not found.');
  if (cycle.status === 'active') return returnFunction(res, 400, false, 'Cycle is already active.');

  const employees = await findMany('employees', { status: 'active' }, { projection: { _id: 1, userId: 1 } });
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
  if (req.query.employeeId) filter.employeeId = new ObjectId(req.query.employeeId);
  if (req.query.reviewerId) filter.reviewerId = new ObjectId(req.query.reviewerId);

  if (req.user.role === 'staff') {
    const emp = await findOne('employees', { userId: new ObjectId(req.user._id) }, { projection: { _id: 1 } });
    if (emp) filter.employeeId = emp._id;
  }

  const reviews = await findMany('reviews', filter, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, reviews);
};

const getReview = async (req, res) => {
  const review = await findOne('reviews', { _id: new ObjectId(req.params.id) });
  if (!review) return returnFunction(res, 404, false, 'Review not found.');

  if (!_isHROrMgmt(req.user.role) &&
      String(review.reviewerId) !== String(req.user._id) &&
      String(review.employeeId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'Forbidden.');
  }

  const [employee, reviewer, cycle] = await Promise.all([
    findOne('employees', { _id: review.employeeId }, { projection: { fullName: 1, designation: 1, department: 1 } }),
    findOne('users', { _id: review.reviewerId }, { projection: { name: 1 } }),
    findOne('review_cycles', { _id: review.cycleId }, { projection: { name: 1, type: 1, phases: 1 } }),
  ]);

  return returnFunction(res, 200, true, req.locale.success, { ...review, employee, reviewer, cycle });
};

const upsertReview = async (req, res) => {
  const { cycleId, employeeId, reviewType } = req.body;
  if (!validateRequiredFields(req, res, ['cycleId', 'employeeId', 'reviewType'])) return;

  const filter = {
    cycleId: new ObjectId(cycleId),
    employeeId: new ObjectId(employeeId),
    reviewType,
  };

  const existing = await findOne('reviews', filter);

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
  if (!_isHROrMgmt(req.user.role) && String(review.reviewerId) !== String(req.user._id)) {
    return returnFunction(res, 403, false, 'Only the assigned reviewer can submit this review.');
  }

  await updateOne('reviews', { _id: new ObjectId(req.params.id) }, {
    $set: {
      status: 'submitted',
      recommendation: req.body.recommendation || null,
      overallRating: req.body.overallRating ? Number(req.body.overallRating) : review.overallRating,
      submittedAt: new Date(),
      updatedAt: new Date(),
    },
  });

  await global.dbo.collection('review_cycles').updateOne(
    { _id: review.cycleId, 'participants.employeeId': review.employeeId },
    { $set: { 'participants.$.selfReviewStatus': 'submitted', 'participants.$.selfReviewSubmittedAt': new Date() } }
  );

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

const listFeedback = async (req, res) => {
  const userId = new ObjectId(req.user._id);
  const emp = await findOne('employees', { userId }, { projection: { _id: 1 } });
  const empId = emp?._id;

  const filter = empId
    ? { $or: [{ giverId: userId }, { recipientId: userId }, { giverId: empId }, { recipientId: empId }] }
    : { $or: [{ giverId: userId }, { recipientId: userId }] };

  if (req.query.type === 'received') delete filter.$or, filter.recipientId = empId || userId;
  if (req.query.type === 'given')    delete filter.$or, filter.giverId    = empId || userId;

  const feedback = await findMany('feedback', filter, { sort: { createdAt: -1 } });

  const enriched = await Promise.all(feedback.map(async (f) => {
    const giver = await findOne('employees', { _id: f.giverId }, { projection: { fullName: 1 } })
      || await findOne('users', { _id: f.giverId }, { projection: { name: 1 } });
    const recipient = await findOne('employees', { _id: f.recipientId }, { projection: { fullName: 1 } })
      || await findOne('users', { _id: f.recipientId }, { projection: { name: 1 } });
    return {
      ...f,
      giverName: giver?.fullName || giver?.name || 'Anonymous',
      recipientName: recipient?.fullName || recipient?.name || 'Unknown',
    };
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
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

// ── Analytics ─────────────────────────────────────────────────────────────────

const getAnalytics = async (req, res) => {
  const [
    goalsTotal,
    goalsCompleted,
    goalsAtRisk,
    reviewsTotal,
    reviewsSubmitted,
    cycles,
    recentAppraisals,
  ] = await Promise.all([
    global.dbo.collection('goals').countDocuments({}),
    global.dbo.collection('goals').countDocuments({ status: 'completed' }),
    global.dbo.collection('goals').countDocuments({ status: 'at_risk' }),
    global.dbo.collection('reviews').countDocuments({}),
    global.dbo.collection('reviews').countDocuments({ status: 'submitted' }),
    findMany('review_cycles', { status: 'active' }, { sort: { createdAt: -1 } }),
    global.dbo.collection('appraisal_records').aggregate([
      { $group: { _id: '$rating', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
  ]);

  const goalsByStatus = await aggregate('goals', [
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const appraisalByDept = await global.dbo.collection('appraisal_records').aggregate([
    { $lookup: { from: 'employees', localField: 'employeeId', foreignField: '_id', as: 'emp' } },
    { $unwind: '$emp' },
    { $group: { _id: '$emp.department', avgRating: { $avg: '$rating' }, count: { $sum: 1 } } },
    { $sort: { avgRating: -1 } },
    { $limit: 8 },
  ]).toArray();

  const avgScore = recentAppraisals.reduce((s, r) => s + r._id * r.count, 0) /
    Math.max(1, recentAppraisals.reduce((s, r) => s + r.count, 0));

  return returnFunction(res, 200, true, req.locale.success, {
    goalsCompletionRate: goalsTotal ? Math.round((goalsCompleted / goalsTotal) * 100) : 0,
    averagePerformanceScore: avgScore ? Math.round(avgScore * 10) / 10 : 0,
    reviewParticipationRate: reviewsTotal ? Math.round((reviewsSubmitted / reviewsTotal) * 100) : 0,
    activeCycles: cycles.length,
    goalsByStatus,
    ratingDistribution: recentAppraisals,
    departmentPerformance: appraisalByDept,
  });
};

module.exports = {
  // Legacy appraisal
  getEmployeePerformance,
  createAppraisal,
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
  // Review cycles
  listCycles,
  createCycle,
  getCycle,
  updateCycle,
  launchCycle,
  closeCycle,
  // Reviews
  listReviews,
  getReview,
  upsertReview,
  submitReview,
  // Calibration
  getCalibration,
  updateCalibrationBox,
  // Feedback
  listFeedback,
  giveFeedback,
  // Analytics
  getAnalytics,
};
