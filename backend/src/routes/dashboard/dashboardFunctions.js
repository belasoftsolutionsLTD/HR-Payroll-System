const returnFunction = require('../../functions/returnFunction');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md) —
// employees/users (Phase 1), leave_balances/leave_requests/leave_types/public_holidays
// (Phase 3a), attendance_records/shifts (Phase 3b), goals (Phase 5), expense_claims
// (Phase 8), community_posts/job_requisitions (Phase 4/9), and scheduled_events/
// inbox_items (Phase 10) now all live in Postgres — this file is fully migrated, no
// more Mongo helpers. (job_postings/payroll_runs/communication_posts were stale
// legacy collection names nothing ever wrote to — see the notes at each call site
// below for their real, actively-written replacements.)
const pgDB = require('../../functions/Database/pgDBFunctions');

const today = () => new Date().toISOString().split('T')[0];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Role-based summary ─────────────────────────────────────────────────────────
const getDashboardSummary = async (req, res) => {
  const role = req.user.role;
  const todayStr = today();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

  if (role === 'staff') {
    const empId = req.user.employeeId ? String(req.user.employeeId) : null;
    const year = new Date().getFullYear();

    const [balances, pendingExpenses, goals] = await Promise.all([
      empId ? pgDB.findMany('leave_balances', { employeeId: empId, year }) : [],
      empId ? pgDB.knex('expense_claims').where({ employeeId: empId, status: 'submitted' }).count('* as count').first().then((r) => Number(r.count)) : 0,
      empId ? pgDB.knex('goals').where({ employeeId: empId }).whereIn('status', ['at_risk', 'behind']).count('* as count').then(([r]) => Number(r.count)) : 0,
    ]);

    const totalLeaveBalance = balances.reduce((sum, b) => sum + Math.max(0, Number(b.closingBalance)), 0);
    return returnFunction(res, 200, true, 'ok', {
      role: 'staff',
      leaveBalance: totalLeaveBalance,
      pendingExpenses,
      goalsAtRisk: goals,
    });
  }

  if (role === 'department_head') {
    const now = new Date();
    const empId = req.user.employeeId ? String(req.user.employeeId) : null;
    const emp = empId ? await pgDB.findOne('employees', { id: empId }) : null;
    const dept = emp?.department;

    const teamEmps = dept ? await pgDB.knex('employees').where({ department: dept, status: 'active' }).select('id') : [];
    const teamIds = teamEmps.map(e => e.id);

    const [teamSize, onLeaveToday, pendingLeave, pendingExpenses] = await Promise.all([
      pgDB.knex('employees').where({ status: 'active' }).modify((qb) => { if (dept) qb.where({ department: dept }); }).count('* as count').first().then(r => Number(r.count)),
      teamIds.length ? pgDB.knex('leave_requests').whereIn('employeeId', teamIds).where({ status: 'approved' }).where('startDate', '<=', now).where('endDate', '>=', now).count('* as count').first().then(r => Number(r.count)) : 0,
      teamIds.length ? pgDB.knex('leave_requests').whereIn('employeeId', teamIds).where({ status: 'pending' }).count('* as count').first().then(r => Number(r.count)) : 0,
      // 'pending' is not a real expense_claims status (submitted/approved/rejected/
      // disputed/reimbursed) — this always resolved to 0 pre-migration too; preserved
      // as-is rather than silently changed, same posture as the payrollStatus note below.
      pgDB.knex('expense_claims').where({ status: 'pending' }).count('* as count').first().then((r) => Number(r.count)),
    ]);

    // Missing clock-in (active team members with no attendance record today)
    let missingClockIn = 0;
    if (dept) {
      const clockedIn = await pgDB.knex('attendance_records').where({ date: todayStr }).whereIn('employeeId', teamIds).whereNotNull('checkInTime')
        .count('* as count').first().then((r) => Number(r.count));
      missingClockIn = Math.max(0, teamIds.length - clockedIn);
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
    pgDB.knex('employees').where({ status: 'active' }).count('* as count').first().then(r => Number(r.count)),
    pgDB.knex('employees').where({ status: 'active' }).where('createdAt', '>=', monthStart).count('* as count').first().then(r => Number(r.count)),
    // job_postings was a stale/legacy collection name nothing ever wrote to; job_requisitions
    // is the real, actively-written table for this concept (see reportFunctions.js's
    // executive dashboard, which uses the same table for the same stat).
    pgDB.knex('job_requisitions').where({ status: 'open' }).count('* as count').first().then(r => Number(r.count)),
  ]);

  // Payroll cycle status — payroll_runs was a stale/legacy collection name predating
  // payroll_cycles that nothing ever wrote to (this stat always showed "No active cycle"
  // regardless of Mongo vs Postgres); payroll_cycles is the real, actively-written table.
  const currentPayroll = await pgDB.knex('payroll_cycles').orderBy('createdAt', 'desc').first();

  return returnFunction(res, 200, true, 'ok', {
    role: 'hr',
    totalHeadcount,
    newHires,
    openPositions,
    payrollStatus: currentPayroll ? `${MONTHS[currentPayroll.periodMonth - 1]} ${currentPayroll.periodYear} cycle: ${currentPayroll.status || 'open'}` : 'No active cycle',
  });
};

// ── Feed preview ──────────────────────────────────────────────────────────────
const getFeedPreview = async (req, res) => {
  // communication_posts was a stale/legacy collection name nothing ever wrote to;
  // community_posts (Phase 9) is the real, actively-written table for the company feed.
  // authorId references users, not employees — and the row already caches authorName
  // as a fast path (see communicationFunctions.js's own enrichPost), so only posts
  // missing that cache need the users→employees lookup.
  const posts = await pgDB.knex('community_posts').whereNot({ type: 'trust' }).orderBy('createdAt', 'desc').limit(3);

  const needsLookup = posts.filter(p => !p.authorName && p.authorId);
  const authorIds = [...new Set(needsLookup.map(p => p.authorId))];
  const users = authorIds.length ? await pgDB.knex('users').whereIn('id', authorIds).select('id', 'employeeId') : [];
  const employeeIds = [...new Set(users.map(u => u.employeeId).filter(Boolean))];
  const employees = employeeIds.length ? await pgDB.knex('employees').whereIn('id', employeeIds).select('id', 'fullName') : [];
  const empNameById = Object.fromEntries(employees.map(e => [e.id, e.fullName]));
  const userToEmpName = Object.fromEntries(users.map(u => [u.id, empNameById[u.employeeId]]));

  // _id alias: this route bypasses pgDBFunctions' own findMany/withMongoId wrapper
  // (raw knex, needed for the whereNot/orderBy chain), so the frontend's still-Mongo-
  // shaped FeedPost._id contract is aliased here manually.
  const enriched = posts.map(p => ({ ...p, _id: p.id, authorName: p.authorName || userToEmpName[p.authorId] || 'Unknown' }));

  return returnFunction(res, 200, true, 'ok', enriched);
};

// ── Upcoming events ───────────────────────────────────────────────────────────
const getUpcomingEvents = async (req, res) => {
  const todayStr = today();
  const events = await pgDB.knex('scheduled_events').where('scheduledDate', '>=', todayStr).orderBy('scheduledDate', 'asc').limit(5);
  // _id alias — see the matching note in getFeedPreview above.
  return returnFunction(res, 200, true, 'ok', events.map(e => ({ ...e, _id: e.id })));
};

// ── Celebrations (birthdays + work anniversaries this week) ──────────────────
const getCelebrations = async (req, res) => {
  const now = new Date();
  const weekEnd = new Date(now);
  weekEnd.setDate(now.getDate() + 7);

  const employees = await pgDB.knex('employees').where({ status: 'active' }).select('id', 'fullName', 'dateOfBirth', 'dateOfHire');

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
    if (emp.dateOfHire) {
      const start = new Date(emp.dateOfHire);
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
  const [totalActive, rawRecords] = await Promise.all([
    pgDB.knex('employees').where({ status: 'active' }).count('* as count').first().then(r => Number(r.count)),
    pgDB.knex('attendance_records').where({ date: todayStr }),
  ]);
  // breaks is its own child table now (Phase 3b), not an embedded array — fetch open
  // breaks in one query rather than one round-trip per record.
  const openBreakEmployeeIds = rawRecords.length
    ? new Set((await pgDB.knex('attendance_breaks')
        .whereIn('attendanceRecordId', rawRecords.map((r) => r.id)).whereNull('endTime').select('attendanceRecordId'))
        .map((b) => b.attendanceRecordId))
    : new Set();
  const records = rawRecords.map((r) => ({ ...r, hasOpenBreak: openBreakEmployeeIds.has(r.id) }));

  const clockedIn = records.filter(r => r.checkInTime && !r.checkOutTime && !r.hasOpenBreak).length;
  const onBreak   = records.filter(r => r.checkInTime && r.hasOpenBreak).length;
  const clockedOut = records.filter(r => r.checkOutTime).length;
  const now = new Date();
  const onLeave   = await pgDB.knex('leave_requests').where({ status: 'approved' }).where('startDate', '<=', now).where('endDate', '>=', now).count('* as count').first().then(r => Number(r.count));
  const notIn     = Math.max(0, totalActive - clockedIn - onBreak - clockedOut - onLeave);

  // Recent clock-ins (last 5)
  const recent = records
    .filter(r => r.checkInTime)
    .sort((a, b) => new Date(b.checkInTime) - new Date(a.checkInTime))
    .slice(0, 5);

  const recentEmpIds = [...new Set(recent.map(r => String(r.employeeId)))];
  const recentEmps = recentEmpIds.length
    ? await pgDB.knex('employees').whereIn('id', recentEmpIds).select('id', 'fullName')
    : [];
  const recentEmpById = Object.fromEntries(recentEmps.map(e => [e.id, e]));
  const recentEnriched = recent.map(r => ({ name: recentEmpById[String(r.employeeId)]?.fullName || 'Unknown', checkInTime: r.checkInTime }));

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
  const items = await pgDB.knex('inbox_items')
    .where({ recipientId: req.user.id, requiresAction: true }).whereIn('status', ['unread', 'read'])
    .select('type');

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
  const empId = String(req.user.employeeId);
  const todayStr = today();

  // Check if employee is on leave
  const now = new Date();
  const onLeave = await pgDB.knex('leave_requests')
    .where({ employeeId: empId, status: 'approved' }).where('startDate', '<=', now).where('endDate', '>=', now)
    .first();
  if (onLeave) {
    const leaveType = await pgDB.findOne('leave_types', { id: onLeave.leaveTypeId });
    return returnFunction(res, 200, true, 'ok', { type: 'leave', leaveType: leaveType?.name || 'Leave' });
  }

  // Check public holiday
  const holiday = await pgDB.findOne('public_holidays', { date: todayStr });
  if (holiday) return returnFunction(res, 200, true, 'ok', { type: 'holiday', name: holiday.name });

  // Get assigned shift or default schedule. shifts now lives in Postgres (Phase 3b).
  // employees.shiftId isn't a real column (nothing in the employees schema ever set
  // one — this always resolved to the fallback defaults below regardless), preserved
  // as-is rather than invented.
  const emp = await pgDB.findOne('employees', { id: empId });
  const shift = emp?.shiftId ? await pgDB.findOne('shifts', { id: String(emp.shiftId) }) : null;

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

  const goals = await pgDB.knex('goals').where({ employeeId: String(req.user.employeeId) }).select('title', 'status', 'progress');
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
