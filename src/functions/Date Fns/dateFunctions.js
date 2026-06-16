const { defaultTimezone } = require('../../configs/constants');

/**
 * Returns the current UTC date as a JS Date object.
 */
const nowUTC = () => new Date();

/**
 * Formats a Date to an ISO date string (YYYY-MM-DD) in the default timezone.
 * Uses Intl.DateTimeFormat — no external dependency.
 */
const toLocaleDateString = (date, timezone = defaultTimezone) => {
  return new Intl.DateTimeFormat('en-KE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
};

/**
 * Returns true if a value is a valid Date object or parseable date string.
 */
const isValidDate = (value) => {
  const d = new Date(value);
  return !isNaN(d.getTime());
};

/**
 * Adds a given number of days to a date.
 */
const addDays = (date, days) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

/**
 * Returns the difference in whole days between two dates.
 */
const diffInDays = (dateA, dateB) => {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((new Date(dateA) - new Date(dateB)) / msPerDay);
};

/**
 * Returns a human-readable "time ago" string (e.g. "3 days ago").
 */
const timeAgo = (date) => {
  const seconds = Math.floor((Date.now() - new Date(date)) / 1000);
  const intervals = [
    { label: 'year', secs: 31536000 },
    { label: 'month', secs: 2592000 },
    { label: 'day', secs: 86400 },
    { label: 'hour', secs: 3600 },
    { label: 'minute', secs: 60 },
  ];
  for (const { label, secs } of intervals) {
    const count = Math.floor(seconds / secs);
    if (count >= 1) return `${count} ${label}${count !== 1 ? 's' : ''} ago`;
  }
  return 'just now';
};

module.exports = { nowUTC, toLocaleDateString, isValidDate, addDays, diffInDays, timeAgo };
