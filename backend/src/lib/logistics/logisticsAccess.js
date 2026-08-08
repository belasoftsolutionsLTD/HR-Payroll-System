// Postgres migration (Phase 8) — employees/logistics_vehicles are Postgres now (employees
// since Phase 1, logistics_vehicles this phase); this file was still reading employees
// off the Mongo helper (found while sweeping for Phase 8, same gap as every other
// module's own accessLevel file before its phase).
const { knex } = require('../../functions/Database/pgDBFunctions');
const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF } = require('../../constants/roles');

// Logistics has its own access model layered on the app's 4 real roles, same convention
// as Inventory/POS/Accounting ("manager" is computed — department_head, or a plain staff
// account referenced as someone else's managerId — there is no separate "manager" role
// anywhere in this codebase). The spec's "hr" maps to HR_MANAGER.
//
//   'admin'     — super_admin. Full access: fleet setup (create/archive vehicles),
//                 compliance records, everything an opsAdmin can do.
//   'opsAdmin'  — hr_manager. Full transactional access — vehicle assignment, route
//                 planning, shipment tracking, maintenance scheduling — but not fleet
//                 setup or compliance-record structure (mirrors Accounting's
//                 admin-vs-bookkeeper split between structural and transactional).
//   'manager'   — department_head, OR a plain staff account with a direct report.
//                 View/manage routes and shipments for their own team/location, can mark
//                 deliveries complete, cannot touch fleet setup or compliance records.
//   'driver'    — a plain staff account currently assigned as a vehicle's driver
//                 (vehicles.driverId === employeeId). Sees only their own assigned route
//                 and stops, can update stop status and capture proof of delivery.
//   null        — no access at all.
const getLogisticsAccessLevel = async (user) => {
  if (!user) return null;
  if (user.role === SUPER_ADMIN) return 'admin';
  if (user.role === HR_MANAGER) return 'opsAdmin';
  if (user.role === DEPT_HEAD) return 'manager';
  if (user.role === STAFF) {
    if (user.employeeId) {
      const directReport = await knex('employees').where({ managerId: String(user.employeeId) }).select('id').first();
      if (directReport) return 'manager';
      const assignedVehicle = await knex('logistics_vehicles').where({ driverId: String(user.employeeId) }).select('id').first();
      if (assignedVehicle) return 'driver';
    }
  }
  return null;
};

// 'manager'-level scoping — matched by department, same "null means unrestricted"
// convention used by Inventory's getScopedLocationFilter / Attendance's getScopedEmployeeIds.
const getLogisticsDepartmentFilter = (user, level) => {
  if (level === 'admin' || level === 'opsAdmin') return null;
  if (!user.department) return { department: '__none__' };
  return { department: user.department };
};

module.exports = { getLogisticsAccessLevel, getLogisticsDepartmentFilter };
