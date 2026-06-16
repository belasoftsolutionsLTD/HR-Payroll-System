const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');

// ── Positions ────────────────────────────────────────────────────────────────

const listPositions = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.department) filter.department = req.query.department;
  const { page, limit, skip } = getPagination(req.query);
  const total = await countDocuments('job_positions', filter);
  const data = await findMany('job_positions', filter, { skip, limit, sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

const createPosition = async (req, res) => {
  if (!validateRequiredFields(req, res, ['jobTitle', 'department', 'numberOfOpenings'])) return;
  const doc = {
    jobTitle: req.body.jobTitle,
    designation: req.body.designation || req.body.jobTitle,
    jobCategory: req.body.jobCategory || null,
    jobDescription: req.body.jobDescription || null,
    department: req.body.department,
    requiredQualifications: req.body.requiredQualifications || [],
    yearsOfExperience: req.body.yearsOfExperience ? Number(req.body.yearsOfExperience) : null,
    salaryBandMin: req.body.salaryBandMin ? Number(req.body.salaryBandMin) : null,
    salaryBandMax: req.body.salaryBandMax ? Number(req.body.salaryBandMax) : null,
    numberOfOpenings: Number(req.body.numberOfOpenings),
    filledCount: 0,
    stageRequirements: req.body.stageRequirements || [],
    status: 'open',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('job_positions', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updatePosition = async (req, res) => {
  const { id } = req.params;
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  await updateOne('job_positions', { _id: new ObjectId(id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deletePosition = async (req, res) => {
  const result = await global.dbo.collection('job_positions').deleteOne({ _id: new ObjectId(req.params.id) });
  if (!result.deletedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const patchPositionStatus = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  const allowed = ['open', 'filled', 'frozen'];
  if (!allowed.includes(req.body.status)) {
    return returnFunction(res, 400, false, 'Invalid status.');
  }
  await updateOne('job_positions', { _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Dashboard ────────────────────────────────────────────────────────────────

const getDashboard = async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());

  const [
    totalHeadcount,
    headcountByDept,
    teachingCount,
    nonTeachingCount,
    positionOpen,
    positionFilled,
    positionFrozen,
    pendingLeaveArr,
    newHires,
    expiringContracts,
    attendanceThisWeek,
    onboardingData,
    performanceConcerns,
  ] = await Promise.all([
    countDocuments('employees', { status: 'active' }),
    global.dbo.collection('employees').aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
    ]).toArray(),
    countDocuments('employees', { staffCategory: 'teaching', status: 'active' }),
    countDocuments('employees', { staffCategory: 'non-teaching', status: 'active' }),
    countDocuments('job_positions', { status: 'open' }),
    countDocuments('job_positions', { status: 'filled' }),
    countDocuments('job_positions', { status: 'frozen' }),
    findMany('leave_requests', { status: 'pending' }, { limit: 20, sort: { createdAt: -1 } }),
    findMany('employees', { dateOfHire: { $gte: startOfMonth }, status: 'active' }, { sort: { dateOfHire: -1 } }),
    global.dbo.collection('employees').find({
      contractEndDate: { $gte: now, $lte: thirtyDaysFromNow },
      status: 'active',
    }).toArray(),
    global.dbo.collection('attendance_records').aggregate([
      { $match: { date: { $gte: startOfWeek.toISOString().split('T')[0] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray(),
    global.dbo.collection('onboarding_tasks').aggregate([
      { $group: {
        _id: '$employeeId',
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
      }},
      { $match: { $expr: { $lt: ['$completed', '$total'] } } },
    ]).toArray(),
    global.dbo.collection('appraisal_records').aggregate([
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$employeeId', ratings: { $push: '$rating' } } },
      { $addFields: { lastTwo: { $slice: ['$ratings', 2] } } },
      { $match: { 'lastTwo.0': { $lte: 2 }, 'lastTwo.1': { $lte: 2 }, $expr: { $gte: [{ $size: '$lastTwo' }, 2] } } },
    ]).toArray(),
  ]);

  const presentCount = attendanceThisWeek.find((a) => a._id === 'present')?.count || 0;
  const totalAtt = attendanceThisWeek.reduce((s, a) => s + a.count, 0);
  const attendanceRateThisWeek = totalAtt > 0 ? Math.round((presentCount / totalAtt) * 100) : 0;

  const expiring = expiringContracts.map((e) => ({
    ...e,
    daysRemaining: Math.ceil((new Date(e.contractEndDate) - now) / (1000 * 60 * 60 * 24)),
  }));

  return returnFunction(res, 200, true, req.locale.success, {
    totalHeadcount,
    headcountByDepartment: headcountByDept.map((d) => ({ department: d._id, count: d.count })),
    teachingVsNonTeaching: { teaching: teachingCount, nonTeaching: nonTeachingCount },
    positionsSummary: { open: positionOpen, filled: positionFilled, frozen: positionFrozen },
    pendingLeaveRequests: { count: pendingLeaveArr.length, items: pendingLeaveArr },
    newHiresThisMonth: newHires,
    expiringContracts: expiring,
    attendanceRateThisWeek,
    performanceConcerns,
    onboardingProgress: onboardingData.map((o) => ({
      employeeId: o._id,
      total: o.total,
      completed: o.completed,
      percentage: Math.round((o.completed / o.total) * 100),
    })),
  });
};

// ── Notifications ─────────────────────────────────────────────────────────────

const getNotifications = async (req, res) => {
  const notifications = await findMany('notifications',
    { userId: new ObjectId(req.user._id), read: false },
    { sort: { createdAt: -1 }, limit: 50 }
  );
  return returnFunction(res, 200, true, req.locale.success, notifications);
};

const markNotificationRead = async (req, res) => {
  await updateOne('notifications',
    { _id: new ObjectId(req.params.id), userId: new ObjectId(req.user._id) },
    { $set: { read: true } }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const markAllNotificationsRead = async (req, res) => {
  await global.dbo.collection('notifications').updateMany(
    { userId: new ObjectId(req.user._id), read: false },
    { $set: { read: true } }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

module.exports = {
  listPositions, createPosition, updatePosition, deletePosition, patchPositionStatus,
  getDashboard,
  getNotifications, markNotificationRead, markAllNotificationsRead,
};
