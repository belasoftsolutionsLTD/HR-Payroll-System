const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');

// Job requisitions now live in the recruitment module (jobRequisitions collection) —
// see backend/src/routes/recruitment/recruitmentFunctions.js

// ── Org Chart ────────────────────────────────────────────────────────────────

const getOrgChart = async (req, res) => {
  const filter = { status: { $nin: ['terminated'] } };

  // Dept heads only see their own department's branch — matches listEmployees' scoping.
  if (req.user.role === 'department_head') {
    const empRecord = req.user.employeeId
      ? await findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1 } })
      : null;
    if (empRecord?.department) filter.department = empRecord.department;
    else return returnFunction(res, 200, true, req.locale.success, { departments: [], total: 0 });
  }

  const employees = await findMany(
    'employees',
    filter,
    {
      projection: { fullName: 1, designation: 1, department: 1, status: 1, staffNumber: 1, profilePhoto: 1, email: 1, managerId: 1 },
      sort: { fullName: 1 },
    }
  );

  // Real managerId-based hierarchy. An employee whose manager isn't in this
  // (possibly department-scoped) result set becomes a root — e.g. a department
  // head's own manager sits in a different department and won't be in a
  // department-scoped fetch, so their subtree still needs a place to attach.
  const nodeMap = {};
  employees.forEach(e => { nodeMap[String(e._id)] = { ...e, reports: [] }; });
  const roots = [];
  employees.forEach(e => {
    const node = nodeMap[String(e._id)];
    if (e.managerId && nodeMap[String(e.managerId)]) {
      nodeMap[String(e.managerId)].reports.push(node);
    } else {
      roots.push(node);
    }
  });

  const deptMap = {};
  for (const emp of employees) {
    const dept = emp.department || 'Unassigned';
    if (!deptMap[dept]) deptMap[dept] = { name: dept, employees: [] };
    deptMap[dept].employees.push(emp);
  }

  const departments = Object.values(deptMap).sort((a, b) => b.employees.length - a.employees.length);
  return returnFunction(res, 200, true, req.locale.success, { tree: roots, departments, total: employees.length });
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
  getOrgChart, getAllDocuments,
  getNotifications, markNotificationRead, markAllNotificationsRead,
};
