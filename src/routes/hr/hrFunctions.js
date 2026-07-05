const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');

// Job requisitions now live in the recruitment module (jobRequisitions collection) —
// see backend/src/routes/recruitment/recruitmentFunctions.js

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
    countDocuments('jobRequisitions', { status: 'open' }),
    countDocuments('jobRequisitions', { status: 'filled' }),
    countDocuments('jobRequisitions', { status: 'onHold' }),
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

// ── Org Chart ────────────────────────────────────────────────────────────────

const getOrgChart = async (req, res) => {
  const employees = await findMany(
    'employees',
    { status: { $nin: ['terminated'] } },
    {
      projection: { fullName: 1, designation: 1, department: 1, status: 1, staffNumber: 1, profilePhoto: 1, email: 1, staffCategory: 1 },
      sort: { fullName: 1 },
    }
  );

  const deptMap = {};
  for (const emp of employees) {
    const dept = emp.department || 'Unassigned';
    if (!deptMap[dept]) deptMap[dept] = { name: dept, employees: [] };
    deptMap[dept].employees.push(emp);
  }

  const departments = Object.values(deptMap).sort((a, b) => b.employees.length - a.employees.length);
  return returnFunction(res, 200, true, req.locale.success, { departments, total: employees.length });
};

// ── Documents ─────────────────────────────────────────────────────────────────

const getAllDocuments = async (req, res) => {
  const { docType, search } = req.query;
  const match = { 'documents.0': { $exists: true } };
  if (docType) match['documents.docType'] = docType;

  const pipeline = [
    { $match: { documents: { $exists: true, $not: { $size: 0 } } } },
    { $unwind: '$documents' },
    ...(docType ? [{ $match: { 'documents.docType': docType } }] : []),
    ...(search ? [{ $match: { $or: [
      { 'documents.fileName': { $regex: search, $options: 'i' } },
      { fullName: { $regex: search, $options: 'i' } },
    ] } }] : []),
    { $project: {
      _id: '$documents.docId',
      employeeId: '$_id',
      employeeName: '$fullName',
      employeeStaffNo: '$staffNumber',
      department: '$department',
      docType: '$documents.docType',
      fileName: '$documents.fileName',
      filePath: '$documents.filePath',
      uploadedAt: '$documents.uploadedAt',
    } },
    { $sort: { uploadedAt: -1 } },
  ];

  const documents = await global.dbo.collection('employees').aggregate(pipeline).toArray();
  return returnFunction(res, 200, true, req.locale.success, { documents, total: documents.length });
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
  getDashboard,
  getOrgChart, getAllDocuments,
  getNotifications, markNotificationRead, markAllNotificationsRead,
};
