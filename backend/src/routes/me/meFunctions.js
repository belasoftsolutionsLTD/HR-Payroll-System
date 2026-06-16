const fs   = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, updateOne, insertOne } = require('../../functions/Database/commonDBFunctions');
const { calculateWorkingDays } = require('../../functions/HR/leaveCalculator');

// ── Profile ────────────────────────────────────────────────────────────────────
const getMyProfile = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account. Contact HR.');
  const employee = await findOne('employees', { _id: req.user.employeeId });
  if (!employee) return returnFunction(res, 404, false, 'Employee record not found.');
  return returnFunction(res, 200, true, 'OK', employee);
};

const updateMyProfile = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  const ALLOWED = ['phone', 'email', 'nextOfKin', 'bankName', 'bankAccountNumber', 'mpesaNumber'];
  const patch = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (!Object.keys(patch).length) return returnFunction(res, 400, false, 'No updatable fields provided.');
  patch.updatedAt = new Date();
  await updateOne('employees', { _id: req.user.employeeId }, { $set: patch });
  // Also sync email on the user account if changed
  if (patch.email) {
    await updateOne('users', { _id: req.user._id }, { $set: { email: patch.email } });
  }
  return returnFunction(res, 200, true, 'Profile updated.');
};

// ── Leave ──────────────────────────────────────────────────────────────────────
const getMyLeaveBalance = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const balance = await findOne('leave_balances', { employeeId: req.user.employeeId, year });
  if (!balance) return returnFunction(res, 404, false, 'No leave balance for this year.');
  return returnFunction(res, 200, true, 'OK', balance);
};

const getMyLeaveRequests = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  const filter = { employeeId: req.user.employeeId };
  if (req.query.status) filter.status = req.query.status;
  const requests = await findMany('leave_requests', filter, { sort: { createdAt: -1 }, limit: 50 });
  return returnFunction(res, 200, true, 'OK', requests);
};

const applyForLeave = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee record linked to your account. Contact HR.');
  if (!validateRequiredFields(req, res, ['leaveType', 'startDate', 'endDate', 'reason'])) return;

  const { leaveType, startDate, endDate, reason } = req.body;
  const year = new Date(startDate).getFullYear();
  const numberOfDays = calculateWorkingDays(startDate, endDate);

  const balance = await findOne('leave_balances', { employeeId: req.user.employeeId, year });
  if (!balance) return returnFunction(res, 400, false, 'No leave balance record found for this year.');

  const typeBalance = balance.balances[leaveType];
  if (!typeBalance) return returnFunction(res, 400, false, 'Invalid leave type.');
  if (typeBalance.remaining !== null && typeBalance.remaining < numberOfDays) {
    return returnFunction(res, 400, false, `Insufficient ${leaveType} leave. Available: ${typeBalance.remaining} days, Requested: ${numberOfDays} days.`);
  }

  const doc = {
    employeeId: req.user.employeeId,
    leaveType,
    startDate,
    endDate,
    numberOfDays,
    reason,
    status: 'pending',
    approvedBy: null,
    approvedAt: null,
    comments: null,
    createdAt: new Date(),
  };
  const result = await insertOne('leave_requests', doc);
  return returnFunction(res, 201, true, 'Leave request submitted.', { _id: result.insertedId, numberOfDays });
};

const disputeLeaveRequest = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  const { reason } = req.body;
  if (!reason?.trim()) return returnFunction(res, 400, false, 'A dispute reason is required.');

  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, 'Leave request not found.');
  if (String(request.employeeId) !== String(req.user.employeeId))
    return returnFunction(res, 403, false, 'This is not your leave request.');
  if (request.status !== 'rejected')
    return returnFunction(res, 400, false, 'Only rejected requests can be disputed.');

  await updateOne('leave_requests', { _id: request._id }, {
    $set: { status: 'disputed', disputeReason: reason.trim(), disputedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Leave dispute submitted. HR will review your case.');
};

// ── Payslips ───────────────────────────────────────────────────────────────────
const getMyPayslips = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  const records = await findMany('payroll_summaries', { employeeId: req.user.employeeId }, { sort: { year: -1, month: -1 } });
  return returnFunction(res, 200, true, 'OK', records);
};

// ── Attendance ─────────────────────────────────────────────────────────────────
const getMyAttendance = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');

  const filter = { employeeId: req.user.employeeId };
  if (req.query.month && req.query.year) {
    const m = String(req.query.month).padStart(2, '0');
    filter.date = { $gte: `${req.query.year}-${m}-01`, $lte: `${req.query.year}-${m}-31` };
  }

  const records = await global.dbo.collection('attendance_records')
    .find(filter).sort({ date: -1 }).limit(90).toArray();

  return returnFunction(res, 200, true, 'OK', [{ employeeId: req.user.employeeId, records }]);
};

// ── Onboarding tasks ───────────────────────────────────────────────────────────
const getMyOnboardingTasks = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  const tasks = await findMany('onboarding_tasks', { employeeId: req.user.employeeId }, { sort: { status: 1, dueDate: 1 } });
  return returnFunction(res, 200, true, 'OK', tasks);
};

// ── Leave PDF ──────────────────────────────────────────────────────────────────
const downloadLeavePdf = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, 'Leave request not found.');
  if (String(request.employeeId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'Access denied.');
  }
  const employee = await findOne('employees', { _id: req.user.employeeId }, { projection: { fullName: 1, staffNumber: 1, designation: 1, department: 1 } });

  const PDFDocument = require('pdfkit');
  const companyName = process.env.COMPANY_NAME || 'School ERP';
  const fmt = (d) => d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', disputed: 'Disputed', partial: 'Partially Approved' };

  const pdfBuffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60 });
    const buffers = [];
    doc.on('data', (c) => buffers.push(c));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').text(companyName, { align: 'center' });
    doc.fontSize(12).font('Helvetica').text('LEAVE APPLICATION RECORD', { align: 'center' });
    doc.moveDown(1);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke().moveDown(0.5);

    const row = (label, value) => {
      doc.font('Helvetica-Bold').text(label + ':', { continued: true, width: 180 });
      doc.font('Helvetica').text('  ' + (value || '—'));
    };

    row('Employee Name',  employee?.fullName);
    row('Staff Number',   employee?.staffNumber);
    row('Department',     employee?.department);
    row('Designation',    employee?.designation);
    doc.moveDown(0.5);
    row('Leave Type',     request.leaveType ? request.leaveType.charAt(0).toUpperCase() + request.leaveType.slice(1) : '—');
    row('Start Date',     fmt(request.startDate));
    row('End Date',       fmt(request.endDate));
    row('Number of Days', String(request.numberOfDays || '—'));
    row('Status',         STATUS_LABEL[request.status] || request.status);
    if (request.approvedDays) row('Approved Days', String(request.approvedDays));
    row('Reason',         request.reason);
    if (request.comments) row('HR Comments',  request.comments);
    doc.moveDown(1);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke().moveDown(0.5);
    doc.fontSize(8).fillColor('grey').text('Generated on ' + new Date().toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' }), { align: 'right' });
    doc.end();
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="leave-${request._id}.pdf"`);
  res.send(pdfBuffer);
};

// ── Documents ──────────────────────────────────────────────────────────────────
const getMyDocuments = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  const employee = await findOne('employees', { _id: req.user.employeeId }, { projection: { documents: 1 } });
  return returnFunction(res, 200, true, 'OK', employee?.documents ?? []);
};

const uploadMyDocument = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  if (!req.file) return returnFunction(res, 400, false, 'No file uploaded.');
  if (!req.body.docType) return returnFunction(res, 400, false, 'Document type is required.');
  const doc = {
    docId: new ObjectId(),
    docType: req.body.docType,
    fileName: req.file.originalname,
    filePath: req.file.path,
    uploadedAt: new Date(),
  };
  await updateOne('employees', { _id: req.user.employeeId }, { $push: { documents: doc } });
  return returnFunction(res, 200, true, 'Document uploaded.', doc);
};

const downloadMyDocument = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  const fs = require('fs');
  const employee = await findOne('employees', { _id: req.user.employeeId });
  if (!employee) return returnFunction(res, 404, false, 'Not found.');
  const doc = (employee.documents || []).find(d => String(d.docId) === req.params.docId);
  if (!doc) return returnFunction(res, 404, false, 'Document not found.');
  if (!fs.existsSync(doc.filePath)) return returnFunction(res, 404, false, 'File not found on server.');
  res.download(doc.filePath, doc.fileName);
};

const deleteMyDocument = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  await global.dbo.collection('employees').updateOne(
    { _id: req.user.employeeId },
    { $pull: { documents: { docId: new ObjectId(req.params.docId) } } }
  );
  return returnFunction(res, 200, true, 'Document removed.');
};

// ── Department Portal (department_head only) ────────────────────────────────────
const getDepartmentData = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked to your account.');

  const me = await findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1 } });
  if (!me?.department) return returnFunction(res, 400, false, 'No department set on your employee profile. Contact HR.');

  const dept = me.department;

  const employees = await findMany('employees',
    { department: dept, status: { $in: ['active', 'on_leave', 'suspended'] } },
    { projection: { fullName: 1, staffNumber: 1, designation: 1, status: 1, email: 1, phone: 1 }, sort: { fullName: 1 } }
  );

  const empIds = employees.map(e => e._id);

  // Pending leave requests
  const leaveRequests = await findMany('leave_requests',
    { employeeId: { $in: empIds }, status: 'pending' },
    { sort: { createdAt: -1 }, limit: 30 }
  );
  const enrichedLeave = leaveRequests.map(lr => {
    const emp = employees.find(e => String(e._id) === String(lr.employeeId));
    return { ...lr, employeeName: emp?.fullName || null };
  });

  // Today's attendance
  const today = new Date().toISOString().split('T')[0];
  const todayAttendance = await findMany('attendance_records', { employeeId: { $in: empIds }, date: today }, {});
  const present   = todayAttendance.filter(r => ['present', 'late'].includes(r.status)).length;
  const absent    = todayAttendance.filter(r => r.status === 'absent').length;
  const onLeave   = employees.filter(e => e.status === 'on_leave').length;

  return returnFunction(res, 200, true, 'OK', {
    department: dept,
    employees,
    pendingLeave: enrichedLeave,
    stats: { total: employees.length, present, absent, onLeave, notMarked: employees.length - todayAttendance.length },
  });
};

const deptActOnLeave = async (req, res) => {
  const { id } = req.params;
  const action = req.body.action; // 'approve' | 'reject'
  if (!['approve', 'reject'].includes(action)) return returnFunction(res, 400, false, 'Action must be approve or reject.');
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'No employee profile linked.');

  const me = await findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1 } });
  if (!me?.department) return returnFunction(res, 400, false, 'No department on your profile.');

  const lr = await findOne('leave_requests', { _id: new ObjectId(id) });
  if (!lr) return returnFunction(res, 404, false, 'Leave request not found.');

  const emp = await findOne('employees', { _id: lr.employeeId }, { projection: { department: 1 } });
  if (emp?.department !== me.department) return returnFunction(res, 403, false, 'This employee is not in your department.');
  if (lr.status !== 'pending') return returnFunction(res, 409, false, `Leave request is already ${lr.status}.`);

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  await global.dbo.collection('leave_requests').updateOne(
    { _id: lr._id },
    { $set: { status: newStatus, reviewedBy: new ObjectId(req.user._id), reviewedAt: new Date() } }
  );
  if (action === 'approve') {
    await global.dbo.collection('employees').updateOne({ _id: lr.employeeId }, { $set: { status: 'on_leave' } });
  }

  return returnFunction(res, 200, true, action === 'approve' ? 'Leave approved.' : 'Leave rejected.');
};

// ── Performance ────────────────────────────────────────────────────────────────
const getMyPerformance = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  const records = await findMany('appraisal_records',
    { employeeId: req.user.employeeId },
    { sort: { createdAt: -1 } }
  );
  return returnFunction(res, 200, true, 'OK', records);
};

// ── Awards ────────────────────────────────────────────────────────────────────
const getMyAwards = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'OK', []);
  const awards = await findMany('employee_awards',
    { employeeId: req.user.employeeId },
    { sort: { awardedAt: -1 } }
  );
  return returnFunction(res, 200, true, 'OK', awards);
};

// ── Upcoming Events (training & team building) ────────────────────────────────
const getMyEvents = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const emp   = req.user.employeeId
    ? await findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1 } })
    : null;

  const filter = {
    scheduledDate: { $gte: today },
    $or: [
      { audience: 'all' },
      { audience: 'department', department: emp?.department ?? '__none__' },
    ],
  };
  const events = await findMany('scheduled_events', filter, { sort: { scheduledDate: 1 }, limit: 20 });
  return returnFunction(res, 200, true, 'OK', events);
};

// ── Notification preference ────────────────────────────────────────────────────
const getNotificationPreference = async (req, res) => {
  const user = await findOne('users', { _id: req.user._id }, { projection: { notificationsEnabled: 1 } });
  return returnFunction(res, 200, true, 'OK', { notificationsEnabled: user?.notificationsEnabled !== false });
};

const toggleNotifications = async (req, res) => {
  const user = await findOne('users', { _id: req.user._id }, { projection: { notificationsEnabled: 1 } });
  const next = !(user?.notificationsEnabled !== false);
  await updateOne('users', { _id: req.user._id }, { $set: { notificationsEnabled: next } });
  return returnFunction(res, 200, true, 'OK', { notificationsEnabled: next });
};

const uploadMyProfilePhoto = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, 'No file uploaded.');
  const photoPath = req.file.filename;
  if (req.user.employeeId) {
    await updateOne('employees', { _id: req.user.employeeId }, { $set: { photoPath, updatedAt: new Date() } });
  }
  await updateOne('users', { _id: req.user._id }, { $set: { photoPath } });
  return returnFunction(res, 200, true, 'Photo updated.', { photoPath });
};

const serveMyProfilePhoto = async (req, res) => {
  const user = await findOne('users', { _id: req.user._id });
  const photoFile = user?.photoPath
    || (req.user.employeeId && (await findOne('employees', { _id: req.user.employeeId }))?.photoPath);
  if (!photoFile) return returnFunction(res, 404, false, 'No profile photo.');
  const filePath = path.resolve(process.env.UPLOAD_DIR || 'uploads', photoFile);
  if (!fs.existsSync(filePath)) return returnFunction(res, 404, false, 'Photo file not found.');
  const ext  = path.extname(filePath).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(filePath).pipe(res);
};

module.exports = {
  getMyProfile, updateMyProfile, uploadMyProfilePhoto, serveMyProfilePhoto,
  getMyLeaveBalance, getMyLeaveRequests, applyForLeave, disputeLeaveRequest, downloadLeavePdf,
  getMyPayslips, getMyAttendance, getMyOnboardingTasks,
  getMyDocuments, uploadMyDocument, downloadMyDocument, deleteMyDocument,
  getMyPerformance,
  getMyAwards, getMyEvents,
  getNotificationPreference, toggleNotifications,
  getDepartmentData, deptActOnLeave,
};
