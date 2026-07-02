const logger = require('./logger');

const REQUIRED = [
  'MONGO_DB_URI',
  'JWT_SECRET',
];

const RECOMMENDED = [
  'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',
  'UPLOAD_DIR',
  'FRONTEND_URL',
];

function validateEnv() {
  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
    logger.error('Set them in your .env file and restart the server.');
    process.exit(1);
  }

  const jwtSecret = process.env.JWT_SECRET || '';
  if (jwtSecret.length < 32) {
    logger.error('FATAL: JWT_SECRET must be at least 32 characters long.');
    process.exit(1);
  }

  const warn = RECOMMENDED.filter(k => !process.env[k]);
  if (warn.length) {
    logger.warn(`Missing recommended environment variables: ${warn.join(', ')} — some features may not work`);
  }

  logger.info('Environment validation passed.');
}

module.exports = validateEnv;
