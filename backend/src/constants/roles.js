const SUPER_ADMIN    = 'super_admin';
const HR_MANAGER     = 'hr_manager';
const DEPT_HEAD      = 'department_head';
const STAFF          = 'staff';

const HR_ROLES       = [SUPER_ADMIN, HR_MANAGER];
const MGMT_ROLES     = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD];
const ALL_ROLES      = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF];

module.exports = { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD, STAFF, HR_ROLES, MGMT_ROLES, ALL_ROLES };
