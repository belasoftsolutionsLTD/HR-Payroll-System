const cron = require('node-cron');
const { ObjectId } = require('mongodb');
const { triggerTasksFromTemplate } = require('./triggerTasksFromTemplate');
const { notifyEmployee } = require('../../functions/HR/notifyUser');
const { runLeaveAccrual, runYearEndCarryForward } = require('../../routes/leave/leaveFunctions');

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
  const todayStr = new Date().toISOString().split('T')[0];

  const onLeaveEmps = await global.dbo.collection('employees')
    .find({ status: 'on_leave' }, { projection: { _id: 1 } })
    .toArray();

  if (!onLeaveEmps.length) return;
  const empIds = onLeaveEmps.map(e => e._id);

  // Find which of these employees have NO currently-active approved leave
  const activeLeaves = await global.dbo.collection('leave_requests').find({
    employeeId: { $in: empIds },
    status: 'approved',
    endDate: { $gte: todayStr },
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

// Mark attendance records as 'late' for employees who clocked in after start + grace
// Runs at 10:00 EAT (07:00 UTC) — well after any reasonable grace period
async function markLateArrivals() {
  if (!global.dbo) return;
  const todayStr = new Date().toISOString().split('T')[0];

  // Load default schedule (first enabled schedule, or hard defaults)
  const schedule = await global.dbo.collection('work_schedules').findOne({}) || {};
  const startTime   = schedule.startTime   || '09:00';
  const graceMins   = Number(schedule.gracePeriod) || 15;

  // Compute late threshold as 'HH:MM' string
  const [sh, sm] = startTime.split(':').map(Number);
  const lateMins  = sh * 60 + sm + graceMins;
  const lateHH    = String(Math.floor(lateMins / 60)).padStart(2, '0');
  const lateMM    = String(lateMins % 60).padStart(2, '0');
  const lateThreshold = `${lateHH}:${lateMM}`;

  // Find records clocked in today with checkInTime after the threshold and still marked 'present'
  const result = await global.dbo.collection('attendance_records').updateMany(
    {
      date: todayStr,
      status: 'present',
      checkInTime: { $gt: lateThreshold },
      lateMarked: { $ne: true },
    },
    { $set: { status: 'late', lateMarked: true, updatedAt: new Date() } }
  );

  if (result.modifiedCount > 0) {
    console.log(`[CRON] Marked ${result.modifiedCount} employee(s) as late for ${todayStr} (threshold ${lateThreshold})`);
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
    startDate: { $lte: todayStr },
    endDate:   { $gte: todayStr },
  }, { projection: { employeeId: 1 } }).toArray();
  const onLeaveIds = new Set(onLeave.map(l => String(l.employeeId)));

  const absentIds = empIds.filter(id => !hasRecord.has(String(id)) && !onLeaveIds.has(String(id)));

  if (!absentIds.length) return;

  const absentDocs = absentIds.map(id => ({
    employeeId: id,
    date:       todayStr,
    status:     'absent',
    autoMarked: true,
    createdAt:  now,
    updatedAt:  now,
  }));

  // bulkWrite to avoid duplicates (in case of reruns)
  await global.dbo.collection('attendance_records').bulkWrite(
    absentDocs.map(doc => ({
      updateOne: {
        filter: { employeeId: doc.employeeId, date: todayStr },
        update: { $setOnInsert: doc },
        upsert: true,
      },
    }))
  );

  console.log(`[CRON] Auto-marked ${absentIds.length} employee(s) as absent for ${todayStr}`);
}

// ── Auto-complete training sessions whose end time has passed ─────────────────

async function autoCompleteTraining() {
  if (!global.dbo) return;

  const now = new Date();

  // Find in_progress enrollments
  const inProgress = await global.dbo.collection('training_enrollments')
    .find({ status: 'in_progress' }, { projection: { _id: 1, courseId: 1, startedAt: 1 } })
    .toArray();

  if (!inProgress.length) return;

  const courseIds = [...new Set(inProgress.map(e => String(e.courseId)))];

  // Find courses whose endTime has passed and is a full ISO datetime
  const courses = await global.dbo.collection('training_courses').find({
    _id: { $in: courseIds.map(id => new ObjectId(id)) },
    endTime: { $ne: null },
  }, { projection: { _id: 1, endTime: 1, isRecurring: 1, recurringFrequency: 1, startTime: 1 } }).toArray();

  let count = 0;
  for (const course of courses) {
    if (!course.endTime || !String(course.endTime).includes('T')) continue;
    const endDate = new Date(course.endTime);
    if (isNaN(endDate.getTime()) || endDate > now) continue;

    // Mark matching enrollments as auto_completed
    const matching = inProgress.filter(e => String(e.courseId) === String(course._id));
    for (const enr of matching) {
      const minutesPresent = enr.startedAt
        ? Math.max(1, Math.round((endDate - new Date(enr.startedAt)) / 60000))
        : null;

      await global.dbo.collection('training_enrollments').updateOne(
        { _id: enr._id },
        { $set: {
          status: 'auto_completed',
          completedAt: endDate,
          progress: 100,
          ...(minutesPresent !== null ? { minutesPresent } : {}),
          updatedAt: now,
        }}
      );
      count++;
    }

    // Auto-create next occurrence for recurring courses (once, using a flag)
    if (course.isRecurring && course.recurringFrequency && !course.nextOccurrenceCreated) {
      const freq = {
        daily:     { days: 1 },
        weekly:    { days: 7 },
        monthly:   { months: 1 },
        quarterly: { months: 3 },
        annually:  { years: 1 },
      }[course.recurringFrequency];

      if (freq) {
        const addToDate = (d) => {
          const nd = new Date(d);
          if (freq.days)   nd.setDate(nd.getDate() + freq.days);
          if (freq.months) nd.setMonth(nd.getMonth() + freq.months);
          if (freq.years)  nd.setFullYear(nd.getFullYear() + freq.years);
          return nd;
        };

        const fullCourse = await global.dbo.collection('training_courses').findOne({ _id: course._id });
        if (fullCourse) {
          const { _id, createdAt, updatedAt, enrolledCount, nextOccurrenceCreated, ...rest } = fullCourse;
          await global.dbo.collection('training_courses').insertOne({
            ...rest,
            startTime: fullCourse.startTime ? addToDate(fullCourse.startTime).toISOString() : null,
            endTime:   fullCourse.endTime   ? addToDate(fullCourse.endTime).toISOString()   : null,
            enrolledCount: 0,
            status: 'published',
            nextOccurrenceCreated: false,
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      // Mark this course so we don't create another occurrence next run
      await global.dbo.collection('training_courses').updateOne(
        { _id: course._id },
        { $set: { nextOccurrenceCreated: true, updatedAt: now } }
      );
    }
  }

  if (count > 0) {
    console.log(`[CRON] Auto-completed ${count} training enrollment(s)`);
  }
}

async function checkOverdueMandatoryTraining() {
  if (!global.dbo) return;

  const todayStr = new Date().toISOString().split('T')[0];

  const mandatoryCourses = await global.dbo.collection('training_courses')
    .find({ isMandatory: true, status: 'published' }, { projection: { _id: 1, title: 1 } })
    .toArray();

  if (!mandatoryCourses.length) return;

  const mandatoryIds = mandatoryCourses.map(c => c._id);
  const titleMap = Object.fromEntries(mandatoryCourses.map(c => [String(c._id), c.title]));

  const overdue = await global.dbo.collection('training_enrollments').find({
    courseId: { $in: mandatoryIds },
    dueDate: { $lt: todayStr, $ne: null },
    status: { $nin: ['completed', 'auto_completed'] },
    overdueNotified: { $ne: todayStr },
  }).toArray();

  for (const enr of overdue) {
    notifyEmployee(enr.userId, {
      title: 'Mandatory training overdue',
      body: `"${titleMap[String(enr.courseId)] || 'A mandatory course'}" was due ${enr.dueDate} — please complete it now.`,
      type: 'training_overdue',
      link: '/training',
    }).catch(() => {});

    await global.dbo.collection('training_enrollments').updateOne(
      { _id: enr._id },
      { $set: { overdueNotified: todayStr } }
    );
  }

  if (overdue.length > 0) {
    console.log(`[CRON] Notified ${overdue.length} employee(s) of overdue mandatory training`);
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

  // Every hour: detect employees who clocked in but haven't clocked out after 12h
  cron.schedule('0 * * * *', async () => {
    try { await detectMissedClockOuts(); }
    catch (err) { console.error('[CRON] Clock-out detection error:', err); }
  });

  // Every 15 minutes: auto-complete training sessions whose end time has passed
  cron.schedule('*/15 * * * *', async () => {
    try { await autoCompleteTraining(); }
    catch (err) { console.error('[CRON] Training auto-complete error:', err); }
  });

  // 1st of each month at 01:00 UTC — monthly leave accrual (idempotent per month)
  cron.schedule('0 1 1 * *', async () => {
    try {
      const r = await runLeaveAccrual({ body: {}, query: {} }, null);
      console.log(`[CRON] Leave accrual ${r.accrualMonth}: ${r.processed} processed, ${r.skipped} skipped`);
    } catch (err) { console.error('[CRON] Leave accrual error:', err); }
  });

  // Jan 1 at 02:00 UTC — year-end carry-forward for the previous year
  cron.schedule('0 2 1 1 *', async () => {
    try { await runYearEndCarryForward({ body: {}, query: {} }, null); }
    catch (err) { console.error('[CRON] Year-end carry-forward error:', err); }
  });

  // Daily at 08:00 UTC — notify employees with overdue mandatory training
  cron.schedule('0 8 * * *', async () => {
    try { await checkOverdueMandatoryTraining(); }
    catch (err) { console.error('[CRON] Mandatory training overdue check error:', err); }
  });

  console.log('[CRON] All cron jobs scheduled');
}

module.exports = { startCronJobs, dailyTaskJobs, autoCompleteTraining };
