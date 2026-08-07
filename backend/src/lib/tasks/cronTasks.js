const cron = require('node-cron');
const { ObjectId } = require('mongodb');
const { triggerTasksFromTemplate } = require('./triggerTasksFromTemplate');
const { notifyEmployee, notifyUser, notifyByRoles } = require('../../functions/HR/notifyUser');
const { runAccrual, runYearEndCarryOver } = require('../leave/accrualEngine');
const { getEffectiveScheduleForEmployee } = require('../../routes/attendance/attendanceFunctions');
const { runDueScheduledReports } = require('../../routes/reports/reportFunctions');
const { getLowStockLevels } = require('../../routes/inventory/inventoryLocationsFunctions');
const { updateOne, findOne, findMany } = require('../../functions/Database/commonDBFunctions');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md) —
// employees/users (Phase 1) and leave_requests/leave_types (Phase 3a) now live in
// Postgres; attendance_records/shifts/work_schedules/offboarding_records stay on the
// Mongo helpers above until their own phase.
const pgDB = require('../../functions/Database/pgDBFunctions');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

const emailEmployee = async (employeeId, trigger, tokens, fallbackSubject, fallbackHtml) => {
  const user = await pgDB.knex('users').where({ employeeId: String(employeeId) }).select('email').first();
  if (!user?.email) return;
  return sendTemplatedEmail({ trigger, to: user.email, tokens, fallbackSubject, fallbackHtml }).catch(() => {});
};
const emailUser = async (userId, trigger, tokens, fallbackSubject, fallbackHtml) => {
  const user = await pgDB.findOne('users', { id: String(userId) });
  if (!user?.email) return;
  return sendTemplatedEmail({ trigger, to: user.email, tokens, fallbackSubject, fallbackHtml }).catch(() => {});
};

// Re-notifying on every hourly/daily tick for a level that's been low for a week would
// bury HR's inbox — only re-alert once the last alert is more than 20h old, same
// "sentFlag timestamp" idempotency idiom leaveStartReminder/detectMissedClockOuts use.
const LOW_STOCK_REALERT_MS = 20 * 60 * 60 * 1000;

async function checkLowStockAlerts() {
  if (!global.dbo) return;
  const lowLevels = await getLowStockLevels(null); // null = unrestricted, company-wide sweep
  const now = Date.now();
  const dueForAlert = lowLevels.filter((l) => !l.lastLowStockAlertAt || (now - new Date(l.lastLowStockAlertAt).getTime()) > LOW_STOCK_REALERT_MS);
  if (!dueForAlert.length) return;

  for (const level of dueForAlert) {
    await notifyByRoles(['super_admin', 'hr_manager'], {
      title: 'Low stock alert',
      body: `${level.item?.name ?? 'An item'} (${level.item?.sku ?? ''}) at ${level.location?.name ?? 'a location'} is at ${level.quantity} ${level.item?.unitOfMeasure ?? 'units'}, at/below its reorder point of ${level.reorderPoint}.`,
      type: 'inventory',
      link: `/inventory?tab=items`,
    }).catch(() => {});
    {
      const hrUsers = await findMany('users', { role: { $in: ['super_admin', 'hr_manager'] }, isActive: { $ne: false } }, { projection: { email: 1 } });
      const tokens = {
        itemName: level.item?.name ?? 'An item', sku: level.item?.sku ?? '', locationName: level.location?.name ?? 'a location',
        quantity: level.quantity, unitOfMeasure: level.item?.unitOfMeasure ?? 'units', reorderPoint: level.reorderPoint,
      };
      hrUsers.filter(u => u.email).forEach(u => sendTemplatedEmail({
        trigger: 'inventoryLowStockAlert', to: u.email, tokens,
        fallbackSubject: 'Low stock alert',
        fallbackHtml: `<p>${tokens.itemName} (${tokens.sku}) at ${tokens.locationName} is at ${tokens.quantity} ${tokens.unitOfMeasure}, at/below its reorder point of ${tokens.reorderPoint}.</p>`,
      }).catch(() => {}));
    }
    await updateOne('inventory_stock_levels', { itemId: level.itemId, locationId: level.locationId }, { $set: { lastLowStockAlertAt: new Date() } });
  }
}

// employees.certifications[] (Skills & Qualifications tab) has always had an expiryDate
// field but no notification behind it — pull-based only via getUpcomingAnalytics. This is
// the smallest addition that gives it one, reused as-is by Logistics for driver license
// expiry rather than building a parallel tracking system. Same single-fixed-offset +
// sent-flag idempotency pattern as leaveStartReminder (30 days ahead, once per cert).
async function checkExpiringCertifications() {
  if (!global.dbo) return;
  const target = new Date();
  target.setUTCDate(target.getUTCDate() + 30);
  const dayStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const employees = await global.dbo.collection('employees').find({
    certifications: { $elemMatch: { expiryDate: { $gte: dayStart, $lt: dayEnd }, alertSent: { $ne: true } } },
  }, { projection: { fullName: 1, certifications: 1 } }).toArray();
  if (!employees.length) return;

  for (const emp of employees) {
    const due = emp.certifications.filter((c) => c.expiryDate && new Date(c.expiryDate) >= dayStart && new Date(c.expiryDate) < dayEnd && !c.alertSent);
    for (const cert of due) {
      notifyEmployee(emp._id, {
        title: 'Certification Expiring Soon',
        body: `Your "${cert.name}" certification expires on ${new Date(cert.expiryDate).toISOString().split('T')[0]} — renew it soon.`,
        type: 'general',
      }).catch(() => {});
      emailEmployee(emp._id, 'certificationExpiring', { certName: cert.name, expiryDate: new Date(cert.expiryDate).toISOString().split('T')[0] },
        'Certification Expiring Soon',
        `<p>Your "${cert.name}" certification expires on ${new Date(cert.expiryDate).toISOString().split('T')[0]} — renew it soon.</p>`);
      await global.dbo.collection('employees').updateOne(
        { _id: emp._id },
        { $set: { 'certifications.$[cert].alertSent': true } },
        { arrayFilters: [{ 'cert.id': cert.id }] }
      );
    }
  }
}

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
    emailEmployee(task.assignedTo, 'taskDueTomorrow', { taskTitle: task.title, dueDate: task.dueDate },
      `Due tomorrow: "${task.title}"`, `<p>Make sure to complete this task by ${task.dueDate}.</p>`);
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
    emailEmployee(rec.employeeId, 'missingClockOut', {}, 'Missing clock-out',
      '<p>You clocked in earlier today but never clocked out. Please update your attendance.</p>');
  }

  if (missed.length > 0) {
    console.log(`[CRON] Flagged ${missed.length} missed clock-out(s) for ${todayStr}`);
  }
}

// Reset on_leave status for employees whose approved leave has ended
async function resetOnLeaveStatus() {
  const today = new Date();

  const onLeaveEmps = await pgDB.knex('employees').where({ status: 'on_leave' }).select('id');
  if (!onLeaveEmps.length) return;
  const empIds = onLeaveEmps.map(e => e.id);

  // Find which of these employees have NO currently-active approved leave
  const activeLeaves = await pgDB.knex('leave_requests')
    .whereIn('employeeId', empIds).where({ status: 'approved' }).where('endDate', '>=', today)
    .select('employeeId');

  const stillOnLeave = new Set(activeLeaves.map(l => l.employeeId));
  const toReset = empIds.filter(id => !stillOnLeave.has(id));

  if (toReset.length) {
    await pgDB.knex('employees').whereIn('id', toReset).update({ status: 'active', updatedAt: new Date() });
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
  const empIds = dueRecords.map(r => String(r.employeeId));

  const modifiedCount = await pgDB.knex('employees')
    .whereIn('id', empIds).whereIn('status', ['active', 'on_leave'])
    .update({ status: 'offboarding', updatedAt: now });

  if (modifiedCount > 0) {
    console.log(`[CRON] Flipped ${modifiedCount} employee(s) to 'offboarding' status (past last working day)`);
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

  // Get all active employees. employees now lives in Postgres (Phase 1); empObjectIds
  // is kept alongside the plain-string empIds for the still-Mongo attendance_records
  // queries/writes below.
  const activeEmps = await pgDB.knex('employees').where({ status: 'active' }).select('id');
  if (!activeEmps.length) return;
  const empIds = activeEmps.map(e => e.id);
  const empObjectIds = empIds.map((id) => new ObjectId(id));

  // Find employees who already have a record today
  const existing = await global.dbo.collection('attendance_records')
    .find({ date: todayStr, employeeId: { $in: empObjectIds } }, { projection: { employeeId: 1 } })
    .toArray();
  const hasRecord = new Set(existing.map(r => String(r.employeeId)));

  // Employees on approved leave today are not absent. leave_requests now lives in
  // Postgres (Phase 3a).
  const onLeave = await pgDB.knex('leave_requests')
    .whereIn('employeeId', empIds).where({ status: 'approved' })
    .where('startDate', '<=', now).where('endDate', '>=', now)
    .select('employeeId');
  const onLeaveIds = new Set(onLeave.map(l => l.employeeId));

  const noRecordIds = empObjectIds.filter(id => !hasRecord.has(String(id)));
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

// Contract employees (employmentType:'contract') — including project-invite contractors,
// see projectsFunctions.js's acceptInviteCore — have their login access end automatically
// once contractEndDate passes, so a short (e.g. 2-week) engagement is self-cleaning and
// doesn't rely on anyone remembering to manually offboard them. Scoped to employmentType
// 'contract' specifically (not "any employee with a past contractEndDate") since that
// field is a general, already-existing employee field that HR may have set on other
// employment types for informational tracking only, with no prior expectation that it
// would ever trigger deactivation.
async function deactivateExpiredContractors() {
  const now = new Date();

  const expired = await pgDB.knex('employees')
    .where({ employmentType: 'contract' }).whereNotNull('contractEndDate').where('contractEndDate', '<=', now)
    .whereIn('status', ['active', 'on_leave']).select('id');

  if (!expired.length) return;
  const empIds = expired.map(e => e.id);

  await pgDB.knex('employees').whereIn('id', empIds).update({ status: 'offboarding', updatedAt: now });

  const modifiedCount = await pgDB.knex('users').whereIn('employeeId', empIds).where({ isActive: true })
    .update({ isActive: false, updatedAt: now, refreshTokenHash: null, refreshTokenExpiresAt: null });

  console.log(`[CRON] Contract expiry: deactivated ${modifiedCount} user account(s), flipped ${empIds.length} employee(s) to 'offboarding'`);
}

// Leave: 3-day advance reminder before an approved leave starts. Matches by
// calendar date only (a UTC day range), not time-of-day. leaveStartReminderSent
// guards against re-sending on the next run once a request has been notified.
async function leaveStartReminder() {
  const target = new Date();
  target.setUTCDate(target.getUTCDate() + 3);
  const dayStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const upcoming = await pgDB.knex('leave_requests')
    .where({ status: 'approved' }).where('startDate', '>=', dayStart).where('startDate', '<', dayEnd)
    .whereNot('leaveStartReminderSent', true);
  if (!upcoming.length) return;

  const leaveTypeIds = [...new Set(upcoming.map(r => r.leaveTypeId))];
  const leaveTypes = leaveTypeIds.length ? await pgDB.knex('leave_types').whereIn('id', leaveTypeIds).select('id', 'name') : [];
  const nameById = Object.fromEntries(leaveTypes.map(t => [t.id, t.name]));

  for (const r of upcoming) {
    const dateStr = new Date(r.startDate).toISOString().split('T')[0];
    notifyEmployee(r.employeeId, {
      title: 'Upcoming Leave',
      body: `Your ${nameById[r.leaveTypeId] || 'leave'} leave begins in 3 days, on ${dateStr}. Please make any necessary arrangements.`,
      type: 'leave',
    }).catch(() => {});
    emailEmployee(r.employeeId, 'upcomingLeaveReminder', { leaveType: nameById[r.leaveTypeId] || 'leave', startDate: dateStr },
      'Upcoming Leave', `<p>Your ${nameById[r.leaveTypeId] || 'leave'} leave begins in 3 days, on ${dateStr}. Please make any necessary arrangements.</p>`);
    await pgDB.knex('leave_requests').where({ id: r.id }).update({ leaveStartReminderSent: true, updatedAt: new Date() });
  }
  console.log(`[CRON] Sent ${upcoming.length} leave-start reminder(s)`);
}

// Leave: "welcome back" reminder 3 days after an approved leave ended. Same
// date-only matching + sent-flag guard as leaveStartReminder above.
async function leaveEndReminder() {
  const target = new Date();
  target.setUTCDate(target.getUTCDate() - 3);
  const dayStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  const dayEnd = new Date(dayStart); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const ended = await pgDB.knex('leave_requests')
    .where({ status: 'approved' }).where('endDate', '>=', dayStart).where('endDate', '<', dayEnd)
    .whereNot('leaveEndReminderSent', true);
  if (!ended.length) return;

  const leaveTypeIds = [...new Set(ended.map(r => r.leaveTypeId))];
  const leaveTypes = leaveTypeIds.length ? await pgDB.knex('leave_types').whereIn('id', leaveTypeIds).select('id', 'name') : [];
  const nameById = Object.fromEntries(leaveTypes.map(t => [t.id, t.name]));

  for (const r of ended) {
    const dateStr = new Date(r.endDate).toISOString().split('T')[0];
    notifyEmployee(r.employeeId, {
      title: 'Welcome Back',
      body: `Your ${nameById[r.leaveTypeId] || 'leave'} leave ended 3 days ago, on ${dateStr}. We hope you had a restful break.`,
      type: 'leave',
    }).catch(() => {});
    emailEmployee(r.employeeId, 'leaveWelcomeBack', { leaveType: nameById[r.leaveTypeId] || 'leave', endDate: dateStr },
      'Welcome Back', `<p>Your ${nameById[r.leaveTypeId] || 'leave'} leave ended 3 days ago, on ${dateStr}. We hope you had a restful break.</p>`);
    await pgDB.knex('leave_requests').where({ id: r.id }).update({ leaveEndReminderSent: true, updatedAt: new Date() });
  }
  console.log(`[CRON] Sent ${ended.length} leave-end reminder(s)`);
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
    emailUser(enr.employeeId, 'trainingOverdue', { courseTitle: titleMap[String(enr.courseId)] || 'A required course' },
      'Training Overdue', `<p>"${titleMap[String(enr.courseId)] || 'A required course'}" was due and is now overdue — please complete it.</p>`);
  }

  console.log(`[CRON] Marked ${overdue.length} training enrollment(s) overdue`);
}

// Flip 'open' requisitions past their applicationDeadline to 'closed'. The public/
// internal application routes already reject expired-but-still-open requisitions
// in real time (see the notExpired() filter in publicRoutes.js / meFunctions.js) —
// this is what makes that reflected in HR's own requisition list/status field too.
async function closeExpiredRequisitions() {
  if (!global.dbo) return;
  const result = await global.dbo.collection('jobRequisitions').updateMany(
    { status: 'open', applicationDeadline: { $ne: null, $lt: new Date() } },
    { $set: { status: 'closed', updatedAt: new Date() } }
  );
  if (result.modifiedCount > 0) {
    console.log(`[CRON] Auto-closed ${result.modifiedCount} requisition(s) past their application deadline`);
  }
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

  // Daily at 00:20 UTC — deactivate login access for contract employees past their contractEndDate
  cron.schedule('20 0 * * *', async () => {
    try { await deactivateExpiredContractors(); }
    catch (err) { console.error('[CRON] Contract expiry deactivation error:', err); }
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

  // Daily at 08:00 UTC — leave-start (3 days ahead) and leave-end (3 days after) reminders
  cron.schedule('0 8 * * *', async () => {
    try { await leaveStartReminder(); }
    catch (err) { console.error('[CRON] Leave start reminder error:', err); }
    try { await leaveEndReminder(); }
    catch (err) { console.error('[CRON] Leave end reminder error:', err); }
  });

  // Daily at 08:15 UTC — run due "scheduled" and "onCertExpiry" training assignment rules
  cron.schedule('15 8 * * *', async () => {
    try { await runTrainingAutomationRules(); }
    catch (err) { console.error('[CRON] Training automation rule error:', err); }
  });

  // Daily at 08:20 UTC — employees.certifications[] expiring in 30 days (driver licenses, etc.)
  cron.schedule('20 8 * * *', async () => {
    try { await checkExpiringCertifications(); }
    catch (err) { console.error('[CRON] Certification expiry check error:', err); }
  });

  // Daily at 00:15 UTC — auto-close requisitions past their application deadline
  cron.schedule('15 0 * * *', async () => {
    try { await closeExpiredRequisitions(); }
    catch (err) { console.error('[CRON] Requisition auto-close error:', err); }
  });

  // Daily at 06:00 UTC — run due weekly/monthly scheduled custom reports and email them
  cron.schedule('0 6 * * *', async () => {
    try { await runDueScheduledReports(); }
    catch (err) { console.error('[CRON] Scheduled report error:', err); }
  });

  // Every 2 hours — sweep inventory_stock_levels for anything at/below its reorder
  // point and notify HR (idempotency guard inside checkLowStockAlerts avoids re-paging
  // for the same low item more than once every ~20h).
  cron.schedule('0 */2 * * *', async () => {
    try { await checkLowStockAlerts(); }
    catch (err) { console.error('[CRON] Low stock alert error:', err); }
  });

  console.log('[CRON] All cron jobs scheduled');
}

module.exports = { startCronJobs, dailyTaskJobs, checkOverdueTraining, runTrainingAutomationRules, flipOffboardingEmployeeStatus, deactivateExpiredContractors, autoMarkAbsent, markLateArrivals, detectMissedClockOuts, closeExpiredRequisitions, leaveStartReminder, leaveEndReminder, checkLowStockAlerts, checkExpiringCertifications };
