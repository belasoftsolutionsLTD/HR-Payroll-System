const calculateWorkingDays = (startDate, endDate, holidaySet = new Set()) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const day = cur.getDay();
    const dateStr = cur.toISOString().split('T')[0];
    if (day !== 0 && day !== 6 && !holidaySet.has(dateStr)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
};

// Async version that fetches public holidays from DB and excludes them.
// public_holidays now lives in Postgres (Phase 3a — see
// /home/carole/.claude/plans/abundant-dreaming-flurry.md).
const calculateWorkingDaysDB = async (startDate, endDate) => {
  let holidaySet = new Set();
  try {
    const knex = require('../Database/pgClient');
    const holidays = await knex('public_holidays')
      .where('date', '>=', startDate).where('date', '<=', endDate)
      .select('date');
    holidaySet = new Set(holidays.map(h => h.date));
  } catch {
    // Fall back to weekend-only calculation if DB unavailable
  }
  return calculateWorkingDays(startDate, endDate, holidaySet);
};

module.exports = { calculateWorkingDays, calculateWorkingDaysDB };
