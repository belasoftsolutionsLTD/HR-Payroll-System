const cron = require('node-cron');
const { ObjectId } = require('mongodb');
const { triggerTasksFromTemplate } = require('./triggerTasksFromTemplate');
const { notifyEmployee, notifyUser } = require('../../functions/HR/notifyUser');
const { runAccrual, runYearEndCarryOver } = require('../leave/accrualEngine');
const { getEffectiveScheduleForEmployee } = require('../../routes/attendance/attendanceFunctions');
const { runDueScheduledReports } = require('../../routes/reports/reportFunctions');

async function dailyTaskJobs() {
  if (!global.dbo) return;

  const todayStr = new Date().toISOString().split('T')[0];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const in14 = new Date();
  in14.setDate(in14.getDate() + 14);
  const in14Str = in14.toISOString().split('T')[0];

  // 1. Mark overdue
  await global.dbo.collection('tasks').updateMany(
    { status: { $in: ['not_started', 'in_progress'] }, dueDate: { $lt: todayStr } },
    { $set: { status: 'overdue', updatedAt: new Date() } }
  );

  // 2. Trigger onboarding for employees starting within 14 days (first time only)
  const onboardingTpl = await global.dbo.collection('task_templates').findOne({
    triggerEvent: 'new_hire', isActive: true,
  });
  if (onboardingTpl) {
    const newHires = await global.dbo.collection('employees').find({
      startDate: { $gte: todayStr, $lte: in14Str }, status: { $ne: 'terminated' },
    }).toArray();

    for (const emp of newHires) {
      const already = await global.dbo.collection('tasks').findOne({
        linkedEmployeeId: emp._id, templateId: onboardingTpl._id,
      });
      if (!already) {
        await triggerTasksFromTemplate(onboardingTpl._id, emp._id, emp.startDate || todayStr);
      }
    }
  }

  // 3. Trigger offboarding when endDate is set and approaching
  const offboardingTpl = await global.dbo.collection('task_templates').findOne({
    triggerEvent: 'offboarding', isActive: true,
  });
  if (offboardingTpl) {
    const leavers = await global.dbo.collection('employees').find({
      endDate: { $gte: todayStr, $lte: in14Str },
    }).toArray();

    for (const emp of leavers) {
      const already = await global.dbo.collection('tasks').findOne({
        linkedEmployeeId: emp._id, templateId: offboardingTpl._id,
      });
      if (!already) {
        await triggerTasksFromTemplate(offboardingTpl._id, emp._id, emp.endDate);
      }
    }
  }

  // 4. Remind about tasks due tomorrow
  const dueTomorrow = await global.dbo.collection('tasks').find({
    status: { $in: ['not_started', 'in_progress'] },
    dueDate: tomorrowStr,
    assignedTo: { $ne: null },
  }).toArray();

  for (const task of dueTomorrow) {
    notifyEmployee(task.assignedTo, {
      title: `Due tomorrow: "${task.title}"`,
      body:  `Make sure to complete this task by ${task.dueDate}`,
      type:  'task_reminder',
    });
  }

  console.log(`[CRON] Daily task jobs done — overdue marked, ${newHires?.length ?? 0} onboarding triggers checked, ${dueTomorrow.length} reminders sent`);
}

async function detectMissedClockOuts() {
  if (!global.dbo) return;

  // Find attendance records where employee clocked in today but has no clock-out
  // after 12 hours — flag them as 'incomplete' and notify the employee
  const now = new Date();
  const cutoff = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const todayStr = now.toISOString().split('T')[0];

  const missed = await global.dbo.collection('attendance_records').find({
    date: todayStr,
    checkInAt: { $lte: cutoff },
    checkOutTime: null,
    missedClockOutNotified: { $ne: true },
  }).toArray();

  for (const rec of missed) {
    await global.dbo.collection('attendance_records').updateOne(
      { _id: rec._id },
      { $set: { status: 'incomplete', missedClockOutNotified: true, updatedAt: now } }
    );
    notifyEmployee(rec.employeeId, {
      title: 'Missing clock-out',
      body:  'You clocked in earlier today but never clocked out. Please update your attendance.',
      type:  'attendance_alert',
      link:  '/staff-portal',
    }).catch(() => {});
  }

  if (missed.length > 0) {
    console.log(`[CRON] Flagged ${missed.length} missed clock-out(s) for ${todayStr}`);
  }
}

// Reset on_leave status for employees whose approved leave has ended
async function resetOnLeaveStatus() {
  if (!global.dbo) return;
  const today = new Date();

  const onLeaveEmps = await global.dbo.collection('employees')
    .find({ status: 'on_leave' }, { projection: { _id: 1 } })
    .toArray();

  if (!onLeaveEmps.length) return;
  const empIds = onLeaveEmps.map(e => e._id);

  // Find which of these employees have NO currently-active approved leave
  const activeLeaves = await global.dbo.collection('leave_requests').find({
    employeeId: { $in: empIds },
    status: 'approved',
    endDate: { $gte: today },
  }, { projection: { employeeId: 1 } }).toArray();

  const stillOnLeave = new Set(activeLeaves.map(l => String(l.employeeId)));
  const toReset = empIds.filter(id => !stillOnLeave.has(String(id)));

  if (toReset.length) {
    await global.dbo.collection('employees').updateMany(
      { _id: { $in: toReset } },
      { $set: { status: 'active', updatedAt: new Date() } }
    );
    console.log(`[CRON] Reset ${toReset.length} employee(s) from on_leave → active`);
  }
}

// Flip employees.status to 'offboarding' only once their lastWorkingDay has passed
// — NOT at initiation. Many other modules (payroll compensation runs, attendance
// rosters, leave eligibility, performance reviews) filter on status:'active', so
// flipping early would silently drop someone still working out their notice
// period from payroll/attendance. "In offboarding" during the notice period is
// tracked purely via the offboardingRecord's own status, not employees.status.
async function flipOffboardingEmployeeStatus() {
  if (!global.dbo) return;
  const now = new Date();

  const dueRecords = await global.dbo.collection('offboarding_records').find({
    status: { $ne: 'completed' },
    lastWorkingDay: { $lte: now },
  }, { projection: { employeeId: 1 } }).toArray();

  if (!dueRecords.length) return;
  const empIds = dueRecords.map(r => r.employeeId);

  const result = await global.dbo.collection('employees').updateMany(
    { _id: { $in: empIds }, status: { $in: ['active', 'on_leave'] } },
    { $set: { status: 'offboarding', updatedAt: now } }
  );

  if (result.modifiedCount > 0) {
    console.log(`[CRON] Flipped ${result.modifiedCount} employee(s) to 'offboarding' status (past last working day)`);
  }
}

// Mark attendance records as 'late' for employees who clocked in after start + grace.
// Runs at 10:00 EAT (07:00 UTC) — well after any reasonable grace period.
//
// Per-employee shift start time (the same `shifts` doc clockOut already uses for its
// overtime split) wins over the org-wide default schedule — previously this compared
// every employee against whichever work_schedules doc happened to be first in the
// collection, regardless of what shift they were actually assigned. Grace-period
// minutes still fall back to the default schedule since `shifts` doesn't carry its
// own grace value yet.
async function markLateArrivals() {
  if (!global.dbo) return;
  const todayStr = new Date().toISOString().split('T')[0];

  const defaultSchedule = await global.dbo.collection('work_schedules').findOne({}) || {};
  const defaultStartTime = defaultSchedule.startTime || '09:00';
  const defaultGraceMins = Number(defaultSchedule.gracePeriod) || 15;

  const toMins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const thresholdStr = (startTime, graceMins) => {
    const total = toMins(startTime) + graceMins;
    const hh = String(Math.floor(total / 60)).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  };
  const defaultThreshold = thresholdStr(defaultStartTime, defaultGraceMins);

  const candidates = await global.dbo.collection('attendance_records').find({
    date: todayStr,
    status: 'present',
    lateMarked: { $ne: true },
    checkInTime: { $exists: true, $ne: null },
  }, { projection: { employeeId: 1, checkInTime: 1 } }).toArray();

  if (!candidates.length) return;

  const empIds = candidates.map((c) => c.employeeId);
  const todayShifts = await global.dbo.collection('shifts').find({
    employeeId: { $in: empIds }, date: todayStr,
  }, { projection: { employeeId: 1, startTime: 1 } }).toArray();
  const shiftByEmp = Object.fromEntries(todayShifts.map((s) => [String(s.employeeId), s]));

  const ops = [];
  for (const rec of candidates) {
    const shift = shiftByEmp[String(rec.employeeId)];
    let threshold;
    if (shift?.startTime) {
      threshold = thresholdStr(shift.startTime, defaultGraceMins);
    } else {
      // No ad-hoc shift for today — fall back to their standing schedule assignment.
      const assignedSchedule = await getEffectiveScheduleForEmployee(rec.employeeId, todayStr);
      threshold = assignedSchedule
        ? thresholdStr(assignedSchedule.startTime, Number(assignedSchedule.gracePeriod) || defaultGraceMins)
        : defaultThreshold;
    }
    if (rec.checkInTime > threshold) {
      ops.push({
        updateOne: {
          filter: { _id: rec._id },
          update: { $set: { status: 'late', lateMarked: true, updatedAt: new Date() } },
        },
      });
    }
  }

  if (ops.length) {
    const result = await global.dbo.collection('attendance_records').bulkWrite(ops);
    console.log(`[CRON] Marked ${result.modifiedCount} employee(s) as late for ${todayStr} (per-shift thresholds)`);
  }
}

// Auto-mark absent for active employees with no attendance record by end of work day
// Runs at 18:00 EAT (15:00 UTC)
async function autoMarkAbsent() {
  if (!global.dbo) return;
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // Skip weekends (0=Sun, 6=Sat)
  const dow = now.getDay();
  if (dow === 0 || dow === 6) return;

  // Get all active employees
  const activeEmps = await global.dbo.collection('employees')
    .find({ status: { $in: ['active'] } }, { projection: { _id: 1 } })
    .toArray();

  if (!activeEmps.length) return;
  const empIds = activeEmps.map(e => e._id);

  // Find employees who already have a record today
  const existing = await global.dbo.collection('attendance_records')
    .find({ date: todayStr, employeeId: { $in: empIds } }, { projection: { employeeId: 1 } })
    .toArray();
  const hasRecord = new Set(existing.map(r => String(r.employeeId)));

  // Employees on approved leave today are not absent
  const onLeave = await global.dbo.collection('leave_requests').find({
    employeeId: { $in: empIds },
    status: 'approved',
    startDate: { $lte: now },
    endDate:   { $gte: now },
  }, { projection: { employeeId: 1 } }).toArray();
  const onLeaveIds = new Set(onLeave.map(l => String(l.employeeId)));

  const noRecordIds = empIds.filter(id => !hasRecord.has(String(id)));
  const absentIds = noRecordIds.filter(id => !onLeaveIds.has(String(id)));
  const onLeaveNoRecordIds = noRecordIds.filter(id => onLeaveIds.has(String(id)));

  if (!absentIds.length && !onLeaveNoRecordIds.length) return;

  const docs = [
    ...absentIds.map(id => ({ employeeId: id, date: todayStr, status: 'absent', autoMarked: true, createdAt: now, updatedAt: now })),
    ...onLeaveNoRecordIds.map(id => ({ employeeId: id, date: todayStr, status: 'onLeave', autoMarked: true, createdAt: now, updatedAt: now })),
  ];

  // bulkWrite to avoid duplicates (in case of reruns)
  await global.dbo.collection('attendance_records').bulkWrite(
    docs.map(doc => ({
      updateOne: {
        filter: { employeeId: doc.employeeId, date: todayStr },
        update: { $setOnInsert: doc },
        upsert: true,
      },
    }))
  );

  if (absentIds.length) console.log(`[CRON] Auto-marked ${absentIds.length} employee(s) as absent for ${todayStr}`);
  if (onLeaveNoRecordIds.length) console.log(`[CRON] Auto-marked ${onLeaveNoRecordIds.length} employee(s) as onLeave for ${todayStr}`);
}

// ── Training / LMS: overdue detection + automation rule engine ────────────────

async function checkOverdueTraining() {
  if (!global.dbo) return;

  const now = new Date();
  const overdue = await global.dbo.collection('enrollments').find({
    dueDate: { $lt: now, $ne: null },
    status: { $in: ['notStarted', 'inProgress'] },
  }).toArray();

  if (!overdue.length) return;

  const courseIds = [...new Set(overdue.filter((e) => e.courseId).map((e) => String(e.courseId)))].map((id) => new ObjectId(id));
  const courses = courseIds.length
    ? await global.dbo.collection('courses').find({ _id: { $in: courseIds } }, { projection: { title: 1 } }).toArray()
    : [];
  const titleMap = Object.fromEntries(courses.map((c) => [String(c._id), c.title]));

  for (const enr of overdue) {
    await global.dbo.collection('enrollments').updateOne(
      { _id: enr._id },
      { $set: { status: 'overdue', updatedAt: now } }
    );
    // enrollments.employeeId is the learner's users._id directly (not an employees._id),
    // so this must use notifyUser, not notifyEmployee (which expects an employees._id).
    notifyUser(enr.employeeId, {
      title: 'Training Overdue',
      body: `"${titleMap[String(enr.courseId)] || 'A required course'}" was due and is now overdue — please complete it.`,
      type: 'training',
      link: '/my/training',
    }).catch(() => {});
  }

  console.log(`[CRON] Marked ${overdue.length} training enrollment(s) overdue`);
}

async function runTrainingAutomationRules() {
  if (!global.dbo) return;
  try {
    const { runDueScheduledAndExpiryRules } = require('../training/autoEnrollment');
    await runDueScheduledAndExpiryRules();
  } catch (err) {
    console.error('[CRON] Training automation rule error:', err.message);
  }
}

function startCronJobs() {
  // Daily at midnight (UTC) — task overdue, onboarding triggers, reminders
  cron.schedule('0 0 * * *', async () => {
    try { await dailyTaskJobs(); }
    catch (err) { console.error('[CRON] Task job error:', err); }
  });

  // Daily at 07:00 UTC (10:00 EAT) — mark late arrivals
  cron.schedule('0 7 * * *', async () => {
    try { await markLateArrivals(); }
    catch (err) { console.error('[CRON] Late-marking error:', err); }
  });

  // Daily at 15:00 UTC (18:00 EAT) — auto-mark absent for no-shows
  cron.schedule('0 15 * * *', async () => {
    try { await autoMarkAbsent(); }
    catch (err) { console.error('[CRON] Auto-absent error:', err); }
  });

  // Daily at 00:05 UTC — reset on_leave → active for employees whose leave ended
  cron.schedule('5 0 * * *', async () => {
    try { await resetOnLeaveStatus(); }
    catch (err) { console.error('[CRON] On-leave reset error:', err); }
  });

  // Daily at 00:10 UTC — flip employees.status to 'offboarding' once their last working day has passed
  cron.schedule('10 0 * * *', async () => {
    try { await flipOffboardingEmployeeStatus(); }
    catch (err) { console.error('[CRON] Offboarding status flip error:', err); }
  });

  // Every hour: detect employees who clocked in but haven't clocked out after 12h
  cron.schedule('0 * * * *', async () => {
    try { await detectMissedClockOuts(); }
    catch (err) { console.error('[CRON] Clock-out detection error:', err); }
  });

  // 1st of each month at 01:00 UTC — monthly leave accrual (idempotent per month)
  cron.schedule('0 1 1 * *', async () => {
    try {
      const r = await runAccrual(null);
      console.log(`[CRON] Leave accrual: ${r.processed} balance(s) updated`);
    } catch (err) { console.error('[CRON] Leave accrual error:', err); }
  });

  // Jan 1 at 02:00 UTC — year-end carry-forward for the previous year
  cron.schedule('0 2 1 1 *', async () => {
    try {
      const r = await runYearEndCarryOver(null);
      console.log(`[CRON] Year-end carry-forward: ${r.processed} balance(s) created`);
    } catch (err) { console.error('[CRON] Year-end carry-forward error:', err); }
  });

  // Daily at 08:00 UTC — mark overdue training enrollments + notify
  cron.schedule('0 8 * * *', async () => {
    try { await checkOverdueTraining(); }
    catch (err) { console.error('[CRON] Training overdue check error:', err); }
  });

  // Daily at 08:15 UTC — run due "scheduled" and "onCertExpiry" training assignment rules
  cron.schedule('15 8 * * *', async () => {
    try { await runTrainingAutomationRules(); }
    catch (err) { console.error('[CRON] Training automation rule error:', err); }
  });

  // Daily at 06:00 UTC — run due weekly/monthly scheduled custom reports and email them
  cron.schedule('0 6 * * *', async () => {
    try { await runDueScheduledReports(); }
    catch (err) { console.error('[CRON] Scheduled report error:', err); }
  });

  console.log('[CRON] All cron jobs scheduled');
}

module.exports = { startCronJobs, dailyTaskJobs, checkOverdueTraining, runTrainingAutomationRules, flipOffboardingEmployeeStatus, autoMarkAbsent, markLateArrivals, detectMissedClockOuts };
