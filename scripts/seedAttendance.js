/**
 * Attendance & Time Tracking demo seed.
 * Creates 3 work schedules (Standard 9-5, Morning 7-3, Flexible 10-6), assigns one
 * to every active employee via employeeShiftAssignments, generates 30 days of
 * attendance_records per employee (weekdays only, varied present/late/absent/half_day
 * statuses with realistic clock times, breaks, and shift-based overtime splits), and
 * builds weekly timesheets for the last 4 weeks aggregated from those records, with a
 * mix of submitted/approved/rejected/draft statuses. Idempotent — safe to re-run
 * (upserts attendance by {employeeId,date}, timesheets by {employeeId,weekStart},
 * skips schedules/assignments that already exist).
 * Run: node scripts/seedAttendance.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'school-erp';

const SCHEDULES = [
  { name: 'Standard 9-5', startTime: '09:00', endTime: '17:00', breakMinutes: 60, weeklyHours: 40, gracePeriod: 15 },
  { name: 'Morning 7-3',  startTime: '07:00', endTime: '15:00', breakMinutes: 45, weeklyHours: 40, gracePeriod: 10 },
  { name: 'Flexible 10-6', startTime: '10:00', endTime: '18:00', breakMinutes: 60, weeklyHours: 40, gracePeriod: 20 },
];

function toMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function toTimeStr(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function dateStr(d) { return d.toISOString().split('T')[0]; }
function mondayOf(d) {
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return monday;
}
// Small deterministic pseudo-random generator so re-runs produce the same demo data.
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log('Connected to', DB_NAME);

  const now = new Date();

  // ── 1. Work schedules ─────────────────────────────────────────────────────────
  const scheduleIds = [];
  for (const s of SCHEDULES) {
    let doc = await db.collection('work_schedules').findOne({ name: s.name });
    if (!doc) {
      const result = await db.collection('work_schedules').insertOne({
        ...s, workDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], createdBy: null, createdAt: now, isDemoSeed: true,
      });
      doc = { _id: result.insertedId, ...s };
      console.log(`Created work schedule: ${s.name}`);
    }
    scheduleIds.push(doc);
  }

  // ── 2. Employees ──────────────────────────────────────────────────────────────
  const employees = await db.collection('employees').find({ status: 'active' }).toArray();
  if (!employees.length) {
    console.log('No active employees found — seed the employees module first (or run seed-demo.js).');
    await client.close();
    return;
  }
  console.log(`Seeding attendance for ${employees.length} active employee(s)`);

  // ── 3. Shift assignments — rotate employees across the 3 schedules ─────────────
  const effectiveFrom = new Date(now); effectiveFrom.setDate(effectiveFrom.getDate() - 60);
  let assignmentsCreated = 0;
  const scheduleByEmp = {};
  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];
    const schedule = scheduleIds[i % scheduleIds.length];
    scheduleByEmp[String(emp._id)] = schedule;
    const existing = await db.collection('employeeShiftAssignments').findOne({ employeeId: emp._id, effectiveTo: null });
    if (!existing) {
      await db.collection('employeeShiftAssignments').insertOne({
        employeeId: emp._id, scheduleId: schedule._id, effectiveFrom, effectiveTo: null,
        assignedBy: null, createdAt: now, isDemoSeed: true,
      });
      assignmentsCreated++;
    }
  }
  console.log(`${assignmentsCreated} shift assignment(s) created`);

  // ── 4. 30 days of attendance records per employee ───────────────────────────────
  let recordsUpserted = 0;
  const perEmployeeRecords = {}; // for building timesheets below

  for (const emp of employees) {
    const schedule = scheduleByEmp[String(emp._id)];
    const rand = seededRandom(emp._id.toString().split('').reduce((s, c) => s + c.charCodeAt(0), 0));
    perEmployeeRecords[String(emp._id)] = [];

    for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
      const d = new Date(now); d.setDate(d.getDate() - daysAgo);
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue; // weekends

      const roll = rand();
      let status, checkInTime, checkOutTime, regularMinutes = 0, overtimeMinutes = 0, totalBreakMinutes = 0, totalWorkMinutes = 0, payCategory = 'normal';
      const scheduledMins = toMins(schedule.endTime) - toMins(schedule.startTime) - schedule.breakMinutes;
      const lateThreshold = toMins(schedule.startTime) + schedule.gracePeriod;

      if (roll < 0.06) {
        status = 'absent';
      } else if (roll < 0.09) {
        status = 'half_day';
        checkInTime = schedule.startTime;
        totalWorkMinutes = Math.round(scheduledMins / 2);
        regularMinutes = totalWorkMinutes;
        checkOutTime = toTimeStr(toMins(schedule.startTime) + totalWorkMinutes);
        totalBreakMinutes = Math.round(schedule.breakMinutes / 2);
      } else {
        const lateBy = roll < 0.18 ? Math.round(10 + rand() * 30) : 0;
        status = lateBy > 0 ? 'late' : 'present';
        checkInTime = toTimeStr(toMins(schedule.startTime) + lateBy);

        const overtimeBy = roll > 0.85 ? Math.round(30 + rand() * 120) : 0;
        checkOutTime = toTimeStr(toMins(schedule.endTime) + overtimeBy);
        totalBreakMinutes = schedule.breakMinutes;
        totalWorkMinutes = toMins(checkOutTime) - toMins(checkInTime) - totalBreakMinutes;

        if (overtimeBy > 0) {
          overtimeMinutes = Math.min(overtimeBy, 180); // matches attendance_settings default maxOvertimeHours=3h
          regularMinutes = totalWorkMinutes - overtimeMinutes;
          payCategory = 'overtime';
        } else {
          regularMinutes = totalWorkMinutes;
        }
      }

      const doc = {
        employeeId: emp._id,
        date: dateStr(d),
        status,
        checkInTime: checkInTime || null,
        checkOutTime: checkOutTime || null,
        checkInAt: checkInTime ? new Date(`${dateStr(d)}T${checkInTime}:00.000Z`) : null,
        checkOutAt: checkOutTime ? new Date(`${dateStr(d)}T${checkOutTime}:00.000Z`) : null,
        mode: 'onsite',
        location: 'office',
        breaks: [],
        totalWorkMinutes, totalBreakMinutes, regularMinutes, overtimeMinutes,
        overtimeHours: Math.round((overtimeMinutes / 60) * 100) / 100,
        payCategory,
        selfMarked: true,
        isManualEntry: false,
        lateMarked: status === 'late',
        createdAt: now, updatedAt: now, isDemoSeed: true,
      };

      await db.collection('attendance_records').updateOne(
        { employeeId: emp._id, date: doc.date },
        { $set: doc },
        { upsert: true }
      );
      recordsUpserted++;
      perEmployeeRecords[String(emp._id)].push(doc);
    }
  }
  console.log(`${recordsUpserted} attendance record(s) upserted`);

  // ── 5. Weekly timesheets for the last 4 weeks ───────────────────────────────────
  const STATUS_CYCLE = ['approved', 'approved', 'submitted', 'rejected'];
  let timesheetsUpserted = 0;

  for (const emp of employees) {
    const empRecords = perEmployeeRecords[String(emp._id)];
    for (let w = 3; w >= 0; w--) {
      const weekAnchor = new Date(now); weekAnchor.setDate(weekAnchor.getDate() - w * 7);
      const weekStart = mondayOf(weekAnchor);
      const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
      const weekStartStr = dateStr(weekStart);
      const weekEndStr = dateStr(weekEnd);

      const weekRecs = empRecords.filter((r) => r.date >= weekStartStr && r.date <= weekEndStr && r.checkOutTime);
      if (!weekRecs.length) continue;

      const entries = weekRecs.map((r) => ({
        date: r.date, projectId: null, projectName: 'General',
        startTime: r.checkInTime, endTime: r.checkOutTime,
        breakMinutes: r.totalBreakMinutes, totalMinutes: r.totalWorkMinutes,
        description: '', isLocked: w > 0,
      }));
      const totalRegularMinutes = weekRecs.reduce((s, r) => s + r.regularMinutes, 0);
      const totalOvertimeMinutes = weekRecs.reduce((s, r) => s + r.overtimeMinutes, 0);
      const totalBreakMinutesWeek = weekRecs.reduce((s, r) => s + r.totalBreakMinutes, 0);
      const totalMinutes = totalRegularMinutes + totalOvertimeMinutes;

      // Current week stays a draft (matches getCurrentTimesheet's default for an
      // in-progress week); past weeks cycle through the demo status mix.
      const status = w === 0 ? 'draft' : STATUS_CYCLE[w % STATUS_CYCLE.length];

      const setDoc = {
        entries, totalMinutes, totalRegularMinutes,
        overtimeMinutes: totalOvertimeMinutes, totalBreakMinutes: totalBreakMinutesWeek,
        status, updatedAt: now, isDemoSeed: true,
      };
      if (status !== 'draft') setDoc.submittedAt = new Date(weekEnd.getTime() + 24 * 60 * 60 * 1000);
      if (status === 'approved') { setDoc.approvedBy = null; setDoc.approvedAt = new Date(weekEnd.getTime() + 2 * 24 * 60 * 60 * 1000); }
      if (status === 'rejected') setDoc.rejectionReason = 'Please double-check Wednesday\'s hours and resubmit.';

      await db.collection('timesheets').updateOne(
        { employeeId: emp._id, weekStart },
        { $set: setDoc, $setOnInsert: { employeeId: emp._id, weekStart, weekEnd, createdAt: now } },
        { upsert: true }
      );
      timesheetsUpserted++;
    }
  }
  console.log(`${timesheetsUpserted} timesheet(s) upserted`);

  console.log('Attendance seed complete.');
  await client.close();
}

seed().catch((err) => { console.error(err); process.exit(1); });
