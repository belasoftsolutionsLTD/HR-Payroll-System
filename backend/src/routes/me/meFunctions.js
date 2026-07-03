const fs   = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, updateOne, insertOne } = require('../../functions/Database/commonDBFunctions');
const { calculateWorkingDays } = require('../../functions/HR/leaveCalculator');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR, notifyManager } = require('../inbox/inboxFunctions');

// ── Profile ────────────────────────────────────────────────────────────────────
const getMyProfile = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account. Contact HR.');
  const employee = await findOne('employees', { _id: req.user.employeeId });
  if (!employee) return returnFunction(res, 404, false, 'Employee record not found.');
  return returnFunction(res, 200, true, 'OK', employee);
};

const updateMyProfile = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  const ALLOWED = ['phone', 'email', 'nextOfKin', 'kraPin', 'bankName', 'bankAccountNumber', 'mpesaNumber', 'paymentMethod', 'paypalEmail', 'cryptoWalletAddress', 'cryptoNetwork'];
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
  if (new Date(endDate) < new Date(startDate)) {
    return returnFunction(res, 400, false, 'Invalid leave date range. End date must be on or after the start date.');
  }
  const year = new Date(startDate).getFullYear();
  const numberOfDays = calculateWorkingDays(startDate, endDate);
  if (numberOfDays < 1) return returnFunction(res, 400, false, 'Invalid leave time range.');

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

  // Notify HR and manager
  const emp = await findOne('employees', { _id: req.user.employeeId }, { projection: { fullName: 1, department: 1 } });
  const empName = emp?.fullName || 'An employee';
  const inboxPayload = {
    type: 'leave', subType: 'leave_request',
    title: `Leave request from ${empName}`,
    subtitle: `${leaveType} leave · ${startDate} – ${endDate} · ${numberOfDays} day${numberOfDays !== 1 ? 's' : ''}`,
    referenceId: result.insertedId, referenceModel: 'leave_requests',
    requiresAction: true, triggeredBy: req.user._id,
  };
  notifyHR(inboxPayload).catch(() => {});
  notifyManager(req.user.employeeId, inboxPayload).catch(() => {});
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: `Leave request from ${empName}`,
    body: `${leaveType} leave · ${startDate} – ${endDate}`,
    type: 'leave',
  }).catch(() => {});

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
  const empId = req.user.employeeId;

  const [appraisals, goals, rawReviews] = await Promise.all([
    findMany('appraisal_records', { employeeId: empId }, { sort: { createdAt: -1 } }),
    findMany('goals', { employeeId: empId }, { sort: { createdAt: -1 } }),
    findMany('reviews', { employeeId: empId, status: 'submitted' }, { sort: { submittedAt: -1 } }),
  ]);

  const reviews = await Promise.all(rawReviews.map(async r => {
    const cycle = r.cycleId
      ? await findOne('review_cycles', { _id: r.cycleId }, { projection: { name: 1, type: 1 } })
      : null;
    return { ...r, cycleName: cycle?.name ?? null };
  }));

  return returnFunction(res, 200, true, 'OK', { appraisals, goals, reviews });
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

// ── Offboarding (self-view) ────────────────────────────────────────────────────

const getMyOffboardingTasks = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'OK', []);
  const tasks = await findMany(
    'offboarding_tasks',
    { employeeId: new ObjectId(String(req.user.employeeId)) },
    { sort: { taskSection: 1, dueDate: 1 } }
  );
  return returnFunction(res, 200, true, 'OK', tasks);
};

const completeMyOffboardingTask = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 403, false, 'No employee record linked.');
  const task = await findOne('offboarding_tasks', { _id: new ObjectId(req.params.taskId) });
  if (!task) return returnFunction(res, 404, false, 'Task not found.');
  if (String(task.employeeId) !== String(req.user.employeeId))
    return returnFunction(res, 403, false, 'Not your task.');

  await updateOne(
    'offboarding_tasks',
    { _id: new ObjectId(req.params.taskId) },
    { $set: { status: 'completed', completedAt: new Date(), completedBy: new ObjectId(String(req.user._id)) } }
  );

  // Notify HR when all tasks belonging to this employee are done
  const remaining = await global.dbo.collection('offboarding_tasks').countDocuments({
    employeeId: task.employeeId,
    status: { $ne: 'completed' },
  });
  if (remaining === 0) {
    const employee = await findOne('employees', { _id: task.employeeId }, { projection: { fullName: 1 } });
    const hrManagers = await findMany('users', { role: { $in: ['hr_manager', 'super_admin'] } }, { projection: { _id: 1 } });
    if (employee) {
      notifyByRoles(['super_admin', 'hr_manager'], {
        title: 'Offboarding Complete',
        body: `All offboarding tasks for ${employee.fullName} have been completed.`,
        type: 'general',
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, 'Task marked complete.');
};

// ── My Projects ────────────────────────────────────────────────────────────────
const getMyProjects = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'OK', []);
  const empId = req.user.employeeId;

  const memberships = await findMany('project_members', { employeeId: empId });
  if (!memberships.length) return returnFunction(res, 200, true, 'OK', []);

  const projectIds = memberships.map(m => m.projectId);
  const projects = await findMany('projects', { _id: { $in: projectIds } }, { sort: { createdAt: -1 } });

  const enriched = await Promise.all(projects.map(async p => {
    const membership = memberships.find(m => String(m.projectId) === String(p._id));
    const [timeResult] = await global.dbo.collection('project_time_entries').aggregate([
      { $match: { projectId: p._id, employeeId: empId } },
      { $group: { _id: null, totalHours: { $sum: '$hours' } } },
    ]).toArray();
    const recentEntries = await findMany(
      'project_time_entries',
      { projectId: p._id, employeeId: empId },
      { sort: { date: -1 }, limit: 5 }
    );
    return {
      ...p,
      myRole:         membership?.role ?? 'member',
      myHours:        timeResult?.totalHours ?? 0,
      myRecentEntries: recentEntries,
    };
  }));

  return returnFunction(res, 200, true, 'OK', enriched);
};

// ── My Tasks ───────────────────────────────────────────────────────────────────
const getMyTasks = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'OK', []);
  const tasks = await findMany(
    'tasks',
    { assignedTo: req.user.employeeId },
    { sort: { dueDate: 1, createdAt: -1 }, limit: 100 }
  );
  return returnFunction(res, 200, true, 'OK', tasks);
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
  getMyOffboardingTasks, completeMyOffboardingTask,
  getMyTasks,
  getMyProjects,
};
