const fs   = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, updateOne, insertOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { sendTemplatedEmail } = require('../../lib/recruitment/emailTemplateHelpers');

const MAX_APPLICATIONS_PER_REQUISITION = 2;
const { notifyHR } = require('../inbox/inboxFunctions');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { getEmployeePayslipRecords } = require('../payroll/payrollPayslipsFunctions');

// Kenyan mobile format: 254 followed by 9 digits, Safaricom/Airtel/Telkom ranges start with 7 or 1.
const MPESA_NUMBER_REGEX = /^254(7|1)\d{8}$/;
const MPESA_NUMBER_ERROR = 'M-Pesa number must start with 254 and be a valid Kenyan mobile number (e.g. 254712345678).';

// ── Profile ────────────────────────────────────────────────────────────────────
const getMyProfile = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account. Contact HR.');
  const employee = await findOne('employees', { _id: req.user.employeeId });
  if (!employee) return returnFunction(res, 404, false, 'Employee record not found.');
  return returnFunction(res, 200, true, 'OK', employee);
};

const updateMyProfile = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  const ALLOWED = [
    'phone', 'email', 'nextOfKin', 'kraPin', 'bankName', 'bankAccountNumber', 'mpesaNumber', 'paymentMethod', 'paypalEmail', 'cryptoWalletAddress', 'cryptoNetwork',
    'preferredName', 'gender', 'maritalStatus', 'nationality', 'passportNumber', 'passportExpiryDate', 'address', 'emergencyContacts',
  ];
  const patch = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (!Object.keys(patch).length) return returnFunction(res, 400, false, 'No updatable fields provided.');
  if (patch.passportExpiryDate) patch.passportExpiryDate = new Date(patch.passportExpiryDate);
  if (Array.isArray(patch.emergencyContacts)) {
    patch.emergencyContacts = patch.emergencyContacts.map(c => ({
      id: c.id || new ObjectId().toString(),
      name: c.name, relationship: c.relationship || null, phone: c.phone, email: c.email || null,
    }));
  }
  const effectivePaymentMethod = patch.paymentMethod ?? (await findOne('employees', { _id: req.user.employeeId }, { projection: { paymentMethod: 1 } }))?.paymentMethod;
  const effectiveMpesaNumber = patch.mpesaNumber !== undefined ? patch.mpesaNumber : undefined;
  if (effectivePaymentMethod === 'mpesa' && effectiveMpesaNumber !== undefined && !MPESA_NUMBER_REGEX.test(String(effectiveMpesaNumber || '').trim())) {
    return returnFunction(res, 400, false, MPESA_NUMBER_ERROR);
  }
  patch.updatedAt = new Date();
  await updateOne('employees', { _id: req.user.employeeId }, { $set: patch });
  // Also sync email on the user account if changed
  if (patch.email) {
    await updateOne('users', { _id: req.user._id }, { $set: { email: patch.email } });
  }
  return returnFunction(res, 200, true, 'Profile updated.');
};

// Own job history — salary-related values are always stripped, matching the same
// "no salary history shown" rule applied to the rest of self-service.
const getMyJobHistory = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const history = await findMany('job_history', { employeeId: req.user.employeeId }, { sort: { effectiveDate: -1, createdAt: -1 } });
  const sanitized = history.map(h => {
    const { grossPay: _pg, ...previousValues } = h.previousValues || {};
    const { grossPay: _ng, ...newValues } = h.newValues || {};
    return { ...h, previousValues, newValues };
  });
  return returnFunction(res, 200, true, req.locale.success, sanitized);
};

// ── Skills, Certifications, Education (self-service) ──────────────────────────
const updateMySkills = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  if (!Array.isArray(req.body.skills)) return returnFunction(res, 400, false, 'skills must be an array of strings.');
  const skills = req.body.skills.map(s => String(s).trim()).filter(Boolean);
  await updateOne('employees', { _id: req.user.employeeId }, { $set: { skills, updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Skills updated.', skills);
};

const addMyCertification = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  if (!validateRequiredFields(req, res, ['name', 'issuingOrganization', 'issueDate'])) return;
  const cert = {
    id: new ObjectId().toString(),
    name: req.body.name,
    issuingOrganization: req.body.issuingOrganization,
    issueDate: new Date(req.body.issueDate),
    expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
    fileUrl: req.body.fileUrl || null,
  };
  await updateOne('employees', { _id: req.user.employeeId }, { $push: { certifications: cert }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 201, true, 'Certification added.', cert);
};

const deleteMyCertification = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  await updateOne('employees', { _id: req.user.employeeId }, { $pull: { certifications: { id: req.params.certId } }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Certification removed.');
};

const addMyEducation = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  if (!validateRequiredFields(req, res, ['institution', 'degree', 'fieldOfStudy', 'startYear'])) return;
  const edu = {
    id: new ObjectId().toString(),
    institution: req.body.institution,
    degree: req.body.degree,
    fieldOfStudy: req.body.fieldOfStudy,
    startYear: Number(req.body.startYear),
    endYear: req.body.endYear ? Number(req.body.endYear) : null,
  };
  await updateOne('employees', { _id: req.user.employeeId }, { $push: { educationHistory: edu }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 201, true, 'Education entry added.', edu);
};

const deleteMyEducation = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  await updateOne('employees', { _id: req.user.employeeId }, { $pull: { educationHistory: { id: req.params.eduId } }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 200, true, 'Education entry removed.');
};

const contactHR = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  if (!validateRequiredFields(req, res, ['topic'])) return;
  const { topic, message } = req.body;

  const employee = await findOne('employees', { _id: req.user.employeeId }, { projection: { fullName: 1 } });
  await notifyHR({
    type: 'general', subType: 'staff_query',
    title: `${employee?.fullName ?? 'A staff member'} needs help: ${topic}`,
    subtitle: message || `Requesting HR to review/update "${topic}" on their profile.`,
    referenceId: req.user.employeeId, referenceModel: 'employees',
    priority: 'normal', requiresAction: true, triggeredBy: req.user._id,
  });

  return returnFunction(res, 200, true, 'HR has been notified — they will follow up with you.');
};

// ── Leave ──────────────────────────────────────────────────────────────────────
// ── Payslips ───────────────────────────────────────────────────────────────────
// Delegates to the single shared implementation in payrollPayslipsFunctions.js —
// this route intentionally returns a flat array (unpaginated) to match the Staff
// Portal's existing consumption of it; /api/payroll/payslips returns the paginated form.
const getMyPayslips = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked.');
  const { data } = await getEmployeePayslipRecords(req.user.employeeId, {});
  return returnFunction(res, 200, true, 'OK', data);
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

  // Today's attendance
  const today = new Date().toISOString().split('T')[0];
  const todayAttendance = await findMany('attendance_records', { employeeId: { $in: empIds }, date: today }, {});
  const present   = todayAttendance.filter(r => ['present', 'late'].includes(r.status)).length;
  const absent    = todayAttendance.filter(r => r.status === 'absent').length;
  const onLeave   = employees.filter(e => e.status === 'on_leave').length;

  // Pending leave for this department head's team now lives at GET /api/leave/requests
  // (role-scoped automatically for department_head) — not duplicated here.
  return returnFunction(res, 200, true, 'OK', {
    department: dept,
    employees,
    stats: { total: employees.length, present, absent, onLeave, notMarked: employees.length - todayAttendance.length },
  });
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

// ── Internal job board ─────────────────────────────────────────────────────────
// Backed by the recruitment module's jobRequisitions/candidates/applications collections
// (see backend/src/routes/recruitment/recruitmentFunctions.js) rather than the legacy
// job_positions/applicants collections.
// A requisition with a past applicationDeadline is closed immediately, even before the
// daily closeExpiredRequisitions cron has flipped its status field — same real-time
// guarantee as the public careers-site routes (publicRoutes.js). Must be a function, not
// a static object — a plain object literal would capture `new Date()` once at server
// startup and never advance.
const notExpired = () => ({ $or: [{ applicationDeadline: null }, { applicationDeadline: { $gte: new Date() } }] });

const getOpenPositions = async (req, res) => {
  const positions = await findMany('jobRequisitions', { status: 'open', ...notExpired() }, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, 'OK', positions);
};

const applyInternal = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  const employee = await findOne('employees', { _id: req.user.employeeId });
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  const requisition = await findOne('jobRequisitions', { _id: new ObjectId(req.params.positionId), status: 'open', ...notExpired() });
  if (!requisition) return returnFunction(res, 404, false, 'Position not found or no longer open.');
  if (!requisition.pipelineStages?.length) return returnFunction(res, 400, false, 'This position is not currently accepting applications.');

  const email = employee.email.toLowerCase().trim();
  let candidate = await findOne('candidates', { email });
  if (!candidate) {
    const [firstName, ...rest] = (employee.fullName || '').split(' ');
    const candDoc = {
      firstName: firstName || employee.fullName || 'Employee',
      lastName: rest.join(' '),
      email,
      phone: employee.phone || null,
      location: null,
      resumeUrl: null,
      linkedInUrl: null,
      source: 'inbound',
      referredBy: null,
      tags: ['internal'],
      isPassiveTalent: false,
      consentGivenAt: new Date(),
      consentVersion: '1.0',
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const candResult = await insertOne('candidates', candDoc);
    candidate = { _id: candResult.insertedId, ...candDoc };
  }

  const priorApplicationCount = await countDocuments('applications', { candidateId: candidate._id, requisitionId: requisition._id });
  if (priorApplicationCount >= MAX_APPLICATIONS_PER_REQUISITION) {
    return returnFunction(res, 409, false, `You have already applied for this position the maximum number of times (${MAX_APPLICATIONS_PER_REQUISITION}).`);
  }

  const firstStage = requisition.pipelineStages[0];
  const now = new Date();
  const result = await insertOne('applications', {
    candidateId: candidate._id,
    requisitionId: requisition._id,
    currentStageId: firstStage.id,
    stageHistory: [{ stageId: firstStage.id, stageName: firstStage.name, enteredAt: now, movedBy: new ObjectId(req.user._id) }],
    status: 'active',
    rejectionReason: null,
    offerDetails: null,
    coverLetter: null,
    answers: [],
    scorecards: [],
    overallScore: null,
    createdAt: now,
    updatedAt: now,
  });

  if (candidate.email) {
    const tokens = { candidateName: `${candidate.firstName} ${candidate.lastName}`, jobTitle: requisition.title, companyName: process.env.COMPANY_NAME || 'Bella ERP' };
    sendTemplatedEmail({
      trigger: 'applicationReceived',
      to: candidate.email,
      tokens,
      fallbackSubject: `We received your application for ${tokens.jobTitle}`,
      fallbackHtml: `<p>Dear ${tokens.candidateName},</p><p>Thank you for applying to ${tokens.jobTitle}. Our team will review your application and be in touch soon.</p><p>Regards,<br/>${tokens.companyName}</p>`,
    }).catch(() => {});
  }

  // The external careers-site application flow (publicRoutes.js) notifies HR — this
  // internal-employee equivalent never did, so an internal application could sit
  // unnoticed indefinitely. Mirrors that flow exactly.
  notifyHR({
    type: 'recruitment', subType: 'new_application',
    title: 'New Internal Application Received',
    subtitle: `${employee.fullName} applied for ${requisition.title}.`,
    referenceId: result.insertedId, referenceModel: 'applications',
    requiresAction: true, triggeredBy: req.user._id,
  }).catch(() => {});
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'New Internal Application Received',
    body: `${employee.fullName} applied for ${requisition.title}.`,
    type: 'recruitment',
  }).catch(() => {});

  return returnFunction(res, 201, true, 'Application submitted successfully.');
};

const getMyApplications = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  const employee = await findOne('employees', { _id: req.user.employeeId });
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  const candidate = await findOne('candidates', { email: employee.email.toLowerCase().trim() });
  if (!candidate) return returnFunction(res, 200, true, 'OK', []);

  const applications = await findMany('applications', { candidateId: candidate._id }, { sort: { createdAt: -1 } });
  const requisitionIds = [...new Set(applications.map((a) => String(a.requisitionId)))].map((id) => new ObjectId(id));
  const requisitions = requisitionIds.length
    ? await findMany('jobRequisitions', { _id: { $in: requisitionIds } }, { projection: { title: 1, department: 1, pipelineStages: 1 } })
    : [];
  const reqMap = Object.fromEntries(requisitions.map((r) => [String(r._id), r]));

  const enriched = applications.map((a) => {
    const requisition = reqMap[String(a.requisitionId)];
    const stage = requisition?.pipelineStages?.find((s) => s.id === a.currentStageId);
    return {
      ...a,
      positionId: a.requisitionId,
      positionTitle: requisition?.title || 'Unknown Position',
      stageName: stage?.name || null,
    };
  });

  return returnFunction(res, 200, true, 'OK', enriched);
};

const getMyNotes = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  const notes = await global.dbo.collection('staff_notes').aggregate([
    { $match: { employeeId: req.user.employeeId } },
    { $sort: { createdAt: -1 } },
    { $lookup: { from: 'users', localField: 'createdBy', foreignField: '_id', as: '_creator' } },
    { $addFields: { createdByName: { $arrayElemAt: ['$_creator.name', 0] } } },
    { $project: { _creator: 0 } },
  ]).toArray();
  return returnFunction(res, 200, true, 'OK', notes);
};

module.exports = {
  getMyProfile, updateMyProfile, getMyJobHistory, contactHR, uploadMyProfilePhoto, serveMyProfilePhoto,
  updateMySkills, addMyCertification, deleteMyCertification, addMyEducation, deleteMyEducation,
  getMyPayslips, getMyAttendance,
  getMyDocuments, uploadMyDocument, downloadMyDocument, deleteMyDocument,
  getMyPerformance,
  getMyAwards, getMyEvents,
  getNotificationPreference, toggleNotifications,
  getDepartmentData,
  getMyTasks,
  getMyProjects,
  getMyNotes,
  getOpenPositions, applyInternal, getMyApplications,
};
