require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
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

const path = require('path');
const app = express();

// ── Core middleware ──────────────────────────────────────────────────────────
app.use(cors());
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
connectDB().then(() => {
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

// ── Global error handler (must be last) ──────────────────────────────────────
app.use(ErrorHandler);

module.exports = app;
