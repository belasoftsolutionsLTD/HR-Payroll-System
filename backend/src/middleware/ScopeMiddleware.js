const returnFunction = require('../functions/returnFunction');

/**
 * For staff role: silently replaces req.body.employeeId with the current user's
 * own employeeId. HR/manager roles pass through unchanged.
 * Prevents a staff member from submitting forms on behalf of another employee.
 */
const scopeBodyToSelf = (req, res, next) => {
  if (req.user?.role === 'staff' && req.user.employeeId) {
    req.body.employeeId = req.user.employeeId.toString();
  }
  next();
};

/**
 * Blocks staff from accessing routes scoped to another employee via a URL param.
 * Compare req.params.employeeId against req.user.employeeId.
 */
const scopeParamToSelf = (req, res, next) => {
  if (req.user?.role !== 'staff') return next();
  const empId = req.user.employeeId;
  if (!empId) return returnFunction(res, 403, false, 'No employee profile linked to your account.');
  const paramId = req.params.employeeId;
  if (paramId && String(paramId) !== String(empId)) {
    return returnFunction(res, 403, false, 'You can only access your own records.');
  }
  next();
};

module.exports = { scopeBodyToSelf, scopeParamToSelf };
