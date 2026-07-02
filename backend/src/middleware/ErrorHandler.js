const logger = require('../lib/logger');

const ErrorHandler = (err, req, res, next) => {
  const locale = req.locale || {};
  const statusCode = err.statusCode || err.status || 500;

  // Log server errors with full context; client errors (4xx) at warn level
  const meta = { method: req.method, path: req.originalUrl, statusCode, userId: req.user?._id ?? null };
  if (statusCode >= 500) {
    logger.error(err.message || 'Unhandled error', { ...meta, stack: err.stack });
  } else {
    logger.warn(err.message || 'Client error', meta);
  }

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
