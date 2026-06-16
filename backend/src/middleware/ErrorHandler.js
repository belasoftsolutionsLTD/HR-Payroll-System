/**
 * Global Express error-handling middleware.
 * Must be registered last in app.js (after all routes).
 */
const ErrorHandler = (err, req, res, next) => {
  const locale = req.locale || {};

  console.error('[ErrorHandler]', err);

  const statusCode = err.statusCode || err.status || 500;
  const message =
    statusCode === 500
      ? locale.internalServerError || 'An internal server error occurred.'
      : err.message || locale.internalServerError || 'An error occurred.';

  return res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = ErrorHandler;
