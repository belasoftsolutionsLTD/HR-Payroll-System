// Postgres migration (Phase 10) — audit_logs is Postgres now.
// Writes a record to audit_logs for every state-changing API call.
// Reads req.user after auth middleware has run.
const { knex, newId } = require('../functions/Database/pgDBFunctions');

const auditLog = (req, res, next) => {
  const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (!MUTATING.includes(req.method)) return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    // Only log after the response is built so we capture the status code
    knex('audit_logs').insert({
      id: newId(),
      userId:     req.user?.id    ?? null,
      userEmail:  req.user?.email  ?? null,
      userRole:   req.user?.role   ?? null,
      method:     req.method,
      path:       req.originalUrl,
      body:       JSON.stringify(_redact(req.body)),
      statusCode: res.statusCode,
      ip:         req.ip || req.headers['x-forwarded-for'] || null,
      userAgent:  req.headers['user-agent'] || null,
      timestamp:  new Date(),
    }).catch(() => {}); // never block the response
    return originalJson(body);
  };

  next();
};

// Strip sensitive fields before storing
const REDACT_KEYS = new Set(['password', 'newPassword', 'currentPassword', 'token', 'refreshToken', 'secret', 'otpSecret']);
function _redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACT_KEYS.has(k) ? '[REDACTED]' : v;
  }
  return out;
}

module.exports = auditLog;
