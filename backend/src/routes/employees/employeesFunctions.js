const { ObjectId } = require('mongodb');
const path = require('path');
const fs = require('fs');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { generateStaffNumber } = require('../../functions/HR/staffNumberGenerator');
const { initiateOnboarding, resolveDefaultTemplate } = require('../../lib/onboarding/autoAssignTasks');
const { syncBasicPayCompensation } = require('../../lib/payroll/syncBasicPay');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');
const { runAccrual } = require('../../lib/leave/accrualEngine');

const DEPARTMENTS = ['Administration','Human Resources','Finance & Accounts','Information Technology','Operations','Sales & Marketing','Customer Service','Legal & Compliance','Procurement','Logistics & Supply Chain','Research & Development','Communications','Health & Safety','Facilities Management','Executive'];

// Compensation/financial fields — only super_admin and hr_manager may ever see these.
// department_head can manage their department's people but must never see pay/bank/tax info.
const SENSITIVE_FIELDS = ['grossPay', 'kraPin', 'paymentMethod', 'bankName', 'bankAccountNumber', 'mpesaNumber', 'paypalEmail', 'cryptoWalletAddress', 'cryptoNetwork'];
const SENSITIVE_PROJECTION = Object.fromEntries(SENSITIVE_FIELDS.map(f => [f, 0]));
const stripSensitiveFields = (doc) => {
  if (!doc) return doc;
  const copy = { ...doc };
  for (const f of SENSITIVE_FIELDS) delete copy[f];
  return copy;
};

// ── Job History (auto-logged, never written directly by the frontend) ────────
// Every time one of these fields changes on an employee record, a job_history
// entry is created inside the same request that made the change — never relies
// on the frontend to trigger it.
const JOB_HISTORY_TRACKED_FIELDS = ['designation', 'department', 'managerId', 'grossPay', 'status', 'employmentType'];

const logJobHistoryChange = async ({ employeeId, changeType, effectiveDate, previousValues, newValues, reason, changedBy, changedByName }) => {
  await insertOne('job_history', {
    employeeId, changeType, effectiveDate: effectiveDate || new Date(),
    previousValues, newValues, reason: reason || null,
    changedBy: changedBy || null, changedByName: changedByName || null,
    createdAt: new Date(),
  });
};

// Diffs `existing` (the employee doc before update) against `update` (the $set payload)
// across JOB_HISTORY_TRACKED_FIELDS, resolves manager names if managerId changed, picks
// the most specific changeType, and writes one job_history entry covering all changed
// tracked fields. No-ops if nothing tracked actually changed.
const recordJobHistoryIfChanged = async (existing, update, req) => {
  const changedFields = JOB_HISTORY_TRACKED_FIELDS.filter(f =>
    update[f] !== undefined && String(update[f] ?? '') !== String(existing[f] ?? '')
  );
  if (!changedFields.length) return;

  const previousValues = {}; const newValues = {};
  for (const f of changedFields) { previousValues[f] = existing[f] ?? null; newValues[f] = update[f]; }

  if (changedFields.includes('managerId')) {
    const [prevMgr, newMgr] = await Promise.all([
      existing.managerId ? findOne('employees', { _id: existing.managerId }, { projection: { fullName: 1 } }) : null,
      update.managerId   ? findOne('employees', { _id: update.managerId },   { projection: { fullName: 1 } }) : null,
    ]);
    previousValues.managerName = prevMgr?.fullName ?? null;
    newValues.managerName = newMgr?.fullName ?? null;
  }

  let changeType = 'titleChange';
  if (changedFields.includes('status'))          changeType = update.status === 'terminated' ? 'termination' : 'statusChange';
  else if (changedFields.includes('managerId'))   changeType = 'managerChange';
  else if (changedFields.includes('department'))  changeType = 'departmentChange';
  else if (changedFields.includes('grossPay'))    changeType = 'salaryChange';

  await logJobHistoryChange({
    employeeId: existing._id, changeType, effectiveDate: new Date(),
    previousValues, newValues, reason: req.body.changeReason || null,
    changedBy: req.user._id, changedByName: req.user.name,
  });
};

// ── Status-change side effects ────────────────────────────────────────────────
// Revokes login for every user account linked to this employee — status going to
// 'terminated' (or offboarding's 'inactive') must actually block access, not just
// record it on the employee document.
const revokeLoginAccess = async (employeeId) => {
  await global.dbo.collection('users').updateMany({ employeeId }, { $set: { isActive: false } });
};

// Status going to 'terminated' should always be backed by an offboarding record.
// We don't auto-create one (offboarding needs a template + exit type HR must choose)
// — just flag HR if this employee has none, so it isn't silently forgotten.
const flagMissingOffboardingIfNeeded = async (employee) => {
  const activeRecord = await findOne('offboarding_records', { employeeId: employee._id, status: { $ne: 'completed' } });
  if (activeRecord) return;
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Offboarding Not Started',
    body: `${employee.fullName} was marked terminated but has no offboarding record. Start one from the Offboarding module.`,
    type: 'offboarding',
  }).catch(() => {});
};

// Kenyan mobile format: 254 followed by 9 digits, Safaricom/Airtel/Telkom ranges start with 7 or 1.
const MPESA_NUMBER_REGEX = /^254(7|1)\d{8}$/;
const MPESA_NUMBER_ERROR = 'M-Pesa number must start with 254 and be a valid Kenyan mobile number (e.g. 254712345678).';

const revertExpiredLeaveStatuses = async () => {
  const today = new Date();
  const onLeaveEmployees = await findMany('employees', { status: 'on_leave' }, { projection: { _id: 1 } });
  if (!onLeaveEmployees.length) return;

  await Promise.all(onLeaveEmployees.map(async (emp) => {
    const activeLeave = await global.dbo.collection('leave_requests').findOne({
      employeeId: emp._id,
      status: 'approved',
      endDate: { $gte: today },
    });
    if (!activeLeave) {
      await updateOne('employees', { _id: emp._id }, { $set: { status: 'active', updatedAt: new Date() } });
    }
  }));
};

const listEmployees = async (req, res) => {
  revertExpiredLeaveStatuses().catch(() => {}); // fire-and-forget
  const { designation, employmentType, status, search } = req.query;
  let { department } = req.query;
  const filter = {};

  // Dept heads can only see their own department
  if (req.user.role === 'department_head') {
    const empRecord = req.user.employeeId
      ? await findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1 } })
      : null;
    if (empRecord?.department) department = empRecord.department;
    else return returnFunction(res, 200, true, req.locale.success, { data: [], total: 0, page: 1, totalPages: 0 });
  }

  if (department) filter.department = department;
  if (designation) filter.designation = designation;
  if (employmentType) filter.employmentType = employmentType;
  if (status) filter.status = status;
  if (search) filter.$or = [
    { fullName: { $regex: search, $options: 'i' } },
    { staffNumber: { $regex: search, $options: 'i' } },
  ];

  const { page, limit, skip } = getPagination(req.query, 500);
  const projection = req.user.role === 'department_head' ? { password: 0, ...SENSITIVE_PROJECTION } : { password: 0 };
  const [total, data] = await Promise.all([
    countDocuments('employees', filter),
    findMany('employees', filter, { skip, limit, sort: { createdAt: -1 }, projection }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

// Wraps a CSV field in quotes and escapes embedded quotes if it contains a comma,
// quote, or newline — the codebase's other CSV exports (expenseClaimsFunctions.js)
// skip this, but employee names/departments are more likely to contain commas.
const csvField = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportEmployeesCSV = async (req, res) => {
  const { designation, employmentType, status, search, department } = req.query;
  const filter = {};
  if (department) filter.department = department;
  if (designation) filter.designation = designation;
  if (employmentType) filter.employmentType = employmentType;
  if (status) filter.status = status;
  if (search) filter.$or = [
    { fullName: { $regex: search, $options: 'i' } },
    { staffNumber: { $regex: search, $options: 'i' } },
  ];

  const employees = await findMany('employees', filter, { sort: { fullName: 1 }, limit: 5000 });
  const jobGroupIds = [...new Set(employees.map(e => e.jobGroupId).filter(Boolean).map(String))].map(id => new ObjectId(id));
  const jobGroups = jobGroupIds.length ? await findMany('job_groups', { _id: { $in: jobGroupIds } }, { projection: { name: 1 } }) : [];
  const jobGroupNameById = Object.fromEntries(jobGroups.map(g => [String(g._id), g.name]));

  const header = ['Staff Number', 'Full Name', 'Email', 'Phone', 'Department', 'Designation', 'Employment Type', 'Status', 'Location', 'Job Group', 'Date of Hire', 'Gross Pay'];
  const rows = employees.map(e => [
    e.staffNumber, e.fullName, e.email, e.phone, e.department, e.designation, e.employmentType, e.status,
    e.location, e.jobGroupId ? (jobGroupNameById[String(e.jobGroupId)] ?? '') : '',
    e.dateOfHire ? new Date(e.dateOfHire).toISOString().slice(0, 10) : '', e.grossPay ?? '',
  ].map(csvField).join(','));

  const csv = [header.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send(csv);
};

const getEmployee = async (req, res) => {
  const employee = await findOne('employees', { _id: new ObjectId(req.params.id) });
  if (!employee) return returnFunction(res, 404, false, req.locale.notFound);
  let manager = null;
  if (employee.managerId) {
    manager = await findOne('employees', { _id: employee.managerId }, { projection: { fullName: 1, designation: 1, department: 1 } });
  }
  const safeEmployee = req.user.role === 'department_head' ? stripSensitiveFields(employee) : employee;
  return returnFunction(res, 200, true, req.locale.success, { ...safeEmployee, manager: manager ?? null });
};

const createEmployee = async (req, res) => {
  const required = ['fullName', 'nationalId', 'designation', 'employmentType', 'department', 'dateOfHire', 'jobGroupId', 'email'];
  if (!validateRequiredFields(req, res, required)) return;

  if (req.body.paymentMethod === 'mpesa' && !MPESA_NUMBER_REGEX.test(String(req.body.mpesaNumber || '').trim())) {
    return returnFunction(res, 400, false, MPESA_NUMBER_ERROR);
  }

  const existing = await findOne('employees', { nationalId: req.body.nationalId });
  if (existing) return returnFunction(res, 409, false, 'An employee with this National ID already exists.');

  const hireYear = new Date(req.body.dateOfHire).getFullYear();
  const staffNumber = await generateStaffNumber(hireYear);

  const doc = {
    fullName: req.body.fullName,
    firstName: req.body.firstName || null,
    lastName: req.body.lastName || null,
    nationalId: req.body.nationalId,
    staffNumber,
    designation: req.body.designation,
    employmentType: req.body.employmentType,
    department: req.body.department,
    jobGroupId: new ObjectId(req.body.jobGroupId),
    dateOfHire: new Date(req.body.dateOfHire),
    dateOfBirth: req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : null,
    contractEndDate: req.body.contractEndDate ? new Date(req.body.contractEndDate) : null,
    probationEndDate: req.body.probationEndDate ? new Date(req.body.probationEndDate) : null,
    confirmationDate: req.body.confirmationDate ? new Date(req.body.confirmationDate) : null,
    terminationDate: null,
    terminationReason: null,
    // Extended personal info
    preferredName: req.body.preferredName || null,
    gender: req.body.gender || null,
    maritalStatus: req.body.maritalStatus || null,
    nationality: req.body.nationality || null,
    passportNumber: req.body.passportNumber || null,
    passportExpiryDate: req.body.passportExpiryDate ? new Date(req.body.passportExpiryDate) : null,
    address: req.body.address || null,
    emergencyContacts: Array.isArray(req.body.emergencyContacts) ? req.body.emergencyContacts : [],
    grossPay: req.body.grossPay ? Number(req.body.grossPay) : null,
    kraPin: req.body.kraPin || null,
    paymentMethod: req.body.paymentMethod || 'bank_transfer',
    bankName: req.body.bankName || null,
    bankAccountNumber: req.body.bankAccountNumber || null,
    mpesaNumber: req.body.mpesaNumber || null,
    paypalEmail: req.body.paypalEmail || null,
    cryptoWalletAddress: req.body.cryptoWalletAddress || null,
    cryptoNetwork: req.body.cryptoNetwork || null,
    email: req.body.email,
    phone: req.body.phone || null,
    nextOfKin: req.body.nextOfKin || null,
    profilePhoto: null,
    documents: [],
    skills: [],
    certifications: [],
    educationHistory: [],
    location:    req.body.location    || null,
    costCenter:  req.body.costCenter  || null,
    managerId:   req.body.managerId   ? new ObjectId(req.body.managerId) : null,
    payGroup:    req.body.payGroup    || 'all',
    payFrequency: req.body.payFrequency || 'monthly',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('employees', doc);

  // Keep the payroll engine's actual "Basic Pay" earnings line in sync with the salary
  // just entered — see lib/payroll/syncBasicPay.js for why this can't be skipped.
  await syncBasicPayCompensation(result.insertedId, doc.grossPay, req.user._id, doc.dateOfHire);

  // Create one leave_balances record per active leave type for the current year —
  // starts at 0 and builds up via the monthly accrual cron (lib/leave/accrualEngine.js).
  const year = new Date().getFullYear();
  const activeLeaveTypes = await findMany('leave_types', { isActive: true }, { projection: { _id: 1 } });
  if (activeLeaveTypes.length) {
    await global.dbo.collection('leave_balances').insertMany(activeLeaveTypes.map(lt => ({
      employeeId: result.insertedId, leaveTypeId: lt._id, year,
      openingBalance: 0, accrued: 0, used: 0, pending: 0, carriedOver: 0, carryOverExpiry: null,
      closingBalance: 0, lastAccrualDate: null, updatedAt: new Date(),
    })));
  }

  // Grant this employee's first accrual immediately rather than making them wait for
  // the 1st-of-month cron — otherwise every new hire shows 0 days for up to a month.
  runAccrual(req.user._id, [result.insertedId]).catch(() => {});

  // Auto-start onboarding from the best-matching template, if any exist (fire-and-forget)
  (async () => {
    const template = await resolveDefaultTemplate(doc.department);
    if (template) await initiateOnboarding(result.insertedId, template._id, req.body.dateOfHire || new Date(), null);
  })().catch(() => {});

  // Job history: the initial hire entry
  await logJobHistoryChange({
    employeeId: result.insertedId, changeType: 'hire', effectiveDate: doc.dateOfHire,
    previousValues: {}, newValues: { designation: doc.designation, department: doc.department, status: doc.status, employmentType: doc.employmentType, grossPay: doc.grossPay },
    changedBy: req.user._id, changedByName: req.user.name,
  });

  // Notify HR managers and super admins about new employee (fire-and-forget)
  const newEmpMsg = `${doc.fullName} (${staffNumber}) has been added as ${doc.designation} in ${doc.department}.`;
  notifyByRoles(['super_admin', 'hr_manager'], { title: '👤 New Employee Added', body: newEmpMsg, type: 'general' }).catch(() => {});
  notifyHR({
    type: 'hr', subType: 'new_employee',
    title: '👤 New Employee Added',
    subtitle: newEmpMsg,
    referenceId: result.insertedId, referenceModel: 'employees',
    requiresAction: false,
    triggeredBy: req.user._id,
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, staffNumber });
};

const updateEmployee = async (req, res) => {
  if (req.body.paymentMethod === 'mpesa' && req.body.mpesaNumber !== undefined && !MPESA_NUMBER_REGEX.test(String(req.body.mpesaNumber || '').trim())) {
    return returnFunction(res, 400, false, MPESA_NUMBER_ERROR);
  }
  const existing = await findOne('employees', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);

  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  delete update.staffNumber;
  delete update.nationalId;
  delete update.changeReason; // consumed by job-history logging below, not a real employee field
  if (update.dateOfHire) update.dateOfHire = new Date(update.dateOfHire);
  if (update.contractEndDate) update.contractEndDate = new Date(update.contractEndDate);
  if (update.passportExpiryDate) update.passportExpiryDate = new Date(update.passportExpiryDate);
  if (update.probationEndDate) update.probationEndDate = new Date(update.probationEndDate);
  if (update.confirmationDate) update.confirmationDate = new Date(update.confirmationDate);
  if (update.terminationDate) update.terminationDate = new Date(update.terminationDate);
  if (update.jobGroupId) update.jobGroupId = new ObjectId(update.jobGroupId);
  if (update.managerId !== undefined) update.managerId = update.managerId ? new ObjectId(update.managerId) : null;

  await updateOne('employees', { _id: existing._id }, { $set: update });
  await recordJobHistoryIfChanged(existing, update, req);
  if (update.status === 'terminated' && existing.status !== 'terminated') {
    await revokeLoginAccess(existing._id);
    await flagMissingOffboardingIfNeeded(existing);
  }
  if (update.grossPay !== undefined && update.grossPay !== existing.grossPay) {
    await syncBasicPayCompensation(existing._id, update.grossPay, req.user._id, existing.dateOfHire);
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const patchEmployeeStatus = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  const allowed = ['active', 'on_leave', 'suspended', 'terminated'];
  if (!allowed.includes(req.body.status)) return returnFunction(res, 400, false, 'Invalid status.');
  const existing = await findOne('employees', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const set = { status: req.body.status, updatedAt: new Date() };
  if (req.body.status === 'terminated') {
    set.terminationDate = new Date();
    set.terminationReason = req.body.terminationReason || null;
  }
  await updateOne('employees', { _id: existing._id }, { $set: set });
  await recordJobHistoryIfChanged(existing, { status: req.body.status }, req);
  if (req.body.status === 'terminated') {
    await revokeLoginAccess(existing._id);
    await flagMissingOffboardingIfNeeded(existing);
  }
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteEmployee = async (req, res) => {
  const existing = await findOne('employees', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('employees', { _id: existing._id }, {
    $set: { status: 'terminated', terminationDate: new Date(), terminationReason: req.body.terminationReason || null, updatedAt: new Date() },
  });
  await recordJobHistoryIfChanged(existing, { status: 'terminated' }, req);
  await revokeLoginAccess(existing._id);
  await flagMissingOffboardingIfNeeded(existing);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const getJobHistory = async (req, res) => {
  const history = await findMany('job_history', { employeeId: new ObjectId(req.params.id) }, { sort: { effectiveDate: -1, createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, history);
};

// ── Emergency Contacts (multiple; separate from the single legacy nextOfKin field) ──
const updateEmergencyContacts = async (req, res) => {
  if (!Array.isArray(req.body.emergencyContacts)) return returnFunction(res, 400, false, 'emergencyContacts must be an array.');
  const emergencyContacts = req.body.emergencyContacts.map(c => ({
    id: c.id || new ObjectId().toString(),
    name: c.name, relationship: c.relationship || null, phone: c.phone, email: c.email || null,
  }));
  await updateOne('employees', { _id: new ObjectId(req.params.id) }, { $set: { emergencyContacts, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, emergencyContacts);
};

// ── Skills, Certifications, Education (Skills & Qualifications tab) ──────────

const updateSkills = async (req, res) => {
  if (!Array.isArray(req.body.skills)) return returnFunction(res, 400, false, 'skills must be an array of strings.');
  const skills = req.body.skills.map(s => String(s).trim()).filter(Boolean);
  await updateOne('employees', { _id: new ObjectId(req.params.id) }, { $set: { skills, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, skills);
};

const addCertification = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'issuingOrganization', 'issueDate'])) return;
  const cert = {
    id: new ObjectId().toString(),
    name: req.body.name,
    issuingOrganization: req.body.issuingOrganization,
    issueDate: new Date(req.body.issueDate),
    expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
    fileUrl: req.body.fileUrl || null,
  };
  await updateOne('employees', { _id: new ObjectId(req.params.id) }, { $push: { certifications: cert }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, cert);
};

const deleteCertification = async (req, res) => {
  await updateOne('employees', { _id: new ObjectId(req.params.id) }, { $pull: { certifications: { id: req.params.certId } }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const addEducation = async (req, res) => {
  if (!validateRequiredFields(req, res, ['institution', 'degree', 'fieldOfStudy', 'startYear'])) return;
  const edu = {
    id: new ObjectId().toString(),
    institution: req.body.institution,
    degree: req.body.degree,
    fieldOfStudy: req.body.fieldOfStudy,
    startYear: Number(req.body.startYear),
    endYear: req.body.endYear ? Number(req.body.endYear) : null,
  };
  await updateOne('employees', { _id: new ObjectId(req.params.id) }, { $push: { educationHistory: edu }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, edu);
};

const deleteEducation = async (req, res) => {
  await updateOne('employees', { _id: new ObjectId(req.params.id) }, { $pull: { educationHistory: { id: req.params.eduId } }, $set: { updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const uploadDocument = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, req.locale.missingRequiredFields);
  if (!req.body.docType) return returnFunction(res, 400, false, req.locale.missingRequiredFields);

  const doc = {
    docId: new ObjectId(),
    docType: req.body.docType,
    fileName: req.file.originalname,
    filePath: req.file.path,
    uploadedAt: new Date(),
  };
  await updateOne('employees', { _id: new ObjectId(req.params.id) }, { $push: { documents: doc } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, doc);
};

const downloadDocument = async (req, res) => {
  const employee = await findOne('employees', { _id: new ObjectId(req.params.id) });
  if (!employee) return returnFunction(res, 404, false, req.locale.notFound);
  const doc = (employee.documents || []).find((d) => String(d.docId) === req.params.docId);
  if (!doc) return returnFunction(res, 404, false, req.locale.notFound);
  if (!fs.existsSync(doc.filePath)) return returnFunction(res, 404, false, 'File not found on server.');
  res.download(doc.filePath, doc.fileName);
};

const getOrgChart = async (req, res) => {
  const employees = await findMany('employees', { status: { $in: ['active', 'on_leave'] } }, {
    projection: { fullName: 1, designation: 1, department: 1, managerId: 1, profilePhoto: 1 },
  });

  // Build a map for O(1) child lookup
  const nodeMap = {};
  employees.forEach(e => { nodeMap[String(e._id)] = { ...e, reports: [] }; });

  const roots = [];
  employees.forEach(e => {
    if (e.managerId && nodeMap[String(e.managerId)]) {
      nodeMap[String(e.managerId)].reports.push(nodeMap[String(e._id)]);
    } else {
      roots.push(nodeMap[String(e._id)]);
    }
  });

  return returnFunction(res, 200, true, 'Org chart fetched', roots);
};

// ── Payroll Readiness Check ───────────────────────────────────────────────────
// GET /api/employees/payroll-readiness
// Returns all active/on-leave employees that are missing fields required for
// payroll to run correctly. Designed to be called before creating a cycle.

const READINESS_CHECKS = [
  { key: 'grossPay',       label: 'Gross Pay',       critical: true,  test: e => e.grossPay && e.grossPay > 0 },
  { key: 'jobGroup',       label: 'Job Group',        critical: true,  test: e => !!e.jobGroupId },
  { key: 'taxId',          label: 'Tax ID / PIN',     critical: false, test: e => !!e.kraPin },
  { key: 'paymentMethod',  label: 'Payment Method',   critical: false, test: e => !!(e.bankAccountNumber || e.mpesaNumber) },
  { key: 'department',     label: 'Department',       critical: false, test: e => !!e.department },
  { key: 'staffNumber',    label: 'Staff Number',     critical: false, test: e => !!e.staffNumber },
];

// Single source of truth for "is this employee safe to run through payroll" — used both
// by the readiness-check endpoint below and by the payroll cycle run itself (which pays
// ready employees first and excludes the rest rather than producing a broken payslip).
const getMissingCriticalFields = (emp) => READINESS_CHECKS.filter(c => c.critical && !c.test(emp)).map(c => c.label);
const isPayrollReady = (emp) => getMissingCriticalFields(emp).length === 0;

const getPayrollReadiness = async (req, res) => {
  const employees = await findMany(
    'employees',
    { status: { $in: ['active', 'on_leave'] } },
    { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1, grossPay: 1, jobGroupId: 1, kraPin: 1, bankAccountNumber: 1, mpesaNumber: 1 } },
  );

  const incomplete = employees
    .map(emp => {
      const missing         = READINESS_CHECKS.filter(c => !c.test(emp));
      const missingLabels   = missing.map(c => c.label);
      const hasCritical     = missing.some(c => c.critical);
      if (!missing.length) return null;
      return {
        _id:          emp._id,
        fullName:     emp.fullName,
        staffNumber:  emp.staffNumber ?? '—',
        department:   emp.department  ?? '—',
        designation:  emp.designation ?? '—',
        missing:      missingLabels,
        hasCritical,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.hasCritical ? 1 : 0) - (a.hasCritical ? 1 : 0));

  return returnFunction(res, 200, true, req.locale.success, {
    total:           employees.length,
    incompleteCount: incomplete.length,
    criticalCount:   incomplete.filter(e => e.hasCritical).length,
    employees:       incomplete,
  });
};

// ── Pay Groups (payroll schedule configuration) ───────────────────────────────
// A pay group is just a free-form tag on the employee record (default 'all'); this endpoint
// summarizes the distinct groups in use so HR can see headcount and pay frequency per group,
// and bulk-set a frequency for everyone in one.

const listPayGroups = async (req, res) => {
  const employees = await findMany('employees', { status: { $in: ['active', 'on_leave'] } }, { projection: { payGroup: 1, payFrequency: 1 } });
  const groups = {};
  for (const e of employees) {
    const g = e.payGroup || 'all';
    if (!groups[g]) groups[g] = { payGroup: g, employeeCount: 0, frequencies: {} };
    groups[g].employeeCount++;
    const f = e.payFrequency || 'monthly';
    groups[g].frequencies[f] = (groups[g].frequencies[f] || 0) + 1;
  }
  const result = Object.values(groups).map((g) => ({
    payGroup: g.payGroup,
    employeeCount: g.employeeCount,
    // 'mixed' if the group has employees on more than one frequency
    payFrequency: Object.keys(g.frequencies).length === 1 ? Object.keys(g.frequencies)[0] : 'mixed',
  }));
  return returnFunction(res, 200, true, req.locale.success, result);
};

const setPayGroupFrequency = async (req, res) => {
  if (!validateRequiredFields(req, res, ['payFrequency'])) return;
  if (!['weekly', 'biweekly', 'monthly'].includes(req.body.payFrequency)) {
    return returnFunction(res, 400, false, 'payFrequency must be weekly, biweekly, or monthly.');
  }
  await global.dbo.collection('employees').updateMany(
    { payGroup: req.params.payGroup },
    { $set: { payFrequency: req.body.payFrequency, updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, `Pay frequency updated for "${req.params.payGroup}".`);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Workforce Analytics — HR only
// ══════════════════════════════════════════════════════════════════════════════

const NOT_TERMINATED = { status: { $ne: 'terminated' } };

const getHeadcountAnalytics = async (req, res) => {
  const [total, byDepartment, byEmploymentType, byStatus] = await Promise.all([
    countDocuments('employees', NOT_TERMINATED),
    global.dbo.collection('employees').aggregate([
      { $match: NOT_TERMINATED },
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    global.dbo.collection('employees').aggregate([
      { $match: NOT_TERMINATED },
      { $group: { _id: '$employmentType', count: { $sum: 1 } } },
    ]).toArray(),
    global.dbo.collection('employees').aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray(),
  ]);
  return returnFunction(res, 200, true, req.locale.success, {
    total,
    byDepartment: byDepartment.map(d => ({ department: d._id || 'Unassigned', count: d.count })),
    byEmploymentType: byEmploymentType.map(d => ({ employmentType: d._id || 'Unspecified', count: d.count })),
    byStatus: byStatus.map(d => ({ status: d._id, count: d.count })),
  });
};

const getTurnoverAnalytics = async (req, res) => {
  const months = Math.min(Number(req.query.months) || 12, 24);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);

  const [hires, terminations] = await Promise.all([
    global.dbo.collection('employees').aggregate([
      { $match: { dateOfHire: { $gte: start } } },
      { $group: { _id: { y: { $year: '$dateOfHire' }, m: { $month: '$dateOfHire' } }, count: { $sum: 1 } } },
    ]).toArray(),
    global.dbo.collection('employees').aggregate([
      { $match: { terminationDate: { $gte: start } } },
      { $group: { _id: { y: { $year: '$terminationDate' }, m: { $month: '$terminationDate' } }, count: { $sum: 1 } } },
    ]).toArray(),
  ]);

  const key = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
  const hireMap = Object.fromEntries(hires.map(h => [key(h._id.y, h._id.m), h.count]));
  const termMap = Object.fromEntries(terminations.map(t => [key(t._id.y, t._id.m), t.count]));

  const series = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const k = key(d.getFullYear(), d.getMonth() + 1);
    series.push({ month: k, hires: hireMap[k] || 0, terminations: termMap[k] || 0 });
  }
  return returnFunction(res, 200, true, req.locale.success, series);
};

const getTenureAnalytics = async (req, res) => {
  const employees = await findMany('employees', NOT_TERMINATED, { projection: { department: 1, dateOfHire: 1 } });
  const now = new Date();
  const byDept = {};
  for (const e of employees) {
    if (!e.dateOfHire) continue;
    const dept = e.department || 'Unassigned';
    const years = (now - new Date(e.dateOfHire)) / (1000 * 60 * 60 * 24 * 365.25);
    if (!byDept[dept]) byDept[dept] = { totalYears: 0, count: 0 };
    byDept[dept].totalYears += years;
    byDept[dept].count += 1;
  }
  const result = Object.entries(byDept)
    .map(([department, v]) => ({ department, averageTenureYears: Math.round((v.totalYears / v.count) * 10) / 10, count: v.count }))
    .sort((a, b) => b.averageTenureYears - a.averageTenureYears);
  return returnFunction(res, 200, true, req.locale.success, result);
};

const getDemographicsAnalytics = async (req, res) => {
  const [byGender, byNationality] = await Promise.all([
    global.dbo.collection('employees').aggregate([
      { $match: NOT_TERMINATED },
      { $group: { _id: { $ifNull: ['$gender', 'Not specified'] }, count: { $sum: 1 } } },
    ]).toArray(),
    global.dbo.collection('employees').aggregate([
      { $match: NOT_TERMINATED },
      { $group: { _id: { $ifNull: ['$nationality', 'Not specified'] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
  ]);
  return returnFunction(res, 200, true, req.locale.success, {
    byGender: byGender.map(g => ({ gender: g._id, count: g.count })),
    byNationality: byNationality.map(n => ({ nationality: n._id, count: n.count })),
  });
};

const getUpcomingAnalytics = async (req, res) => {
  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const projection = { fullName: 1, staffNumber: 1, department: 1, probationEndDate: 1, passportExpiryDate: 1, contractEndDate: 1 };

  const [probations, passports, contracts] = await Promise.all([
    findMany('employees', { ...NOT_TERMINATED, probationEndDate: { $gte: now, $lte: in90 } }, { projection, sort: { probationEndDate: 1 } }),
    findMany('employees', { ...NOT_TERMINATED, passportExpiryDate: { $gte: now, $lte: in90 } }, { projection, sort: { passportExpiryDate: 1 } }),
    findMany('employees', { ...NOT_TERMINATED, contractEndDate: { $gte: now, $lte: in90 } }, { projection, sort: { contractEndDate: 1 } }),
  ]);

  const bucket = (date) => {
    const days = Math.ceil((new Date(date) - now) / (1000 * 60 * 60 * 24));
    return days <= 30 ? 30 : days <= 60 ? 60 : 90;
  };
  const withBucket = (list, dateField) => list.map(e => ({ ...e, daysRemaining: Math.ceil((new Date(e[dateField]) - now) / (1000 * 60 * 60 * 24)), bucket: bucket(e[dateField]) }));

  return returnFunction(res, 200, true, req.locale.success, {
    probationEndings: withBucket(probations, 'probationEndDate'),
    passportExpiries: withBucket(passports, 'passportExpiryDate'),
    contractEndings: withBucket(contracts, 'contractEndDate'),
  });
};

module.exports = {
  listEmployees, exportEmployeesCSV, getEmployee, createEmployee, updateEmployee, patchEmployeeStatus, deleteEmployee,
  uploadDocument, downloadDocument, getOrgChart, getPayrollReadiness, isPayrollReady, getMissingCriticalFields, listPayGroups, setPayGroupFrequency, getJobHistory,
  updateSkills, addCertification, deleteCertification, addEducation, deleteEducation,
  updateEmergencyContacts,
  getHeadcountAnalytics, getTurnoverAnalytics, getTenureAnalytics, getDemographicsAnalytics, getUpcomingAnalytics,
};
