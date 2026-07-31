const { findMany } = require('../../functions/Database/commonDBFunctions');
const { DEPT_HEAD, STAFF, HR_ROLES, ALL_ROLES } = require('../../constants/roles');

// Same "no dedicated role, computed per-request" convention as Inventory/POS — but
// unlike those two, CRM scopes by WHO a record is assigned to (a salesperson's own
// book of contacts/deals), not by location. Every real role gets SOME access here
// (no gating flag like isInventoryClerk/posLocationIds needed — a plain staff account
// is a sales rep by default in this module):
//   'admin'   — super_admin / hr_manager. Every contact/deal, custom field config,
//               cross-team reporting.
//   'manager' — department_head, OR any employee referenced as someone else's
//               managerId (same convention as Inventory/POS). Sees their team's
//               contacts/deals (their own + their direct reports'), can reassign.
//   'staff'   — only contacts/deals assigned to them. Cannot reassign or see anyone
//               else's pipeline.
const getCrmAccessLevel = async (user) => {
  if (!user) return null;
  if (HR_ROLES.includes(user.role)) return 'admin';
  if (user.role === DEPT_HEAD) return 'manager';
  if (user.role === STAFF) {
    if (user.employeeId) {
      const directReport = await findMany('employees', { managerId: user.employeeId }, { projection: { _id: 1 } });
      if (directReport.length) return 'manager';
    }
    return 'staff';
  }
  return null;
};

// User ids (against assignedTo/ownerId fields) a given level may see. null = unrestricted.
const getScopedAssigneeIds = async (user, level) => {
  if (level === 'admin') return null;
  if (level === 'staff') return [user._id];

  // 'manager' — self + direct reports' linked user accounts. Two hops: employees
  // reporting to this manager -> the users documents linked to those employees.
  if (!user.employeeId) return [user._id];
  const reports = await findMany('employees', { managerId: user.employeeId }, { projection: { _id: 1 } });
  const reportEmployeeIds = reports.map((e) => e._id);
  const reportUsers = reportEmployeeIds.length
    ? await findMany('users', { employeeId: { $in: reportEmployeeIds } }, { projection: { _id: 1 } })
    : [];
  return [user._id, ...reportUsers.map((u) => u._id)];
};

const canAccessAssignee = async (user, level, assigneeId) => {
  const scoped = await getScopedAssigneeIds(user, level);
  if (scoped === null) return true;
  return scoped.some((id) => String(id) === String(assigneeId));
};

// Candidate list for the "reassign this deal/contact" picker — every user an
// admin/manager is allowed to hand a record to, scoped the same way everything else is.
const listTeamMembers = async (user, level) => {
  if (level === 'admin') {
    return findMany('users', { role: { $in: ALL_ROLES } }, { projection: { name: 1, email: 1, role: 1 } });
  }
  const scoped = await getScopedAssigneeIds(user, level);
  return findMany('users', { _id: { $in: scoped } }, { projection: { name: 1, email: 1, role: 1 } });
};

module.exports = { getCrmAccessLevel, getScopedAssigneeIds, canAccessAssignee, listTeamMembers };
