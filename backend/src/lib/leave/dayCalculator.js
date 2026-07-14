const { calculateWorkingDays, calculateWorkingDaysDB } = require('../../functions/HR/leaveCalculator');

// Wraps the existing (kept-as-is, payroll also depends on it) weekend+holiday
// calculator with leave-specific rules: countPublicHolidays (per leave type)
// and half-day adjustment. Dates are normalized to 'YYYY-MM-DD' strings to
// match leaveCalculator.js's string-keyed holiday set.
const calculateLeaveDays = async ({ startDate, endDate, countPublicHolidays = false, halfDay = null }) => {
  const startStr = new Date(startDate).toISOString().split('T')[0];
  const endStr = new Date(endDate).toISOString().split('T')[0];

  // Public holidays inside the period still count as leave days when
  // countPublicHolidays is true — don't exclude them in that case.
  const days = countPublicHolidays
    ? calculateWorkingDays(startStr, endStr, new Set())
    : await calculateWorkingDaysDB(startStr, endStr);

  return halfDay ? days - 0.5 : days;
};

module.exports = { calculateLeaveDays };
