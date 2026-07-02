const rateLimit = require('express-rate-limit');

// Strict limit for sensitive auth actions
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

// General limit for all mutating API endpoints (POST/PUT/PATCH/DELETE)
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,             // 60 writes per minute per IP — stops bulk abuse
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method),
  message: { success: false, message: 'Too many requests. Slow down and try again shortly.' },
});

// Looser limit for read-heavy endpoints
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests.' },
});

module.exports = { authLimiter, writeLimiter, readLimiter };
