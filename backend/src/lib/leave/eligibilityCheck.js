// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 3a) —
// employees and leave_requests now live in Postgres.
const { findOne, knex } = require('../../functions/Database/pgDBFunctions');

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const monthsBetween = (from, to) => (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());

// Tenure check — has the employee worked long enough to be eligible for this leave type.
const checkEligibility = (employee, leaveType) => {
  if (!leaveType.eligibilityMonths) return { eligible: true };
  const hireDate = employee.dateOfHire ? new Date(employee.dateOfHire) : null;
  if (!hireDate) return { eligible: true };
  const tenureMonths = monthsBetween(hireDate, new Date());
  if (tenureMonths < leaveType.eligibilityMonths) {
    return { eligible: false, message: `You must have worked at least ${leaveType.eligibilityMonths} month(s) before applying for ${leaveType.name}.` };
  }
  return { eligible: true };
};

// Minimum notice check — startDate must be far enough in the future.
const checkMinNotice = (leaveType, startDate) => {
  if (!leaveType.minNoticeDays) return { ok: true };
  const noticeDays = Math.ceil((new Date(startDate) - new Date()) / MS_PER_DAY);
  if (noticeDays < leaveType.minNoticeDays) {
    return { ok: false, message: `${leaveType.name} requires at least ${leaveType.minNoticeDays} day(s) notice.` };
  }
  return { ok: true };
};

// Max consecutive days check.
const checkMaxConsecutive = (leaveType, totalDays) => {
  if (!leaveType.maxConsecutiveDays) return { ok: true };
  if (totalDays > leaveType.maxConsecutiveDays) {
    return { ok: false, message: `${leaveType.name} cannot be taken for more than ${leaveType.maxConsecutiveDays} consecutive day(s).` };
  }
  return { ok: true };
};

// Overlap detection — does this employee already have a pending/approved
// request overlapping the given date range (optionally excluding one request,
// for edit-in-place scenarios).
const checkOverlap = async (employeeId, startDate, endDate, excludeRequestId = null) => {
  let query = knex('leave_requests')
    .where({ employeeId: String(employeeId) })
    .whereIn('status', ['pending', 'approved'])
    .where('startDate', '<=', new Date(endDate))
    .where('endDate', '>=', new Date(startDate));
  if (excludeRequestId) query = query.whereNot('id', String(excludeRequestId));
  const existing = await query.first();
  return !!existing;
};

// Team overlap warning (non-blocking) — how many people from the same
// department are already approved for an overlapping period.
const TEAM_OVERLAP_WARNING_THRESHOLD = 2;
const checkTeamOverlap = async (department, startDate, endDate, excludeEmployeeId = null) => {
  const deptEmployees = await knex('employees').where({ department }).select('id');
  const deptIds = deptEmployees.map(e => e.id).filter(id => id !== String(excludeEmployeeId));
  if (!deptIds.length) return { count: 0, warn: false };
  const count = await knex('leave_requests')
    .whereIn('employeeId', deptIds).where({ status: 'approved' })
    .where('startDate', '<=', new Date(endDate)).where('endDate', '>=', new Date(startDate))
    .count('* as count').first().then((r) => Number(r.count));
  return { count, warn: count > TEAM_OVERLAP_WARNING_THRESHOLD };
};

module.exports = { checkEligibility, checkMinNotice, checkMaxConsecutive, checkOverlap, checkTeamOverlap, TEAM_OVERLAP_WARNING_THRESHOLD };
