require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');

const validateEnv = require('./src/lib/validateEnv');
validateEnv(); // Fail-fast before anything else if env is misconfigured

const logger     = require('./src/lib/logger');
const connectDB  = require('./src/configs/dbConfig');
const { startCronJobs } = require('./src/lib/tasks/cronTasks');
const { seedDefaultTemplates } = require('./src/lib/tasks/seedDefaultTemplates');
const { initIndexes } = require('./src/lib/initIndexes');
const LocaleMiddleware = require('./src/middleware/LocaleMiddleware');
const ErrorHandler     = require('./src/middleware/ErrorHandler');
const auditLog         = require('./src/middleware/AuditMiddleware');
const { writeLimiter } = require('./src/middleware/RateLimitMiddleware');
const { decodeToken, getUserData } = require('./src/middleware/AuthMiddleware');

const authRoutes       = require('./src/routes/auth/auth');
const demoRoutes       = require('./src/routes/demo/demo');
const hrRoutes         = require('./src/routes/hr/hr');
const employeesRoutes  = require('./src/routes/employees/employees');
const recruitmentRoutes = require('./src/routes/recruitment/recruitment');
const onboardingRoutes = require('./src/routes/onboarding/onboarding');
const offboardingRoutes = require('./src/routes/offboarding/offboarding');
const leaveRoutes      = require('./src/routes/leave/leave');
const attendanceRoutes = require('./src/routes/attendance/attendance');
const payrollRoutes    = require('./src/routes/payroll/payroll');
const performanceRoutes = require('./src/routes/performance/performance');
const staffNotesRoutes = require('./src/routes/staffNotes/staffNotes');
const configRoutes     = require('./src/routes/config/config');
const publicRoutes     = require('./src/routes/public/publicRoutes');
const meRoutes            = require('./src/routes/me/me');
const announcementRoutes  = require('./src/routes/announcements/announcements');
const messageRoutes       = require('./src/routes/messages/messages');
const reportRoutes        = require('./src/routes/reports/reports');
const awardRoutes         = require('./src/routes/awards/awards');
const taskRoutes          = require('./src/routes/tasks/tasks');
const expenseRoutes       = require('./src/routes/expenses/expenses');
const financeRoutes       = require('./src/routes/finance/finance');
const projectRoutes       = require('./src/routes/projects/projects');
const spendingRoutes      = require('./src/routes/spending/spending');
const communicationRoutes = require('./src/routes/communication/communication');
const { submitTrustReport, checkTrustStatus } = require('./src/routes/communication/communicationFunctions');
const inboxRoutes         = require('./src/routes/inbox/inbox');
const dashboardRoutes     = require('./src/routes/dashboard/dashboard');
const itRoutes            = require('./src/routes/it/it');
const notificationRoutes  = require('./src/routes/notifications/notifications');
const trainingRoutes      = require('./src/routes/training/training');
const welfareRoutes       = require('./src/routes/welfare/welfare');
const inventoryRoutes     = require('./src/routes/inventory/inventory');
const posRoutes           = require('./src/routes/pos/pos');
const crmRoutes           = require('./src/routes/crm/crm');
const accountingRoutes    = require('./src/routes/accounting/accounting');
const logisticsRoutes     = require('./src/routes/logistics/logistics');
const emailTemplatesRoutes = require('./src/routes/settings/emailTemplates');

const path = require('path');
const app = express();

// ── Core middleware ──────────────────────────────────────────────────────────
// Standard hardening headers (clickjacking protection, MIME-sniffing protection,
// HSTS, etc.) — this is a pure JSON+file API with no server-rendered HTML, so
// helmet's default Content-Security-Policy is a no-op rather than something that
// needs tuning. crossOriginResourcePolicy is relaxed from helmet's 'same-origin'
// default to 'cross-origin': in production the frontend and this API happen to sit
// behind the same nginx host, but dev (localhost:3000 → localhost:5000) genuinely is
// cross-origin, and this API is meant to be called cross-origin regardless — that's
// what the CORS allowlist just above already governs correctly.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Behind nginx on Contabo — without this, Express (and express-rate-limit's IP-based
// login throttling) sees nginx's own address as the "client" for every request instead
// of the real visitor, since it doesn't trust X-Forwarded-For by default.
app.set('trust proxy', 1);

// A bare cors() reflects and allows *any* origin — any website's JavaScript could call
// this API. Locked to the real frontend(s) only; requests with no Origin header (curl,
// server-to-server, the deploy health check) are never blocked, since CORS is purely a
// browser-enforced concept and doesn't apply to those.
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'https://workfola.com',
  'https://www.workfola.com',
].filter(Boolean);
app.use(cors({
  // CORS is enforced by the browser refusing to expose the response to page JS based
  // on the Access-Control-Allow-Origin header — it was never a server-side access
  // gate. Passing `false` here (not throwing) just omits that header for a
  // disallowed origin; the request still completes normally underneath, same as any
  // non-browser caller (curl, server-to-server) always ignores CORS entirely.
  origin: (origin, callback) => callback(null, !origin || ALLOWED_ORIGINS.includes(origin)),
}));
app.use(express.json());

// Strip MongoDB operators ($where, $gt, etc.) from req.body / req.query / req.params
app.use(mongoSanitize({ replaceWith: '_' }));

// Rate-limit all mutating requests (POST/PUT/PATCH/DELETE)
app.use(writeLimiter);

// Audit log — fires after auth middleware populates req.user
app.use(auditLog);

// ── Health check (no auth, no rate limit) ────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});
// Protect uploaded files — require a valid JWT (Bearer header or ?token= query param)
const jwt = require('jsonwebtoken');
app.use('/uploads', (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '') || req.query.token;
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}, express.static(path.join(__dirname, 'uploads')));

// ── Database ─────────────────────────────────────────────────────────────────
// Exported as `dbReady` below so server.js can hold off calling app.listen() until
// global.dbo is actually set — route registration below doesn't need the DB to be
// ready, but any REQUEST handled before this resolves would hit `global.dbo` while
// it's still undefined.
const dbReady = connectDB().then(() => {
  initIndexes().catch(e => logger.error('initIndexes failed', { error: e.message }));
  seedDefaultTemplates().catch(e => logger.error('seedDefaultTemplates failed', { error: e.message }));
  startCronJobs();
}).catch(e => {
  logger.error('Database connection failed', { error: e.message });
  process.exit(1);
});

// ── Locale ───────────────────────────────────────────────────────────────────
app.use(LocaleMiddleware);

// ── Public routes (no auth) ───────────────────────────────────────────────────
app.use('/api/auth',   authRoutes);
app.use('/api/public', publicRoutes);
// Mixed — login is public, everything else requires the guest token it issues;
// each route declares its own auth, see demo.js.
app.use('/api/demo',   demoRoutes);

// ── HR Module routes (all require auth) ──────────────────────────────────────
app.use('/api/hr',          decodeToken, getUserData, hrRoutes);
app.use('/api/recruitment', decodeToken, getUserData, recruitmentRoutes);
app.use('/api/onboarding',  decodeToken, getUserData, onboardingRoutes);
app.use('/api/offboarding', decodeToken, getUserData, offboardingRoutes);
app.use('/api/employees',   decodeToken, getUserData, employeesRoutes);
app.use('/api/leave',       decodeToken, getUserData, leaveRoutes);
app.use('/api/attendance',  decodeToken, getUserData, attendanceRoutes);
app.use('/api/payroll',     decodeToken, getUserData, payrollRoutes);
app.use('/api/performance', decodeToken, getUserData, performanceRoutes);
app.use('/api/staff-notes', decodeToken, getUserData, staffNotesRoutes);
app.use('/api/config',     decodeToken, getUserData, configRoutes);
app.use('/api/me',         decodeToken, getUserData, meRoutes);
app.use('/api/me',         decodeToken, getUserData, messageRoutes);
app.use('/api',            decodeToken, getUserData, announcementRoutes);
app.use('/api',            decodeToken, getUserData, reportRoutes);
app.use('/api',            decodeToken, getUserData, awardRoutes);
app.use('/api',            decodeToken, getUserData, taskRoutes);
app.use('/api',            decodeToken, getUserData, expenseRoutes);
app.use('/api/finance',    decodeToken, getUserData, financeRoutes);
app.use('/api/projects',   decodeToken, getUserData, projectRoutes);
app.use('/api/spending',   decodeToken, getUserData, spendingRoutes);

// Communication routes (includes protected /trust/admin)
const AsyncHandler = require('./src/middleware/AsyncHandler');
app.use('/api/communication', decodeToken, getUserData, communicationRoutes);

// Trust channel public endpoints (no auth required) — registered AFTER protected routes
// so /trust/admin is not swallowed by the :trackingCode wildcard
app.post('/api/communication/trust', AsyncHandler(submitTrustReport));
app.get('/api/communication/trust/:trackingCode', AsyncHandler(checkTrustStatus));
app.use('/api/inbox',         decodeToken, getUserData, inboxRoutes);
app.use('/api/dashboard',     decodeToken, getUserData, dashboardRoutes);
app.use('/api/it',            decodeToken, getUserData, itRoutes);
app.use('/api/notifications', decodeToken, getUserData, notificationRoutes);
app.use('/api/training',      decodeToken, getUserData, trainingRoutes);
app.use('/api/welfare',       decodeToken, getUserData, welfareRoutes);
app.use('/api/inventory',     decodeToken, getUserData, inventoryRoutes);
app.use('/api/pos',           decodeToken, getUserData, posRoutes);
app.use('/api/crm',           decodeToken, getUserData, crmRoutes);
app.use('/api/accounting',    decodeToken, getUserData, accountingRoutes);
app.use('/api/logistics',     decodeToken, getUserData, logisticsRoutes);
app.use('/api/email-templates', decodeToken, getUserData, emailTemplatesRoutes);

// ── Global error handler (must be last) ──────────────────────────────────────
app.use(ErrorHandler);

module.exports = app;
module.exports.dbReady = dbReady;
