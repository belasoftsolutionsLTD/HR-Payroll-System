const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findOne, findMany, countDocuments } = require('../../functions/Database/commonDBFunctions');

const today = () => new Date().toISOString().split('T')[0];

// ── Role-based summary ─────────────────────────────────────────────────────────
const getDashboardSummary = async (req, res) => {
  const role = req.user.role;
  const todayStr = today();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

  if (role === 'staff') {
    const empId = req.user.employeeId;
    const year = new Date().getFullYear();

    const [balance, pendingExpenses, goals] = await Promise.all([
      empId ? findOne('leave_balances', { employeeId: empId, year }) : null,
      empId ? countDocuments('expense_claims', { employeeId: empId, status: 'submitted' }) : 0,
      empId ? countDocuments('goals', { employeeId: empId, status: { $in: ['at_risk', 'behind'] } }) : 0,
    ]);

    const annualBalance = balance?.balances?.annual?.remaining ?? 0;
    return returnFunction(res, 200, true, 'ok', {
      role: 'staff',
      leaveBalance: annualBalance,
      pendingExpenses,
      goalsAtRisk: goals,
    });
  }

  if (role === 'department_head') {
    const emp = req.user.employeeId ? await findOne('employees', { _id: req.user.employeeId }) : null;
    const dept = emp?.department;
    const filter = dept ? { department: dept } : {};

    const [teamSize, onLeaveToday, pendingLeave, pendingExpenses] = await Promise.all([
      countDocuments('employees', { ...filter, status: 'active' }),
      countDocuments('leave_requests', { ...filter, status: 'approved', startDate: { $lte: todayStr }, endDate: { $gte: todayStr } }),
      countDocuments('leave_requests', { ...filter, status: 'pending' }),
      countDocuments('expense_claims', { status: 'pending' }),
    ]);

    // Missing clock-in (active team members with no attendance record today)
    let missingClockIn = 0;
    if (dept) {
      const teamEmps = await findMany('employees', { department: dept, status: 'active' }, { projection: { _id: 1 } });
      const clockedIn = await global.dbo.collection('attendance_records')
        .countDocuments({ date: todayStr, employeeId: { $in: teamEmps.map(e => e._id) }, checkInTime: { $ne: null } });
      missingClockIn = Math.max(0, teamEmps.length - clockedIn);
    }

    return returnFunction(res, 200, true, 'ok', {
      role: 'department_head',
      teamSize,
      onLeaveToday,
      pendingApprovals: pendingLeave + pendingExpenses,
      missingClockIn,
    });
  }

  // HR / super_admin
  const [totalHeadcount, newHires, openPositions] = await Promise.all([
    countDocuments('employees', { status: 'active' }),
    countDocuments('employees', { status: 'active', startDate: { $gte: monthStart } }),
    countDocuments('job_postings', { status: { $in: ['open', 'active'] } }),
  ]);

  // Payroll cycle status
  const currentPayroll = await findOne('payroll_runs', {}, { sort: { createdAt: -1 } });

  return returnFunction(res, 200, true, 'ok', {
    role: 'hr',
    totalHeadcount,
    newHires,
    openPositions,
    payrollStatus: currentPayroll ? `${currentPayroll.period || 'Current'} cycle: ${currentPayroll.status || 'open'}` : 'No active cycle',
  });
};

// ── Feed preview ──────────────────────────────────────────────────────────────
const getFeedPreview = async (req, res) => {
  const posts = await findMany('communication_posts', { type: { $ne: 'trust' } }, {
    limit: 3,
    sort: { createdAt: -1 },
  });

  const enriched = await Promise.all(posts.map(async (p) => {
    const author = p.authorId ? await findOne('employees', { _id: p.authorId }, { projection: { fullName: 1 } }) : null;
    return { ...p, authorName: author?.fullName || 'Unknown' };
  }));

  return returnFunction(res, 200, true, 'ok', enriched);
};

// ── Upcoming events ───────────────────────────────────────────────────────────
const getUpcomingEvents = async (req, res) => {
  const todayStr = today();
  const events = await findMany('scheduled_events', { scheduledDate: { $gte: todayStr } }, {
    limit: 5,
    sort: { scheduledDate: 1 },
  });
  return returnFunction(res, 200, true, 'ok', events);
};

// ── Celebrations (birthdays + work anniversaries this week) ──────────────────
const getCelebrations = async (req, res) => {
  const now = new Date();
  const weekEnd = new Date(now);
  weekEnd.setDate(now.getDate() + 7);

  const employees = await findMany('employees', { status: 'active' }, {
    projection: { fullName: 1, dateOfBirth: 1, startDate: 1 },
  });

  const celebrations = [];
  const thisYear = now.getFullYear();
  const todayMs = now.setHours(0, 0, 0, 0);
  const weekEndMs = weekEnd.getTime();

  for (const emp of employees) {
    // Birthday this week
    if (emp.dateOfBirth) {
      const dob = new Date(emp.dateOfBirth);
      const birthday = new Date(thisYear, dob.getMonth(), dob.getDate()).getTime();
      if (birthday >= todayMs && birthday <= weekEndMs) {
        celebrations.push({ type: 'birthday', employee: emp, date: new Date(birthday).toISOString().split('T')[0] });
      }
    }
    // Work anniversary this week
    if (emp.startDate) {
      const start = new Date(emp.startDate);
      const anniv = new Date(thisYear, start.getMonth(), start.getDate()).getTime();
      const years = thisYear - start.getFullYear();
      if (years > 0 && anniv >= todayMs && anniv <= weekEndMs) {
        celebrations.push({ type: 'anniversary', employee: emp, date: new Date(anniv).toISOString().split('T')[0], years });
      }
    }
  }

  celebrations.sort((a, b) => new Date(a.date) - new Date(b.date));
  return returnFunction(res, 200, true, 'ok', celebrations);
};

// ── Live attendance (HR/Admin only) ──────────────────────────────────────────
const getLiveAttendance = async (req, res) => {
  const todayStr = today();
  const [totalActive, records] = await Promise.all([
    countDocuments('employees', { status: 'active' }),
    global.dbo.collection('attendance_records').find({ date: todayStr }).toArray(),
  ]);

  const clockedIn = records.filter(r => r.checkInTime && !r.checkOutTime && !(r.breaks || []).find(b => !b.endTime)).length;
  const onBreak   = records.filter(r => r.checkInTime && (r.breaks || []).find(b => !b.endTime)).length;
  const clockedOut = records.filter(r => r.checkOutTime).length;
  const onLeave   = await countDocuments('leave_requests', { status: 'approved', startDate: { $lte: todayStr }, endDate: { $gte: todayStr } });
  const notIn     = Math.max(0, totalActive - clockedIn - onBreak - clockedOut - onLeave);

  // Recent clock-ins (last 5)
  const recent = records
    .filter(r => r.checkInTime)
    .sort((a, b) => new Date(b.checkInTime) - new Date(a.checkInTime))
    .slice(0, 5);

  const recentEnriched = await Promise.all(recent.map(async (r) => {
    const emp = await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1 } });
    return { name: emp?.fullName || 'Unknown', checkInTime: r.checkInTime };
  }));

  return returnFunction(res, 200, true, 'ok', {
    clockedIn,
    onBreak,
    clockedOut,
    onLeave,
    notIn,
    totalActive,
    recentClockIns: recentEnriched,
  });
};

// ── Pending actions count ─────────────────────────────────────────────────────
const getPendingActions = async (req, res) => {
  const filter = { recipientId: req.user._id, requiresAction: true, status: { $in: ['unread', 'read'] } };
  const items = await findMany('inbox_items', filter, { projection: { type: 1 } });

  const byType = {};
  let total = 0;
  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    total++;
  }

  return returnFunction(res, 200, true, 'ok', { total, byType });
};

// ── Today's schedule ──────────────────────────────────────────────────────────
const getTodaySchedule = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'ok', null);
  const todayStr = today();

  // Check if employee is on leave
  const onLeave = await findOne('leave_requests', {
    employeeId: req.user.employeeId,
    status: 'approved',
    startDate: { $lte: todayStr },
    endDate: { $gte: todayStr },
  });
  if (onLeave) return returnFunction(res, 200, true, 'ok', { type: 'leave', leaveType: onLeave.leaveType });

  // Check public holiday
  const holiday = await findOne('public_holidays', { date: todayStr });
  if (holiday) return returnFunction(res, 200, true, 'ok', { type: 'holiday', name: holiday.name });

  // Get assigned shift or default schedule
  const emp = await findOne('employees', { _id: req.user.employeeId }, { projection: { shiftId: 1 } });
  const shift = emp?.shiftId ? await findOne('shifts', { _id: emp.shiftId }) : null;

  return returnFunction(res, 200, true, 'ok', {
    type: 'work',
    scheduleName: shift?.name || 'Standard 9–5',
    shiftStart: shift?.startTime || '09:00',
    shiftEnd: shift?.endTime || '17:00',
    breakStart: shift?.breakStart || '13:00',
    breakEnd: shift?.breakEnd || '14:00',
    expectedHours: shift?.expectedHours || 8,
  });
};

// ── Goals summary ─────────────────────────────────────────────────────────────
const getGoalsSummary = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'ok', null);

  const goals = await findMany('goals', { employeeId: req.user.employeeId }, { projection: { title: 1, status: 1, progress: 1 } });
  const total = goals.length;
  const onTrack = goals.filter(g => g.status === 'on_track' || g.status === 'completed').length;
  const overallProgress = total > 0
    ? Math.round(goals.reduce((sum, g) => sum + (g.progress || 0), 0) / total)
    : 0;

  return returnFunction(res, 200, true, 'ok', {
    total,
    onTrack,
    overallProgress,
    goals: goals.slice(0, 3),
  });
};

module.exports = {
  getDashboardSummary,
  getFeedPreview,
  getUpcomingEvents,
  getCelebrations,
  getLiveAttendance,
  getPendingActions,
  getTodaySchedule,
  getGoalsSummary,
};
