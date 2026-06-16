const returnFunction = require('../functions/returnFunction');

/**
 * Returns an Express middleware that allows only the specified roles.
 * req.user must already be populated by AuthMiddleware.getUserData.
 *
 * Usage: router.get('/admin', decodeToken, getUserData, allowRoles(['admin']), handler)
 */
const allowRoles = (roles = []) => (req, res, next) => {
  const locale = req.locale || {};

  if (!req.user || !req.user.role) {
    return returnFunction(res, 403, false, locale.noPermission || 'Permission denied.');
  }

  const userRole = req.user.role;
  const permitted = Array.isArray(roles) ? roles : [roles];

  if (!permitted.includes(userRole)) {
    return returnFunction(res, 403, false, locale.noPermission || 'Permission denied.');
  }

  next();
};

module.exports = { allowRoles };
