const { ObjectId } = require('mongodb');
const { findOne, findMany } = require('../../functions/Database/commonDBFunctions');

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
  const filter = {
    employeeId: new ObjectId(employeeId),
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: new Date(endDate) },
    endDate: { $gte: new Date(startDate) },
  };
  if (excludeRequestId) filter._id = { $ne: new ObjectId(excludeRequestId) };
  const existing = await findOne('leave_requests', filter);
  return !!existing;
};

// Team overlap warning (non-blocking) — how many people from the same
// department are already approved for an overlapping period.
const TEAM_OVERLAP_WARNING_THRESHOLD = 2;
const checkTeamOverlap = async (department, startDate, endDate, excludeEmployeeId = null) => {
  const deptEmployees = await findMany('employees', { department }, { projection: { _id: 1 } });
  const deptIds = deptEmployees.map(e => e._id).filter(id => String(id) !== String(excludeEmployeeId));
  if (!deptIds.length) return { count: 0, warn: false };
  const count = await global.dbo.collection('leave_requests').countDocuments({
    employeeId: { $in: deptIds },
    status: 'approved',
    startDate: { $lte: new Date(endDate) },
    endDate: { $gte: new Date(startDate) },
  });
  return { count, warn: count > TEAM_OVERLAP_WARNING_THRESHOLD };
};

module.exports = { checkEligibility, checkMinNotice, checkMaxConsecutive, checkOverlap, checkTeamOverlap, TEAM_OVERLAP_WARNING_THRESHOLD };
