const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { parseAttendanceCSV } = require('../../services/csvService');
const { notifyManager } = require('../inbox/inboxFunctions');
const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD } = require('../../constants/roles');

const HR_ROLE_LIST = [SUPER_ADMIN, HR_MANAGER];
const isHR = (req) => HR_ROLE_LIST.includes(req.user?.role);

// Minutes of overlap between [rangeStart, rangeEnd) (same-day, minutes-since-midnight)
// and the configured night window [nightStart, nightEnd), which may wrap past midnight
// (e.g. 22:00–06:00). Used to split an employee's overtime into day vs night portions.
const overlapMins = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
const minutesInNightWindow = (rangeStart, rangeEnd, nightStart, nightEnd) => {
  if (rangeEnd <= rangeStart) return 0;
  if (nightStart < nightEnd) return overlapMins(rangeStart, rangeEnd, nightStart, nightEnd);
  // Wraps past midnight — night is [nightStart, 1440) union [0, nightEnd)
  return overlapMins(rangeStart, rangeEnd, nightStart, 1440) + overlapMins(rangeStart, rangeEnd, 0, nightEnd);
};

// Same convention as the leave module's getScopedEmployeeIds: null = no restriction
// (HR/super_admin see everyone), department_head sees their department, and a plain
// "manager" — any employee referenced as someone's managerId, regardless of role —
// sees their direct reports plus themselves.
const getScopedEmployeeIds = async (user) => {
  if (HR_ROLE_LIST.includes(user.role)) return null;
  if (user.role === DEPT_HEAD) {
    if (!user.department) return [];
    const emps = await findMany('employees', { department: user.department }, { projection: { _id: 1 } });
    return emps.map((e) => e._id);
  }
  if (!user.employeeId) return [];
  const directReports = await findMany('employees', { managerId: new ObjectId(user.employeeId) }, { projection: { _id: 1 } });
  const ids = directReports.map((e) => e._id);
  ids.push(new ObjectId(user.employeeId));
  return ids;
};

// Authorization for a single-employee action (approve/reject a timesheet) — HR bypasses,
// otherwise the acting user must be that employee's manager or department_head-of-record.
const isAuthorizedForEmployee = async (req, employeeId) => {
  if (isHR(req)) return true;
  const emp = await findOne('employees', { _id: employeeId }, { projection: { managerId: 1, department: 1 } });
  if (!emp) return false;
  if (req.user.role === DEPT_HEAD) return !!req.user.department && emp.department === req.user.department;
  return !!req.user.employeeId && String(emp.managerId || '') === String(req.user.employeeId);
};

// ── Existing helpers ──────────────────────────────────────────────────────────

const listAttendance = async (req, res) => {
  const filter = {};
  const { month, year, employeeId, department } = req.query;
  if (month && year) {
    const m = String(month).padStart(2, '0');
    filter.date = { $gte: `${year}-${m}-01`, $lte: `${year}-${m}-31` };
  }

  // A caller-supplied ?employeeId= must be validated against the requester's own
  // scope, not applied verbatim — otherwise any authenticated staff user can read
  // any other employee's attendance history simply by passing their id.
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);
  if (employeeId) {
    const requested = new ObjectId(employeeId);
    if (scopedIds !== null && !scopedIds.some((id) => String(id) === String(requested))) {
      return returnFunction(res, 403, false, 'You are not authorized to view this employee\'s attendance.');
    }
    filter.employeeId = requested;
  } else if (scopedIds !== null) {
    filter.employeeId = { $in: scopedIds };
  }

  let records = await global.dbo.collection('attendance_records').find(filter).sort({ date: 1 }).toArray();

  if (department) {
    const deptEmps = await findMany('employees', { department }, { projection: { _id: 1 } });
    const ids = deptEmps.map((e) => String(e._id));
    records = records.filter((r) => ids.includes(String(r.employeeId)));
  }

  const grouped = {};
  for (const rec of records) {
    const key = String(rec.employeeId);
    if (!grouped[key]) grouped[key] = { employeeId: rec.employeeId, records: [] };
    grouped[key].records.push(rec);
  }

  const groupedValues = Object.values(grouped);
  const attEmpIds = groupedValues.map(g => g.employeeId);
  const attEmps = await findMany('employees', { _id: { $in: attEmpIds } }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
  const attEmpMap = Object.fromEntries(attEmps.map(e => [String(e._id), e]));
  const enriched = groupedValues.map(g => {
    const emp = attEmpMap[String(g.employeeId)];
    return { ...g, employeeName: emp?.fullName || null, staffNumber: emp?.staffNumber || null, department: emp?.department || null };
  });

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const markAttendance = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'date', 'status'])) return;
  const employeeId = new ObjectId(req.body.employeeId);
  const entryDate = new Date(`${req.body.date}T00:00:00.000Z`);

  // A manual entry claiming the employee worked (present/late/half_day) while they
  // have approved leave covering that date is almost always a mistake — block it
  // unless HR explicitly confirms the override (e.g. leave was later cancelled but
  // the record wasn't updated).
  const WORKED_STATUSES = ['present', 'late', 'half_day', 'remote'];
  if (WORKED_STATUSES.includes(req.body.status) && !req.body.overrideLeaveConflict) {
    const conflictingLeave = await findOne('leave_requests', {
      employeeId,
      status: 'approved',
      startDate: { $lte: entryDate },
      endDate: { $gte: entryDate },
    });
    if (conflictingLeave) {
      return returnFunction(res, 409, false,
        `This employee has approved leave covering ${req.body.date}. Set overrideLeaveConflict to confirm this entry anyway.`,
        { leaveConflict: true, leaveRequestId: conflictingLeave._id }
      );
    }
  }

  const doc = {
    employeeId,
    date: req.body.date,
    status: req.body.status,
    checkInTime: req.body.checkInTime || null,
    checkOutTime: req.body.checkOutTime || null,
    notes: req.body.notes || null,
    isManualEntry: true,
    markedBy: new ObjectId(req.user._id),
    createdAt: new Date(),
  };

  await global.dbo.collection('attendance_records').updateOne(
    { employeeId: doc.employeeId, date: doc.date },
    { $set: doc },
    { upsert: true }
  );
  return returnFunction(res, 200, true, req.locale.success);
};

const bulkImportAttendance = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, 'CSV file required.');
  const { validRows, invalidRows } = parseAttendanceCSV(req.file.path);

  let successCount = 0;
  const errors = [];

  for (const row of validRows) {
    const employee = await findOne('employees', { staffNumber: row.staffNumber });
    if (!employee) {
      errors.push({ row, reason: `No employee found with staffNumber ${row.staffNumber}` });
      continue;
    }
    const doc = {
      employeeId: employee._id,
      date: row.date,
      status: row.status,
      checkInTime: row.checkInTime || null,
      checkOutTime: row.checkOutTime || null,
      notes: row.notes || null,
      markedBy: new ObjectId(req.user._id),
      createdAt: new Date(),
    };
    await global.dbo.collection('attendance_records').updateOne(
      { employeeId: doc.employeeId, date: doc.date },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    successCount++;
  }

  return returnFunction(res, 200, true, req.locale.success, {
    totalRows: validRows.length + invalidRows.length,
    successCount,
    failCount: invalidRows.length + (validRows.length - successCount),
    errors: [...invalidRows.map((r) => ({ row: r.row, reason: r.reason })), ...errors],
  });
};

const getAbsenceAlerts = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);
  const alertFilter = { status: 'absent' };
  if (scopedIds !== null) alertFilter.employeeId = { $in: scopedIds };

  const recentRecords = await global.dbo.collection('attendance_records')
    .find(alertFilter)
    .sort({ employeeId: 1, date: 1 })
    .toArray();

  const byEmployee = {};
  for (const r of recentRecords) {
    const key = String(r.employeeId);
    if (!byEmployee[key]) byEmployee[key] = [];
    byEmployee[key].push(r.date);
  }

  // First pass: find which employees have consecutive absence streaks >= 3
  const alertCandidates = [];
  for (const [empId, dates] of Object.entries(byEmployee)) {
    dates.sort();
    let streak = 1;
    let streakStart = dates[0];
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1]);
      const cur  = new Date(dates[i]);
      const diff = (cur - prev) / (1000 * 60 * 60 * 24);
      if (diff === 1) {
        streak++;
        if (streak >= 3) {
          alertCandidates.push({ empId, streak, from: streakStart, to: dates[i] });
          break;
        }
      } else {
        streak = 1;
        streakStart = dates[i];
      }
    }
  }

  // Batch-fetch employees for all alert candidates
  const alertEmpIds = alertCandidates.map(a => new ObjectId(a.empId));
  const alertEmpDocs = alertEmpIds.length
    ? await findMany('employees', { _id: { $in: alertEmpIds } }, { projection: { fullName: 1, staffNumber: 1, department: 1 } })
    : [];
  const alertEmpMap = Object.fromEntries(alertEmpDocs.map(e => [String(e._id), e]));

  const alerts = alertCandidates
    .filter(a => alertEmpMap[a.empId])
    .map(a => ({ employee: alertEmpMap[a.empId], consecutiveAbsentDays: a.streak, from: a.from, to: a.to }));

  return returnFunction(res, 200, true, req.locale.success, alerts);
};

// Single source of truth for weekly overtime: sums each day's shift-based
// regularMinutes/overtimeMinutes (computed once, in clockOut) rather than
// recomputing against a flat weekly threshold that could disagree with it.
async function computeWeeklyHoursFromAttendance(employeeId, weekStartStr, weekEndStr) {
  const recs = await global.dbo.collection('attendance_records').find({
    employeeId,
    date: { $gte: weekStartStr, $lte: weekEndStr },
  }).toArray();

  let totalRegularMinutes = 0;
  let totalOvertimeMinutes = 0;
  let totalBreakMinutes = 0;
  const overtimeBreakdown = { weekdayDayMins: 0, weekdayNightMins: 0, weekendDayMins: 0, weekendNightMins: 0 };
  for (const r of recs) {
    if (!r.checkOutTime) continue; // incomplete day — no split computed yet
    totalRegularMinutes  += r.regularMinutes || 0;
    totalOvertimeMinutes += r.overtimeMinutes || 0;
    totalBreakMinutes    += r.totalBreakMinutes || 0;
    if (r.overtimeBreakdown) {
      overtimeBreakdown.weekdayDayMins   += r.overtimeBreakdown.weekdayDayMins || 0;
      overtimeBreakdown.weekdayNightMins += r.overtimeBreakdown.weekdayNightMins || 0;
      overtimeBreakdown.weekendDayMins   += r.overtimeBreakdown.weekendDayMins || 0;
      overtimeBreakdown.weekendNightMins += r.overtimeBreakdown.weekendNightMins || 0;
    }
  }
  return { totalRegularMinutes, totalOvertimeMinutes, totalBreakMinutes, totalMinutes: totalRegularMinutes + totalOvertimeMinutes, overtimeBreakdown };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const clockIn = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked to your account.');
  const empId = req.user.employeeId;
  const today = new Date().toISOString().split('T')[0];

  const existing = await findOne('attendance_records', { employeeId: empId, date: today });
  if (existing?.checkInTime) return returnFunction(res, 409, false, 'You have already clocked in today.');

  const onApprovedLeave = await findOne('leave_requests', {
    employeeId: empId,
    status: 'approved',
    startDate: { $lte: new Date() },
    endDate:   { $gte: new Date() },
  });
  if (onApprovedLeave) return returnFunction(res, 403, false, 'You are on approved leave today and cannot clock in.');

  const latitude  = parseFloat(req.body.latitude);
  const longitude = parseFloat(req.body.longitude);
  if (isNaN(latitude) || isNaN(longitude)) {
    return returnFunction(res, 400, false, 'Location access is required to clock in. Please enable GPS and try again.');
  }

  const settings = await findOne('company_settings', {});
  const officeLat    = parseFloat(settings?.officeLatitude);
  const officeLng    = parseFloat(settings?.officeLongitude);
  const radiusMeters = parseFloat(settings?.officeRadiusMeters) || 200;

  let mode = 'onsite';
  if (!isNaN(officeLat) && !isNaN(officeLng)) {
    const distanceM = Math.round(haversineMeters(latitude, longitude, officeLat, officeLng));
    if (distanceM > radiusMeters) {
      return returnFunction(res, 403, false,
        `You are ${distanceM}m from the office. You must be within ${radiusMeters}m to clock in.`,
        { distanceM, radiusMeters }
      );
    }
  }

  // Block unscheduled clock-ins if the setting is enabled
  const attSettings = await findOne('attendance_settings', {});
  if (attSettings?.blockUnscheduledClockIn) {
    const todayShift = await findOne('shifts', { employeeId: empId, date: today });
    if (!todayShift) {
      return returnFunction(res, 403, false, 'You do not have a scheduled shift today. Please contact HR.');
    }
  }

  const now = new Date();
  const checkInTime = now.toTimeString().slice(0, 5);

  const patch = {
    employeeId:      empId,
    date:            today,
    status:          'present',
    mode,
    checkInTime,
    checkInAt:       now,
    checkInLat:      latitude,
    checkInLng:      longitude,
    checkInLocation: req.body.locationName || null,
    location:        req.body.workLocation || 'office',
    breaks:          [],
    selfMarked:      true,
    markedBy:        new ObjectId(req.user._id),
    updatedAt:       now,
  };

  await global.dbo.collection('attendance_records').updateOne(
    { employeeId: empId, date: today },
    { $set: patch, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );

  return returnFunction(res, 200, true, 'Clocked in successfully.', { checkInTime, mode });
};

const clockOut = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked to your account.');
  const empId = req.user.employeeId;
  const today = new Date().toISOString().split('T')[0];

  const existing = await findOne('attendance_records', { employeeId: empId, date: today });
  if (!existing?.checkInTime) return returnFunction(res, 400, false, 'You have not clocked in yet today.');
  if (existing?.checkOutTime) return returnFunction(res, 409, false, 'You have already clocked out today.');

  const now = new Date();
  const checkOutTime = now.toTimeString().slice(0, 5);
  const latitude  = parseFloat(req.body.latitude);
  const longitude = parseFloat(req.body.longitude);

  // Compute total break minutes from breaks array
  const totalBreakMins = (existing.breaks || []).reduce((sum, b) => {
    if (b.endTime) return sum + Math.round((new Date(b.endTime) - new Date(b.startTime)) / 60000);
    return sum;
  }, 0);

  const workMins = existing.checkInAt
    ? Math.round((now - new Date(existing.checkInAt)) / 60000) - totalBreakMins
    : 0;

  // Overtime + payment category calculation
  const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const [todayShift, attSettings, holiday] = await Promise.all([
    findOne('shifts', { employeeId: empId, date: today }),
    findOne('attendance_settings', {}),
    findOne('holidays', { date: today }),
  ]);

  let regularMinutes  = workMins;
  let overtimeMinutes = 0;
  let payCategory     = 'normal';

  // No per-date shift set for today (the common case for anyone not on an ad-hoc
  // schedule) — fall back to their standing schedule assignment rather than skipping
  // the overtime split entirely.
  const effectiveShift = todayShift || await getEffectiveScheduleForEmployee(empId, today);

  if (holiday) {
    payCategory = 'holiday';
  } else if (effectiveShift) {
    const scheduledMins = toMins(effectiveShift.endTime) - toMins(effectiveShift.startTime) - (effectiveShift.breakMinutes || 0);
    if (workMins > scheduledMins && attSettings?.overtimeEnabled !== false) {
      const maxOvertimeMins = (attSettings?.maxOvertimeHours || 3) * 60;
      overtimeMinutes = Math.min(workMins - scheduledMins, maxOvertimeMins);
      regularMinutes  = workMins - overtimeMinutes;
      payCategory     = 'overtime';
    }
  }

  // overtimeHours mirrors overtimeMinutes for payroll, which reads hours not minutes —
  // previously nothing ever wrote this field, so every payroll cycle's overtime pay was silently 0.
  const overtimeHours = Math.round((overtimeMinutes / 60) * 100) / 100;

  // Split overtime minutes into weekday/weekend × day/night buckets so payroll can apply
  // HR's own custom multiplier per bucket instead of one flat rate for all overtime.
  // Overtime is the tail end of the shift, i.e. the last `overtimeMinutes` minutes
  // before checkout.
  const overtimeConfig = await global.dbo.collection('overtime_config').findOne({});
  const isWeekend = [0, 6].includes(new Date(today + 'T00:00:00').getDay());
  let weekdayDayMins = 0, weekdayNightMins = 0, weekendDayMins = 0, weekendNightMins = 0;
  if (overtimeMinutes > 0) {
    const nightMins = overtimeConfig ? minutesInNightWindow(
      Math.max(0, toMins(checkOutTime) - overtimeMinutes), toMins(checkOutTime),
      toMins(overtimeConfig.nightStart), toMins(overtimeConfig.nightEnd)
    ) : 0;
    const dayMins = overtimeMinutes - nightMins;
    if (isWeekend) { weekendDayMins = dayMins; weekendNightMins = nightMins; }
    else { weekdayDayMins = dayMins; weekdayNightMins = nightMins; }
  }

  await global.dbo.collection('attendance_records').updateOne(
    { employeeId: empId, date: today },
    { $set: {
      checkOutTime,
      checkOutAt:        now,
      checkOutLat:       isNaN(latitude)  ? null : latitude,
      checkOutLng:       isNaN(longitude) ? null : longitude,
      checkOutLocation:  req.body.locationName || null,
      totalWorkMinutes:  workMins,
      totalBreakMinutes: totalBreakMins,
      regularMinutes,
      overtimeMinutes,
      overtimeHours,
      overtimeBreakdown: { weekdayDayMins, weekdayNightMins, weekendDayMins, weekendNightMins },
      payCategory,
      updatedAt:         now,
    }}
  );

  return returnFunction(res, 200, true, 'Clocked out successfully.', { checkOutTime, totalWorkMinutes: workMins, overtimeMinutes, payCategory });
};

// ── Break tracking ────────────────────────────────────────────────────────────

const breakStart = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked.');
  const empId = req.user.employeeId;
  const today = new Date().toISOString().split('T')[0];

  const existing = await findOne('attendance_records', { employeeId: empId, date: today });
  if (!existing?.checkInTime) return returnFunction(res, 400, false, 'You have not clocked in yet.');
  if (existing?.checkOutTime) return returnFunction(res, 400, false, 'You have already clocked out.');

  const openBreak = (existing.breaks || []).find(b => !b.endTime);
  if (openBreak) return returnFunction(res, 409, false, 'You are already on a break.');

  const now = new Date();
  const breakEntry = { startTime: now, endTime: null };

  await global.dbo.collection('attendance_records').updateOne(
    { employeeId: empId, date: today },
    { $push: { breaks: breakEntry }, $set: { updatedAt: now } }
  );

  return returnFunction(res, 200, true, 'Break started.', { breakStartedAt: now });
};

const breakEnd = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked.');
  const empId = req.user.employeeId;
  const today = new Date().toISOString().split('T')[0];

  const existing = await findOne('attendance_records', { employeeId: empId, date: today });
  if (!existing) return returnFunction(res, 400, false, 'No attendance record found for today.');

  const breaks = existing.breaks || [];
  const openIdx = breaks.findIndex(b => !b.endTime);
  if (openIdx === -1) return returnFunction(res, 400, false, 'You are not currently on a break.');

  const now = new Date();
  const durationMins = Math.round((now - new Date(breaks[openIdx].startTime)) / 60000);
  breaks[openIdx].endTime = now;
  breaks[openIdx].duration = durationMins;

  await global.dbo.collection('attendance_records').updateOne(
    { employeeId: empId, date: today },
    { $set: { breaks, updatedAt: now } }
  );

  return returnFunction(res, 200, true, 'Break ended.', { durationMinutes: durationMins });
};

// ── Get today status + break state ───────────────────────────────────────────

const getTodayStatus = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, req.locale.success, null);
  const today = new Date().toISOString().split('T')[0];
  const record = await findOne('attendance_records', { employeeId: req.user.employeeId, date: today });
  return returnFunction(res, 200, true, req.locale.success, record || null);
};

const getMyRecords = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const since = new Date();
  since.setDate(since.getDate() - days + 1);
  const sinceStr = since.toISOString().split('T')[0];
  const records = await global.dbo.collection('attendance_records')
    .find({ employeeId: req.user.employeeId, date: { $gte: sinceStr } })
    .sort({ date: 1 })
    .toArray();
  return returnFunction(res, 200, true, req.locale.success, records);
};

// ── Team status today (HR/manager) ────────────────────────────────────────────

const getTeamStatus = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) {
    return returnFunction(res, 200, true, req.locale.success, { records: [], stats: { clockedIn: 0, onBreak: 0, completed: 0, notClockedIn: 0 } });
  }
  const recordFilter = { date: today };
  if (scopedIds !== null) recordFilter.employeeId = { $in: scopedIds };

  const records = await global.dbo.collection('attendance_records')
    .find(recordFilter)
    .toArray();

  const teamEmpIds = records.map(r => r.employeeId);
  const teamEmps = await findMany('employees', { _id: { $in: teamEmpIds } }, { projection: { fullName: 1, designation: 1, department: 1 } });
  const teamEmpMap = Object.fromEntries(teamEmps.map(e => [String(e._id), e]));
  const enriched = records.map(r => {
    const openBreak = (r.breaks || []).find(b => !b.endTime);
    const clockStatus = r.checkOutTime ? 'completed'
      : openBreak ? 'on_break'
      : r.checkInTime ? 'clocked_in'
      : 'not_clocked_in';
    return { ...r, employee: teamEmpMap[String(r.employeeId)] ?? null, clockStatus };
  });

  const allEmpFilter = { status: 'active' };
  if (scopedIds !== null) allEmpFilter._id = { $in: scopedIds };
  const allEmployees = await findMany('employees', allEmpFilter, { projection: { _id: 1, fullName: 1, designation: 1, department: 1 } });
  const recordedIds = new Set(records.map(r => String(r.employeeId)));
  const notClockedIn = allEmployees
    .filter(e => !recordedIds.has(String(e._id)))
    .map(e => ({ employeeId: e._id, employee: e, clockStatus: 'not_clocked_in', date: today }));

  const all = [...enriched, ...notClockedIn];

  const stats = {
    clockedIn:     all.filter(r => r.clockStatus === 'clocked_in').length,
    onBreak:       all.filter(r => r.clockStatus === 'on_break').length,
    completed:     all.filter(r => r.clockStatus === 'completed').length,
    notClockedIn:  all.filter(r => r.clockStatus === 'not_clocked_in').length,
  };

  return returnFunction(res, 200, true, req.locale.success, { records: all, stats });
};

// ── Timesheets ────────────────────────────────────────────────────────────────

const getTimesheets = async (req, res) => {
  const filter = {};
  if (req.query.weekStart) filter.weekStart = new Date(req.query.weekStart);
  if (req.query.status) filter.status = req.query.status;

  // Route everyone (including plain "staff") through getScopedEmployeeIds — a staff
  // role can still be someone's manager via employees.managerId, and that helper
  // already resolves to [directReports..., self] in that case, or just [self] for a
  // non-manager. A special-cased staff branch here previously forced self-only
  // regardless, so a staff-role manager's direct reports never showed up in this list
  // even though approve/reject (via isAuthorizedForEmployee) correctly authorized them.
  let isTeamView = false;
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);
  if (req.query.employeeId) {
    const requested = new ObjectId(req.query.employeeId);
    if (scopedIds !== null && !scopedIds.some((id) => String(id) === String(requested))) {
      return returnFunction(res, 403, false, 'You are not authorized to view this employee\'s timesheets.');
    }
    filter.employeeId = requested;
  } else if (scopedIds !== null) {
    filter.employeeId = { $in: scopedIds };
    isTeamView = scopedIds.length > 1;
  } else {
    isTeamView = true; // HR/super_admin browsing everyone's timesheets
  }

  const sheets = await findMany('timesheets', filter, { sort: { weekStart: -1 }, limit: isTeamView ? 200 : 20 });

  if (!isTeamView) return returnFunction(res, 200, true, req.locale.success, sheets);

  const empIds = [...new Set(sheets.map((s) => String(s.employeeId)))].map((id) => new ObjectId(id));
  const employees = empIds.length
    ? await findMany('employees', { _id: { $in: empIds } }, { projection: { fullName: 1, staffNumber: 1, department: 1 } })
    : [];
  const empMap = Object.fromEntries(employees.map((e) => [String(e._id), e]));
  const enriched = sheets.map((s) => ({ ...s, employee: empMap[String(s.employeeId)] ?? null }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getCurrentTimesheet = async (req, res) => {
  const empId = req.user.employeeId;
  if (!empId) return returnFunction(res, 400, false, 'No employee profile linked.');

  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  let sheet = await findOne('timesheets', {
    employeeId: empId,
    weekStart:  { $gte: monday, $lte: new Date(monday.getTime() + 1000) },
  });

  if (!sheet) {
    // Auto-populate from clock_records for this week
    const weekStr = monday.toISOString().split('T')[0];
    const sundayStr = sunday.toISOString().split('T')[0];
    const clockRecs = await global.dbo.collection('attendance_records')
      .find({ employeeId: empId, date: { $gte: weekStr, $lte: sundayStr } })
      .sort({ date: 1 })
      .toArray();

    const entries = clockRecs.filter(r => r.checkInTime && r.checkOutTime).map(r => ({
      date: r.date,
      projectId: null,
      projectName: 'General',
      startTime: r.checkInTime,
      endTime: r.checkOutTime,
      breakMinutes: r.totalBreakMinutes || 0,
      totalMinutes: r.totalWorkMinutes || 0,
      description: '',
      isLocked: false,
    }));

    const weekHours = await computeWeeklyHoursFromAttendance(empId, weekStr, sundayStr);

    const doc = {
      employeeId: empId,
      weekStart:  monday,
      weekEnd:    sunday,
      entries,
      totalMinutes: weekHours.totalMinutes,
      totalRegularMinutes: weekHours.totalRegularMinutes,
      overtimeMinutes: weekHours.totalOvertimeMinutes,
      overtimeBreakdown: weekHours.overtimeBreakdown,
      totalBreakMinutes: weekHours.totalBreakMinutes,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await insertOne('timesheets', doc);
    sheet = { ...doc, _id: result.insertedId };
  }

  return returnFunction(res, 200, true, req.locale.success, sheet);
};

const saveTimesheet = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'weekStart'])) return;

  const empId = new ObjectId(req.body.employeeId);
  const weekStart = new Date(req.body.weekStart);
  const entries = (req.body.entries || []).map(e => ({
    ...e,
    totalMinutes: e.totalMinutes || 0,
    breakMinutes: e.breakMinutes || 0,
  }));

  const weekStartStr = weekStart.toISOString().split('T')[0];
  const weekEndStr = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const weekHours = await computeWeeklyHoursFromAttendance(empId, weekStartStr, weekEndStr);

  await global.dbo.collection('timesheets').updateOne(
    { employeeId: empId, weekStart },
    { $set: {
      entries,
      totalMinutes: weekHours.totalMinutes,
      totalRegularMinutes: weekHours.totalRegularMinutes,
      overtimeMinutes: weekHours.totalOvertimeMinutes,
      overtimeBreakdown: weekHours.overtimeBreakdown,
      totalBreakMinutes: weekHours.totalBreakMinutes,
      status: req.body.status || 'draft',
      updatedAt: new Date(),
    }, $setOnInsert: { createdAt: new Date(), employeeId: empId, weekStart } },
    { upsert: true }
  );

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const submitTimesheet = async (req, res) => {
  const sheet = await findOne('timesheets', { _id: new ObjectId(req.params.id) });
  if (!sheet) return returnFunction(res, 404, false, 'Timesheet not found.');
  if (req.user.role === 'staff' && req.user.employeeId && String(sheet.employeeId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'You can only submit your own timesheets.');
  }
  if (sheet.status === 'submitted') return returnFunction(res, 400, false, 'Already submitted.');

  await updateOne('timesheets', { _id: sheet._id }, { $set: { status: 'submitted', submittedAt: new Date(), updatedAt: new Date() } });

  // Inbox: notify manager that timesheet was submitted
  if (req.user.employeeId) {
    const emp = await findOne('employees', { _id: req.user.employeeId }, { projection: { fullName: 1 } });
    await notifyManager(req.user.employeeId, {
      type: 'timesheet', subType: 'timesheet_submission',
      title: `Timesheet submitted by ${emp?.fullName || 'An employee'}`,
      subtitle: `Week ${sheet.weekStart || ''} – ${sheet.weekEnd || ''} · ${sheet.totalHours || ''}h`,
      referenceId: sheet._id, referenceModel: 'timesheets',
      requiresAction: true, triggeredBy: req.user._id,
    });
  }

  return returnFunction(res, 200, true, 'Timesheet submitted for approval.');
};

const approveTimesheet = async (req, res) => {
  const sheet = await findOne('timesheets', { _id: new ObjectId(req.params.id) });
  if (!sheet) return returnFunction(res, 404, false, 'Timesheet not found.');
  if (!(await isAuthorizedForEmployee(req, sheet.employeeId))) {
    return returnFunction(res, 403, false, 'You can only approve timesheets for your direct reports.');
  }
  await updateOne('timesheets', { _id: sheet._id }, {
    $set: { status: 'approved', approvedBy: new ObjectId(req.user._id), approvedAt: new Date(), updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Timesheet approved.');
};

const rejectTimesheet = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const sheet = await findOne('timesheets', { _id: new ObjectId(req.params.id) });
  if (!sheet) return returnFunction(res, 404, false, 'Timesheet not found.');
  if (!(await isAuthorizedForEmployee(req, sheet.employeeId))) {
    return returnFunction(res, 403, false, 'You can only reject timesheets for your direct reports.');
  }
  await updateOne('timesheets', { _id: sheet._id }, {
    $set: { status: 'rejected', rejectionReason: req.body.reason, updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Timesheet rejected.');
};

const bulkApproveTimesheets = async (req, res) => {
  if (!validateRequiredFields(req, res, ['timesheetIds'])) return;
  const ids = req.body.timesheetIds.map((id) => new ObjectId(id));
  const sheets = await findMany('timesheets', { _id: { $in: ids }, status: 'submitted' }, {});

  const approvedIds = [];
  const skipped = [];
  for (const sheet of sheets) {
    if (await isAuthorizedForEmployee(req, sheet.employeeId)) {
      approvedIds.push(sheet._id);
    } else {
      skipped.push(sheet._id);
    }
  }

  if (approvedIds.length) {
    await global.dbo.collection('timesheets').updateMany(
      { _id: { $in: approvedIds } },
      { $set: { status: 'approved', approvedBy: new ObjectId(req.user._id), approvedAt: new Date(), updatedAt: new Date() } }
    );
  }

  return returnFunction(res, 200, true, `${approvedIds.length} timesheet(s) approved.`, {
    approvedCount: approvedIds.length,
    skippedCount: skipped.length,
  });
};

// ── Payroll feed ──────────────────────────────────────────────────────────────
// payrollCyclesFunctions.js's lockCycleInternal stamps payrollRunId automatically when
// a cycle locks; these two endpoints exist for payroll ops to inspect what's pending
// before that happens, and to manually reconcile/mark items outside the normal cycle flow.

const getPayrollFeed = async (req, res) => {
  const filter = { status: 'approved', payrollRunId: null };
  if (req.query.startDate && req.query.endDate) {
    filter.weekStart = { $gte: new Date(req.query.startDate), $lte: new Date(req.query.endDate) };
  }
  const sheets = await findMany('timesheets', filter, { sort: { weekStart: 1 } });
  const empIds = [...new Set(sheets.map((s) => String(s.employeeId)))].map((id) => new ObjectId(id));
  const employees = empIds.length
    ? await findMany('employees', { _id: { $in: empIds } }, { projection: { fullName: 1, staffNumber: 1, department: 1 } })
    : [];
  const empMap = Object.fromEntries(employees.map((e) => [String(e._id), e]));

  const feed = sheets.map((s) => ({
    ...s,
    employee: empMap[String(s.employeeId)] ?? null,
    overtimeHours: Math.round(((s.overtimeMinutes || 0) / 60) * 100) / 100,
  }));

  return returnFunction(res, 200, true, req.locale.success, feed);
};

const markPayrollFeedProcessed = async (req, res) => {
  if (!validateRequiredFields(req, res, ['timesheetIds', 'payrollRunId'])) return;
  const ids = req.body.timesheetIds.map((id) => new ObjectId(id));
  const payrollRunId = new ObjectId(req.body.payrollRunId);
  const result = await global.dbo.collection('timesheets').updateMany(
    { _id: { $in: ids }, status: 'approved', payrollRunId: null },
    { $set: { payrollRunId, updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
};

// ── Shifts ────────────────────────────────────────────────────────────────────

const getShifts = async (req, res) => {
  const filter = {};
  if (req.query.startDate && req.query.endDate) {
    filter.date = { $gte: req.query.startDate, $lte: req.query.endDate };
  }

  // Unscoped before this: any authenticated user (route allows ALL roles) could pass
  // ?employeeId=<anyone> — or no filter at all — and see every employee's shift
  // schedule company-wide. Open shifts (employeeId: null) stay visible to everyone,
  // matching the marketplace's intent; assigned shifts are scoped like every other
  // attendance endpoint.
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (req.query.employeeId) {
    const requested = new ObjectId(req.query.employeeId);
    if (scopedIds !== null && !scopedIds.some((id) => String(id) === String(requested))) {
      return returnFunction(res, 403, false, 'You are not authorized to view this employee\'s shifts.');
    }
    filter.employeeId = requested;
  } else if (scopedIds !== null) {
    filter.$or = [{ employeeId: { $in: scopedIds } }, { employeeId: null }];
  }

  const shifts = await findMany('shifts', filter, { sort: { date: 1 } });
  const shiftEmpIds = [...new Set(shifts.map(s => s.employeeId))];
  const shiftEmps = await findMany('employees', { _id: { $in: shiftEmpIds } }, { projection: { fullName: 1, designation: 1, department: 1 } });
  const shiftEmpMap = Object.fromEntries(shiftEmps.map(e => [String(e._id), e]));
  const enriched = shifts.map(s => ({ ...s, employee: shiftEmpMap[String(s.employeeId)] ?? null }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createShift = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'date', 'startTime', 'endTime'])) return;

  const doc = {
    employeeId: new ObjectId(req.body.employeeId),
    date:       req.body.date,
    shiftType:  req.body.shiftType || 'custom',
    startTime:  req.body.startTime,
    endTime:    req.body.endTime,
    breakMinutes: Number(req.body.breakMinutes) || 0,
    location:   req.body.location || 'office',
    notes:      req.body.notes || '',
    assignedBy: new ObjectId(req.user._id),
    createdAt:  new Date(),
  };

  const { createdAt: _ca, ...shiftFields } = doc;
  await global.dbo.collection('shifts').updateOne(
    { employeeId: doc.employeeId, date: doc.date },
    { $set: shiftFields, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, doc);
};

const updateShift = async (req, res) => {
  const update = { ...req.body };
  delete update._id;
  update.updatedAt = new Date();
  if (update.employeeId) update.employeeId = new ObjectId(update.employeeId);
  await updateOne('shifts', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteShift = async (req, res) => {
  await global.dbo.collection('shifts').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Attendance report (monthly grid) ─────────────────────────────────────────

const getAttendanceReport = async (req, res) => {
  const month = String(req.query.month || (new Date().getMonth() + 1)).padStart(2, '0');
  const year  = req.query.year || new Date().getFullYear();
  const from  = `${year}-${month}-01`;
  const to    = `${year}-${month}-31`;

  const filter = { date: { $gte: from, $lte: to } };
  if (req.query.department) {
    const empIds = (await findMany('employees', { department: req.query.department }, { projection: { _id: 1 } })).map(e => e._id);
    filter.employeeId = { $in: empIds };
  }

  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) {
    return returnFunction(res, 200, true, req.locale.success, { report: [], month: Number(month), year: Number(year) });
  }
  // A caller-supplied ?employeeId= is validated against scope below via employeeFilter
  // (the returned `report` is built by mapping over that scoped employee list, so a
  // record fetched for an out-of-scope id would never actually surface) — but keep
  // `filter.employeeId` itself scoped too, for defense in depth and clarity.
  if (req.query.employeeId) {
    const requested = new ObjectId(req.query.employeeId);
    if (scopedIds !== null && !scopedIds.some((id) => String(id) === String(requested))) {
      return returnFunction(res, 403, false, 'You are not authorized to view this employee\'s attendance.');
    }
    filter.employeeId = requested;
  }
  const employeeFilter = { status: 'active' };
  if (scopedIds !== null) {
    employeeFilter._id = { $in: scopedIds };
    filter.employeeId = filter.employeeId ? filter.employeeId : { $in: scopedIds };
  }
  if (req.query.employeeId) employeeFilter._id = new ObjectId(req.query.employeeId);

  const records = await global.dbo.collection('attendance_records').find(filter).sort({ date: 1 }).toArray();

  const byEmp = {};
  for (const r of records) {
    const k = String(r.employeeId);
    if (!byEmp[k]) byEmp[k] = { employeeId: r.employeeId, days: {} };
    byEmp[k].days[r.date] = r;
  }

  const employees = await findMany('employees', employeeFilter, { projection: { fullName: 1, staffNumber: 1, department: 1 } });

  const report = employees.map(emp => ({
    employee: emp,
    days: byEmp[String(emp._id)]?.days || {},
  }));

  return returnFunction(res, 200, true, req.locale.success, { report, month: Number(month), year: Number(year) });
};

// Scoped equivalent of reports/reportFunctions.js's exportAttendanceCSV — that one is
// HR-only and company-wide, but the Report tab this button lives on is also visible to
// department_head/managers, so it needs the same getScopedEmployeeIds/department scoping
// as the rest of this module rather than 403ing them or leaking other departments' data.
const exportAttendanceReportCSV = async (req, res) => {
  const now   = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year  = parseInt(req.query.year)  || now.getFullYear();
  const m     = String(month).padStart(2, '0');

  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${year}-${m}.csv"`);
    return res.send('StaffNo,Name,Department,Present,Absent,Late,TotalHours');
  }

  const empFilter = {};
  if (scopedIds !== null) empFilter._id = { $in: scopedIds };
  if (req.query.department) empFilter.department = req.query.department;
  const employees = await findMany('employees', empFilter, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
  const empMap = Object.fromEntries(employees.map((e) => [String(e._id), e]));

  const records = await global.dbo.collection('attendance_records').find({
    date: { $gte: `${year}-${m}-01`, $lte: `${year}-${m}-31` },
    employeeId: { $in: employees.map((e) => e._id) },
  }).toArray();

  const grouped = {};
  for (const r of records) {
    const k = String(r.employeeId);
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(r);
  }

  const toMins = (t) => { const [h, mi] = String(t).split(':').map(Number); return h * 60 + mi; };
  const rows = employees.map((emp) => {
    const recs = grouped[String(emp._id)] || [];
    let present = 0, absent = 0, late = 0, totalMins = 0;
    for (const r of recs) {
      if (['present', 'remote', 'late'].includes(r.status)) present++;
      if (r.status === 'absent') absent++;
      if (r.status === 'late') late++;
      if (r.checkInTime && r.checkOutTime) {
        const diff = toMins(r.checkOutTime) - toMins(r.checkInTime);
        if (diff > 0) totalMins += diff;
      }
    }
    return [
      emp.staffNumber ?? '', `"${(emp.fullName ?? '').replace(/"/g, '')}"`,
      emp.department ?? '', present, absent, late,
      parseFloat((totalMins / 60).toFixed(1)),
    ].join(',');
  });

  const csv = ['StaffNo,Name,Department,Present,Absent,Late,TotalHours', ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${year}-${m}.csv"`);
  return res.send(csv);
};

const getAttendanceStats = async (req, res) => {
  const month = String(req.query.month || (new Date().getMonth() + 1)).padStart(2, '0');
  const year  = req.query.year || new Date().getFullYear();
  const from  = `${year}-${month}-01`;
  const to    = `${year}-${month}-31`;

  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) {
    return returnFunction(res, 200, true, req.locale.success, { attendanceRate: 0, totalPresent: 0, totalLate: 0, totalAbsent: 0, totalRecords: 0 });
  }
  const baseFilter = { date: { $gte: from, $lte: to } };
  if (scopedIds !== null) baseFilter.employeeId = { $in: scopedIds };

  const [present, late, absent, total] = await Promise.all([
    global.dbo.collection('attendance_records').countDocuments({ ...baseFilter, status: 'present' }),
    global.dbo.collection('attendance_records').countDocuments({ ...baseFilter, status: 'late' }),
    global.dbo.collection('attendance_records').countDocuments({ ...baseFilter, status: 'absent' }),
    global.dbo.collection('attendance_records').countDocuments(baseFilter),
  ]);

  const rate = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

  return returnFunction(res, 200, true, req.locale.success, {
    attendanceRate: rate,
    totalPresent:   present,
    totalLate:      late,
    totalAbsent:    absent,
    totalRecords:   total,
  });
};

// ── Settings ──────────────────────────────────────────────────────────────────

const getSettings = async (req, res) => {
  const settings = await findOne('attendance_settings', {}) || {};
  return returnFunction(res, 200, true, req.locale.success, settings);
};

const saveSettings = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  await global.dbo.collection('attendance_settings').updateOne(
    {},
    { $set: update, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const getSchedules = async (req, res) => {
  const schedules = await findMany('work_schedules', {}, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, schedules);
};

const createSchedule = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const doc = {
    name:         req.body.name,
    workDays:     req.body.workDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    startTime:    req.body.startTime || '09:00',
    endTime:      req.body.endTime || '17:00',
    breakMinutes: Number(req.body.breakMinutes) || 60,
    weeklyHours:  Number(req.body.weeklyHours) || 40,
    gracePeriod:  Number(req.body.gracePeriod) || 15,
    createdBy:    new ObjectId(req.user._id),
    createdAt:    new Date(),
  };
  const result = await insertOne('work_schedules', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateSchedule = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  await updateOne('work_schedules', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteSchedule = async (req, res) => {
  await global.dbo.collection('work_schedules').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── employeeShiftAssignments — links a named work_schedules template to an employee ──
// The per-date `shifts` collection remains the source of truth when a specific shift
// exists for that day (ad-hoc scheduling, the open-shift marketplace); this assignment
// is the fallback "what's their normal schedule" used by clockOut's overtime split and
// markLateArrivals when no such per-date shift is set.

const assignSchedule = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'scheduleId', 'effectiveFrom'])) return;
  const employeeId = new ObjectId(req.body.employeeId);
  const scheduleId = new ObjectId(req.body.scheduleId);
  const effectiveFrom = new Date(req.body.effectiveFrom);

  const schedule = await findOne('work_schedules', { _id: scheduleId });
  if (!schedule) return returnFunction(res, 404, false, 'Work schedule not found.');

  // Close out any currently-open assignment for this employee as of the day before the new one starts
  const dayBefore = new Date(effectiveFrom.getTime() - 24 * 60 * 60 * 1000);
  await global.dbo.collection('employeeShiftAssignments').updateMany(
    { employeeId, effectiveTo: null },
    { $set: { effectiveTo: dayBefore, updatedAt: new Date() } }
  );

  const doc = {
    employeeId,
    scheduleId,
    effectiveFrom,
    effectiveTo: req.body.effectiveTo ? new Date(req.body.effectiveTo) : null,
    assignedBy: new ObjectId(req.user._id),
    createdAt: new Date(),
  };
  const result = await insertOne('employeeShiftAssignments', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const getEmployeeScheduleAssignment = async (req, res) => {
  const employeeId = new ObjectId(req.params.employeeId);
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.some((id) => String(id) === String(employeeId))) {
    return returnFunction(res, 403, false, 'You are not authorized to view this employee\'s schedule.');
  }
  const now = new Date();
  const assignment = await global.dbo.collection('employeeShiftAssignments').findOne(
    { employeeId, effectiveFrom: { $lte: now }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: now } }] },
    { sort: { effectiveFrom: -1 } }
  );
  if (!assignment) return returnFunction(res, 200, true, req.locale.success, null);
  const schedule = await findOne('work_schedules', { _id: assignment.scheduleId });
  return returnFunction(res, 200, true, req.locale.success, { ...assignment, schedule: schedule || null });
};

// Shared by clockOut's overtime split and markLateArrivals — resolves what an employee's
// "normal" schedule is on a given date via their current employeeShiftAssignments link.
async function getEffectiveScheduleForEmployee(employeeId, dateStr) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  const assignment = await global.dbo.collection('employeeShiftAssignments').findOne(
    { employeeId, effectiveFrom: { $lte: date }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }] },
    { sort: { effectiveFrom: -1 } }
  );
  if (!assignment) return null;
  return findOne('work_schedules', { _id: assignment.scheduleId });
}

const bulkCreateShifts = async (req, res) => {
  const { employeeIds, dates, shiftType, startTime, endTime, breakMinutes, location, notes, isOpen } = req.body;
  const open = isOpen === true || isOpen === 'true';
  if (!open && (!Array.isArray(employeeIds) || employeeIds.length === 0)) return returnFunction(res, 400, false, 'No employees selected.');
  if (!Array.isArray(dates) || dates.length === 0) return returnFunction(res, 400, false, 'No dates selected.');

  const shiftBase = {
    shiftType:    shiftType || 'full_day',
    startTime:    startTime || '08:00',
    endTime:      endTime   || '17:00',
    breakMinutes: Number(breakMinutes) || 60,
    location:     location || 'office',
    notes:        notes || '',
    createdBy:    new ObjectId(req.user._id),
    createdAt:    new Date(),
  };

  const docs = [];
  if (open) {
    for (const date of dates) {
      docs.push({ ...shiftBase, employeeId: null, isOpen: true, date });
    }
  } else {
    for (const empId of employeeIds) {
      for (const date of dates) {
        docs.push({ ...shiftBase, employeeId: new ObjectId(empId), isOpen: false, date });
      }
    }
  }
  await global.dbo.collection('shifts').insertMany(docs);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { count: docs.length });
};

// ── Open shifts & applications ────────────────────────────────────────────────

const getMyShifts = async (req, res) => {
  const empId = req.user.employeeId;
  if (!empId) return returnFunction(res, 400, false, 'No employee profile linked.');
  const today = new Date().toISOString().split('T')[0];
  const shifts = await findMany('shifts', { employeeId: empId, date: { $gte: today } }, { sort: { date: 1 }, limit: 30 });
  return returnFunction(res, 200, true, req.locale.success, shifts);
};

const getOpenShifts = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const shifts = await findMany('shifts', { isOpen: true, employeeId: null, date: { $gte: today } }, { sort: { date: 1 } });
  return returnFunction(res, 200, true, req.locale.success, shifts);
};

const applyForShift = async (req, res) => {
  const empId = req.user.employeeId;
  if (!empId) return returnFunction(res, 400, false, 'No employee profile linked.');
  const shift = await findOne('shifts', { _id: new ObjectId(req.params.id) });
  if (!shift) return returnFunction(res, 404, false, 'Shift not found.');
  if (!shift.isOpen) return returnFunction(res, 400, false, 'This shift is not open for applications.');
  const existing = await findOne('shift_applications', { shiftId: new ObjectId(req.params.id), employeeId: empId });
  if (existing) return returnFunction(res, 409, false, 'You have already applied for this shift.');
  const emp = await findOne('employees', { _id: empId });
  await global.dbo.collection('shift_applications').insertOne({
    shiftId:      new ObjectId(req.params.id),
    employeeId:   empId,
    employeeName: emp?.fullName || '',
    status:       'pending',
    note:         req.body.note || '',
    createdAt:    new Date(),
  });
  return returnFunction(res, 201, true, 'Application submitted successfully.');
};

const getShiftApplications = async (req, res) => {
  const filter = {};
  if (req.query.shiftId) filter.shiftId = new ObjectId(req.query.shiftId);
  if (req.query.status)  filter.status  = req.query.status;
  const apps   = await findMany('shift_applications', filter, { sort: { createdAt: -1 } });
  const shiftIds = [...new Set(apps.map(a => a.shiftId))];
  const shifts   = shiftIds.length ? await findMany('shifts', { _id: { $in: shiftIds } }) : [];
  const shiftMap = Object.fromEntries(shifts.map(s => [String(s._id), s]));
  return returnFunction(res, 200, true, req.locale.success, apps.map(a => ({ ...a, shift: shiftMap[String(a.shiftId)] ?? null })));
};

const resolveShiftApplication = async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) return returnFunction(res, 400, false, 'Invalid status.');
  const app = await findOne('shift_applications', { _id: new ObjectId(req.params.id) });
  if (!app) return returnFunction(res, 404, false, 'Application not found.');
  await global.dbo.collection('shift_applications').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status, resolvedAt: new Date(), resolvedBy: new ObjectId(req.user._id) } }
  );
  if (status === 'approved') {
    await global.dbo.collection('shifts').updateOne(
      { _id: app.shiftId },
      { $set: { employeeId: app.employeeId, isOpen: false } }
    );
    await global.dbo.collection('shift_applications').updateMany(
      { shiftId: app.shiftId, _id: { $ne: new ObjectId(req.params.id) } },
      { $set: { status: 'rejected', resolvedAt: new Date() } }
    );
  }
  return returnFunction(res, 200, true, status === 'approved' ? 'Application approved.' : 'Application rejected.');
};

const getMyShiftApplications = async (req, res) => {
  const empId = req.user.employeeId;
  if (!empId) return returnFunction(res, 400, false, 'No employee profile linked.');
  const apps    = await findMany('shift_applications', { employeeId: empId }, { sort: { createdAt: -1 } });
  const shiftIds = [...new Set(apps.map(a => a.shiftId))];
  const shifts   = shiftIds.length ? await findMany('shifts', { _id: { $in: shiftIds } }) : [];
  const shiftMap = Object.fromEntries(shifts.map(s => [String(s._id), s]));
  return returnFunction(res, 200, true, req.locale.success, apps.map(a => ({ ...a, shift: shiftMap[String(a.shiftId)] ?? null })));
};

// ── Analytics ─────────────────────────────────────────────────────────────────
// All scoped via getScopedEmployeeIds: HR/super_admin see everyone, department_head
// sees their department, a manager (via employees.managerId) sees direct reports.

const getAttendanceOverview = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) {
    return returnFunction(res, 200, true, req.locale.success, { present: 0, absent: 0, late: 0, onLeave: 0, notClockedIn: 0, total: 0 });
  }

  const empFilter = { status: 'active' };
  if (scopedIds !== null) empFilter._id = { $in: scopedIds };
  const employees = await findMany('employees', empFilter, { projection: { _id: 1 } });
  const empIds = employees.map((e) => e._id);

  const recordFilter = { date: today, employeeId: { $in: empIds } };
  const byStatus = await global.dbo.collection('attendance_records').aggregate([
    { $match: recordFilter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).toArray();
  const statusMap = Object.fromEntries(byStatus.map((s) => [s._id, s.count]));

  const recordedCount = await global.dbo.collection('attendance_records').countDocuments(recordFilter);

  return returnFunction(res, 200, true, req.locale.success, {
    present:      statusMap.present || 0,
    late:         statusMap.late || 0,
    absent:       statusMap.absent || 0,
    onLeave:      statusMap.onLeave || statusMap.on_leave || 0,
    notClockedIn: Math.max(0, empIds.length - recordedCount),
    total:        empIds.length,
  });
};

const getAttendanceSummary = async (req, res) => {
  const groupBy = req.query.groupBy === 'department' ? 'department' : 'employee';
  const from = req.query.startDate || new Date(new Date().setDate(1)).toISOString().split('T')[0];
  const to   = req.query.endDate   || new Date().toISOString().split('T')[0];

  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);

  const empFilter = { status: 'active' };
  if (scopedIds !== null) empFilter._id = { $in: scopedIds };
  const employees = await findMany('employees', empFilter, { projection: { fullName: 1, department: 1 } });
  const empMap = Object.fromEntries(employees.map((e) => [String(e._id), e]));

  const records = await global.dbo.collection('attendance_records').find({
    date: { $gte: from, $lte: to },
    employeeId: { $in: employees.map((e) => e._id) },
  }).toArray();

  const groups = {};
  for (const r of records) {
    const emp = empMap[String(r.employeeId)];
    if (!emp) continue;
    const key = groupBy === 'department' ? (emp.department || 'Unassigned') : String(r.employeeId);
    if (!groups[key]) {
      groups[key] = {
        key,
        label: groupBy === 'department' ? key : emp.fullName,
        present: 0, late: 0, absent: 0, halfDay: 0, totalDays: 0,
      };
    }
    groups[key].totalDays++;
    if (r.status === 'present') groups[key].present++;
    else if (r.status === 'late') groups[key].late++;
    else if (r.status === 'absent') groups[key].absent++;
    else if (r.status === 'half_day') groups[key].halfDay++;
  }

  const summary = Object.values(groups).map((g) => ({
    ...g,
    attendanceRate: g.totalDays > 0 ? Math.round(((g.present + g.late) / g.totalDays) * 100) : 0,
  }));

  return returnFunction(res, 200, true, req.locale.success, summary);
};

const getOvertimeAnalytics = async (req, res) => {
  const month = String(req.query.month || (new Date().getMonth() + 1)).padStart(2, '0');
  const year  = req.query.year || new Date().getFullYear();
  const from  = `${year}-${month}-01`;
  const to    = `${year}-${month}-31`;
  const groupBy = req.query.groupBy === 'department' ? 'department' : 'employee';

  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);

  const empFilter = {};
  if (scopedIds !== null) empFilter._id = { $in: scopedIds };
  const employees = await findMany('employees', empFilter, { projection: { fullName: 1, department: 1 } });
  const empMap = Object.fromEntries(employees.map((e) => [String(e._id), e]));

  const records = await global.dbo.collection('attendance_records').find({
    date: { $gte: from, $lte: to },
    employeeId: { $in: employees.map((e) => e._id) },
    overtimeMinutes: { $gt: 0 },
  }).toArray();

  const groups = {};
  for (const r of records) {
    const emp = empMap[String(r.employeeId)];
    if (!emp) continue;
    const key = groupBy === 'department' ? (emp.department || 'Unassigned') : String(r.employeeId);
    if (!groups[key]) groups[key] = { key, label: groupBy === 'department' ? key : emp.fullName, overtimeMinutes: 0 };
    groups[key].overtimeMinutes += r.overtimeMinutes || 0;
  }

  const result = Object.values(groups)
    .map((g) => ({ ...g, overtimeHours: Math.round((g.overtimeMinutes / 60) * 100) / 100 }))
    .sort((a, b) => b.overtimeMinutes - a.overtimeMinutes);

  return returnFunction(res, 200, true, req.locale.success, result);
};

const getLateArrivalsAnalytics = async (req, res) => {
  const from = req.query.startDate || new Date(new Date().setDate(new Date().getDate() - 29)).toISOString().split('T')[0];
  const to   = req.query.endDate   || new Date().toISOString().split('T')[0];

  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, { trend: [], leaderboard: [] });

  const empFilter = { status: 'active' };
  if (scopedIds !== null) empFilter._id = { $in: scopedIds };
  const employees = await findMany('employees', empFilter, { projection: { fullName: 1, department: 1 } });
  const empMap = Object.fromEntries(employees.map((e) => [String(e._id), e]));

  const lateRecords = await global.dbo.collection('attendance_records').find({
    date: { $gte: from, $lte: to },
    status: 'late',
    employeeId: { $in: employees.map((e) => e._id) },
  }).toArray();

  const byDay = {};
  const byEmployee = {};
  for (const r of lateRecords) {
    byDay[r.date] = (byDay[r.date] || 0) + 1;
    const key = String(r.employeeId);
    byEmployee[key] = (byEmployee[key] || 0) + 1;
  }

  const trend = Object.entries(byDay).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
  const leaderboard = Object.entries(byEmployee)
    .map(([empId, count]) => ({ employeeId: empId, employee: empMap[empId] || null, lateCount: count }))
    .filter((l) => l.employee)
    .sort((a, b) => b.lateCount - a.lateCount)
    .slice(0, 10);

  return returnFunction(res, 200, true, req.locale.success, { trend, leaderboard });
};

const getAbsenteeismAnalytics = async (req, res) => {
  const from = req.query.startDate || new Date(new Date().setDate(1)).toISOString().split('T')[0];
  const to   = req.query.endDate   || new Date().toISOString().split('T')[0];

  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);

  const empFilter = { status: 'active' };
  if (scopedIds !== null) empFilter._id = { $in: scopedIds };
  const employees = await findMany('employees', empFilter, { projection: { department: 1 } });
  const empMap = Object.fromEntries(employees.map((e) => [String(e._id), e]));

  const records = await global.dbo.collection('attendance_records').find({
    date: { $gte: from, $lte: to },
    employeeId: { $in: employees.map((e) => e._id) },
    status: { $in: ['present', 'late', 'absent', 'half_day'] },
  }).toArray();

  const groups = {};
  for (const r of records) {
    const emp = empMap[String(r.employeeId)];
    if (!emp) continue;
    const dept = emp.department || 'Unassigned';
    if (!groups[dept]) groups[dept] = { department: dept, absentDays: 0, totalDays: 0 };
    groups[dept].totalDays++;
    if (r.status === 'absent') groups[dept].absentDays++;
  }

  const result = Object.values(groups)
    .map((g) => ({ ...g, absenteeismRate: g.totalDays > 0 ? Math.round((g.absentDays / g.totalDays) * 1000) / 10 : 0 }))
    .sort((a, b) => b.absenteeismRate - a.absenteeismRate);

  return returnFunction(res, 200, true, req.locale.success, result);
};

module.exports = {
  // existing
  listAttendance, markAttendance, bulkImportAttendance, getAbsenceAlerts,
  clockIn, clockOut, getTodayStatus, getMyRecords,
  // new
  breakStart, breakEnd,
  getTeamStatus,
  getTimesheets, getCurrentTimesheet, saveTimesheet, submitTimesheet, approveTimesheet, rejectTimesheet,
  getShifts, createShift, updateShift, deleteShift,
  getMyShifts, getOpenShifts, applyForShift, getShiftApplications, resolveShiftApplication, getMyShiftApplications,
  getAttendanceReport, getAttendanceStats,
  getSettings, saveSettings, getSchedules, createSchedule, updateSchedule, deleteSchedule,
  bulkCreateShifts,
  assignSchedule, getEmployeeScheduleAssignment, getEffectiveScheduleForEmployee,
  getAttendanceOverview, getAttendanceSummary, getOvertimeAnalytics, getLateArrivalsAnalytics, getAbsenteeismAnalytics,
  exportAttendanceReportCSV,
  getPayrollFeed, markPayrollFeedProcessed,
  bulkApproveTimesheets,
};
