const { findOne, findMany } = require('../../functions/Database/commonDBFunctions');
const { DEPT_HEAD, STAFF, HR_ROLES } = require('../../constants/roles');

// Mirrors Inventory's access model exactly (lib/inventory/inventoryAccess.js) — same
// "no dedicated role, computed per-request" convention:
//   'admin'   — super_admin / hr_manager. Every register, every location, void/refund
//               approval anywhere, all-location daily summaries.
//   'manager' — department_head, OR any employee referenced as someone else's managerId
//               (this app has no separate "manager" role, same convention leave/
//               attendance/inventory all use). Full checkout at their department's
//               location(s), can void/refund same-day sales there.
//   'staff'   — a plain staff account, checkout-only, and ONLY at locations explicitly
//               assigned via users.posLocationIds (a new POS-owned field — Inventory has
//               no equivalent concept, a cashier isn't necessarily a department manager).
//               Cannot void or refund at all — that's manager/admin only.
//   null      — no POS access.
const getPosAccessLevel = async (user) => {
  if (!user) return null;
  if (HR_ROLES.includes(user.role)) return 'admin';
  if (user.role === DEPT_HEAD) return 'manager';
  if (user.role === STAFF) {
    if (user.employeeId) {
      const directReport = await findOne('employees', { managerId: user.employeeId }, { projection: { _id: 1 } });
      if (directReport) return 'manager';
    }
    return 'staff';
  }
  return null;
};

// Locations a given access level may sell from. null = unrestricted (admin).
const getScopedPosLocationIds = async (user, level) => {
  if (level === 'admin') return null;
  if (level === 'manager') {
    if (!user.department) return [];
    const locations = await findMany('inventory_locations', { department: user.department, isActive: { $ne: false } }, { projection: { _id: 1 } });
    return locations.map((l) => l._id);
  }
  // 'staff' — explicit assignment only, no department fallback (a cashier must be
  // deliberately assigned, unlike a manager who inherits their whole department).
  return (user.posLocationIds || []).map((id) => (typeof id === 'string' ? id : id));
};

const canSellAtLocation = async (user, level, locationId) => {
  const scoped = await getScopedPosLocationIds(user, level);
  if (scoped === null) return true;
  return scoped.some((id) => String(id) === String(locationId));
};

module.exports = { getPosAccessLevel, getScopedPosLocationIds, canSellAtLocation };
