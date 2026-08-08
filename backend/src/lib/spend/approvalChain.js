// Postgres migration (Phase 8) — employees/users have been Postgres since Phase 1; this
// file was still reading them off the Mongo helper.
const { knex } = require('../../functions/Database/pgDBFunctions');

// Resolves a concrete, ordered approval chain for one employee's expense claim or
// purchase request — always live from org data, never hardcoded approver ids.
// Default levels (used when a policy doesn't specify its own approvalChain):
//   1. the employee's direct manager (employees.managerId, a self-referential
//      employee link — resolved to that employee's user account)
//   2. the department_head user whose `department` matches the employee's department
//   3. HR (super_admin/hr_manager) — only once amount crosses the level's threshold
// A level is skipped (not blocking) if no approver can be resolved for it, so a
// claim never gets stuck because e.g. an employee has no manager on file.
const buildApprovalChain = async (employeeId, amount, policy) => {
  const chain = [];
  const employee = await knex('employees').where({ id: String(employeeId) }).first();
  if (!employee) return chain;

  const policyLevels = policy?.approvalChain?.length
    ? policy.approvalChain
    : [
        { level: 1, approverRole: 'manager' },
        { level: 2, approverRole: 'department_head' },
        { level: 3, approverRole: 'hr_manager', thresholdAmount: policy?.hrApprovalThreshold ?? null },
      ];

  for (const levelSpec of policyLevels) {
    if (levelSpec.thresholdAmount != null && amount <= levelSpec.thresholdAmount) continue;

    let approver = null;
    if (levelSpec.approverRole === 'manager' && employee.managerId) {
      const [managerEmp, managerUser] = await Promise.all([
        knex('employees').where({ id: employee.managerId }).select('fullName').first(),
        knex('users').where({ employeeId: employee.managerId }).select('id', 'name').first(),
      ]);
      if (managerUser) approver = { id: managerUser.id, name: managerEmp?.fullName || managerUser.name };
    } else if (levelSpec.approverRole === 'department_head' && employee.department) {
      const deptHeadUser = await knex('users').where({ role: 'department_head', department: employee.department }).select('id', 'name').first();
      if (deptHeadUser) approver = { id: deptHeadUser.id, name: deptHeadUser.name };
    } else if (['hr_manager', 'hr'].includes(levelSpec.approverRole)) {
      const hrUser = await knex('users').whereIn('role', ['hr_manager', 'super_admin']).select('id', 'name').first();
      if (hrUser) approver = { id: hrUser.id, name: hrUser.name };
    } else if (levelSpec.approverRole === 'specificUser' && levelSpec.approverId) {
      const specificUser = await knex('users').where({ id: String(levelSpec.approverId) }).select('id', 'name').first();
      if (specificUser) approver = { id: specificUser.id, name: specificUser.name };
    }

    if (approver) {
      chain.push({
        level: levelSpec.level,
        approverId: approver.id,
        approverName: approver.name || 'Unknown',
        approverRole: levelSpec.approverRole,
        status: 'pending',
        actedAt: null,
        comment: null,
        thresholdAmount: levelSpec.thresholdAmount ?? null,
      });
    }
  }
  return chain;
};

// ── Chain walking (shared by expense claims and purchase requests approve/reject) ──

const findCurrentLevelEntry = (record) => (record.approvalChain || []).find(
  (a) => a.level === record.currentApprovalLevel && a.status === 'pending'
);

// HR/super_admin: always allowed (override any level). The exact resolved approver
// for the current level: always allowed. A department_head: allowed on any record
// whose owning employee shares their department, even if the auto-resolved chain
// couldn't find a specific department_head user at submit time (e.g. none existed
// yet). Everyone else: not authorized.
const canActOnLevel = async (req, record, levelEntry) => {
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (isHR) return true;
  if (levelEntry && String(levelEntry.approverId) === String(req.user?.id)) return true;
  if (req.user?.role === 'department_head' && req.user?.employeeId && record.employeeId) {
    const [recordEmp, reqEmp] = await Promise.all([
      knex('employees').where({ id: String(record.employeeId) }).select('department').first(),
      knex('employees').where({ id: String(req.user.employeeId) }).select('department').first(),
    ]);
    if (recordEmp?.department && reqEmp?.department && recordEmp.department === reqEmp.department) return true;
  }
  return false;
};

module.exports = { buildApprovalChain, findCurrentLevelEntry, canActOnLevel };
