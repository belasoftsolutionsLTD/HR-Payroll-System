const { findOne } = require('../../functions/Database/commonDBFunctions');
const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF, HR_ROLES } = require('../../constants/roles');

// Inventory has its own access model, layered on top of the app's 4 real roles —
// there is no "inventory" role, so this is computed per-request rather than gated
// purely by allowRoles(), matching the codebase's existing convention (e.g. attendance's
// isAuthorizedForEmployee) of "broad role gate at the route + real check in the handler".
//
//   'admin'   — super_admin / hr_manager. Full CRUD everywhere, valuation reports,
//               reorder points, can toggle the isInventoryClerk flag on staff.
//   'manager' — department_head, OR any employee referenced as someone else's managerId
//               (this app has no separate "manager" role — see attendance/leave for the
//               same convention). View-only, scoped to locations linked to their
//               department; can request stock transfers.
//   'clerk'   — a plain staff account with users.isInventoryClerk === true. Operational
//               access across all locations (view, record movements, receive POs,
//               approve/receive transfers) but no item/supplier/PO authoring, no
//               reorder-point edits, no valuation reports.
//   null      — no access at all.
const getInventoryAccessLevel = async (user) => {
  if (!user) return null;
  if (HR_ROLES.includes(user.role)) return 'admin';
  if (user.role === DEPT_HEAD) return 'manager';
  if (user.role === STAFF) {
    if (user.isInventoryClerk === true) return 'clerk';
    if (user.employeeId) {
      const directReport = await findOne('employees', { managerId: user.employeeId }, { projection: { _id: 1 } });
      if (directReport) return 'manager';
    }
  }
  return null;
};

// Locations a 'manager'-level user may see — matched by department. Admin/clerk get
// unrestricted access (null = no filter), same "null means unrestricted" convention
// used by attendance's getScopedEmployeeIds.
const getScopedLocationFilter = async (user, level) => {
  if (level === 'admin' || level === 'clerk') return null;
  if (!user.department) return { _id: { $in: [] } }; // no department on file — see nothing, not everything
  return { department: user.department };
};

module.exports = { getInventoryAccessLevel, getScopedLocationFilter };
