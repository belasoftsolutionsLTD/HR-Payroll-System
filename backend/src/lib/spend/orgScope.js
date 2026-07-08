const { findOne, findMany } = require('../../functions/Database/commonDBFunctions');
const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD } = require('../../constants/roles');

// Spend Management (Expenses + Procurement) has no "manager" role in this app — only
// super_admin/hr_manager/department_head/staff exist. "Manager" is a relationship
// (employees.managerId, self-referential) already used elsewhere for notifications
// (see inboxFunctions.js notifyManager), not a JWT role. These helpers resolve that
// relationship instead of gating on a role string that doesn't exist.
//
// req.user only ever carries `employeeId` from the users doc (see AuthMiddleware.js
// getUserData) — department and manager relationships always require a follow-up
// employees lookup, which is what getRequesterContext does.

const getRequesterContext = async (req) => {
  const role = req.user?.role;
  const isHR = [SUPER_ADMIN, HR_MANAGER].includes(role);
  const isDeptHead = role === DEPT_HEAD;
  const employee = req.user?.employeeId
    ? await findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1, managerId: 1 } })
    : null;
  return {
    role, isHR, isDeptHead,
    employeeId: req.user?.employeeId ?? null,
    department: employee?.department ?? null,
  };
};

// Employee ids who report directly to this employeeId, via employees.managerId.
const getDirectReportIds = async (employeeId) => {
  if (!employeeId) return [];
  const reports = await findMany('employees', { managerId: employeeId }, { projection: { _id: 1 } });
  return reports.map((r) => r._id);
};

// Scopes a list query on a spend-management collection keyed by `employeeId` (and,
// for department-level access, a `department` string field on the same document).
// HR/super_admin: unrestricted. department_head: their department only. Anyone who
// has direct reports (checked via the employees chain, not a role): those reports'
// records plus their own. Everyone else: their own records only.
const buildSpendScopeFilter = async (req) => {
  const ctx = await getRequesterContext(req);
  if (ctx.isHR) return {};
  if (ctx.isDeptHead) return { department: ctx.department };
  const reportIds = await getDirectReportIds(ctx.employeeId);
  if (reportIds.length) return { employeeId: { $in: [...reportIds, ctx.employeeId] } };
  return { employeeId: ctx.employeeId };
};

// Whether this requester may view/act on a single record belonging to `recordEmployeeId`
// in `recordDepartment`. Same rule set as buildSpendScopeFilter, applied to one record.
const canAccessRecord = async (req, recordEmployeeId, recordDepartment) => {
  const ctx = await getRequesterContext(req);
  if (ctx.isHR) return true;
  if (ctx.isDeptHead) return ctx.department && ctx.department === recordDepartment;
  if (ctx.employeeId && String(ctx.employeeId) === String(recordEmployeeId)) return true;
  const reportIds = await getDirectReportIds(ctx.employeeId);
  return reportIds.some((id) => String(id) === String(recordEmployeeId));
};

// Whether this requester is the direct manager of recordEmployeeId (level-1 approval).
const isDirectManagerOf = async (req, recordEmployeeId) => {
  if (!req.user?.employeeId || !recordEmployeeId) return false;
  const employee = await findOne('employees', { _id: recordEmployeeId }, { projection: { managerId: 1 } });
  return !!employee?.managerId && String(employee.managerId) === String(req.user.employeeId);
};

module.exports = { getRequesterContext, getDirectReportIds, buildSpendScopeFilter, canAccessRecord, isDirectManagerOf };
