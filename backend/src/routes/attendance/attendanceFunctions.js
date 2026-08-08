const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 3b) —
// attendance_records (+ attendance_breaks), timesheets, shifts (+ shift_task_templates/
// shift_tasks/shift_notes/shift_applications), work_schedules, employeeShiftAssignments,
// attendance_settings, employees, users, leave_requests, public_holidays all now live in
// Postgres. company_settings/overtime_config joined them in Phase 10 — this file is
// fully migrated, no more Mongo helpers.
// NOTE: insertOne here MUST come from pgDBFunctions, not commonDBFunctions (Mongo) — an
// earlier version of this file imported it from the Mongo helper by mistake, which meant
// every insert in this module (clock-in, timesheets, shifts, ...) silently wrote to Mongo
// while every read hit Postgres, so nothing ever appeared to persist. Caught via live
// verification (clock-in reported success but the row never showed up in Postgres).
const { knex, newId, insertOne } = require('../../functions/Database/pgDBFunctions');
const { parseAttendanceCSV } = require('../../services/csvService');
const { notifyManager, notifyHR } = require('../inbox/inboxFunctions');
const { notifyEmployee } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');
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
    const emps = await knex('employees').where({ department: user.department }).select('id');
    return emps.map((e) => e.id);
  }
  if (!user.employeeId) return [];
  const empId = String(user.employeeId);
  const directReports = await knex('employees').where({ managerId: empId }).select('id');
  const ids = directReports.map((e) => e.id);
  ids.push(empId);
  return ids;
};

// Authorization for a single-employee action (approve/reject a timesheet) — HR bypasses,
// otherwise the acting user must be that employee's manager or department_head-of-record.
const isAuthorizedForEmployee = async (req, employeeId) => {
  if (isHR(req)) return true;
  const emp = await knex('employees').where({ id: String(employeeId) }).select('managerId', 'department').first();
  if (!emp) return false;
  if (req.user.role === DEPT_HEAD) return !!req.user.department && emp.department === req.user.department;
  return !!req.user.employeeId && emp.managerId === String(req.user.employeeId);
};

// Reassembles an attendance_records row's breaks child table back into the Mongo-
// document-shaped `breaks` array the rest of this file (and the frontend) already
// expects — breakStart/breakEnd insert/update one row at a time (a real per-row
// operation, not a whole-array replace), so the child table is the real storage; this
// view is reconstructed on read. See the migration's file header.
const attachBreaks = async (record) => {
  if (!record) return record;
  const breaks = await knex('attendance_breaks').where({ attendanceRecordId: record.id }).orderBy('startTime');
  return { ...record, breaks: breaks.map((b) => ({ id: b.id, startTime: b.startTime, endTime: b.endTime, duration: b.duration })) };
};
const attachBreaksMany = async (records) => Promise.all(records.map(attachBreaks));

// ── Existing helpers ──────────────────────────────────────────────────────────

const listAttendance = async (req, res) => {
  let query = knex('attendance_records');
  const { month, year, employeeId, department } = req.query;
  if (month && year) {
    const m = String(month).padStart(2, '0');
    query = query.where('date', '>=', `${year}-${m}-01`).where('date', '<=', `${year}-${m}-31`);
  }

  // A caller-supplied ?employeeId= must be validated against the requester's own
  // scope, not applied verbatim — otherwise any authenticated staff user can read
  // any other employee's attendance history simply by passing their id.
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) return returnFunction(res, 200, true, req.locale.success, []);
  if (employeeId) {
    if (scopedIds !== null && !scopedIds.includes(employeeId)) {
      return returnFunction(res, 403, false, 'You are not authorized to view this employee\'s attendance.');
    }
    query = query.where({ employeeId });
  } else if (scopedIds !== null) {
    query = query.whereIn('employeeId', scopedIds);
  }

  let records = await query.orderBy('date', 'asc');

  if (department) {
    const deptEmps = await knex('employees').where({ department }).select('id');
    const ids = deptEmps.map((e) => e.id);
    records = records.filter((r) => ids.includes(r.employeeId));
  }

  const grouped = {};
  for (const rec of records) {
    const key = rec.employeeId;
    if (!grouped[key]) grouped[key] = { employeeId: rec.employeeId, records: [] };
    grouped[key].records.push(rec);
  }

  const groupedValues = Object.values(grouped);
  const attEmpIds = groupedValues.map((g) => g.employeeId);
  const attEmps = attEmpIds.length ? await knex('employees').whereIn('id', attEmpIds).select('id', 'fullName', 'staffNumber', 'department') : [];
  const attEmpMap = Object.fromEntries(attEmps.map((e) => [e.id, e]));
  const enriched = groupedValues.map((g) => {
    const emp = attEmpMap[g.employeeId];
    return { ...g, employeeName: emp?.fullName || null, staffNumber: emp?.staffNumber || null, department: emp?.department || null };
  });

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const markAttendance = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'date', 'status'])) return;
  const employeeId = String(req.body.employeeId);
  const entryDate = req.body.date;

  // A manual entry claiming the employee worked (present/late/half_day) while they
  // have approved leave covering that date is almost always a mistake — block it
  // unless HR explicitly confirms the override (e.g. leave was later cancelled but
  // the record wasn't updated).
  const WORKED_STATUSES = ['present', 'late', 'half_day', 'remote'];
  if (WORKED_STATUSES.includes(req.body.status) && !req.body.overrideLeaveConflict) {
    const conflictingLeave = await knex('leave_requests')
      .where({ employeeId, status: 'approved' })
      .where('startDate', '<=', new Date(`${entryDate}T00:00:00.000Z`))
      .where('endDate', '>=', new Date(`${entryDate}T00:00:00.000Z`))
      .first();
    if (conflictingLeave) {
      return returnFunction(res, 409, false,
        `This employee has approved leave covering ${req.body.date}. Set overrideLeaveConflict to confirm this entry anyway.`,
        { leaveConflict: true, leaveRequestId: conflictingLeave.id }
      );
    }
  }

  const patch = {
    status: req.body.status,
    checkInTime: req.body.checkInTime || null,
    checkOutTime: req.body.checkOutTime || null,
    notes: req.body.notes || null,
    isManualEntry: true,
    markedBy: req.user.id,
  };

  const existing = await knex('attendance_records').where({ employeeId, date: entryDate }).first();
  if (existing) {
    await knex('attendance_records').where({ id: existing.id }).update({ ...patch, updatedAt: new Date() });
  } else {
    await insertOne('attendance_records', { id: newId(), employeeId, date: entryDate, ...patch, createdAt: new Date(), updatedAt: new Date() });
  }
  return returnFunction(res, 200, true, req.locale.success);
};

const bulkImportAttendance = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, 'CSV file required.');
  const { validRows, invalidRows } = parseAttendanceCSV(req.file.path);

  let successCount = 0;
  const errors = [];

  for (const row of validRows) {
    const employee = await knex('employees').where({ staffNumber: row.staffNumber }).first();
    if (!employee) {
      errors.push({ row, reason: `No employee found with staffNumber ${row.staffNumber}` });
      continue;
    }
    const patch = {
      status: row.status, checkInTime: row.checkInTime || null, checkOutTime: row.checkOutTime || null,
      notes: row.notes || null, markedBy: req.user.id, updatedAt: new Date(),
    };
    const existing = await knex('attendance_records').where({ employeeId: employee.id, date: row.date }).first();
    if (existing) {
      await knex('attendance_records').where({ id: existing.id }).update(patch);
    } else {
      await insertOne('attendance_records', { id: newId(), employeeId: employee.id, date: row.date, ...patch, createdAt: new Date() });
    }
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
  let query = knex('attendance_records').where({ status: 'absent' });
  if (scopedIds !== null) query = query.whereIn('employeeId', scopedIds);

  const recentRecords = await query.orderBy('employeeId', 'asc').orderBy('date', 'asc');

  const byEmployee = {};
  for (const r of recentRecords) {
    if (!byEmployee[r.employeeId]) byEmployee[r.employeeId] = [];
    byEmployee[r.employeeId].push(r.date);
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
  const alertEmpIds = alertCandidates.map((a) => a.empId);
  const alertEmpDocs = alertEmpIds.length
    ? await knex('employees').whereIn('id', alertEmpIds).select('id', 'fullName', 'staffNumber', 'department')
    : [];
  const alertEmpMap = Object.fromEntries(alertEmpDocs.map((e) => [e.id, e]));

  const alerts = alertCandidates
    .filter((a) => alertEmpMap[a.empId])
    .map((a) => ({ employee: alertEmpMap[a.empId], consecutiveAbsentDays: a.streak, from: a.from, to: a.to }));

  return returnFunction(res, 200, true, req.locale.success, alerts);
};

// Single source of truth for weekly overtime: sums each day's shift-based
// regularMinutes/overtimeMinutes (computed once, in clockOut) rather than
// recomputing against a flat weekly threshold that could disagree with it.
async function computeWeeklyHoursFromAttendance(employeeId, weekStartStr, weekEndStr) {
  const recs = await knex('attendance_records').where({ employeeId: String(employeeId) })
    .where('date', '>=', weekStartStr).where('date', '<=', weekEndStr);

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

const SHIFT_TYPE_LABELS = { morning: 'Morning Shift', afternoon: 'Afternoon Shift', night: 'Night Shift', full_day: 'Full-Day Shift', custom: 'Shift' };
const LOCATION_LABELS = { office: 'Office', remote: 'Remote', field: 'Field', 'client site': 'Client Site' };
const CLIENT_SITE_GEOFENCE_METERS = 30;

// A timesheet day's Project/Venue/Start/End/Break/Hours are derived from
// attendance_records (clock-in/out) + that day's shift whenever either exists — that
// data can never be hand-typed over, so it can't drift from what was actually clocked.
// But an employee with no shift scheduling at all for a day (no `shifts` doc) has
// nothing for Project to derive from and would otherwise be stuck seeing a permanent
// "—" with no way to say what they worked on — `manualOverrides` (date -> {project,
// venue}) fills exactly that gap, and only that gap: it's ignored the moment a shift
// exists for the day, same as `descOverrides` for the free-text notes field.
async function buildTimesheetEntries(empId, weekStartStr, weekEndStr, descOverrides = {}, manualOverrides = {}) {
  const employeeId = String(empId);
  const [clockRecs, shifts] = await Promise.all([
    knex('attendance_records').where({ employeeId }).where('date', '>=', weekStartStr).where('date', '<=', weekEndStr),
    knex('shifts').where({ employeeId }).where('date', '>=', weekStartStr).where('date', '<=', weekEndStr),
  ]);
  const recByDate = Object.fromEntries(clockRecs.map((r) => [r.date, r]));
  const shiftByDate = Object.fromEntries(shifts.map((s) => [s.date, s]));

  const templateIds = [...new Set(shifts.filter((s) => s.taskTemplateId).map((s) => s.taskTemplateId))];
  const templates = templateIds.length
    ? await knex('shift_task_templates').whereIn('id', templateIds).select('id', 'name')
    : [];
  const templateNameById = Object.fromEntries(templates.map((t) => [t.id, t.name]));

  const dates = [];
  for (let d = new Date(`${weekStartStr}T00:00:00`); d.toISOString().split('T')[0] <= weekEndStr; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }

  return dates.map((date) => {
    const rec = recByDate[date] || null;
    const shift = shiftByDate[date] || null;
    const manual = manualOverrides[date] || {};

    let projectName = '';
    let projectIsAuto = false;
    if (shift?.taskTemplateId && templateNameById[shift.taskTemplateId]) {
      projectName = templateNameById[shift.taskTemplateId];
      projectIsAuto = true;
    } else if (shift?.shiftType) {
      projectName = SHIFT_TYPE_LABELS[shift.shiftType] || 'Shift';
      projectIsAuto = true;
    } else if (rec?.notes?.trim()) {
      // No standard shift on file for this day — fall back to whatever notes were
      // logged at clock-in/manual entry so a handover-style context isn't lost.
      projectName = rec.notes.trim().slice(0, 80);
      projectIsAuto = true;
    } else if (manual.project?.trim()) {
      projectName = manual.project.trim().slice(0, 80);
    }

    let venue = '';
    let venueIsAuto = false;
    if (shift?.address && typeof shift.addressLat === 'number' && typeof shift.addressLng === 'number'
      && rec && typeof rec.checkInLat === 'number' && typeof rec.checkInLng === 'number') {
      const distanceM = haversineMeters(rec.checkInLat, rec.checkInLng, shift.addressLat, shift.addressLng);
      venue = distanceM <= CLIENT_SITE_GEOFENCE_METERS ? shift.address : (rec.checkInLocation || LOCATION_LABELS[rec.location] || '');
      venueIsAuto = true;
    } else if (rec?.checkInLocation) {
      venue = rec.checkInLocation;
      venueIsAuto = true;
    } else if (rec?.location) {
      venue = LOCATION_LABELS[rec.location] || rec.location;
      venueIsAuto = true;
    } else if (shift?.location) {
      venue = LOCATION_LABELS[shift.location] || shift.location;
      venueIsAuto = true;
    } else if (manual.venue?.trim()) {
      venue = manual.venue.trim().slice(0, 120);
    }

    return {
      date,
      projectName,
      projectEditable: !projectIsAuto,
      venue,
      venueEditable: !venueIsAuto,
      startTime: rec?.checkInTime || '',
      endTime: rec?.checkOutTime || '',
      breakMinutes: rec?.totalBreakMinutes || 0,
      totalMinutes: rec?.totalWorkMinutes || 0,
      description: descOverrides[date] ?? '',
    };
  });
}

const clockIn = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked to your account.');
  const empId = String(req.user.employeeId);
  const today = new Date().toISOString().split('T')[0];

  const existing = await knex('attendance_records').where({ employeeId: empId, date: today }).first();
  if (existing?.checkInTime) return returnFunction(res, 409, false, 'You have already clocked in today.');

  const onApprovedLeave = await knex('leave_requests')
    .where({ employeeId: empId, status: 'approved' })
    .where('startDate', '<=', new Date()).where('endDate', '>=', new Date())
    .first();
  if (onApprovedLeave) return returnFunction(res, 403, false, 'You are on approved leave today and cannot clock in.');

  const latitude  = parseFloat(req.body.latitude);
  const longitude = parseFloat(req.body.longitude);
  if (isNaN(latitude) || isNaN(longitude)) {
    return returnFunction(res, 400, false, 'Location access is required to clock in. Please enable GPS and try again.');
  }

  // company_settings is Postgres now (Phase 10).
  const settings = await knex('company_settings').first();
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
  const attSettingsRow = await knex('attendance_settings').where({ id: 'singleton' }).first();
  const attSettings = attSettingsRow?.data || {};
  if (attSettings?.blockUnscheduledClockIn) {
    const todayShift = await knex('shifts').where({ employeeId: empId, date: today }).first();
    if (!todayShift) {
      return returnFunction(res, 403, false, 'You do not have a scheduled shift today. Please contact HR.');
    }
  }

  const now = new Date();
  const checkInTime = now.toTimeString().slice(0, 5);

  const patch = {
    status:          'present',
    mode,
    checkInTime,
    checkInAt:       now,
    checkInLat:      latitude,
    checkInLng:      longitude,
    checkInLocation: req.body.locationName || null,
    location:        req.body.workLocation || 'office',
    selfMarked:      true,
    markedBy:        req.user.id,
    updatedAt:       now,
  };

  if (existing) {
    await knex('attendance_records').where({ id: existing.id }).update(patch);
    // Clear any prior breaks — this is a fresh clock-in on a record that already
    // existed for today (e.g. a manual entry created earlier), matching the old
    // $set-the-whole-doc behavior which implicitly reset `breaks` too.
    await knex('attendance_breaks').where({ attendanceRecordId: existing.id }).del();
  } else {
    await insertOne('attendance_records', { id: newId(), employeeId: empId, date: today, ...patch, createdAt: now });
  }

  return returnFunction(res, 200, true, 'Clocked in successfully.', { checkInTime, mode });
};

const clockOut = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked to your account.');
  const empId = String(req.user.employeeId);
  const today = new Date().toISOString().split('T')[0];

  const existing = await knex('attendance_records').where({ employeeId: empId, date: today }).first();
  if (!existing?.checkInTime) return returnFunction(res, 400, false, 'You have not clocked in yet today.');
  if (existing?.checkOutTime) return returnFunction(res, 409, false, 'You have already clocked out today.');

  const now = new Date();
  const checkOutTime = now.toTimeString().slice(0, 5);
  const latitude  = parseFloat(req.body.latitude);
  const longitude = parseFloat(req.body.longitude);

  // Compute total break minutes from the breaks child table (was an embedded array).
  const breaks = await knex('attendance_breaks').where({ attendanceRecordId: existing.id });
  const totalBreakMins = breaks.reduce((sum, b) => {
    if (b.endTime) return sum + Math.round((new Date(b.endTime) - new Date(b.startTime)) / 60000);
    return sum;
  }, 0);

  const workMins = existing.checkInAt
    ? Math.round((now - new Date(existing.checkInAt)) / 60000) - totalBreakMins
    : 0;

  // Overtime + payment category calculation
  const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const [todayShift, attSettingsRow, holiday] = await Promise.all([
    knex('shifts').where({ employeeId: empId, date: today }).first(),
    knex('attendance_settings').where({ id: 'singleton' }).first(),
    // public_holidays now lives in Postgres (Phase 3a) — this used to (incorrectly)
    // query a 'holidays' collection nothing ever wrote to, so this branch could never
    // fire; fixed here since there's no real prior behavior to preserve.
    knex('public_holidays').where({ date: today }).first(),
  ]);
  const attSettings = attSettingsRow?.data || {};

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
  // before checkout. overtime_config is Postgres now (Phase 10).
  const overtimeConfig = await knex('overtime_config').first();
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

  await knex('attendance_records').where({ id: existing.id }).update({
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
    overtimeBreakdown: JSON.stringify({ weekdayDayMins, weekdayNightMins, weekendDayMins, weekendNightMins }),
    payCategory,
    updatedAt:         now,
  });

  return returnFunction(res, 200, true, 'Clocked out successfully.', { checkOutTime, totalWorkMinutes: workMins, overtimeMinutes, payCategory });
};

// ── Break tracking ────────────────────────────────────────────────────────────

const breakStart = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked.');
  const empId = String(req.user.employeeId);
  const today = new Date().toISOString().split('T')[0];

  const existing = await knex('attendance_records').where({ employeeId: empId, date: today }).first();
  if (!existing?.checkInTime) return returnFunction(res, 400, false, 'You have not clocked in yet.');
  if (existing?.checkOutTime) return returnFunction(res, 400, false, 'You have already clocked out.');

  const openBreak = await knex('attendance_breaks').where({ attendanceRecordId: existing.id }).whereNull('endTime').first();
  if (openBreak) return returnFunction(res, 409, false, 'You are already on a break.');

  const now = new Date();
  // NOT addChildRow here — that helper always assigns a Mongo-ObjectId-shaped TEXT id
  // (right for employee_documents/certifications/education, which preserve Mongo
  // sub-document ids), but attendance_breaks.id is a real Postgres auto-increment
  // integer (see the migration file header), so a plain insert with no id is correct.
  await knex('attendance_breaks').insert({ attendanceRecordId: existing.id, startTime: now, endTime: null });
  await knex('attendance_records').where({ id: existing.id }).update({ updatedAt: now });

  return returnFunction(res, 200, true, 'Break started.', { breakStartedAt: now });
};

const breakEnd = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked.');
  const empId = String(req.user.employeeId);
  const today = new Date().toISOString().split('T')[0];

  const existing = await knex('attendance_records').where({ employeeId: empId, date: today }).first();
  if (!existing) return returnFunction(res, 400, false, 'No attendance record found for today.');

  const openBreak = await knex('attendance_breaks').where({ attendanceRecordId: existing.id }).whereNull('endTime').first();
  if (!openBreak) return returnFunction(res, 400, false, 'You are not currently on a break.');

  const now = new Date();
  const durationMins = Math.round((now - new Date(openBreak.startTime)) / 60000);
  await knex('attendance_breaks').where({ id: openBreak.id }).update({ endTime: now, duration: durationMins });
  await knex('attendance_records').where({ id: existing.id }).update({ updatedAt: now });

  return returnFunction(res, 200, true, 'Break ended.', { durationMinutes: durationMins });
};

// ── Get today status + break state ───────────────────────────────────────────

const getTodayStatus = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, req.locale.success, null);
  const today = new Date().toISOString().split('T')[0];
  const record = await knex('attendance_records').where({ employeeId: String(req.user.employeeId), date: today }).first();
  return returnFunction(res, 200, true, req.locale.success, record ? await attachBreaks(record) : null);
};

const getMyRecords = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const since = new Date();
  since.setDate(since.getDate() - days + 1);
  const sinceStr = since.toISOString().split('T')[0];
  const records = await knex('attendance_records')
    .where({ employeeId: String(req.user.employeeId) }).where('date', '>=', sinceStr)
    .orderBy('date', 'asc');
  return returnFunction(res, 200, true, req.locale.success, records);
};

// ── Team status today (HR/manager) ────────────────────────────────────────────

const getTeamStatus = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) {
    return returnFunction(res, 200, true, req.locale.success, { records: [], stats: { clockedIn: 0, onBreak: 0, completed: 0, notClockedIn: 0 } });
  }
  let recordQuery = knex('attendance_records').where({ date: today });
  if (scopedIds !== null) recordQuery = recordQuery.whereIn('employeeId', scopedIds);

  const rawRecords = await recordQuery;
  const records = await attachBreaksMany(rawRecords);

  const teamEmpIds = records.map((r) => r.employeeId);
  const teamEmps = teamEmpIds.length ? await knex('employees').whereIn('id', teamEmpIds).select('id', 'fullName', 'designation', 'department') : [];
  const teamEmpMap = Object.fromEntries(teamEmps.map((e) => [e.id, e]));
  const enriched = records.map((r) => {
    const openBreak = (r.breaks || []).find((b) => !b.endTime);
    const clockStatus = r.checkOutTime ? 'completed'
      : openBreak ? 'on_break'
      : r.checkInTime ? 'clocked_in'
      : 'not_clocked_in';
    return { ...r, employee: teamEmpMap[r.employeeId] ?? null, clockStatus };
  });

  let allEmpQuery = knex('employees').where({ status: 'active' });
  if (scopedIds !== null) allEmpQuery = allEmpQuery.whereIn('id', scopedIds);
  const allEmployees = await allEmpQuery.select('id', 'fullName', 'designation', 'department');
  const recordedIds = new Set(records.map((r) => r.employeeId));
  const notClockedIn = allEmployees
    .filter((e) => !recordedIds.has(e.id))
    .map((e) => ({ employeeId: e.id, employee: e, clockStatus: 'not_clocked_in', date: today }));

  const all = [...enriched, ...notClockedIn];

  const stats = {
    clockedIn:     all.filter((r) => r.clockStatus === 'clocked_in').length,
    onBreak:       all.filter((r) => r.clockStatus === 'on_break').length,
    completed:     all.filter((r) => r.clockStatus === 'completed').length,
    notClockedIn:  all.filter((r) => r.clockStatus === 'not_clocked_in').length,
  };

  return returnFunction(res, 200, true, req.locale.success, { records: all, stats });
};

// ── Timesheets ────────────────────────────────────────────────────────────────

const getTimesheets = async (req, res) => {
  let query = knex('timesheets');
  if (req.query.weekStart) query = query.where({ weekStart: new Date(req.query.weekStart) });
  if (req.query.status) query = query.where({ status: req.query.status });

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
    if (scopedIds !== null && !scopedIds.includes(req.query.employeeId)) {
      return returnFunction(res, 403, false, 'You are not authorized to view this employee\'s timesheets.');
    }
    query = query.where({ employeeId: req.query.employeeId });
  } else if (scopedIds !== null) {
    query = query.whereIn('employeeId', scopedIds);
    isTeamView = scopedIds.length > 1;
  } else {
    isTeamView = true; // HR/super_admin browsing everyone's timesheets
  }

  const sheets = await query.orderBy('weekStart', 'desc').limit(isTeamView ? 200 : 20);

  if (!isTeamView) return returnFunction(res, 200, true, req.locale.success, sheets);

  const empIds = [...new Set(sheets.map((s) => s.employeeId))];
  const employees = empIds.length
    ? await knex('employees').whereIn('id', empIds).select('id', 'fullName', 'staffNumber', 'department')
    : [];
  const empMap = Object.fromEntries(employees.map((e) => [e.id, e]));
  const enriched = sheets.map((s) => ({ ...s, employee: empMap[s.employeeId] ?? null }));
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

  let sheet = await knex('timesheets')
    .where({ employeeId: String(empId) })
    .where('weekStart', '>=', monday).where('weekStart', '<=', new Date(monday.getTime() + 1000))
    .first();

  const weekStr = monday.toISOString().split('T')[0];
  const sundayStr = sunday.toISOString().split('T')[0];
  const descOverrides = Object.fromEntries((sheet?.entries || []).map((e) => [e.date, e.description || '']));
  const manualOverrides = Object.fromEntries((sheet?.entries || []).map((e) => [e.date, { project: e.projectEditable ? e.projectName : '', venue: e.venueEditable ? e.venue : '' }]));
  const entries = await buildTimesheetEntries(empId, weekStr, sundayStr, descOverrides, manualOverrides);
  const weekHours = await computeWeeklyHoursFromAttendance(empId, weekStr, sundayStr);

  if (!sheet) {
    const doc = {
      id: newId(),
      employeeId:  String(empId),
      weekStart:  monday,
      weekEnd:    sunday,
      entries: JSON.stringify(entries),
      totalMinutes: weekHours.totalMinutes,
      totalRegularMinutes: weekHours.totalRegularMinutes,
      overtimeMinutes: weekHours.totalOvertimeMinutes,
      overtimeBreakdown: JSON.stringify(weekHours.overtimeBreakdown),
      totalBreakMinutes: weekHours.totalBreakMinutes,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await insertOne('timesheets', doc);
    sheet = { ...doc, entries };
  } else {
    // Re-derive from attendance/shift data on every view (not just on first creation)
    // so a late clock-out or a shift edited after the fact stays reflected — only the
    // persisted per-day description and manually-entered project/venue survive (folded
    // into descOverrides/manualOverrides above).
    sheet = {
      ...sheet,
      entries,
      totalMinutes: weekHours.totalMinutes,
      totalRegularMinutes: weekHours.totalRegularMinutes,
      overtimeMinutes: weekHours.totalOvertimeMinutes,
      overtimeBreakdown: weekHours.overtimeBreakdown,
      totalBreakMinutes: weekHours.totalBreakMinutes,
    };
  }

  return returnFunction(res, 200, true, req.locale.success, sheet);
};

const saveTimesheet = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'weekStart'])) return;

  const empId = String(req.body.employeeId);
  const weekStart = new Date(req.body.weekStart);
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const weekEndStr = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Project/Venue/Start/End/Break/Hours are system-captured from clock-in/out + that
  // day's shift whenever either exists — never client-supplied over real data. A staff
  // member can always submit a per-day description, and additionally a manual
  // project/venue for any day that has no shift on file at all (see buildTimesheetEntries).
  const descOverrides = req.body.descriptions && typeof req.body.descriptions === 'object' ? req.body.descriptions : {};
  const manualOverrides = req.body.manualEntries && typeof req.body.manualEntries === 'object' ? req.body.manualEntries : {};
  const entries = await buildTimesheetEntries(empId, weekStartStr, weekEndStr, descOverrides, manualOverrides);
  const weekHours = await computeWeeklyHoursFromAttendance(empId, weekStartStr, weekEndStr);

  const patch = {
    entries: JSON.stringify(entries),
    totalMinutes: weekHours.totalMinutes,
    totalRegularMinutes: weekHours.totalRegularMinutes,
    overtimeMinutes: weekHours.totalOvertimeMinutes,
    overtimeBreakdown: JSON.stringify(weekHours.overtimeBreakdown),
    totalBreakMinutes: weekHours.totalBreakMinutes,
    status: req.body.status || 'draft',
    updatedAt: new Date(),
  };

  const existing = await knex('timesheets').where({ employeeId: empId, weekStart }).first();
  if (existing) {
    await knex('timesheets').where({ id: existing.id }).update(patch);
  } else {
    await insertOne('timesheets', { id: newId(), employeeId: empId, weekStart, ...patch, createdAt: new Date() });
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const submitTimesheet = async (req, res) => {
  const sheet = await knex('timesheets').where({ id: req.params.id }).first();
  if (!sheet) return returnFunction(res, 404, false, 'Timesheet not found.');
  if (req.user.role === 'staff' && req.user.employeeId && sheet.employeeId !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'You can only submit your own timesheets.');
  }
  if (sheet.status === 'submitted') return returnFunction(res, 400, false, 'Already submitted.');

  await knex('timesheets').where({ id: sheet.id }).update({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() });

  // Inbox: notify manager that timesheet was submitted. notifyManager silently no-ops
  // if the employee has no managerId on file (same gap as the leave-request bug) — HR
  // must always get a copy too, otherwise a timesheet can go unnoticed by anyone.
  if (req.user.employeeId) {
    const emp = await knex('employees').where({ id: String(req.user.employeeId) }).select('fullName').first();
    const inboxItem = {
      type: 'timesheet', subType: 'timesheet_submission',
      title: `Timesheet submitted by ${emp?.fullName || 'An employee'}`,
      subtitle: `Week ${sheet.weekStart || ''} – ${sheet.weekEnd || ''} · ${sheet.totalHours || ''}h`,
      referenceId: sheet.id, referenceModel: 'timesheets',
      requiresAction: true, triggeredBy: req.user.id,
    };
    await notifyManager(req.user.employeeId, inboxItem);
    await notifyHR(inboxItem);
  }

  return returnFunction(res, 200, true, 'Timesheet submitted for approval.');
};

const approveTimesheet = async (req, res) => {
  const sheet = await knex('timesheets').where({ id: req.params.id }).first();
  if (!sheet) return returnFunction(res, 404, false, 'Timesheet not found.');
  if (!(await isAuthorizedForEmployee(req, sheet.employeeId))) {
    return returnFunction(res, 403, false, 'You can only approve timesheets for your direct reports.');
  }
  await knex('timesheets').where({ id: sheet.id }).update({ status: 'approved', approvedBy: req.user.id, approvedAt: new Date(), updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Timesheet approved.');
};

const rejectTimesheet = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const sheet = await knex('timesheets').where({ id: req.params.id }).first();
  if (!sheet) return returnFunction(res, 404, false, 'Timesheet not found.');
  if (!(await isAuthorizedForEmployee(req, sheet.employeeId))) {
    return returnFunction(res, 403, false, 'You can only reject timesheets for your direct reports.');
  }
  await knex('timesheets').where({ id: sheet.id }).update({ status: 'rejected', rejectionReason: req.body.reason, updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Timesheet rejected.');
};

const bulkApproveTimesheets = async (req, res) => {
  if (!validateRequiredFields(req, res, ['timesheetIds'])) return;
  const ids = req.body.timesheetIds.map(String);
  const sheets = await knex('timesheets').whereIn('id', ids).where({ status: 'submitted' });

  const approvedIds = [];
  const skipped = [];
  for (const sheet of sheets) {
    if (await isAuthorizedForEmployee(req, sheet.employeeId)) {
      approvedIds.push(sheet.id);
    } else {
      skipped.push(sheet.id);
    }
  }

  if (approvedIds.length) {
    await knex('timesheets').whereIn('id', approvedIds).update({ status: 'approved', approvedBy: req.user.id, approvedAt: new Date(), updatedAt: new Date() });
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
  let query = knex('timesheets').where({ status: 'approved' }).whereNull('payrollRunId');
  if (req.query.startDate && req.query.endDate) {
    query = query.where('weekStart', '>=', new Date(req.query.startDate)).where('weekStart', '<=', new Date(req.query.endDate));
  }
  const sheets = await query.orderBy('weekStart', 'asc');
  const empIds = [...new Set(sheets.map((s) => s.employeeId))];
  const employees = empIds.length
    ? await knex('employees').whereIn('id', empIds).select('id', 'fullName', 'staffNumber', 'department')
    : [];
  const empMap = Object.fromEntries(employees.map((e) => [e.id, e]));

  const feed = sheets.map((s) => ({
    ...s,
    employee: empMap[s.employeeId] ?? null,
    overtimeHours: Math.round(((s.overtimeMinutes || 0) / 60) * 100) / 100,
  }));

  return returnFunction(res, 200, true, req.locale.success, feed);
};

const markPayrollFeedProcessed = async (req, res) => {
  if (!validateRequiredFields(req, res, ['timesheetIds', 'payrollRunId'])) return;
  const ids = req.body.timesheetIds.map(String);
  const payrollRunId = String(req.body.payrollRunId);
  const modifiedCount = await knex('timesheets').whereIn('id', ids).where({ status: 'approved' }).whereNull('payrollRunId')
    .update({ payrollRunId, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, { matchedCount: ids.length, modifiedCount });
};

// ── Shifts ────────────────────────────────────────────────────────────────────

const getShifts = async (req, res) => {
  let query = knex('shifts');
  if (req.query.startDate && req.query.endDate) {
    query = query.where('date', '>=', req.query.startDate).where('date', '<=', req.query.endDate);
  }

  // Unscoped before this: any authenticated user (route allows ALL roles) could pass
  // ?employeeId=<anyone> — or no filter at all — and see every employee's shift
  // schedule company-wide. Open shifts (employeeId: null) stay visible to everyone,
  // matching the marketplace's intent; assigned shifts are scoped like every other
  // attendance endpoint.
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (req.query.employeeId) {
    if (scopedIds !== null && !scopedIds.includes(req.query.employeeId)) {
      return returnFunction(res, 403, false, 'You are not authorized to view this employee\'s shifts.');
    }
    query = query.where({ employeeId: req.query.employeeId });
  } else if (scopedIds !== null) {
    query = query.where((qb) => qb.whereIn('employeeId', scopedIds).orWhereNull('employeeId'));
  }

  const shifts = await query.orderBy('date', 'asc');
  const shiftEmpIds = [...new Set(shifts.map((s) => s.employeeId).filter(Boolean))];
  const shiftEmps = shiftEmpIds.length ? await knex('employees').whereIn('id', shiftEmpIds).select('id', 'fullName', 'designation', 'department') : [];
  const shiftEmpMap = Object.fromEntries(shiftEmps.map((e) => [e.id, e]));
  const enriched = shifts.map((s) => ({ ...s, employee: s.employeeId ? (shiftEmpMap[s.employeeId] ?? null) : null }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// Free, no-API-key geocoding via OpenStreetMap's Nominatim — same service this app
// already uses for reverse-geocoding in ClockInContext.tsx. Best-effort only: a shift
// still saves fine with no coordinates if this fails or times out, it just won't show
// a map on that shift's detail view. A custom User-Agent is required by Nominatim's
// usage policy (unauthenticated requests without one get blocked).
const geocodeAddress = async (address) => {
  if (!address?.trim()) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { headers: { 'User-Agent': `${process.env.COMPANY_NAME || 'School ERP'} HR System` }, signal: controller.signal });
    clearTimeout(timeout);
    const results = await res.json();
    if (!results?.length) return null;
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch {
    return null;
  }
};

const createShift = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'date', 'startTime', 'endTime'])) return;

  const coords = await geocodeAddress(req.body.address);
  const employeeId = String(req.body.employeeId);
  const fields = {
    shiftType:  req.body.shiftType || 'custom',
    startTime:  req.body.startTime,
    endTime:    req.body.endTime,
    breakMinutes: Number(req.body.breakMinutes) || 0,
    location:   req.body.location || 'office',
    address:    req.body.address || null,
    addressLat: coords?.lat ?? null,
    addressLng: coords?.lng ?? null,
    notes:      req.body.notes || '',
    taskTemplateId: req.body.taskTemplateId ? String(req.body.taskTemplateId) : null,
    assignedBy: req.user.id,
    updatedAt:  new Date(),
  };

  const existing = await knex('shifts').where({ employeeId, date: req.body.date }).first();
  let saved;
  if (existing) {
    await knex('shifts').where({ id: existing.id }).update(fields);
    saved = { ...existing, ...fields };
  } else {
    saved = await insertOne('shifts', { id: newId(), employeeId, date: req.body.date, ...fields, createdAt: new Date() });
  }
  if (saved) await materializeShiftTasks(saved.id, saved.taskTemplateId);
  // Bug found in live verification: this used to omit the shift's own id from the
  // response entirely, so a caller could never learn the id of the shift it just
  // created/updated (needed immediately after for the task-checklist/notes routes,
  // which are keyed by :id). Restored from `saved`, matching every other create
  // endpoint in this file (e.g. createShiftTaskTemplate's `{ _id: result.id }`).
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id, _id: saved.id, employeeId, date: req.body.date, ...fields });
};

const updateShift = async (req, res) => {
  const update = { ...req.body };
  delete update._id;
  delete update.id;
  update.updatedAt = new Date();
  if (update.employeeId) update.employeeId = String(update.employeeId);
  if (update.taskTemplateId !== undefined) update.taskTemplateId = update.taskTemplateId ? String(update.taskTemplateId) : null;
  if (update.address !== undefined) {
    const existing = await knex('shifts').where({ id: req.params.id }).first();
    if (update.address?.trim() && update.address !== existing?.address) {
      const coords = await geocodeAddress(update.address);
      update.addressLat = coords?.lat ?? null;
      update.addressLng = coords?.lng ?? null;
    } else if (!update.address?.trim()) {
      update.addressLat = null;
      update.addressLng = null;
    }
  }
  await knex('shifts').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteShift = async (req, res) => {
  await knex('shifts').where({ id: req.params.id }).del();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Shift task checklists (field/client-visit shifts — see location: 'field'/'client site') ──
// A named, reusable checklist (e.g. "Site Opening Checklist") is defined once by HR, then
// materialized into a per-shift copy of tasks the moment a shift referencing it is
// created — so each shift instance tracks its own completion independently, and later
// edits to the template never retroactively change a shift that's already in progress.

const listShiftTaskTemplates = async (req, res) => {
  const templates = await knex('shift_task_templates').where({ isActive: true }).orderBy('name', 'asc');
  return returnFunction(res, 200, true, req.locale.success, templates);
};

const createShiftTaskTemplate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'tasks'])) return;
  if (!Array.isArray(req.body.tasks) || !req.body.tasks.filter(Boolean).length) {
    return returnFunction(res, 400, false, 'At least one task is required.');
  }
  const doc = {
    name: req.body.name.trim(),
    tasks: req.body.tasks.map((t) => String(t).trim()).filter(Boolean),
    isActive: true,
    createdBy: req.user.id,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('shift_task_templates', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const updateShiftTaskTemplate = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (Array.isArray(req.body.tasks)) update.tasks = req.body.tasks.map((t) => String(t).trim()).filter(Boolean);
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await knex('shift_task_templates').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteShiftTaskTemplate = async (req, res) => {
  await knex('shift_task_templates').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// Idempotent — only materializes once per shift, so re-saving/editing a shift that
// already has tasks (e.g. changing its time) never duplicates or resets progress.
const materializeShiftTasks = async (shiftId, taskTemplateId) => {
  if (!taskTemplateId) return;
  const existing = await knex('shift_tasks').where({ shiftId: String(shiftId) }).first();
  if (existing) return;
  const template = await knex('shift_task_templates').where({ id: String(taskTemplateId) }).first();
  if (!template?.tasks?.length) return;
  const now = new Date();
  const docs = template.tasks.map((title, i) => ({
    id: newId(), shiftId: String(shiftId), title, order: i,
    completed: false, completedAt: null, completedBy: null,
    createdAt: now,
  }));
  await knex('shift_tasks').insert(docs);
};

// Any real assigned party (the shift's own employee) or MGMT — never a stranger who
// just knows the shift id.
const canAccessShift = (shift, reqUser) => {
  if (['super_admin', 'hr_manager', 'department_head'].includes(reqUser.role)) return true;
  return !!reqUser.employeeId && shift.employeeId === String(reqUser.employeeId);
};

const getShiftTasks = async (req, res) => {
  const shift = await knex('shifts').where({ id: req.params.id }).first();
  if (!shift) return returnFunction(res, 404, false, req.locale.notFound);
  if (!canAccessShift(shift, req.user)) return returnFunction(res, 403, false, 'Not authorized.');
  const tasks = await knex('shift_tasks').where({ shiftId: shift.id }).orderBy('order', 'asc');
  return returnFunction(res, 200, true, req.locale.success, tasks);
};

const updateShiftTask = async (req, res) => {
  const shift = await knex('shifts').where({ id: req.params.id }).first();
  if (!shift) return returnFunction(res, 404, false, req.locale.notFound);
  if (!canAccessShift(shift, req.user)) return returnFunction(res, 403, false, 'Not authorized.');
  const completed = !!req.body.completed;
  await knex('shift_tasks').where({ id: req.params.taskId, shiftId: shift.id }).update({
    completed, completedAt: completed ? new Date() : null, completedBy: completed ? req.user.id : null,
  });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Shift notes (progress / incident) ─────────────────────────────────────────
// Incidents notify the manager and HR immediately — same urgency as a shift
// application — progress notes are just a log, no one needs paging for those.

const getShiftNotes = async (req, res) => {
  const shift = await knex('shifts').where({ id: req.params.id }).first();
  if (!shift) return returnFunction(res, 404, false, req.locale.notFound);
  if (!canAccessShift(shift, req.user)) return returnFunction(res, 403, false, 'Not authorized.');
  const notes = await knex('shift_notes').where({ shiftId: shift.id }).orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, notes);
};

const createShiftNote = async (req, res) => {
  if (!validateRequiredFields(req, res, ['type', 'text'])) return;
  if (!['progress', 'incident'].includes(req.body.type)) return returnFunction(res, 400, false, "type must be 'progress' or 'incident'.");
  const shift = await knex('shifts').where({ id: req.params.id }).first();
  if (!shift) return returnFunction(res, 404, false, req.locale.notFound);
  if (!canAccessShift(shift, req.user)) return returnFunction(res, 403, false, 'Not authorized.');

  const emp = req.user.employeeId ? await knex('employees').where({ id: String(req.user.employeeId) }).select('fullName').first() : null;
  const doc = {
    shiftId: shift.id,
    employeeId: shift.employeeId,
    authorName: emp?.fullName || req.user.name || 'Staff',
    type: req.body.type,
    text: req.body.text.trim(),
    createdAt: new Date(),
  };
  const result = await insertOne('shift_notes', doc);

  if (req.body.type === 'incident') {
    const inboxItem = {
      type: 'shift', subType: 'shift_incident',
      title: `Incident logged by ${doc.authorName}`,
      subtitle: `Shift ${shift.date} ${shift.startTime}–${shift.endTime}: ${doc.text.slice(0, 80)}`,
      referenceId: result.id, referenceModel: 'shift_notes',
      requiresAction: true, triggeredBy: req.user.id,
    };
    await notifyManager(shift.employeeId, inboxItem).catch(() => {});
    await notifyHR(inboxItem).catch(() => {});
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id, ...doc });
};

// Handover: the incoming employee on a shift needs to see what the PREVIOUS shift at the
// same place logged (an incident, an unfinished task, "pick up from here"), even though
// they weren't the author and canAccessShift would otherwise block them from that other
// shift's own notes. Match by address first (exact place), falling back to taskTemplateId
// (same recurring checklist/site) when no address was set on either shift.
const getShiftHandoverNotes = async (req, res) => {
  const shift = await knex('shifts').where({ id: req.params.id }).first();
  if (!shift) return returnFunction(res, 404, false, req.locale.notFound);
  if (!canAccessShift(shift, req.user)) return returnFunction(res, 403, false, 'Not authorized.');

  let matchQuery = knex('shifts').whereNot('id', shift.id).where('date', '<', shift.date);
  if (shift.address?.trim()) {
    matchQuery = matchQuery.where({ address: shift.address });
  } else if (shift.taskTemplateId) {
    matchQuery = matchQuery.where({ taskTemplateId: shift.taskTemplateId });
  } else {
    return returnFunction(res, 200, true, req.locale.success, { previousShift: null, notes: [] });
  }

  const previousShift = await matchQuery.orderBy('date', 'desc').first();
  if (!previousShift) return returnFunction(res, 200, true, req.locale.success, { previousShift: null, notes: [] });

  const [notes, prevEmp] = await Promise.all([
    knex('shift_notes').where({ shiftId: previousShift.id }).orderBy('createdAt', 'desc'),
    previousShift.employeeId ? knex('employees').where({ id: previousShift.employeeId }).select('fullName').first() : null,
  ]);

  return returnFunction(res, 200, true, req.locale.success, {
    previousShift: { _id: previousShift.id, date: previousShift.date, employeeName: prevEmp?.fullName || 'A previous staff member' },
    notes,
  });
};

// ── Attendance report (monthly grid) ─────────────────────────────────────────

const getAttendanceReport = async (req, res) => {
  const month = String(req.query.month || (new Date().getMonth() + 1)).padStart(2, '0');
  const year  = req.query.year || new Date().getFullYear();
  const from  = `${year}-${month}-01`;
  const to    = `${year}-${month}-31`;

  let recordQuery = knex('attendance_records').where('date', '>=', from).where('date', '<=', to);
  if (req.query.department) {
    const empIds = (await knex('employees').where({ department: req.query.department }).select('id')).map((e) => e.id);
    recordQuery = recordQuery.whereIn('employeeId', empIds);
  }

  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.length) {
    return returnFunction(res, 200, true, req.locale.success, { report: [], month: Number(month), year: Number(year) });
  }
  // A caller-supplied ?employeeId= is validated against scope below via employeeFilter
  // (the returned `report` is built by mapping over that scoped employee list, so a
  // record fetched for an out-of-scope id would never actually surface) — but keep
  // the record query itself scoped too, for defense in depth and clarity.
  if (req.query.employeeId) {
    if (scopedIds !== null && !scopedIds.includes(req.query.employeeId)) {
      return returnFunction(res, 403, false, 'You are not authorized to view this employee\'s attendance.');
    }
    recordQuery = recordQuery.where({ employeeId: req.query.employeeId });
  } else if (scopedIds !== null) {
    recordQuery = recordQuery.whereIn('employeeId', scopedIds);
  }

  let employeeQuery = knex('employees').where({ status: 'active' });
  if (scopedIds !== null) employeeQuery = employeeQuery.whereIn('id', scopedIds);
  if (req.query.employeeId) employeeQuery = knex('employees').where({ id: req.query.employeeId });

  const records = await recordQuery.orderBy('date', 'asc');

  const byEmp = {};
  for (const r of records) {
    if (!byEmp[r.employeeId]) byEmp[r.employeeId] = { employeeId: r.employeeId, days: {} };
    byEmp[r.employeeId].days[r.date] = r;
  }

  const employees = await employeeQuery.select('id', 'fullName', 'staffNumber', 'department');

  const report = employees.map((emp) => ({
    employee: emp,
    days: byEmp[emp.id]?.days || {},
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

  let empQuery = knex('employees');
  if (scopedIds !== null) empQuery = empQuery.whereIn('id', scopedIds);
  if (req.query.department) empQuery = empQuery.where({ department: req.query.department });
  const employees = await empQuery.select('id', 'fullName', 'staffNumber', 'department');
  const empIds = employees.map((e) => e.id);

  const records = empIds.length
    ? await knex('attendance_records').where('date', '>=', `${year}-${m}-01`).where('date', '<=', `${year}-${m}-31`).whereIn('employeeId', empIds)
    : [];

  const grouped = {};
  for (const r of records) {
    if (!grouped[r.employeeId]) grouped[r.employeeId] = [];
    grouped[r.employeeId].push(r);
  }

  const toMins = (t) => { const [h, mi] = String(t).split(':').map(Number); return h * 60 + mi; };
  const rows = employees.map((emp) => {
    const recs = grouped[emp.id] || [];
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
  let baseQuery = knex('attendance_records').where('date', '>=', from).where('date', '<=', to);
  if (scopedIds !== null) baseQuery = baseQuery.whereIn('employeeId', scopedIds);

  const [present, late, absent, total] = await Promise.all([
    baseQuery.clone().where({ status: 'present' }).count('* as count').first().then((r) => Number(r.count)),
    baseQuery.clone().where({ status: 'late' }).count('* as count').first().then((r) => Number(r.count)),
    baseQuery.clone().where({ status: 'absent' }).count('* as count').first().then((r) => Number(r.count)),
    baseQuery.clone().count('* as count').first().then((r) => Number(r.count)),
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
  const row = await knex('attendance_settings').where({ id: 'singleton' }).first();
  return returnFunction(res, 200, true, req.locale.success, row?.data || {});
};

const saveSettings = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  const existing = await knex('attendance_settings').where({ id: 'singleton' }).first();
  const merged = { ...(existing?.data || {}), ...update };
  if (existing) {
    await knex('attendance_settings').where({ id: 'singleton' }).update({ data: JSON.stringify(merged), updatedAt: new Date() });
  } else {
    await insertOne('attendance_settings', { id: 'singleton', data: JSON.stringify(merged), createdAt: new Date(), updatedAt: new Date() });
  }
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const getSchedules = async (req, res) => {
  const schedules = await knex('work_schedules').orderBy('createdAt', 'desc');
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
    createdBy:    req.user.id,
    createdAt:    new Date(),
  };
  const result = await insertOne('work_schedules', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const updateSchedule = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  delete update.id;
  await knex('work_schedules').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteSchedule = async (req, res) => {
  await knex('work_schedules').where({ id: req.params.id }).del();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── employeeShiftAssignments — links a named work_schedules template to an employee ──
// The per-date `shifts` collection remains the source of truth when a specific shift
// exists for that day (ad-hoc scheduling, the open-shift marketplace); this assignment
// is the fallback "what's their normal schedule" used by clockOut's overtime split and
// markLateArrivals when no such per-date shift is set.

const assignSchedule = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'scheduleId', 'effectiveFrom'])) return;
  const employeeId = String(req.body.employeeId);
  const scheduleId = String(req.body.scheduleId);
  const effectiveFrom = new Date(req.body.effectiveFrom);

  const schedule = await knex('work_schedules').where({ id: scheduleId }).first();
  if (!schedule) return returnFunction(res, 404, false, 'Work schedule not found.');

  // Close out any currently-open assignment for this employee as of the day before the new one starts
  const dayBefore = new Date(effectiveFrom.getTime() - 24 * 60 * 60 * 1000);
  await knex('employeeShiftAssignments').where({ employeeId }).whereNull('effectiveTo')
    .update({ effectiveTo: dayBefore, updatedAt: new Date() });

  const doc = {
    employeeId,
    scheduleId,
    effectiveFrom,
    effectiveTo: req.body.effectiveTo ? new Date(req.body.effectiveTo) : null,
    assignedBy: req.user.id,
    createdAt: new Date(),
  };
  const result = await insertOne('employeeShiftAssignments', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id, ...doc });
};

const getEmployeeScheduleAssignment = async (req, res) => {
  const employeeId = req.params.employeeId;
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.includes(employeeId)) {
    return returnFunction(res, 403, false, 'You are not authorized to view this employee\'s schedule.');
  }
  const now = new Date();
  const assignment = await knex('employeeShiftAssignments')
    .where({ employeeId }).where('effectiveFrom', '<=', now)
    .where((qb) => qb.whereNull('effectiveTo').orWhere('effectiveTo', '>=', now))
    .orderBy('effectiveFrom', 'desc').first();
  if (!assignment) return returnFunction(res, 200, true, req.locale.success, null);
  const schedule = await knex('work_schedules').where({ id: assignment.scheduleId }).first();
  return returnFunction(res, 200, true, req.locale.success, { ...assignment, schedule: schedule || null });
};

// Shared by clockOut's overtime split and markLateArrivals — resolves what an employee's
// "normal" schedule is on a given date via their current employeeShiftAssignments link.
async function getEffectiveScheduleForEmployee(employeeId, dateStr) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  const assignment = await knex('employeeShiftAssignments')
    .where({ employeeId: String(employeeId) }).where('effectiveFrom', '<=', date)
    .where((qb) => qb.whereNull('effectiveTo').orWhere('effectiveTo', '>=', date))
    .orderBy('effectiveFrom', 'desc').first();
  if (!assignment) return null;
  return knex('work_schedules').where({ id: assignment.scheduleId }).first();
}

const bulkCreateShifts = async (req, res) => {
  const { employeeIds, dates, shiftType, startTime, endTime, breakMinutes, location, address, notes, isOpen, taskTemplateId } = req.body;
  const open = isOpen === true || isOpen === 'true';
  if (!open && (!Array.isArray(employeeIds) || employeeIds.length === 0)) return returnFunction(res, 400, false, 'No employees selected.');
  if (!Array.isArray(dates) || dates.length === 0) return returnFunction(res, 400, false, 'No dates selected.');

  const coords = await geocodeAddress(address);
  const shiftBase = {
    shiftType:    shiftType || 'full_day',
    startTime:    startTime || '08:00',
    endTime:      endTime   || '17:00',
    breakMinutes: Number(breakMinutes) || 60,
    location:     location || 'office',
    address:      address || null,
    addressLat:   coords?.lat ?? null,
    addressLng:   coords?.lng ?? null,
    notes:        notes || '',
    taskTemplateId: taskTemplateId ? String(taskTemplateId) : null,
    createdBy:    req.user.id,
    createdAt:    new Date(),
  };

  const docs = [];
  if (open) {
    for (const date of dates) {
      docs.push({ id: newId(), ...shiftBase, employeeId: null, isOpen: true, date });
    }
  } else {
    for (const empId of employeeIds) {
      for (const date of dates) {
        docs.push({ id: newId(), ...shiftBase, employeeId: String(empId), isOpen: false, date });
      }
    }
  }
  await knex('shifts').insert(docs);
  if (taskTemplateId) {
    await Promise.all(docs.map((d) => materializeShiftTasks(d.id, taskTemplateId)));
  }
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { count: docs.length });
};

// ── Open shifts & applications ────────────────────────────────────────────────

const getMyShifts = async (req, res) => {
  const empId = req.user.employeeId;
  if (!empId) return returnFunction(res, 400, false, 'No employee profile linked.');
  const today = new Date().toISOString().split('T')[0];
  const shifts = await knex('shifts').where({ employeeId: String(empId) }).where('date', '>=', today).orderBy('date', 'asc').limit(30);
  return returnFunction(res, 200, true, req.locale.success, shifts);
};

const getOpenShifts = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const shifts = await knex('shifts').where({ isOpen: true }).whereNull('employeeId').where('date', '>=', today).orderBy('date', 'asc');
  return returnFunction(res, 200, true, req.locale.success, shifts);
};

const applyForShift = async (req, res) => {
  const empId = req.user.employeeId;
  if (!empId) return returnFunction(res, 400, false, 'No employee profile linked.');
  const shift = await knex('shifts').where({ id: req.params.id }).first();
  if (!shift) return returnFunction(res, 404, false, 'Shift not found.');
  if (!shift.isOpen) return returnFunction(res, 400, false, 'This shift is not open for applications.');
  const existing = await knex('shift_applications').where({ shiftId: req.params.id, employeeId: String(empId) }).first();
  if (existing) return returnFunction(res, 409, false, 'You have already applied for this shift.');
  const emp = await knex('employees').where({ id: String(empId) }).first();
  const result = await insertOne('shift_applications', {
    shiftId:      req.params.id,
    employeeId:   String(empId),
    employeeName: emp?.fullName || '',
    status:       'pending',
    note:         req.body.note || '',
    createdAt:    new Date(),
  });

  const inboxItem = {
    type: 'shift', subType: 'shift_application',
    title: `Shift application from ${emp?.fullName || 'An employee'}`,
    subtitle: `Shift ${shift.date || ''} ${shift.startTime || ''}–${shift.endTime || ''}`.trim(),
    referenceId: result.id, referenceModel: 'shift_applications',
    requiresAction: true, triggeredBy: req.user.id,
  };
  await notifyManager(empId, inboxItem);
  await notifyHR(inboxItem);

  return returnFunction(res, 201, true, 'Application submitted successfully.');
};

const getShiftApplications = async (req, res) => {
  let query = knex('shift_applications');
  if (req.query.shiftId) query = query.where({ shiftId: req.query.shiftId });
  if (req.query.status)  query = query.where({ status: req.query.status });
  const apps = await query.orderBy('createdAt', 'desc');
  const shiftIds = [...new Set(apps.map((a) => a.shiftId))];
  const shifts   = shiftIds.length ? await knex('shifts').whereIn('id', shiftIds) : [];
  const shiftMap = Object.fromEntries(shifts.map((s) => [s.id, s]));
  return returnFunction(res, 200, true, req.locale.success, apps.map((a) => ({ ...a, shift: shiftMap[a.shiftId] ?? null })));
};

const resolveShiftApplication = async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) return returnFunction(res, 400, false, 'Invalid status.');
  const app = await knex('shift_applications').where({ id: req.params.id }).first();
  if (!app) return returnFunction(res, 404, false, 'Application not found.');
  await knex('shift_applications').where({ id: req.params.id }).update({ status, resolvedAt: new Date(), resolvedBy: req.user.id });
  if (status === 'approved') {
    await knex('shifts').where({ id: app.shiftId }).update({ employeeId: app.employeeId, isOpen: false });
    await knex('shift_applications').where({ shiftId: app.shiftId }).whereNot('id', req.params.id)
      .update({ status: 'rejected', resolvedAt: new Date() });
  }

  notifyEmployee(app.employeeId, {
    title: `Shift application ${status}`,
    body: status === 'approved' ? 'Your shift application was approved.' : 'Your shift application was not approved.',
    type: 'general',
  }).catch(() => {});

  {
    const [empUser, emp] = await Promise.all([
      knex('users').where({ employeeId: app.employeeId }).select('email').first(),
      knex('employees').where({ id: app.employeeId }).select('fullName').first(),
    ]);
    if (empUser?.email) {
      const tokens = { employeeName: emp?.fullName || 'there', status };
      sendTemplatedEmail({
        trigger: 'shiftApplicationResolved', to: empUser.email, tokens,
        fallbackSubject: `Shift application ${status}`,
        fallbackHtml: `<p>Dear ${tokens.employeeName},</p><p>${status === 'approved' ? 'Your shift application was approved.' : 'Your shift application was not approved.'}</p>`,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, status === 'approved' ? 'Application approved.' : 'Application rejected.');
};

const getMyShiftApplications = async (req, res) => {
  const empId = req.user.employeeId;
  if (!empId) return returnFunction(res, 400, false, 'No employee profile linked.');
  const apps = await knex('shift_applications').where({ employeeId: String(empId) }).orderBy('createdAt', 'desc');
  const shiftIds = [...new Set(apps.map((a) => a.shiftId))];
  const shifts   = shiftIds.length ? await knex('shifts').whereIn('id', shiftIds) : [];
  const shiftMap = Object.fromEntries(shifts.map((s) => [s.id, s]));
  return returnFunction(res, 200, true, req.locale.success, apps.map((a) => ({ ...a, shift: shiftMap[a.shiftId] ?? null })));
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

  let empQuery = knex('employees').where({ status: 'active' });
  if (scopedIds !== null) empQuery = empQuery.whereIn('id', scopedIds);
  const employees = await empQuery.select('id');
  const empIds = employees.map((e) => e.id);

  const byStatus = empIds.length
    ? await knex('attendance_records').where({ date: today }).whereIn('employeeId', empIds).select('status').count('* as count').groupBy('status')
    : [];
  const statusMap = Object.fromEntries(byStatus.map((s) => [s.status, Number(s.count)]));

  const recordedCount = empIds.length
    ? await knex('attendance_records').where({ date: today }).whereIn('employeeId', empIds).count('* as count').first().then((r) => Number(r.count))
    : 0;

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

  let empQuery = knex('employees').where({ status: 'active' });
  if (scopedIds !== null) empQuery = empQuery.whereIn('id', scopedIds);
  const employees = await empQuery.select('id', 'fullName', 'department');
  const empMap = Object.fromEntries(employees.map((e) => [e.id, e]));

  const records = employees.length
    ? await knex('attendance_records').where('date', '>=', from).where('date', '<=', to).whereIn('employeeId', employees.map((e) => e.id))
    : [];

  const groups = {};
  for (const r of records) {
    const emp = empMap[r.employeeId];
    if (!emp) continue;
    const key = groupBy === 'department' ? (emp.department || 'Unassigned') : r.employeeId;
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

  let empQuery = knex('employees');
  if (scopedIds !== null) empQuery = empQuery.whereIn('id', scopedIds);
  const employees = await empQuery.select('id', 'fullName', 'department');
  const empMap = Object.fromEntries(employees.map((e) => [e.id, e]));

  const records = employees.length
    ? await knex('attendance_records').where('date', '>=', from).where('date', '<=', to).whereIn('employeeId', employees.map((e) => e.id)).where('overtimeMinutes', '>', 0)
    : [];

  const groups = {};
  for (const r of records) {
    const emp = empMap[r.employeeId];
    if (!emp) continue;
    const key = groupBy === 'department' ? (emp.department || 'Unassigned') : r.employeeId;
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

  let empQuery = knex('employees').where({ status: 'active' });
  if (scopedIds !== null) empQuery = empQuery.whereIn('id', scopedIds);
  const employees = await empQuery.select('id', 'fullName', 'department');
  const empMap = Object.fromEntries(employees.map((e) => [e.id, e]));

  const lateRecords = employees.length
    ? await knex('attendance_records').where('date', '>=', from).where('date', '<=', to).where({ status: 'late' }).whereIn('employeeId', employees.map((e) => e.id))
    : [];

  const byDay = {};
  const byEmployee = {};
  for (const r of lateRecords) {
    byDay[r.date] = (byDay[r.date] || 0) + 1;
    byEmployee[r.employeeId] = (byEmployee[r.employeeId] || 0) + 1;
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

  let empQuery = knex('employees').where({ status: 'active' });
  if (scopedIds !== null) empQuery = empQuery.whereIn('id', scopedIds);
  const employees = await empQuery.select('id', 'department');
  const empMap = Object.fromEntries(employees.map((e) => [e.id, e]));

  const records = employees.length
    ? await knex('attendance_records').where('date', '>=', from).where('date', '<=', to)
        .whereIn('employeeId', employees.map((e) => e.id)).whereIn('status', ['present', 'late', 'absent', 'half_day'])
    : [];

  const groups = {};
  for (const r of records) {
    const emp = empMap[r.employeeId];
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
  listShiftTaskTemplates, createShiftTaskTemplate, updateShiftTaskTemplate, deleteShiftTaskTemplate,
  getShiftTasks, updateShiftTask,
  getShiftNotes, createShiftNote, getShiftHandoverNotes,
};
