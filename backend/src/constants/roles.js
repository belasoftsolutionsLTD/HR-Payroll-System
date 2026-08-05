const SUPER_ADMIN    = 'super_admin';
const HR_MANAGER     = 'hr_manager';
const DEPT_HEAD      = 'department_head';
const STAFF          = 'staff';
// Sales-demo visitor — deliberately excluded from HR_ROLES/MGMT_ROLES/ALL_ROLES so
// no existing allowRoles() gate ever admits it by accident. Only the dedicated
// /api/demo routes (backend/src/routes/demo) allow this role, and those routes only
// ever touch documents flagged isDemoData:true — never real company data.
const GUEST          = 'guest';

const HR_ROLES       = [SUPER_ADMIN, HR_MANAGER];
const MGMT_ROLES     = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD];
const ALL_ROLES      = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF];

module.exports = { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF, GUEST, HR_ROLES, MGMT_ROLES, ALL_ROLES };
