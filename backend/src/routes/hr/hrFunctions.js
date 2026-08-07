const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, updateOne } = require('../../functions/Database/commonDBFunctions');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 1) —
// employees now live in Postgres; notifications is unmigrated (Phase 10), so it stays
// on the Mongo helpers above.
const pgDB = require('../../functions/Database/pgDBFunctions');

// Job requisitions now live in the recruitment module (jobRequisitions collection) —
// see backend/src/routes/recruitment/recruitmentFunctions.js

// ── Org Chart ────────────────────────────────────────────────────────────────

const getOrgChart = async (req, res) => {
  let query = pgDB.knex('employees').whereNot('status', 'terminated');

  // Dept heads only see their own department's branch — matches listEmployees' scoping.
  if (req.user.role === 'department_head') {
    const empRecord = req.user.employeeId
      ? await pgDB.findOne('employees', { id: req.user.employeeId.toString() })
      : null;
    if (empRecord?.department) query = query.where({ department: empRecord.department });
    else return returnFunction(res, 200, true, req.locale.success, { departments: [], total: 0 });
  }

  const employees = await query
    .select('id', 'fullName', 'designation', 'department', 'status', 'staffNumber', 'profilePhoto', 'email', 'managerId')
    .orderBy('fullName', 'asc');

  // Real managerId-based hierarchy. An employee whose manager isn't in this
  // (possibly department-scoped) result set becomes a root — e.g. a department
  // head's own manager sits in a different department and won't be in a
  // department-scoped fetch, so their subtree still needs a place to attach.
  const nodeMap = {};
  employees.forEach(e => { nodeMap[e.id] = { ...e, _id: new ObjectId(e.id), reports: [] }; });
  const roots = [];
  employees.forEach(e => {
    const node = nodeMap[e.id];
    if (e.managerId && nodeMap[e.managerId]) {
      nodeMap[e.managerId].reports.push(node);
    } else {
      roots.push(node);
    }
  });

  const deptMap = {};
  for (const emp of employees) {
    const dept = emp.department || 'Unassigned';
    if (!deptMap[dept]) deptMap[dept] = { name: dept, employees: [] };
    deptMap[dept].employees.push({ ...emp, _id: new ObjectId(emp.id) });
  }

  const departments = Object.values(deptMap).sort((a, b) => b.employees.length - a.employees.length);
  return returnFunction(res, 200, true, req.locale.success, { tree: roots, departments, total: employees.length });
};

// ── Documents ─────────────────────────────────────────────────────────────────

const getAllDocuments = async (req, res) => {
  const { docType, search, department, staffNumber } = req.query;

  // department/staffNumber scope which EMPLOYEES are in play (matches exactly, like
  // the old $match-before-$unwind); docType/search then filter within that same set —
  // search is deliberately fuzzy (fileName OR the employee's own fullName), matching
  // the original aggregation's single $or.
  let employeesQuery = pgDB.knex('employees');
  if (department) employeesQuery = employeesQuery.where({ department });
  if (staffNumber) employeesQuery = employeesQuery.where({ staffNumber });
  const matchingEmployees = await employeesQuery.select('id', 'fullName', 'staffNumber', 'department');
  if (!matchingEmployees.length) return returnFunction(res, 200, true, req.locale.success, { documents: [], total: 0 });
  const employeeById = Object.fromEntries(matchingEmployees.map(e => [e.id, e]));

  let docsQuery = pgDB.knex('employee_documents').whereIn('employeeId', Object.keys(employeeById));
  if (docType) docsQuery = docsQuery.where({ docType });
  const docRows = await docsQuery;

  let documents = docRows
    .map(d => {
      const emp = employeeById[d.employeeId];
      return {
        _id: new ObjectId(d.id),
        employeeId: new ObjectId(d.employeeId),
        employeeName: emp?.fullName,
        employeeStaffNo: emp?.staffNumber,
        department: emp?.department,
        docType: d.docType,
        fileName: d.fileName,
        filePath: d.filePath,
        uploadedAt: d.uploadedAt,
      };
    })
    .filter(d => !search || d.fileName?.toLowerCase().includes(search.toLowerCase()) || d.employeeName?.toLowerCase().includes(search.toLowerCase()));

  documents.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return returnFunction(res, 200, true, req.locale.success, { documents, total: documents.length });
};

// ── Notifications ─────────────────────────────────────────────────────────────

const getNotifications = async (req, res) => {
  const notifications = await findMany('notifications',
    { userId: new ObjectId(req.user.id), read: false },
    { sort: { createdAt: -1 }, limit: 50 }
  );
  return returnFunction(res, 200, true, req.locale.success, notifications);
};

const markNotificationRead = async (req, res) => {
  await updateOne('notifications',
    { _id: new ObjectId(req.params.id), userId: new ObjectId(req.user.id) },
    { $set: { read: true } }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const markAllNotificationsRead = async (req, res) => {
  await global.dbo.collection('notifications').updateMany(
    { userId: new ObjectId(req.user.id), read: false },
    { $set: { read: true } }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

module.exports = {
  getOrgChart, getAllDocuments,
  getNotifications, markNotificationRead, markAllNotificationsRead,
};
