const { findOne } = require('../../functions/Database/commonDBFunctions');
const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF } = require('../../constants/roles');

// Accounting has its own access model layered on the app's 4 real roles, same convention
// as Inventory/POS/CRM ("manager" is computed — department_head, or a plain staff account
// referenced as someone else's managerId — there is no separate "manager" role anywhere
// in this codebase).
//
//   'admin'       — super_admin. Full Chart of Accounts control (create/edit/archive
//                   accounts), period open/close, everything a bookkeeper can do.
//   'bookkeeper'  — hr_manager. Full transactional access — manual journal entries, AR,
//                   AP, bank reconciliation, all reports — but cannot restructure the
//                   Chart of Accounts or close/reopen a period.
//   'viewer'      — department_head, OR a plain staff account with a direct report.
//                   Read-only, department-scoped financial REPORTS only — never the raw
//                   journal entry list/detail (enforced in each handler, not just here).
//   null          — no access at all. Accounting is the one module where a plain staff
//                   account gets nothing, not even a clerk-style operational tier.
const getAccountingAccessLevel = async (user) => {
  if (!user) return null;
  if (user.role === SUPER_ADMIN) return 'admin';
  if (user.role === HR_MANAGER) return 'bookkeeper';
  if (user.role === DEPT_HEAD) return 'viewer';
  if (user.role === STAFF && user.employeeId) {
    const directReport = await findOne('employees', { managerId: user.employeeId }, { projection: { _id: 1 } });
    if (directReport) return 'viewer';
  }
  return null;
};

// 'viewer'-level report scoping — matched by department. Admin/bookkeeper see everything
// (null = no filter), same "null means unrestricted" convention used elsewhere.
const getAccountingDepartmentFilter = (user, level) => {
  if (level === 'admin' || level === 'bookkeeper') return null;
  if (!user.department) return { 'lines.department': '__none__' }; // no department on file — see nothing
  return { 'lines.department': user.department };
};

module.exports = { getAccountingAccessLevel, getAccountingDepartmentFilter };
