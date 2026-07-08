const { ObjectId } = require('mongodb');
const { findOne } = require('../../functions/Database/commonDBFunctions');

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
  const employee = await findOne('employees', { _id: employeeId });
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
        findOne('employees', { _id: employee.managerId }, { projection: { fullName: 1 } }),
        findOne('users', { employeeId: employee.managerId }, { projection: { _id: 1, name: 1 } }),
      ]);
      if (managerUser) approver = { _id: managerUser._id, name: managerEmp?.fullName || managerUser.name };
    } else if (levelSpec.approverRole === 'department_head' && employee.department) {
      const deptHeadUser = await findOne('users', { role: 'department_head', department: employee.department }, { projection: { _id: 1, name: 1 } });
      if (deptHeadUser) approver = { _id: deptHeadUser._id, name: deptHeadUser.name };
    } else if (['hr_manager', 'hr'].includes(levelSpec.approverRole)) {
      const hrUser = await findOne('users', { role: { $in: ['hr_manager', 'super_admin'] } }, { projection: { _id: 1, name: 1 } });
      if (hrUser) approver = { _id: hrUser._id, name: hrUser.name };
    } else if (levelSpec.approverRole === 'specificUser' && levelSpec.approverId) {
      const specificUser = await findOne('users', { _id: new ObjectId(levelSpec.approverId) }, { projection: { _id: 1, name: 1 } });
      if (specificUser) approver = { _id: specificUser._id, name: specificUser.name };
    }

    if (approver) {
      chain.push({
        level: levelSpec.level,
        approverId: approver._id,
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
  if (levelEntry && String(levelEntry.approverId) === String(req.user?._id)) return true;
  if (req.user?.role === 'department_head' && req.user?.employeeId && record.employeeId) {
    const [recordEmp, reqEmp] = await Promise.all([
      findOne('employees', { _id: record.employeeId }, { projection: { department: 1 } }),
      findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1 } }),
    ]);
    if (recordEmp?.department && reqEmp?.department && recordEmp.department === reqEmp.department) return true;
  }
  return false;
};

module.exports = { buildApprovalChain, findCurrentLevelEntry, canActOnLevel };
