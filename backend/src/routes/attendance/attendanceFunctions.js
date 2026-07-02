const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { parseAttendanceCSV } = require('../../services/csvService');
const { notifyManager } = require('../inbox/inboxFunctions');

// ── Existing helpers ──────────────────────────────────────────────────────────

const listAttendance = async (req, res) => {
  const filter = {};
  const { month, year, employeeId, department } = req.query;
  if (employeeId) filter.employeeId = new ObjectId(employeeId);
  if (month && year) {
    const m = String(month).padStart(2, '0');
    filter.date = { $gte: `${year}-${m}-01`, $lte: `${year}-${m}-31` };
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
  const doc = {
    employeeId: new ObjectId(req.body.employeeId),
    date: req.body.date,
    status: req.body.status,
    checkInTime: req.body.checkInTime || null,
    checkOutTime: req.body.checkOutTime || null,
    notes: req.body.notes || null,
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
  const recentRecords = await global.dbo.collection('attendance_records')
    .find({ status: 'absent' })
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

  if (holiday) {
    payCategory = 'holiday';
  } else if (todayShift) {
    const scheduledMins = toMins(todayShift.endTime) - toMins(todayShift.startTime) - (todayShift.breakMinutes || 0);
    if (workMins > scheduledMins && attSettings?.overtimeEnabled !== false) {
      const maxOvertimeMins = (attSettings?.maxOvertimeHours || 3) * 60;
      overtimeMinutes = Math.min(workMins - scheduledMins, maxOvertimeMins);
      regularMinutes  = workMins - overtimeMinutes;
      payCategory     = 'overtime';
    }
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
  const records = await global.dbo.collection('attendance_records')
    .find({ date: today })
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

  const allEmployees = await findMany('employees', { status: 'active' }, { projection: { _id: 1, fullName: 1, designation: 1, department: 1 } });
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
  if (req.query.employeeId) filter.employeeId = new ObjectId(req.query.employeeId);
  if (req.query.weekStart) filter.weekStart = new Date(req.query.weekStart);

  if (req.user.role === 'staff') {
    const emp = await findOne('employees', { userId: new ObjectId(req.user._id) }, { projection: { _id: 1 } });
    if (emp) filter.employeeId = emp._id;
  }

  const sheets = await findMany('timesheets', filter, { sort: { weekStart: -1 }, limit: 20 });
  return returnFunction(res, 200, true, req.locale.success, sheets);
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

    const totalMinutes = entries.reduce((s, e) => s + e.totalMinutes, 0);

    const doc = {
      employeeId: empId,
      weekStart:  monday,
      weekEnd:    sunday,
      entries,
      totalMinutes,
      overtimeMinutes: Math.max(0, totalMinutes - 2400),
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
  const totalMinutes = entries.reduce((s, e) => s + (e.totalMinutes || 0), 0);

  await global.dbo.collection('timesheets').updateOne(
    { employeeId: empId, weekStart },
    { $set: {
      entries,
      totalMinutes,
      overtimeMinutes: Math.max(0, totalMinutes - 2400),
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
  await updateOne('timesheets', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'approved', approvedBy: new ObjectId(req.user._id), approvedAt: new Date(), updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Timesheet approved.');
};

const rejectTimesheet = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  await updateOne('timesheets', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'rejected', rejectionReason: req.body.reason, updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Timesheet rejected.');
};

// ── Shifts ────────────────────────────────────────────────────────────────────

const getShifts = async (req, res) => {
  const filter = {};
  if (req.query.employeeId) filter.employeeId = new ObjectId(req.query.employeeId);
  if (req.query.startDate && req.query.endDate) {
    filter.date = { $gte: req.query.startDate, $lte: req.query.endDate };
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
  if (req.query.employeeId) filter.employeeId = new ObjectId(req.query.employeeId);

  const records = await global.dbo.collection('attendance_records').find(filter).sort({ date: 1 }).toArray();

  const byEmp = {};
  for (const r of records) {
    const k = String(r.employeeId);
    if (!byEmp[k]) byEmp[k] = { employeeId: r.employeeId, days: {} };
    byEmp[k].days[r.date] = r;
  }

  const employees = await findMany('employees', { status: 'active' }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });

  const report = employees.map(emp => ({
    employee: emp,
    days: byEmp[String(emp._id)]?.days || {},
  }));

  return returnFunction(res, 200, true, req.locale.success, { report, month: Number(month), year: Number(year) });
};

const getAttendanceStats = async (req, res) => {
  const month = String(req.query.month || (new Date().getMonth() + 1)).padStart(2, '0');
  const year  = req.query.year || new Date().getFullYear();
  const from  = `${year}-${month}-01`;
  const to    = `${year}-${month}-31`;

  const [present, late, absent, total] = await Promise.all([
    global.dbo.collection('attendance_records').countDocuments({ date: { $gte: from, $lte: to }, status: 'present' }),
    global.dbo.collection('attendance_records').countDocuments({ date: { $gte: from, $lte: to }, status: 'late' }),
    global.dbo.collection('attendance_records').countDocuments({ date: { $gte: from, $lte: to }, status: 'absent' }),
    global.dbo.collection('attendance_records').countDocuments({ date: { $gte: from, $lte: to } }),
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
};
