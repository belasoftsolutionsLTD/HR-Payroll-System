/**
 * Capitalises the first letter of a string.
 */
const capitalise = (str) => {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
};

/**
 * Converts a string to Title Case.
 */
const toTitleCase = (str) => {
  if (!str) return '';
  return str.replace(/\w\S*/g, (word) => capitalise(word.toLowerCase()));
};

/**
 * Converts a camelCase or PascalCase string to a readable label.
 * e.g. "firstName" → "First Name"
 */
const camelToLabel = (str) => {
  if (!str) return '';
  return toTitleCase(str.replace(/([A-Z])/g, ' $1').trim());
};

/**
 * Truncates a string to maxLength and appends "…" if it exceeds that length.
 */
const truncate = (str, maxLength = 100) => {
  if (!str) return '';
  return str.length <= maxLength ? str : str.slice(0, maxLength) + '…';
};

/**
 * Strips HTML tags from a string.
 */
const stripHtml = (str) => {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '');
};

/**
 * Generates a URL-friendly slug from a string.
 */
const slugify = (str) => {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

module.exports = { capitalise, toTitleCase, camelToLabel, truncate, stripHtml, slugify };
