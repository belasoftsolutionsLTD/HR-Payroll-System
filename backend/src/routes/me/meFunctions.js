const fs   = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md) —
// employees/users/job_history/staff_notes (Phase 1), attendance_records (Phase 3b),
// job_requisitions/candidates/applications (Phase 4), appraisal_records/goals/
// reviews/review_cycles (Phase 5), employee_awards/project_members/projects/
// project_time_entries/tasks (Phase 9), and scheduled_events (Phase 10) now all
// live in Postgres — this file is fully migrated, no more Mongo helpers.
const pgDB = require('../../functions/Database/pgDBFunctions');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

const MAX_APPLICATIONS_PER_REQUISITION = 2;
const { notifyHR } = require('../inbox/inboxFunctions');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { getEmployeePayslipRecords } = require('../payroll/payrollPayslipsFunctions');

// Kenyan mobile format: 254 followed by 9 digits, Safaricom/Airtel/Telkom ranges start with 7 or 1.
const MPESA_NUMBER_REGEX = /^254(7|1)\d{8}$/;
const MPESA_NUMBER_ERROR = 'M-Pesa number must start with 254 and be a valid Kenyan mobile number (e.g. 254712345678).';

// req.user.employeeId is a Mongo ObjectId (AuthMiddleware.js's backward-compat alias —
// see that file for why); Postgres lookups need the plain string.
const myEmployeeId = (req) => (req.user.employeeId ? String(req.user.employeeId) : null);

// ── Profile ────────────────────────────────────────────────────────────────────
const getMyProfile = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account. Contact HR.');
  const employee = await pgDB.findOne('employees', { id: empId });
  if (!employee) return returnFunction(res, 404, false, 'Employee record not found.');
  return returnFunction(res, 200, true, 'OK', employee);
};

const updateMyProfile = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  const ALLOWED = [
    'phone', 'email', 'nextOfKin', 'kraPin', 'bankName', 'bankAccountNumber', 'mpesaNumber', 'paymentMethod', 'paypalEmail', 'cryptoWalletAddress', 'cryptoNetwork',
    'preferredName', 'gender', 'maritalStatus', 'nationality', 'passportNumber', 'passportExpiryDate', 'address',
  ];
  const patch = {};
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (!Object.keys(patch).length && !Array.isArray(req.body.emergencyContacts)) return returnFunction(res, 400, false, 'No updatable fields provided.');
  if (patch.passportExpiryDate) patch.passportExpiryDate = new Date(patch.passportExpiryDate);
  if (patch.nextOfKin !== undefined) patch.nextOfKin = patch.nextOfKin ? JSON.stringify(patch.nextOfKin) : null;

  const effectivePaymentMethod = patch.paymentMethod ?? (await pgDB.findOne('employees', { id: empId }))?.paymentMethod;
  const effectiveMpesaNumber = patch.mpesaNumber !== undefined ? patch.mpesaNumber : undefined;
  if (effectivePaymentMethod === 'mpesa' && effectiveMpesaNumber !== undefined && !MPESA_NUMBER_REGEX.test(String(effectiveMpesaNumber || '').trim())) {
    return returnFunction(res, 400, false, MPESA_NUMBER_ERROR);
  }
  patch.updatedAt = new Date();
  await pgDB.updateOne('employees', { id: empId }, patch);

  // Emergency contacts are their own child table now — wholesale-replaced separately
  // from the rest of the profile patch.
  if (Array.isArray(req.body.emergencyContacts)) {
    const emergencyContacts = req.body.emergencyContacts.map(c => ({
      id: c.id || new ObjectId().toString(), employeeId: empId,
      name: c.name, relationship: c.relationship || null, phone: c.phone, email: c.email || null,
    }));
    await pgDB.replaceChildRows('employee_emergency_contacts', 'employeeId', empId, emergencyContacts);
  }

  // Also sync email on the user account if changed
  if (patch.email) {
    await pgDB.updateOne('users', { id: req.user.id }, { email: patch.email });
  }

  // HR previously had no visibility at all into self-service profile edits — bank/mpesa/
  // KRA PIN changes in particular affect payroll and are worth HR noticing, not just
  // silently taking effect.
  const changedFields = Object.keys(patch).filter((k) => k !== 'updatedAt');
  const employee = await pgDB.findOne('employees', { id: empId });
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Employee Updated Their Profile',
    body: `${employee?.fullName ?? 'An employee'} updated: ${changedFields.join(', ')}.`,
    type: 'general',
  }).catch(() => {});

  {
    const hrUsers = await pgDB.knex('users').whereIn('role', ['super_admin', 'hr_manager']).whereNot('isActive', false).select('email');
    const tokens = { employeeName: employee?.fullName ?? 'An employee', fields: changedFields.join(', ') };
    hrUsers.filter(u => u.email).forEach(u => sendTemplatedEmail({
      trigger: 'employeeSelfServiceProfileUpdated', to: u.email, tokens,
      fallbackSubject: 'Employee Updated Their Profile',
      fallbackHtml: `<p>${tokens.employeeName} updated: ${tokens.fields}.</p>`,
    }).catch(() => {}));
  }

  return returnFunction(res, 200, true, 'Profile updated.');
};

// Own job history — salary-related values are always stripped, matching the same
// "no salary history shown" rule applied to the rest of self-service.
const getMyJobHistory = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 200, true, req.locale.success, []);
  const history = await pgDB.findMany('job_history', { employeeId: empId },
    { orderBy: [{ column: 'effectiveDate', order: 'desc' }, { column: 'createdAt', order: 'desc' }] });
  const sanitized = history.map(h => {
    const { grossPay: _pg, ...previousValues } = h.previousValues || {};
    const { grossPay: _ng, ...newValues } = h.newValues || {};
    return { ...h, previousValues, newValues };
  });
  return returnFunction(res, 200, true, req.locale.success, sanitized);
};

// ── Skills, Certifications, Education (self-service) ──────────────────────────
const updateMySkills = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  if (!Array.isArray(req.body.skills)) return returnFunction(res, 400, false, 'skills must be an array of strings.');
  const skills = req.body.skills.map(s => String(s).trim()).filter(Boolean);
  await pgDB.replaceChildRows('employee_skills', 'employeeId', empId,
    skills.map((skill, position) => ({ employeeId: empId, skill, position })));
  await pgDB.updateOne('employees', { id: empId }, { updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Skills updated.', skills);
};

const addMyCertification = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  if (!validateRequiredFields(req, res, ['name', 'issuingOrganization', 'issueDate'])) return;
  const cert = await pgDB.addChildRow('employee_certifications', {
    employeeId: empId,
    name: req.body.name,
    issuingOrganization: req.body.issuingOrganization,
    issueDate: new Date(req.body.issueDate),
    expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
    fileUrl: req.body.fileUrl || null,
  });
  await pgDB.updateOne('employees', { id: empId }, { updatedAt: new Date() });
  return returnFunction(res, 201, true, 'Certification added.', cert);
};

const deleteMyCertification = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  await pgDB.deleteChildRow('employee_certifications', 'employeeId', empId, req.params.certId);
  await pgDB.updateOne('employees', { id: empId }, { updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Certification removed.');
};

const addMyEducation = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  if (!validateRequiredFields(req, res, ['institution', 'degree', 'fieldOfStudy', 'startYear'])) return;
  const edu = await pgDB.addChildRow('employee_education_history', {
    employeeId: empId,
    institution: req.body.institution,
    degree: req.body.degree,
    fieldOfStudy: req.body.fieldOfStudy,
    startYear: Number(req.body.startYear),
    endYear: req.body.endYear ? Number(req.body.endYear) : null,
  });
  await pgDB.updateOne('employees', { id: empId }, { updatedAt: new Date() });
  return returnFunction(res, 201, true, 'Education entry added.', edu);
};

const deleteMyEducation = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  await pgDB.deleteChildRow('employee_education_history', 'employeeId', empId, req.params.eduId);
  await pgDB.updateOne('employees', { id: empId }, { updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Education entry removed.');
};

const contactHR = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  if (!validateRequiredFields(req, res, ['topic'])) return;
  const { topic, message } = req.body;

  const employee = await pgDB.findOne('employees', { id: empId });
  await notifyHR({
    type: 'general', subType: 'staff_query',
    title: `${employee?.fullName ?? 'A staff member'} needs help: ${topic}`,
    subtitle: message || `Requesting HR to review/update "${topic}" on their profile.`,
    referenceId: empId, referenceModel: 'employees',
    priority: 'normal', requiresAction: true, triggeredBy: req.user.id,
  });

  return returnFunction(res, 200, true, 'HR has been notified — they will follow up with you.');
};

// ── Payslips ───────────────────────────────────────────────────────────────────
// Delegates to the single shared implementation in payrollPayslipsFunctions.js —
// this route intentionally returns a flat array (unpaginated) to match the Staff
// Portal's existing consumption of it; /api/payroll/payslips returns the paginated form.
const getMyPayslips = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked.');
  const { data } = await getEmployeePayslipRecords(empId, {});
  return returnFunction(res, 200, true, 'OK', data);
};

// ── Attendance ─────────────────────────────────────────────────────────────────
// attendance_records now lives in Postgres (Phase 3b).
const getMyAttendance = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked.');

  let query = pgDB.knex('attendance_records').where({ employeeId: empId });
  if (req.query.month && req.query.year) {
    const m = String(req.query.month).padStart(2, '0');
    query = query.where('date', '>=', `${req.query.year}-${m}-01`).where('date', '<=', `${req.query.year}-${m}-31`);
  }

  const records = await query.orderBy('date', 'desc').limit(90);

  return returnFunction(res, 200, true, 'OK', [{ employeeId: empId, records }]);
};

// ── Documents ──────────────────────────────────────────────────────────────────
const getMyDocuments = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked.');
  const documents = await pgDB.findMany('employee_documents', { employeeId: empId }, { orderBy: { column: 'uploadedAt', order: 'desc' } });
  return returnFunction(res, 200, true, 'OK', documents);
};

const uploadMyDocument = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked.');
  if (!req.file) return returnFunction(res, 400, false, 'No file uploaded.');
  if (!req.body.docType) return returnFunction(res, 400, false, 'Document type is required.');
  const doc = await pgDB.addChildRow('employee_documents', {
    employeeId: empId,
    docType: req.body.docType,
    fileName: req.file.originalname,
    filePath: req.file.path,
    uploadedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Document uploaded.', doc);
};

const downloadMyDocument = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked.');
  const doc = await pgDB.findOne('employee_documents', { id: req.params.docId, employeeId: empId });
  if (!doc) return returnFunction(res, 404, false, 'Document not found.');
  if (!fs.existsSync(doc.filePath)) return returnFunction(res, 404, false, 'File not found on server.');
  res.download(doc.filePath, doc.fileName);
};

const deleteMyDocument = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked.');
  await pgDB.deleteChildRow('employee_documents', 'employeeId', empId, req.params.docId);
  return returnFunction(res, 200, true, 'Document removed.');
};

// ── Department Portal (department_head only) ────────────────────────────────────
// attendance_records now lives in Postgres (Phase 3b).
const getDepartmentData = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 400, false, 'No employee profile linked to your account.');

  const me = await pgDB.findOne('employees', { id: empId });
  if (!me?.department) return returnFunction(res, 400, false, 'No department set on your employee profile. Contact HR.');

  const dept = me.department;

  const employees = await pgDB.knex('employees')
    .where({ department: dept }).whereIn('status', ['active', 'on_leave', 'suspended'])
    .select('id', 'fullName', 'staffNumber', 'designation', 'status', 'email', 'phone')
    .orderBy('fullName', 'asc');

  const empIds = employees.map(e => e.id);

  // Today's attendance
  const today = new Date().toISOString().split('T')[0];
  const todayAttendance = empIds.length ? await pgDB.knex('attendance_records').whereIn('employeeId', empIds).where({ date: today }) : [];
  const present   = todayAttendance.filter(r => ['present', 'late'].includes(r.status)).length;
  const absent    = todayAttendance.filter(r => r.status === 'absent').length;
  const onLeave   = employees.filter(e => e.status === 'on_leave').length;

  // Pending leave for this department head's team now lives at GET /api/leave/requests
  // (role-scoped automatically for department_head) — not duplicated here.
  return returnFunction(res, 200, true, 'OK', {
    department: dept,
    employees: employees.map((e) => ({ ...e, _id: new ObjectId(e.id) })),
    stats: { total: employees.length, present, absent, onLeave, notMarked: employees.length - todayAttendance.length },
  });
};

// ── Performance ────────────────────────────────────────────────────────────────
// appraisal_records/goals/reviews/review_cycles now live in Postgres (Phase 5).
const getMyPerformance = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked.');

  const [appraisals, goals, rawReviews] = await Promise.all([
    pgDB.knex('appraisal_records').where({ employeeId: empId }).orderBy('createdAt', 'desc'),
    pgDB.knex('goals').where({ employeeId: empId }).orderBy('createdAt', 'desc'),
    pgDB.knex('reviews').where({ employeeId: empId, status: 'submitted' }).orderBy('submittedAt', 'desc'),
  ]);

  const reviews = await Promise.all(rawReviews.map(async r => {
    const cycle = r.cycleId
      ? await pgDB.knex('review_cycles').where({ id: r.cycleId }).select('name', 'type').first()
      : null;
    return { ...r, cycleName: cycle?.name ?? null };
  }));

  return returnFunction(res, 200, true, 'OK', { appraisals, goals, reviews });
};

// ── Awards ────────────────────────────────────────────────────────────────────
// employee_awards is Postgres now (Phase 9).
const getMyAwards = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 200, true, 'OK', []);
  const awards = await pgDB.knex('employee_awards').where({ employeeId: empId }).orderBy('awardedAt', 'desc');
  return returnFunction(res, 200, true, 'OK', awards);
};

// ── Upcoming Events (training & team building) ────────────────────────────────
// scheduled_events is Postgres now (Phase 10).
const getMyEvents = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const empId = myEmployeeId(req);
  const emp   = empId ? await pgDB.findOne('employees', { id: empId }) : null;

  const events = await pgDB.knex('scheduled_events')
    .where('scheduledDate', '>=', today)
    .where((qb) => qb.where({ audience: 'all' }).orWhere({ audience: 'department', department: emp?.department ?? '__none__' }))
    .orderBy('scheduledDate', 'asc')
    .limit(20);
  return returnFunction(res, 200, true, 'OK', events);
};

// ── Notification preference ────────────────────────────────────────────────────
const getNotificationPreference = async (req, res) => {
  const user = await pgDB.findOne('users', { id: req.user.id });
  return returnFunction(res, 200, true, 'OK', { notificationsEnabled: user?.notificationsEnabled !== false });
};

const toggleNotifications = async (req, res) => {
  const user = await pgDB.findOne('users', { id: req.user.id });
  const next = !(user?.notificationsEnabled !== false);
  await pgDB.updateOne('users', { id: req.user.id }, { notificationsEnabled: next });
  return returnFunction(res, 200, true, 'OK', { notificationsEnabled: next });
};

const uploadMyProfilePhoto = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, 'No file uploaded.');
  const photoPath = req.file.filename;
  const empId = myEmployeeId(req);
  if (empId) {
    // Pre-existing Mongo bug fixed in passing here, not a deliberate behavior change:
    // this write used to target employees.photoPath, a field nothing else in the app
    // ever read — every other module (createEmployee, org chart, listEmployees) uses
    // employees.profilePhoto, which is the only one of the two that exists in the
    // Postgres schema. A self-service photo upload was therefore never actually visible
    // anywhere else in the app; this makes it so.
    await pgDB.updateOne('employees', { id: empId }, { profilePhoto: photoPath, updatedAt: new Date() });
  }
  await pgDB.updateOne('users', { id: req.user.id }, { photoPath });
  return returnFunction(res, 200, true, 'Photo updated.', { photoPath });
};

const serveMyProfilePhoto = async (req, res) => {
  const user = await pgDB.findOne('users', { id: req.user.id });
  const empId = myEmployeeId(req);
  const photoFile = user?.photoPath
    || (empId && (await pgDB.findOne('employees', { id: empId }))?.profilePhoto);
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
// project_members/projects/project_time_entries are Postgres now (Phase 9).
const getMyProjects = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 200, true, 'OK', []);

  const memberships = await pgDB.knex('project_members').where({ employeeId: empId });
  if (!memberships.length) return returnFunction(res, 200, true, 'OK', []);

  const projectIds = memberships.map((m) => m.projectId);
  const projects = await pgDB.knex('projects').whereIn('id', projectIds).orderBy('createdAt', 'desc');

  const enriched = await Promise.all(projects.map(async (p) => {
    const membership = memberships.find((m) => String(m.projectId) === String(p.id));
    const [{ totalHours }] = await pgDB.knex('project_time_entries').where({ projectId: p.id, employeeId: empId }).sum('hours as totalHours');
    const recentEntries = await pgDB.knex('project_time_entries').where({ projectId: p.id, employeeId: empId }).orderBy('date', 'desc').limit(5);
    return {
      ...p,
      myRole:         membership?.role ?? 'member',
      myHours:        Number(totalHours) || 0,
      myRecentEntries: recentEntries,
    };
  }));

  return returnFunction(res, 200, true, 'OK', enriched);
};

// ── My Tasks ───────────────────────────────────────────────────────────────────
// tasks is Postgres now (Phase 9).
const getMyTasks = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 200, true, 'OK', []);
  const tasks = await pgDB.knex('tasks').where({ assignedTo: empId }).orderBy('dueDate', 'asc').orderBy('createdAt', 'desc').limit(100);
  return returnFunction(res, 200, true, 'OK', tasks);
};

// ── Internal job board ─────────────────────────────────────────────────────────
// Backed by the recruitment module's job_requisitions/candidates/applications tables
// (see backend/src/routes/recruitment/recruitmentFunctions.js) — all Postgres since
// Phase 4. A requisition with a past applicationDeadline is closed immediately, even
// before the daily closeExpiredRequisitions cron has flipped its status field — same
// real-time guarantee as the public careers-site routes (publicRoutes.js). Applied
// inline per-query (a knex query builder only evaluates `new Date()` when the query
// actually runs, unlike a plain object literal captured once).
const notExpired = (query) => query.andWhere((qb) => qb.whereNull('applicationDeadline').orWhere('applicationDeadline', '>=', new Date()));

const getOpenPositions = async (req, res) => {
  const positions = await notExpired(pgDB.knex('job_requisitions').where({ status: 'open' })).orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, 'OK', positions);
};

const applyInternal = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  const employee = await pgDB.findOne('employees', { id: empId });
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  const requisition = await notExpired(pgDB.knex('job_requisitions').where({ id: req.params.positionId, status: 'open' })).first();
  if (!requisition) return returnFunction(res, 404, false, 'Position not found or no longer open.');
  if (!requisition.pipelineStages?.length) return returnFunction(res, 400, false, 'This position is not currently accepting applications.');

  const email = employee.email.toLowerCase().trim();
  let candidate = await pgDB.findOne('candidates', { email });
  if (!candidate) {
    const [firstName, ...rest] = (employee.fullName || '').split(' ');
    const candDoc = {
      id: pgDB.newId(),
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
    candidate = await pgDB.insertOne('candidates', candDoc);
  }

  const [{ count: priorApplicationCount }] = await pgDB.knex('applications').where({ candidateId: candidate.id, requisitionId: requisition.id }).count('* as count');
  if (Number(priorApplicationCount) >= MAX_APPLICATIONS_PER_REQUISITION) {
    return returnFunction(res, 409, false, `You have already applied for this position the maximum number of times (${MAX_APPLICATIONS_PER_REQUISITION}).`);
  }

  const firstStage = requisition.pipelineStages[0];
  const now = new Date();
  const result = await pgDB.insertOne('applications', {
    id: pgDB.newId(),
    candidateId: candidate.id,
    requisitionId: requisition.id,
    currentStageId: firstStage.id,
    stageHistory: JSON.stringify([{ stageId: firstStage.id, stageName: firstStage.name, enteredAt: now, movedBy: req.user.id }]),
    status: 'active',
    rejectionReason: null,
    offerDetails: null,
    coverLetter: null,
    answers: JSON.stringify([]),
    overallScore: null,
    createdAt: now,
    updatedAt: now,
  });

  if (candidate.email) {
    const tokens = { candidateName: `${candidate.firstName} ${candidate.lastName}`, jobTitle: requisition.title, companyName: process.env.COMPANY_NAME || 'Workfola' };
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
    referenceId: result.id, referenceModel: 'applications',
    requiresAction: true, triggeredBy: req.user.id,
  }).catch(() => {});
  {
    const hrUsers = await pgDB.knex('users').whereIn('role', ['super_admin', 'hr_manager']).whereNot('isActive', false).select('email');
    const tokens = { employeeName: employee.fullName, jobTitle: requisition.title };
    hrUsers.filter(u => u.email).forEach(u => sendTemplatedEmail({
      trigger: 'internalApplicationReceived', to: u.email, tokens,
      fallbackSubject: 'New Internal Application Received',
      fallbackHtml: `<p>${tokens.employeeName} applied for ${tokens.jobTitle}.</p>`,
    }).catch(() => {}));
  }
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'New Internal Application Received',
    body: `${employee.fullName} applied for ${requisition.title}.`,
    type: 'recruitment',
  }).catch(() => {});

  return returnFunction(res, 201, true, 'Application submitted successfully.');
};

const getMyApplications = async (req, res) => {
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  const employee = await pgDB.findOne('employees', { id: empId });
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  const candidate = await pgDB.findOne('candidates', { email: employee.email.toLowerCase().trim() });
  if (!candidate) return returnFunction(res, 200, true, 'OK', []);

  const applications = await pgDB.knex('applications').where({ candidateId: candidate.id }).orderBy('createdAt', 'desc');
  const requisitionIds = [...new Set(applications.map((a) => a.requisitionId))];
  const requisitions = requisitionIds.length
    ? await pgDB.knex('job_requisitions').whereIn('id', requisitionIds).select('id', 'title', 'department', 'pipelineStages')
    : [];
  const reqMap = Object.fromEntries(requisitions.map((r) => [r.id, r]));

  const enriched = applications.map((a) => {
    const requisition = reqMap[a.requisitionId];
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
  const empId = myEmployeeId(req);
  if (!empId) return returnFunction(res, 404, false, 'No employee record linked to your account.');
  const notes = await pgDB.knex('staff_notes')
    .where({ 'staff_notes.employeeId': empId })
    .leftJoin('users', 'staff_notes.createdBy', 'users.id')
    .orderBy('staff_notes.createdAt', 'desc')
    .select('staff_notes.*', 'users.name as createdByName');
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
