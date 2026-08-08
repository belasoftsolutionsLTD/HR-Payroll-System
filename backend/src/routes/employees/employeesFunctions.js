const { ObjectId } = require('mongodb');
const path = require('path');
const fs = require('fs');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md) —
// employees, job_history, and their supporting lookups (Phase 1), leave_types/
// leave_balances/leave_requests (Phase 3a), offboarding_records (Phase 4), and
// notifications (Phase 10) all now live in Postgres — this file is fully migrated,
// no more Mongo helpers.
const {
  findOne, findMany, insertOne, insertMany, updateOne, deleteOne, countDocuments,
  knex, replaceChildRows, addChildRow, deleteChildRow,
} = require('../../functions/Database/pgDBFunctions');
const { generateStaffNumber } = require('../../functions/HR/staffNumberGenerator');
const { initiateOnboarding, resolveDefaultTemplate } = require('../../lib/onboarding/autoAssignTasks');
const { syncBasicPayCompensation } = require('../../lib/payroll/syncBasicPay');
const { notifyByRoles, notifyEmployee } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');
const { runAccrual } = require('../../lib/leave/accrualEngine');

const DEPARTMENTS = ['Administration','Human Resources','Finance & Accounts','Information Technology','Operations','Sales & Marketing','Customer Service','Legal & Compliance','Procurement','Logistics & Supply Chain','Research & Development','Communications','Health & Safety','Facilities Management','Executive'];

const SENSITIVE_FIELDS = ['grossPay', 'kraPin', 'paymentMethod', 'bankName', 'bankAccountNumber', 'mpesaNumber', 'paypalEmail', 'cryptoWalletAddress', 'cryptoNetwork'];
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
    previousValues: JSON.stringify(previousValues || {}), newValues: JSON.stringify(newValues || {}),
    reason: reason || null,
    changedBy: changedBy || null, changedByName: changedByName || null,
    createdAt: new Date(),
  });
};

// Diffs `existing` (the employee row before update) against `update` (the new-values
// payload) across JOB_HISTORY_TRACKED_FIELDS, resolves manager names if managerId
// changed, picks the most specific changeType, and writes one job_history entry
// covering all changed tracked fields. No-ops if nothing tracked actually changed.
const recordJobHistoryIfChanged = async (existing, update, req) => {
  const changedFields = JOB_HISTORY_TRACKED_FIELDS.filter(f =>
    update[f] !== undefined && String(update[f] ?? '') !== String(existing[f] ?? '')
  );
  if (!changedFields.length) return;

  const previousValues = {}; const newValues = {};
  for (const f of changedFields) { previousValues[f] = existing[f] ?? null; newValues[f] = update[f]; }

  if (changedFields.includes('managerId')) {
    const [prevMgr, newMgr] = await Promise.all([
      existing.managerId ? findOne('employees', { id: existing.managerId }) : null,
      update.managerId   ? findOne('employees', { id: update.managerId })   : null,
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
    employeeId: existing.id, changeType, effectiveDate: new Date(),
    previousValues, newValues, reason: req.body.changeReason || null,
    changedBy: req.user.id, changedByName: req.user.name,
  });

  return changedFields;
};

// Friendly labels for the employee-facing "your X was updated" notification below —
// 'status' is deliberately excluded from that notification: a termination is already
// covered by the offboarding flow + immediate login revocation, and other status
// transitions (on_leave, etc.) already have their own dedicated messaging elsewhere.
const FIELD_CHANGE_LABELS = {
  designation: 'job title', department: 'department', managerId: 'manager',
  grossPay: 'salary', employmentType: 'employment type',
};

// ── Status-change side effects ────────────────────────────────────────────────
// Revokes login for every user account linked to this employee — status going to
// 'terminated' (or offboarding's 'inactive') must actually block access, not just
// record it on the employee document.
const revokeLoginAccess = async (employeeId) => {
  await knex('users').where({ employeeId }).update({ isActive: false });
};

// Status going to 'terminated' should always be backed by an offboarding record.
// We don't auto-create one (offboarding needs a template + exit type HR must choose)
// — just flag HR if this employee has none, so it isn't silently forgotten.
// offboarding_records now lives in Postgres (Phase 4).
const flagMissingOffboardingIfNeeded = async (employee) => {
  const activeRecord = await knex('offboarding_records').where({ employeeId: employee.id }).whereNot({ status: 'completed' }).first();
  if (activeRecord) return;
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Offboarding Not Started',
    body: `${employee.fullName} was marked terminated but has no offboarding record. Start one from the Offboarding module.`,
    type: 'offboarding',
  }).catch(() => {});

  const hrUsers = await knex('users').whereIn('role', ['super_admin', 'hr_manager']).whereNot('isActive', false).select('email');
  const tokens = { employeeName: employee.fullName };
  hrUsers.filter(u => u.email).forEach(u => sendTemplatedEmail({
    trigger: 'offboardingNotStarted', to: u.email, tokens,
    fallbackSubject: `Offboarding not started — ${tokens.employeeName}`,
    fallbackHtml: `<p>${tokens.employeeName} was marked terminated but has no offboarding record. Start one from the Offboarding module.</p>`,
  }).catch(() => {}));
};

// Kenyan mobile format: 254 followed by 9 digits, Safaricom/Airtel/Telkom ranges start with 7 or 1.
const MPESA_NUMBER_REGEX = /^254(7|1)\d{8}$/;
const MPESA_NUMBER_ERROR = 'M-Pesa number must start with 254 and be a valid Kenyan mobile number (e.g. 254712345678).';

// leave_requests now lives in Postgres (Phase 3a).
const revertExpiredLeaveStatuses = async () => {
  const today = new Date();
  const onLeaveEmployees = await findMany('employees', { status: 'on_leave' });
  if (!onLeaveEmployees.length) return;

  await Promise.all(onLeaveEmployees.map(async (emp) => {
    const activeLeave = await knex('leave_requests')
      .where({ employeeId: emp.id, status: 'approved' })
      .where('endDate', '>=', today)
      .first();
    if (!activeLeave) {
      await updateOne('employees', { id: emp.id }, { status: 'active', updatedAt: new Date() });
    }
  }));
};

const listEmployees = async (req, res) => {
  revertExpiredLeaveStatuses().catch(() => {}); // fire-and-forget
  const { designation, employmentType, status, search } = req.query;
  let { department } = req.query;

  // Dept heads can only see their own department
  if (req.user.role === 'department_head') {
    const empRecord = req.user.employeeId
      ? await findOne('employees', { id: req.user.employeeId.toString() })
      : null;
    if (empRecord?.department) department = empRecord.department;
    else return returnFunction(res, 200, true, req.locale.success, { data: [], total: 0, page: 1, totalPages: 0 });
  }

  let query = knex('employees');
  if (department) query = query.where({ department });
  // Substring, case-insensitive — callers like Logistics' driver picker filter by role
  // keyword (e.g. "driver") rather than an exact, HR-typed job title string.
  if (designation) query = query.whereILike('designation', `%${designation}%`);
  if (employmentType) query = query.where({ employmentType });
  if (status) query = query.where({ status });
  if (search) {
    query = query.where(function () {
      this.whereILike('fullName', `%${search}%`).orWhereILike('staffNumber', `%${search}%`);
    });
  }

  const { page, limit, skip } = getPagination(req.query, 500);
  const isDeptHead = req.user.role === 'department_head';

  const [{ count }, rows] = await Promise.all([
    query.clone().count('* as count').first(),
    query.clone().orderBy('fullName', 'asc').offset(skip).limit(limit),
  ]);
  const data = (isDeptHead ? rows.map(stripSensitiveFields) : rows).map((r) => ({ ...r, _id: new ObjectId(r.id) }));
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, Number(count), page, limit));
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
  let query = knex('employees');
  if (department) query = query.where({ department });
  if (designation) query = query.whereILike('designation', `%${designation}%`);
  if (employmentType) query = query.where({ employmentType });
  if (status) query = query.where({ status });
  if (search) {
    query = query.where(function () {
      this.whereILike('fullName', `%${search}%`).orWhereILike('staffNumber', `%${search}%`);
    });
  }

  const employees = await query.orderBy('fullName', 'asc').limit(5000);
  const jobGroupIds = [...new Set(employees.map(e => e.jobGroupId).filter(Boolean))];
  const jobGroups = jobGroupIds.length ? await knex('job_groups').whereIn('id', jobGroupIds).select('id', 'name') : [];
  const jobGroupNameById = Object.fromEntries(jobGroups.map(g => [g.id, g.name]));

  const header = ['Staff Number', 'Full Name', 'Email', 'Phone', 'Department', 'Designation', 'Employment Type', 'Status', 'Location', 'Job Group', 'Date of Hire', 'Gross Pay'];
  const rows = employees.map(e => [
    e.staffNumber, e.fullName, e.email, e.phone, e.department, e.designation, e.employmentType, e.status,
    e.location, e.jobGroupId ? (jobGroupNameById[e.jobGroupId] ?? '') : '',
    e.dateOfHire ? new Date(e.dateOfHire).toISOString().slice(0, 10) : '', e.grossPay ?? '',
  ].map(csvField).join(','));

  const csv = [header.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send(csv);
};

const getEmployee = async (req, res) => {
  const employee = await findOne('employees', { id: req.params.id });
  if (!employee) return returnFunction(res, 404, false, req.locale.notFound);
  let manager = null;
  if (employee.managerId) {
    manager = await findOne('employees', { id: employee.managerId });
    if (manager) manager = { fullName: manager.fullName, designation: manager.designation, department: manager.department };
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

  // employees.email has a unique constraint — without this pre-check a duplicate falls
  // through to a raw Postgres unique-violation error, which the generic error handler
  // turns into an opaque "Internal Server Error" (meaningless to a non-technical user).
  const existingEmail = await findOne('employees', { email: String(req.body.email).trim().toLowerCase() });
  if (existingEmail) return returnFunction(res, 409, false, 'An employee with this email already exists.');

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
    jobGroupId: req.body.jobGroupId,
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
    nextOfKin: req.body.nextOfKin ? JSON.stringify(req.body.nextOfKin) : null,
    grossPay: req.body.grossPay ? Number(req.body.grossPay) : null,
    kraPin: req.body.kraPin || null,
    paymentMethod: req.body.paymentMethod || 'bank_transfer',
    bankName: req.body.bankName || null,
    bankAccountNumber: req.body.bankAccountNumber || null,
    mpesaNumber: req.body.mpesaNumber || null,
    paypalEmail: req.body.paypalEmail || null,
    cryptoWalletAddress: req.body.cryptoWalletAddress || null,
    cryptoNetwork: req.body.cryptoNetwork || null,
    email: String(req.body.email).trim().toLowerCase(),
    phone: req.body.phone || null,
    profilePhoto: null,
    location:    req.body.location    || null,
    branchId:    req.body.branchId    || null,
    costCenter:  req.body.costCenter  || null,
    managerId:   req.body.managerId   || null,
    payGroup:    req.body.payGroup    || 'all',
    payFrequency: req.body.payFrequency || 'monthly',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('employees', doc);
  const employeeId = result.id;

  // Keep the payroll engine's actual "Basic Pay" earnings line in sync with the salary
  // just entered — see lib/payroll/syncBasicPay.js for why this can't be skipped.
  await syncBasicPayCompensation(employeeId, doc.grossPay, req.user.id, doc.dateOfHire);

  // Create one leave_balances record per active leave type for the current year —
  // starts at 0 and builds up via the monthly accrual cron (lib/leave/accrualEngine.js).
  // leave_types/leave_balances now live in Postgres (Phase 3a).
  const year = new Date().getFullYear();
  const activeLeaveTypes = await knex('leave_types').where({ isActive: true }).select('id');
  if (activeLeaveTypes.length) {
    await insertMany('leave_balances', activeLeaveTypes.map(lt => ({
      employeeId, leaveTypeId: lt.id, year,
      openingBalance: 0, accrued: 0, used: 0, pending: 0, carriedOver: 0, carryOverExpiry: null,
      closingBalance: 0, lastAccrualDate: null, updatedAt: new Date(),
    })));
  }

  // Grant this employee's first accrual immediately rather than making them wait for
  // the 1st-of-month cron — otherwise every new hire shows 0 days for up to a month.
  runAccrual(req.user.id, [employeeId]).catch(() => {});

  // Auto-start onboarding from the best-matching template, if any exist (fire-and-forget)
  (async () => {
    const template = await resolveDefaultTemplate(doc.department);
    if (template) await initiateOnboarding(employeeId, template._id, req.body.dateOfHire || new Date(), null);
  })().catch(() => {});

  // Job history: the initial hire entry
  await logJobHistoryChange({
    employeeId, changeType: 'hire', effectiveDate: doc.dateOfHire,
    previousValues: {}, newValues: { designation: doc.designation, department: doc.department, status: doc.status, employmentType: doc.employmentType, grossPay: doc.grossPay },
    changedBy: req.user.id, changedByName: req.user.name,
  });

  // Notify HR managers and super admins about new employee (fire-and-forget)
  const newEmpMsg = `${doc.fullName} (${staffNumber}) has been added as ${doc.designation} in ${doc.department}.`;
  notifyByRoles(['super_admin', 'hr_manager'], { title: '👤 New Employee Added', body: newEmpMsg, type: 'general' }).catch(() => {});
  notifyHR({
    type: 'hr', subType: 'new_employee',
    title: '👤 New Employee Added',
    subtitle: newEmpMsg,
    referenceId: employeeId, referenceModel: 'employees',
    requiresAction: false,
    triggeredBy: req.user.id,
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: employeeId, staffNumber });
};

const updateEmployee = async (req, res) => {
  if (req.body.paymentMethod === 'mpesa' && req.body.mpesaNumber !== undefined && !MPESA_NUMBER_REGEX.test(String(req.body.mpesaNumber || '').trim())) {
    return returnFunction(res, 400, false, MPESA_NUMBER_ERROR);
  }
  const existing = await findOne('employees', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);

  // Same crash this collection's unique email constraint would otherwise cause on
  // createEmployee — editing an employee's email to one already in use must fail with
  // a real message, not an unhandled unique-violation turned into "Internal Server Error."
  if (req.body.email) {
    const normalizedEmail = String(req.body.email).trim().toLowerCase();
    const emailTaken = await knex('employees').where({ email: normalizedEmail }).whereNot('id', existing.id).first();
    if (emailTaken) return returnFunction(res, 409, false, 'An employee with this email already exists.');
    req.body.email = normalizedEmail;
  }

  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  delete update.id;
  delete update.staffNumber;
  delete update.nationalId;
  delete update.changeReason; // consumed by job-history logging below, not a real employee field
  if (update.dateOfHire) update.dateOfHire = new Date(update.dateOfHire);
  if (update.contractEndDate) update.contractEndDate = new Date(update.contractEndDate);
  if (update.passportExpiryDate) update.passportExpiryDate = new Date(update.passportExpiryDate);
  if (update.probationEndDate) update.probationEndDate = new Date(update.probationEndDate);
  if (update.confirmationDate) update.confirmationDate = new Date(update.confirmationDate);
  if (update.terminationDate) update.terminationDate = new Date(update.terminationDate);
  if (update.nextOfKin !== undefined) update.nextOfKin = update.nextOfKin ? JSON.stringify(update.nextOfKin) : null;
  // jobGroupId/managerId/branchId are already plain id strings from the client — no
  // ObjectId wrapping needed against Postgres (undefined stays untouched-in-update;
  // explicit null clears the FK).

  await updateOne('employees', { id: existing.id }, update);
  const changedFields = await recordJobHistoryIfChanged(existing, update, req);
  if (update.status === 'terminated' && existing.status !== 'terminated') {
    await revokeLoginAccess(existing.id);
    await flagMissingOffboardingIfNeeded(existing);
  }
  if (update.grossPay !== undefined && update.grossPay !== existing.grossPay) {
    await syncBasicPayCompensation(existing.id, update.grossPay, req.user.id, existing.dateOfHire);
  }

  const notifiableFields = (changedFields || []).filter((f) => f !== 'status');
  if (notifiableFields.length) {
    const labels = notifiableFields.map((f) => FIELD_CHANGE_LABELS[f] || f).join(', ');
    notifyEmployee(existing.id, {
      title: 'Profile Updated',
      body: `Your ${labels} ${notifiableFields.length > 1 ? 'have' : 'has'} been updated by HR. Contact HR if you have any questions.`,
      type: 'general',
    }).catch(() => {});

    const empUser = await findOne('users', { employeeId: existing.id });
    if (empUser?.email) {
      const tokens = { employeeName: existing.fullName, fields: labels, plural: notifiableFields.length > 1 ? 'have' : 'has' };
      sendTemplatedEmail({
        trigger: 'employeeProfileUpdated', to: empUser.email, tokens,
        fallbackSubject: 'Your profile has been updated',
        fallbackHtml: `<p>Dear ${tokens.employeeName},</p><p>Your ${tokens.fields} ${tokens.plural} been updated by HR. Contact HR if you have any questions.</p>`,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const patchEmployeeStatus = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  const allowed = ['active', 'on_leave', 'suspended', 'terminated'];
  if (!allowed.includes(req.body.status)) return returnFunction(res, 400, false, 'Invalid status.');
  const existing = await findOne('employees', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const set = { status: req.body.status, updatedAt: new Date() };
  if (req.body.status === 'terminated') {
    set.terminationDate = new Date();
    set.terminationReason = req.body.terminationReason || null;
  }
  await updateOne('employees', { id: existing.id }, set);
  await recordJobHistoryIfChanged(existing, { status: req.body.status }, req);
  if (req.body.status === 'terminated') {
    await revokeLoginAccess(existing.id);
    await flagMissingOffboardingIfNeeded(existing);
  }
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteEmployee = async (req, res) => {
  const existing = await findOne('employees', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('employees', { id: existing.id }, {
    status: 'terminated', terminationDate: new Date(), terminationReason: req.body.terminationReason || null, updatedAt: new Date(),
  });
  await recordJobHistoryIfChanged(existing, { status: 'terminated' }, req);
  await revokeLoginAccess(existing.id);
  await flagMissingOffboardingIfNeeded(existing);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const getJobHistory = async (req, res) => {
  const history = await findMany('job_history', { employeeId: req.params.id }, {
    orderBy: [{ column: 'effectiveDate', order: 'desc' }, { column: 'createdAt', order: 'desc' }],
  });
  return returnFunction(res, 200, true, req.locale.success, history);
};

// ── Emergency Contacts (multiple; separate from the single legacy nextOfKin field) ──

const updateEmergencyContacts = async (req, res) => {
  if (!Array.isArray(req.body.emergencyContacts)) return returnFunction(res, 400, false, 'emergencyContacts must be an array.');
  const emergencyContacts = req.body.emergencyContacts.map(c => ({
    id: c.id || new ObjectId().toString(),
    employeeId: req.params.id,
    name: c.name, relationship: c.relationship || null, phone: c.phone, email: c.email || null,
  }));
  await replaceChildRows('employee_emergency_contacts', 'employeeId', req.params.id, emergencyContacts);
  await updateOne('employees', { id: req.params.id }, { updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, emergencyContacts);
};

// ── Skills, Certifications, Education (Skills & Qualifications tab) ──────────

const updateSkills = async (req, res) => {
  if (!Array.isArray(req.body.skills)) return returnFunction(res, 400, false, 'skills must be an array of strings.');
  const skills = req.body.skills.map(s => String(s).trim()).filter(Boolean);
  await replaceChildRows('employee_skills', 'employeeId', req.params.id,
    skills.map((skill, position) => ({ employeeId: req.params.id, skill, position })));
  await updateOne('employees', { id: req.params.id }, { updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, skills);
};

const addCertification = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'issuingOrganization', 'issueDate'])) return;
  const cert = await addChildRow('employee_certifications', {
    employeeId: req.params.id,
    name: req.body.name,
    issuingOrganization: req.body.issuingOrganization,
    issueDate: new Date(req.body.issueDate),
    expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
    fileUrl: req.body.fileUrl || null,
  });
  await updateOne('employees', { id: req.params.id }, { updatedAt: new Date() });
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, cert);
};

const deleteCertification = async (req, res) => {
  await deleteChildRow('employee_certifications', 'employeeId', req.params.id, req.params.certId);
  await updateOne('employees', { id: req.params.id }, { updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const addEducation = async (req, res) => {
  if (!validateRequiredFields(req, res, ['institution', 'degree', 'fieldOfStudy', 'startYear'])) return;
  const edu = await addChildRow('employee_education_history', {
    employeeId: req.params.id,
    institution: req.body.institution,
    degree: req.body.degree,
    fieldOfStudy: req.body.fieldOfStudy,
    startYear: Number(req.body.startYear),
    endYear: req.body.endYear ? Number(req.body.endYear) : null,
  });
  await updateOne('employees', { id: req.params.id }, { updatedAt: new Date() });
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, edu);
};

const deleteEducation = async (req, res) => {
  await deleteChildRow('employee_education_history', 'employeeId', req.params.id, req.params.eduId);
  await updateOne('employees', { id: req.params.id }, { updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const uploadDocument = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, req.locale.missingRequiredFields);
  if (!req.body.docType) return returnFunction(res, 400, false, req.locale.missingRequiredFields);

  const doc = await addChildRow('employee_documents', {
    employeeId: req.params.id,
    docType: req.body.docType,
    fileName: req.file.originalname,
    filePath: req.file.path,
    uploadedAt: new Date(),
  });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, doc);
};

const downloadDocument = async (req, res) => {
  const employee = await findOne('employees', { id: req.params.id });
  if (!employee) return returnFunction(res, 404, false, req.locale.notFound);
  const doc = await findOne('employee_documents', { id: req.params.docId, employeeId: req.params.id });
  if (!doc) return returnFunction(res, 404, false, req.locale.notFound);
  if (!fs.existsSync(doc.filePath)) return returnFunction(res, 404, false, 'File not found on server.');
  res.download(doc.filePath, doc.fileName);
};

const getOrgChart = async (req, res) => {
  let query = knex('employees').whereNot('status', 'terminated');

  // Dept heads only see their own department's branch — matches listEmployees' scoping.
  if (req.user.role === 'department_head') {
    const empRecord = req.user.employeeId
      ? await findOne('employees', { id: req.user.employeeId.toString() })
      : null;
    if (empRecord?.department) query = query.where({ department: empRecord.department });
    else return returnFunction(res, 200, true, req.locale.success, { departments: [], total: 0 });
  }

  const employees = await query
    .select('id', 'fullName', 'designation', 'department', 'status', 'staffNumber', 'profilePhoto', 'email', 'managerId')
    .orderBy('fullName', 'asc');

  // Real managerId-based hierarchy. An employee whose manager isn't in this
  // (possibly department-scoped) result set becomes a root — e.g. a department
  // head's own manager sits in a different department and won't be in a
  // department-scoped fetch, so their subtree still needs a place to attach.
  const nodeMap = {};
  employees.forEach(e => { nodeMap[e.id] = { ...e, _id: new ObjectId(e.id), reports: [] }; });
  const roots = [];
  employees.forEach(e => {
    const node = nodeMap[e.id];
    if (e.managerId && nodeMap[e.managerId]) {
      nodeMap[e.managerId].reports.push(node);
    } else {
      roots.push(node);
    }
  });

  const deptMap = {};
  for (const emp of employees) {
    const dept = emp.department || 'Unassigned';
    if (!deptMap[dept]) deptMap[dept] = { name: dept, employees: [] };
    deptMap[dept].employees.push({ ...emp, _id: new ObjectId(emp.id) });
  }

  const departments = Object.values(deptMap).sort((a, b) => b.employees.length - a.employees.length);
  return returnFunction(res, 200, true, req.locale.success, { tree: roots, departments, total: employees.length });
};

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
  const employees = await knex('employees')
    .whereIn('status', ['active', 'on_leave'])
    .select('id', 'fullName', 'staffNumber', 'department', 'designation', 'grossPay', 'jobGroupId', 'kraPin', 'bankAccountNumber', 'mpesaNumber');

  const incomplete = employees
    .map(emp => {
      const missing         = READINESS_CHECKS.filter(c => !c.test(emp));
      const missingLabels   = missing.map(c => c.label);
      const hasCritical     = missing.some(c => c.critical);
      if (!missing.length) return null;
      return {
        _id:          new ObjectId(emp.id),
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
  const employees = await knex('employees').whereIn('status', ['active', 'on_leave']).select('payGroup', 'payFrequency');
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
  await knex('employees').where({ payGroup: req.params.payGroup }).update({ payFrequency: req.body.payFrequency, updatedAt: new Date() });
  return returnFunction(res, 200, true, `Pay frequency updated for "${req.params.payGroup}".`);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Workforce Analytics — HR only
// ══════════════════════════════════════════════════════════════════════════════

const getHeadcountAnalytics = async (req, res) => {
  const [{ count: total }, byDepartment, byEmploymentType, byStatus] = await Promise.all([
    knex('employees').whereNot('status', 'terminated').count('* as count').first(),
    knex('employees').whereNot('status', 'terminated').select('department').count('* as count').groupBy('department').orderBy('count', 'desc'),
    knex('employees').whereNot('status', 'terminated').select('employmentType').count('* as count').groupBy('employmentType'),
    knex('employees').select('status').count('* as count').groupBy('status'),
  ]);
  return returnFunction(res, 200, true, req.locale.success, {
    total: Number(total),
    byDepartment: byDepartment.map(d => ({ department: d.department || 'Unassigned', count: Number(d.count) })),
    byEmploymentType: byEmploymentType.map(d => ({ employmentType: d.employmentType || 'Unspecified', count: Number(d.count) })),
    byStatus: byStatus.map(d => ({ status: d.status, count: Number(d.count) })),
  });
};

const getTurnoverAnalytics = async (req, res) => {
  const months = Math.min(Number(req.query.months) || 12, 24);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);

  const [hireRows, termRows] = await Promise.all([
    knex('employees').where('dateOfHire', '>=', start).select('dateOfHire'),
    knex('employees').where('terminationDate', '>=', start).select('terminationDate'),
  ]);

  const key = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
  const bucketCounts = (rows, field) => {
    const map = {};
    for (const r of rows) {
      const d = new Date(r[field]);
      const k = key(d.getFullYear(), d.getMonth() + 1);
      map[k] = (map[k] || 0) + 1;
    }
    return map;
  };
  const hireMap = bucketCounts(hireRows, 'dateOfHire');
  const termMap = bucketCounts(termRows, 'terminationDate');

  const series = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const k = key(d.getFullYear(), d.getMonth() + 1);
    series.push({ month: k, hires: hireMap[k] || 0, terminations: termMap[k] || 0 });
  }
  return returnFunction(res, 200, true, req.locale.success, series);
};

const getTenureAnalytics = async (req, res) => {
  const employees = await knex('employees').whereNot('status', 'terminated').select('department', 'dateOfHire');
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
  const [byGenderRows, byNationalityRows] = await Promise.all([
    knex('employees').whereNot('status', 'terminated').select('gender').count('* as count').groupBy('gender'),
    knex('employees').whereNot('status', 'terminated').select('nationality').count('* as count').groupBy('nationality').orderBy('count', 'desc'),
  ]);
  return returnFunction(res, 200, true, req.locale.success, {
    byGender: byGenderRows.map(g => ({ gender: g.gender || 'Not specified', count: Number(g.count) })),
    byNationality: byNationalityRows.map(n => ({ nationality: n.nationality || 'Not specified', count: Number(n.count) })),
  });
};

const getUpcomingAnalytics = async (req, res) => {
  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const cols = ['id', 'fullName', 'staffNumber', 'department', 'probationEndDate', 'passportExpiryDate', 'contractEndDate'];

  const [probations, passports, contracts] = await Promise.all([
    knex('employees').whereNot('status', 'terminated').whereBetween('probationEndDate', [now, in90]).orderBy('probationEndDate', 'asc').select(cols),
    knex('employees').whereNot('status', 'terminated').whereBetween('passportExpiryDate', [now, in90]).orderBy('passportExpiryDate', 'asc').select(cols),
    knex('employees').whereNot('status', 'terminated').whereBetween('contractEndDate', [now, in90]).orderBy('contractEndDate', 'asc').select(cols),
  ]);

  const bucket = (date) => {
    const days = Math.ceil((new Date(date) - now) / (1000 * 60 * 60 * 24));
    return days <= 30 ? 30 : days <= 60 ? 60 : 90;
  };
  const withBucket = (list, dateField) => list.map(e => ({
    ...e, _id: new ObjectId(e.id),
    daysRemaining: Math.ceil((new Date(e[dateField]) - now) / (1000 * 60 * 60 * 24)), bucket: bucket(e[dateField]),
  }));

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
  logJobHistoryChange,
};
