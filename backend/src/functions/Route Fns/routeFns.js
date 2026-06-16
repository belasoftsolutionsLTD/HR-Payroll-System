const returnFunction = require('../returnFunction');

/**
 * Validates that all required fields are present and non-empty in req.body.
 * Returns true when validation passes; sends a 400 response and returns false otherwise.
 */
const validateRequiredFields = (req, res, fields) => {
  const missing = fields.filter((field) => {
    const value = req.body[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    const locale = req.locale || {};
    returnFunction(res, 400, false, locale.missingRequiredFields || 'Missing required fields.', {
      missing,
    });
    return false;
  }
  return true;
};

/**
 * Builds a standard MongoDB pagination object from query params.
 * Defaults: page=1, limit=20, maxLimit=100.
 */
const getPagination = (query, maxLimit = 100) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

/**
 * Wraps paginated results with metadata.
 */
const paginatedResponse = (data, total, page, limit) => ({
  data,
  pagination: {
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  },
});

module.exports = { validateRequiredFields, getPagination, paginatedResponse };
