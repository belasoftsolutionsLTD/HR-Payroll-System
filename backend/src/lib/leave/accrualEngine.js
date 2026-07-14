const { findMany, findOne, updateOne, insertOne } = require('../../functions/Database/commonDBFunctions');

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// Monthly accrual run — policy-driven (replaces the old single hardcoded
// 21-days/year env-var rate). Idempotent per calendar month via
// leave_balances.lastAccrualDate, same guard idiom as the old system.
const runAccrual = async (triggeredBy = null) => {
  const now = new Date();
  const year = now.getFullYear();
  const policies = await findMany('leave_accrual_policies', { isActive: true });
  if (!policies.length) return { processed: 0, message: 'No active accrual policies.' };

  const employees = await findMany('employees', { status: { $ne: 'inactive' } });
  const users = await findMany('users', { employeeId: { $in: employees.map(e => e._id) } }, { projection: { employeeId: 1, role: 1 } });
  const roleByEmployeeId = Object.fromEntries(users.map(u => [String(u.employeeId), u.role]));

  const policyApplies = (policy, employee) => {
    const { roles, departments, employmentTypes } = policy.appliesTo || {};
    if (roles?.length && !roles.includes(roleByEmployeeId[String(employee._id)])) return false;
    if (departments?.length && !departments.includes(employee.department)) return false;
    if (employmentTypes?.length && !employmentTypes.includes(employee.employmentType)) return false;
    return true;
  };

  let processed = 0;
  for (const policy of policies) {
    if (policy.accrualFrequency !== 'monthly') continue; // annual grants are applied at creation time, not accrued monthly
    for (const employee of employees) {
      if (!policyApplies(policy, employee)) continue;

      let balance = await findOne('leave_balances', { employeeId: employee._id, leaveTypeId: policy.leaveTypeId, year });
      if (!balance) {
        const { insertedId } = await insertOne('leave_balances', {
          employeeId: employee._id, leaveTypeId: policy.leaveTypeId, year,
          openingBalance: 0, accrued: 0, used: 0, pending: 0, carriedOver: 0, carryOverExpiry: null,
          closingBalance: 0, lastAccrualDate: null, updatedAt: now,
        });
        balance = { _id: insertedId, openingBalance: 0, accrued: 0, used: 0, pending: 0, carriedOver: 0, lastAccrualDate: null };
      }

      const lastMonth = balance.lastAccrualDate ? monthKey(new Date(balance.lastAccrualDate)) : null;
      if (lastMonth === monthKey(now)) continue;

      const room = Math.max(0, policy.maxAnnualEntitlement - balance.accrued);
      const amount = Math.min(policy.accrualAmount, room);
      if (amount <= 0) continue;

      const newAccrued = balance.accrued + amount;
      const newClosing = balance.openingBalance + newAccrued + balance.carriedOver - balance.used - balance.pending;
      await updateOne('leave_balances', { _id: balance._id }, {
        $set: { accrued: newAccrued, closingBalance: newClosing, lastAccrualDate: now, updatedAt: now },
      });

      await insertOne('leave_audit_log', {
        leaveRequestId: null, employeeId: employee._id, action: 'balanceAdjusted',
        performedBy: triggeredBy, performedByName: triggeredBy ? null : 'System (cron)',
        previousValue: { accrued: balance.accrued }, newValue: { accrued: newAccrued },
        comment: `Monthly accrual: +${amount} days (${policy.name})`, timestamp: now,
      });
      processed += 1;
    }
  }
  return { processed };
};

// Year-end carry-over — for each leave type with isCarryOverAllowed, moves
// each employee's unused closing balance (capped at maxCarryOverDays) into a
// fresh next-year balance record. Idempotent: skips employees who already
// have a next-year balance for that leave type.
const runYearEndCarryOver = async (triggeredBy = null) => {
  const now = new Date();
  const currentYear = now.getFullYear();
  const previousYear = currentYear - 1;
  const leaveTypes = await findMany('leave_types', { isCarryOverAllowed: true, isActive: true });

  let processed = 0;
  for (const lt of leaveTypes) {
    const balances = await findMany('leave_balances', { leaveTypeId: lt._id, year: previousYear });
    for (const bal of balances) {
      const existing = await findOne('leave_balances', { employeeId: bal.employeeId, leaveTypeId: lt._id, year: currentYear });
      if (existing) continue;

      const unused = Math.max(0, bal.closingBalance);
      const carriedOver = lt.maxCarryOverDays != null ? Math.min(unused, lt.maxCarryOverDays) : unused;
      const carryOverExpiry = lt.carryOverExpiryMonths
        ? new Date(currentYear, now.getMonth() + lt.carryOverExpiryMonths, now.getDate())
        : null;

      await insertOne('leave_balances', {
        employeeId: bal.employeeId, leaveTypeId: lt._id, year: currentYear,
        openingBalance: 0, accrued: 0, used: 0, pending: 0,
        carriedOver, carryOverExpiry, closingBalance: carriedOver,
        lastAccrualDate: null, updatedAt: now,
      });

      await insertOne('leave_audit_log', {
        leaveRequestId: null, employeeId: bal.employeeId, action: 'balanceAdjusted',
        performedBy: triggeredBy, performedByName: triggeredBy ? null : 'System (cron)',
        previousValue: null, newValue: { carriedOver },
        comment: `Year-end carry-over from ${previousYear}: ${carriedOver} days (${lt.name})`, timestamp: now,
      });
      processed += 1;
    }
  }
  return { processed };
};

module.exports = { runAccrual, runYearEndCarryOver };
