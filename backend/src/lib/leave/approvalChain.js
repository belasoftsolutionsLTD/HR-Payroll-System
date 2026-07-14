const { ObjectId } = require('mongodb');
const { findOne } = require('../../functions/Database/commonDBFunctions');

// Days above this threshold always escalate to HR as the final approval level,
// regardless of how many levels already exist — matches the spec's "Level 3:
// hr — only if amount of days exceeds a configured threshold."
const HR_ESCALATION_THRESHOLD_DAYS = 5;

// Resolves the approval chain for a leave request at submission time.
// Level 1 — employee's direct manager (employees.managerId), same idiom as
//   every other module this session (no dedicated 'manager' role exists).
// Level 2 — the employee's department head (a real role, found via
//   users.department matching the employee's department).
// Level 3 — HR, only if totalDays exceeds HR_ESCALATION_THRESHOLD_DAYS, or as
//   a fallback if neither a manager nor a department head could be resolved
//   (so a request never ends up with nobody able to act on it).
const resolveApprovalChain = async (employee, totalDays) => {
  const chain = [];
  let level = 0;

  if (employee.managerId) {
    const manager = await findOne('employees', { _id: new ObjectId(employee.managerId) });
    if (manager) {
      const managerUser = await findOne('users', { employeeId: manager._id });
      if (managerUser) {
        level += 1;
        chain.push({
          level, approverId: managerUser._id, approverName: manager.fullName,
          approverRole: 'manager', status: 'pending', actedAt: null, comment: null,
        });
      }
    }
  }

  const deptHeadUser = await findOne('users', { role: 'department_head', department: employee.department });
  if (deptHeadUser && String(deptHeadUser.employeeId) !== String(employee._id)) {
    level += 1;
    chain.push({
      level, approverId: deptHeadUser._id, approverName: deptHeadUser.name,
      approverRole: 'department_head', status: 'pending', actedAt: null, comment: null,
    });
  }

  if (totalDays > HR_ESCALATION_THRESHOLD_DAYS || chain.length === 0) {
    const hrUser = await findOne('users', { role: { $in: ['super_admin', 'hr_manager'] } });
    if (hrUser) {
      level += 1;
      chain.push({
        level, approverId: hrUser._id, approverName: hrUser.name,
        approverRole: hrUser.role, status: 'pending', actedAt: null, comment: null,
      });
    }
  }

  return chain;
};

module.exports = { resolveApprovalChain, HR_ESCALATION_THRESHOLD_DAYS };
