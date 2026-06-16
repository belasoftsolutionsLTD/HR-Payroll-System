const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne } = require('../../functions/Database/commonDBFunctions');
const { parseAttendanceCSV } = require('../../services/csvService');

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

  // Group by employee
  const grouped = {};
  for (const rec of records) {
    const key = String(rec.employeeId);
    if (!grouped[key]) grouped[key] = { employeeId: rec.employeeId, records: [] };
    grouped[key].records.push(rec);
  }

  // Join employee name / staffNumber / department
  const enriched = await Promise.all(Object.values(grouped).map(async (g) => {
    const emp = await findOne('employees', { _id: g.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    return { ...g, employeeName: emp?.fullName || null, staffNumber: emp?.staffNumber || null, department: emp?.department || null };
  }));

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
      errors.push({ row: row, reason: `No employee found with staffNumber ${row.staffNumber}` });
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
      { $set: doc },
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
  // Find employees with 3+ consecutive absent days
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

  const alerts = [];
  for (const [empId, dates] of Object.entries(byEmployee)) {
    dates.sort();
    let streak = 1;
    let streakStart = dates[0];
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1]);
      const cur = new Date(dates[i]);
      const diff = (cur - prev) / (1000 * 60 * 60 * 24);
      if (diff === 1) {
        streak++;
        if (streak >= 3) {
          const emp = await findOne('employees', { _id: new ObjectId(empId) }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
          if (emp) alerts.push({ employee: emp, consecutiveAbsentDays: streak, from: streakStart, to: dates[i] });
          break;
        }
      } else {
        streak = 1;
        streakStart = dates[i];
      }
    }
  }

  return returnFunction(res, 200, true, req.locale.success, alerts);
};

// Haversine distance in metres between two lat/lng points
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Self clock-in (any authenticated employee) ────────────────────────────────
const clockIn = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked to your account.');
  const empId = req.user.employeeId;
  const today = new Date().toISOString().split('T')[0];

  const existing = await findOne('attendance_records', { employeeId: empId, date: today });
  if (existing?.checkInTime) return returnFunction(res, 409, false, 'You have already clocked in today.');

  // Location is required
  const latitude  = parseFloat(req.body.latitude);
  const longitude = parseFloat(req.body.longitude);
  if (isNaN(latitude) || isNaN(longitude)) {
    return returnFunction(res, 400, false, 'Location access is required to clock in. Please enable GPS and try again.');
  }

  // Geofence check — only when office coordinates are configured
  const settings = await findOne('company_settings', {});
  const officeLat    = parseFloat(settings?.officeLatitude);
  const officeLng    = parseFloat(settings?.officeLongitude);
  const radiusMeters = parseFloat(settings?.officeRadiusMeters) || 200;

  let mode = 'onsite';
  if (!isNaN(officeLat) && !isNaN(officeLng)) {
    const distanceM = Math.round(haversineMeters(latitude, longitude, officeLat, officeLng));
    if (distanceM > radiusMeters) {
      return returnFunction(
        res, 403, false,
        `You are ${distanceM}m from the office. You must be within ${radiusMeters}m to clock in.`,
        { distanceM, radiusMeters }
      );
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
    checkInLat:      latitude,
    checkInLng:      longitude,
    checkInLocation: req.body.locationName || null,
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

// ── Self clock-out ────────────────────────────────────────────────────────────
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

  await global.dbo.collection('attendance_records').updateOne(
    { employeeId: empId, date: today },
    { $set: {
      checkOutTime,
      checkOutLat:      isNaN(latitude)  ? null : latitude,
      checkOutLng:      isNaN(longitude) ? null : longitude,
      checkOutLocation: req.body.locationName || null,
      updatedAt:        now,
    }}
  );

  return returnFunction(res, 200, true, 'Clocked out successfully.', { checkOutTime });
};

// ── Get today's clock status for logged-in employee ───────────────────────────
const getTodayStatus = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, req.locale.success, null);
  const today = new Date().toISOString().split('T')[0];
  const record = await findOne('attendance_records', { employeeId: req.user.employeeId, date: today });
  return returnFunction(res, 200, true, req.locale.success, record || null);
};

// ── Get logged-in employee's own records (last N days) ───────────────────────
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

module.exports = { listAttendance, markAttendance, bulkImportAttendance, getAbsenceAlerts, clockIn, clockOut, getTodayStatus, getMyRecords };
