require('dotenv').config();
const express = require('express');
const cors = require('cors');

const connectDB = require('./src/configs/dbConfig');
const LocaleMiddleware = require('./src/middleware/LocaleMiddleware');
const ErrorHandler = require('./src/middleware/ErrorHandler');
const { decodeToken, getUserData } = require('./src/middleware/AuthMiddleware');

const authRoutes       = require('./src/routes/auth/auth');
const hrRoutes         = require('./src/routes/hr/hr');
const employeesRoutes  = require('./src/routes/employees/employees');
const recruitmentRoutes = require('./src/routes/recruitment/recruitment');
const onboardingRoutes = require('./src/routes/onboarding/onboarding');
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

const app = express();

// ── Core middleware ──────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Database ─────────────────────────────────────────────────────────────────
connectDB();

// ── Locale ───────────────────────────────────────────────────────────────────
app.use(LocaleMiddleware);

// ── Public routes (no auth) ───────────────────────────────────────────────────
app.use('/api/auth',   authRoutes);
app.use('/api/public', publicRoutes);

// ── HR Module routes (all require auth) ──────────────────────────────────────
app.use('/api/hr',          decodeToken, getUserData, hrRoutes);
app.use('/api/hr',          decodeToken, getUserData, recruitmentRoutes);
app.use('/api/hr',          decodeToken, getUserData, onboardingRoutes);
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

// ── Global error handler (must be last) ──────────────────────────────────────
app.use(ErrorHandler);

module.exports = app;
