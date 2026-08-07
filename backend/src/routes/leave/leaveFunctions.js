const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 3a) —
// leave_types, public_holidays, leave_accrual_policies, leave_balances, leave_requests,
// leave_audit_log, leave_blackouts, employees, and users all now live in Postgres.
const { findMany, findOne, insertOne, updateOne, deleteOne, countDocuments, knex, newId } = require('../../functions/Database/pgDBFunctions');
const { notifyByRoles, notifyEmployee } = require('../../functions/HR/notifyUser');
const { notifyHR, notifyManager } = require('../inbox/inboxFunctions');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');
const { calculateLeaveDays } = require('../../lib/leave/dayCalculator');
const { resolveApprovalChain } = require('../../lib/leave/approvalChain');
const { checkEligibility, checkMinNotice, checkMaxConsecutive, checkOverlap, checkTeamOverlap } = require('../../lib/leave/eligibilityCheck');
const { runAccrual, runYearEndCarryOver } = require('../../lib/leave/accrualEngine');
const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD } = require('../../constants/roles');

const HR_ROLE_LIST = [SUPER_ADMIN, HR_MANAGER];
const isHR = (req) => HR_ROLE_LIST.includes(req.user?.role);

// ══════════════════════════════════════════════════════════════════════════════
//  Shared helpers
// ══════════════════════════════════════════════════════════════════════════════

// Resolves which employeeIds a given user is allowed to see across the
// role-scoped list/calendar/analytics endpoints. Returns null for "no
// restriction" (HR/super_admin see everyone).
const getScopedEmployeeIds = async (user) => {
  if (HR_ROLE_LIST.includes(user.role)) return null;
  if (user.role === DEPT_HEAD) {
    if (!user.department) return [];
    const emps = await knex('employees').where({ department: user.department }).select('id');
    return emps.map(e => e.id);
  }
  // staff acting as a manager (has direct reports) sees those + themselves;
  // otherwise this scope is empty (they should use /my/* instead).
  if (!user.employeeId) return [];
  const empId = String(user.employeeId);
  const directReports = await knex('employees').where({ managerId: empId }).select('id');
  const ids = directReports.map(e => e.id);
  ids.push(empId);
  return ids;
};

const enrichRequest = async (request) => {
  const [employee, leaveType] = await Promise.all([
    knex('employees').where({ id: request.employeeId }).select('fullName', 'staffNumber', 'department', 'designation').first(),
    knex('leave_types').where({ id: request.leaveTypeId }).select('name', 'code', 'color', 'isPaid').first(),
  ]);
  return { ...request, employee: employee || null, leaveType: leaveType || null };
};

const enrichBalance = async (balance) => {
  const leaveType = await knex('leave_types').where({ id: balance.leaveTypeId }).select('name', 'code', 'color', 'isPaid').first();
  return { ...balance, leaveType: leaveType || null };
};

// Batch versions of the two enrichers above — every list/calendar endpoint used to run
// enrichRequest/enrichBalance per row via Promise.all(rows.map(...)), which meant one
// (or two) findOne round-trips per row instead of one $in query for the whole page.
// Harmless at a handful of rows, but this pattern repeats across nearly every leave
// endpoint and was one of the biggest contributors to "everything feels slow."
const enrichRequests = async (requests) => {
  if (!requests.length) return [];
  const employeeIds  = [...new Set(requests.map(r => r.employeeId))];
  const leaveTypeIds = [...new Set(requests.map(r => r.leaveTypeId))];
  const [employees, leaveTypes] = await Promise.all([
    knex('employees').whereIn('id', employeeIds).select('id', 'fullName', 'staffNumber', 'department', 'designation'),
    knex('leave_types').whereIn('id', leaveTypeIds).select('id', 'name', 'code', 'color', 'isPaid'),
  ]);
  const empById  = Object.fromEntries(employees.map(e => [e.id, e]));
  const typeById = Object.fromEntries(leaveTypes.map(t => [t.id, t]));
  return requests.map(r => ({
    ...r,
    employee: empById[r.employeeId] || null,
    leaveType: typeById[r.leaveTypeId] || null,
  }));
};

const enrichBalances = async (balances, { includeEmployee = false } = {}) => {
  if (!balances.length) return [];
  const leaveTypeIds = [...new Set(balances.map(b => b.leaveTypeId))];
  const leaveTypes = await knex('leave_types').whereIn('id', leaveTypeIds).select('id', 'name', 'code', 'color', 'isPaid');
  const typeById = Object.fromEntries(leaveTypes.map(t => [t.id, t]));

  let empById = {};
  if (includeEmployee) {
    const employeeIds = [...new Set(balances.map(b => b.employeeId))];
    const employees = await knex('employees').whereIn('id', employeeIds).select('id', 'fullName', 'staffNumber', 'department');
    empById = Object.fromEntries(employees.map(e => [e.id, e]));
  }

  return balances.map(b => ({
    ...b,
    leaveType: typeById[b.leaveTypeId] || null,
    ...(includeEmployee ? { employee: empById[b.employeeId] || null } : {}),
  }));
};

const recomputeClosing = async (employeeId, leaveTypeId, year) => {
  const bal = await findOne('leave_balances', { employeeId: String(employeeId), leaveTypeId: String(leaveTypeId), year });
  if (!bal) return null;
  const closingBalance = Number(bal.openingBalance) + Number(bal.accrued) + Number(bal.carriedOver) - Number(bal.used) - Number(bal.pending);
  await updateOne('leave_balances', { id: bal.id }, { closingBalance, updatedAt: new Date() });
  return closingBalance;
};

const logAudit = async ({ leaveRequestId, employeeId, action, performedBy, performedByName, previousValue, newValue, comment }) => {
  await insertOne('leave_audit_log', {
    leaveRequestId: leaveRequestId ? String(leaveRequestId) : null,
    employeeId: String(employeeId),
    action, performedBy: performedBy ? String(performedBy) : null, performedByName: performedByName || null,
    previousValue: previousValue !== undefined ? JSON.stringify(previousValue) : null,
    newValue: newValue !== undefined ? JSON.stringify(newValue) : null,
    comment: comment || null,
    timestamp: new Date(),
  });
};

// ══════════════════════════════════════════════════════════════════════════════
//  Leave Types — HR only
// ══════════════════════════════════════════════════════════════════════════════

const createLeaveType = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'code'])) return;
  const {
    name, description, isPaid, isCarryOverAllowed, maxCarryOverDays, carryOverExpiryMonths,
    requiresApproval, requiresAttachment, minNoticeDays, maxConsecutiveDays, eligibilityMonths,
    countPublicHolidays, color, appliesTo,
  } = req.body;
  const doc = {
    name: name.trim(), code: req.body.code.trim().toUpperCase(), description: description || '',
    isPaid: isPaid !== false, isCarryOverAllowed: !!isCarryOverAllowed,
    maxCarryOverDays: maxCarryOverDays != null ? Number(maxCarryOverDays) : null,
    carryOverExpiryMonths: carryOverExpiryMonths != null ? Number(carryOverExpiryMonths) : null,
    requiresApproval: requiresApproval !== false, requiresAttachment: !!requiresAttachment,
    minNoticeDays: minNoticeDays != null ? Number(minNoticeDays) : null,
    maxConsecutiveDays: maxConsecutiveDays != null ? Number(maxConsecutiveDays) : null,
    eligibilityMonths: eligibilityMonths != null ? Number(eligibilityMonths) : null,
    countPublicHolidays: !!countPublicHolidays, color: color || '#3b82f6', isActive: true,
    appliesTo: JSON.stringify(appliesTo || {}), createdBy: req.user?.id || null, createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('leave_types', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listLeaveTypes = async (req, res) => {
  const types = await findMany('leave_types', {}, { orderBy: 'name' });
  return returnFunction(res, 200, true, req.locale.success, types);
};

const getLeaveType = async (req, res) => {
  const type = await findOne('leave_types', { id: req.params.id });
  if (!type) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, type);
};

const updateLeaveType = async (req, res) => {
  const existing = await findOne('leave_types', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const ALLOWED = [
    'name', 'description', 'isPaid', 'isCarryOverAllowed', 'maxCarryOverDays', 'carryOverExpiryMonths',
    'requiresApproval', 'requiresAttachment', 'minNoticeDays', 'maxConsecutiveDays', 'eligibilityMonths',
    'countPublicHolidays', 'color', 'isActive',
  ];
  const update = { updatedAt: new Date() };
  for (const key of ALLOWED) if (req.body[key] !== undefined) update[key] = req.body[key];
  if (req.body.appliesTo !== undefined) update.appliesTo = JSON.stringify(req.body.appliesTo);
  if (req.body.code !== undefined) update.code = req.body.code.trim().toUpperCase();
  await updateOne('leave_types', { id: existing.id }, update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteLeaveType = async (req, res) => {
  const existing = await findOne('leave_types', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('leave_types', { id: existing.id }, { isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Public Holidays — HR manages, all roles can view
// ══════════════════════════════════════════════════════════════════════════════

const createPublicHoliday = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'date'])) return;
  const { name, date, isRecurringAnnually, appliesTo } = req.body;
  const doc = {
    name: name.trim(), date: new Date(date).toISOString().split('T')[0],
    isRecurringAnnually: !!isRecurringAnnually, appliesTo: JSON.stringify(appliesTo || []),
    createdBy: req.user?.id || null, createdAt: new Date(),
  };
  const result = await insertOne('public_holidays', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listPublicHolidays = async (req, res) => {
  let query = knex('public_holidays');
  if (req.query.year) {
    query = query.where('date', '>=', `${req.query.year}-01-01`).where('date', '<=', `${req.query.year}-12-31`);
  }
  const holidays = await query.orderBy('date', 'asc');
  return returnFunction(res, 200, true, req.locale.success, holidays);
};

const updatePublicHoliday = async (req, res) => {
  const existing = await findOne('public_holidays', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const update = {};
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.date !== undefined) update.date = new Date(req.body.date).toISOString().split('T')[0];
  if (req.body.isRecurringAnnually !== undefined) update.isRecurringAnnually = !!req.body.isRecurringAnnually;
  if (req.body.appliesTo !== undefined) update.appliesTo = JSON.stringify(req.body.appliesTo);
  await updateOne('public_holidays', { id: existing.id }, update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deletePublicHoliday = async (req, res) => {
  const existing = await findOne('public_holidays', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await deleteOne('public_holidays', { id: existing.id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Accrual Policies — HR only
// ══════════════════════════════════════════════════════════════════════════════

const createAccrualPolicy = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'leaveTypeId', 'accrualFrequency', 'accrualAmount', 'maxAnnualEntitlement'])) return;
  const { name, leaveTypeId, accrualFrequency, accrualAmount, maxAnnualEntitlement, appliesTo } = req.body;
  const doc = {
    name: name.trim(), leaveTypeId, accrualFrequency,
    accrualAmount: Number(accrualAmount), maxAnnualEntitlement: Number(maxAnnualEntitlement),
    appliesTo: JSON.stringify(appliesTo || {}), isActive: true, createdBy: req.user?.id || null, createdAt: new Date(),
  };
  const result = await insertOne('leave_accrual_policies', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listAccrualPolicies = async (req, res) => {
  const policies = await findMany('leave_accrual_policies', {}, { orderBy: { column: 'createdAt', order: 'desc' } });
  const leaveTypeIds = [...new Set(policies.map(p => p.leaveTypeId))];
  const leaveTypes = leaveTypeIds.length ? await knex('leave_types').whereIn('id', leaveTypeIds).select('id', 'name', 'code') : [];
  const typeById = Object.fromEntries(leaveTypes.map(t => [t.id, t]));
  const enriched = policies.map(p => ({ ...p, leaveType: typeById[p.leaveTypeId] || null }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getAccrualPolicy = async (req, res) => {
  const policy = await findOne('leave_accrual_policies', { id: req.params.id });
  if (!policy) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, policy);
};

const updateAccrualPolicy = async (req, res) => {
  const existing = await findOne('leave_accrual_policies', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const update = {};
  const { name, leaveTypeId, accrualFrequency, accrualAmount, maxAnnualEntitlement, appliesTo, isActive } = req.body;
  if (name !== undefined) update.name = name.trim();
  if (leaveTypeId !== undefined) update.leaveTypeId = leaveTypeId;
  if (accrualFrequency !== undefined) update.accrualFrequency = accrualFrequency;
  if (accrualAmount !== undefined) update.accrualAmount = Number(accrualAmount);
  if (maxAnnualEntitlement !== undefined) update.maxAnnualEntitlement = Number(maxAnnualEntitlement);
  if (appliesTo !== undefined) update.appliesTo = JSON.stringify(appliesTo);
  if (isActive !== undefined) update.isActive = isActive;
  await updateOne('leave_accrual_policies', { id: existing.id }, update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteAccrualPolicy = async (req, res) => {
  const existing = await findOne('leave_accrual_policies', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await deleteOne('leave_accrual_policies', { id: existing.id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const runAccrualPolicies = async (req, res) => {
  const result = await runAccrual(req.user?.id || null);
  return returnFunction(res, 200, true, `Accrual run complete. ${result.processed} balance(s) updated.`, result);
};

const runYearEndCarryForward = async (req, res) => {
  const result = await runYearEndCarryOver(req.user?.id || null);
  return returnFunction(res, 200, true, `Carry-over run complete. ${result.processed} balance(s) created.`, result);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Leave Balances
// ══════════════════════════════════════════════════════════════════════════════

const getLeaveBalances = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  let query = knex('leave_balances');
  if (scopedIds !== null) query = query.whereIn('employeeId', scopedIds);
  if (req.query.year) query = query.where({ year: Number(req.query.year) });
  const balances = await query;
  const enriched = await enrichBalances(balances, { includeEmployee: true });
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getEmployeeLeaveBalances = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.some(id => id === req.params.employeeId)) {
    return returnFunction(res, 403, false, 'You cannot view this employee\'s leave balances.');
  }
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  const balances = await findMany('leave_balances', { employeeId: req.params.employeeId, year });
  const enriched = await enrichBalances(balances);
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const adjustLeaveBalance = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'leaveTypeId', 'amount', 'reason'])) return;
  const { employeeId, leaveTypeId, amount, reason } = req.body;
  const year = req.body.year ? Number(req.body.year) : new Date().getFullYear();
  const numAmount = Number(amount);
  if (!numAmount) return returnFunction(res, 400, false, 'Amount must not be zero.');

  let balance = await findOne('leave_balances', { employeeId, leaveTypeId, year });
  if (!balance) {
    balance = await insertOne('leave_balances', {
      employeeId, leaveTypeId, year,
      openingBalance: 0, accrued: 0, used: 0, pending: 0, carriedOver: 0, carryOverExpiry: null,
      closingBalance: 0, lastAccrualDate: null, updatedAt: new Date(),
    });
  }

  const previousOpening = Number(balance.openingBalance);
  await knex('leave_balances').where({ id: balance.id }).update({
    openingBalance: knex.raw('"openingBalance" + ?', [numAmount]), updatedAt: new Date(),
  });
  const closingBalance = await recomputeClosing(employeeId, leaveTypeId, year);

  await logAudit({
    employeeId, action: 'balanceAdjusted', performedBy: req.user?.id, performedByName: req.user?.name,
    previousValue: { openingBalance: previousOpening }, newValue: { openingBalance: previousOpening + numAmount }, comment: reason,
  });

  return returnFunction(res, 200, true, 'Balance adjusted.', { closingBalance });
};

// ══════════════════════════════════════════════════════════════════════════════
//  Leave Requests
// ══════════════════════════════════════════════════════════════════════════════

const listLeaveRequests = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const scopedIds = await getScopedEmployeeIds(req.user);
  let query = knex('leave_requests');
  if (scopedIds !== null) query = query.whereIn('employeeId', scopedIds);
  if (req.query.employeeId) {
    if (scopedIds !== null && !scopedIds.includes(req.query.employeeId)) {
      query = query.whereRaw('1 = 0');
    } else {
      query = knex('leave_requests').where({ employeeId: req.query.employeeId });
    }
  }
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.leaveTypeId) query = query.where({ leaveTypeId: req.query.leaveTypeId });
  if (req.query.startDate) query = query.where('startDate', '>=', new Date(req.query.startDate));
  if (req.query.endDate) query = query.where('startDate', '<=', new Date(req.query.endDate));

  const [{ count }, requests] = await Promise.all([
    query.clone().count('* as count').first(),
    query.clone().orderBy('createdAt', 'desc').offset(skip).limit(limit),
  ]);
  let enriched = await enrichRequests(requests);

  if (req.query.department) enriched = enriched.filter(r => r.employee?.department === req.query.department);
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    enriched = enriched.filter(r => r.employee?.fullName.toLowerCase().includes(q));
  }

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

// CSV export of leave requests over a date range — same filter/scoping rules as
// listLeaveRequests, minus pagination, so HR (or a scoped manager/dept_head) can pull a
// raw list of who took what leave, when, for how long, and its outcome.
const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportLeaveRequestsCSV = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  let query = knex('leave_requests');
  if (scopedIds !== null) query = query.whereIn('employeeId', scopedIds);
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.leaveTypeId) query = query.where({ leaveTypeId: req.query.leaveTypeId });
  if (req.query.startDate) query = query.where('startDate', '>=', new Date(req.query.startDate));
  if (req.query.endDate) query = query.where('startDate', '<=', new Date(req.query.endDate));

  const requests = await query.orderBy('startDate', 'desc');
  let enriched = await enrichRequests(requests);
  if (req.query.department) enriched = enriched.filter((r) => r.employee?.department === req.query.department);

  const header = 'StaffNo,Name,Department,LeaveType,StartDate,EndDate,TotalDays,Status,LastUpdated';
  const rows = enriched.map((r) => [
    r.employee?.staffNumber || '',
    r.employee?.fullName || '',
    r.employee?.department || '',
    r.leaveType?.name || '',
    r.startDate ? new Date(r.startDate).toISOString().split('T')[0] : '',
    r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '',
    r.totalDays ?? '',
    r.status || '',
    r.updatedAt ? new Date(r.updatedAt).toISOString().split('T')[0] : '',
  ].map(csvEscape).join(','));
  const csv = [header, ...rows].join('\n');

  const from = req.query.startDate || 'all';
  const to = req.query.endDate || 'time';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leave-requests-${from}-to-${to}.csv"`);
  return res.send(csv);
};

const getLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { id: req.params.id });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.includes(request.employeeId)) {
    return returnFunction(res, 403, false, 'You cannot view this leave request.');
  }
  const enriched = await enrichRequest(request);
  const auditLog = await findMany('leave_audit_log', { leaveRequestId: request.id }, { orderBy: 'timestamp' });
  return returnFunction(res, 200, true, req.locale.success, { ...enriched, auditLog });
};

const createLeaveRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['leaveTypeId', 'startDate', 'endDate'])) return;
  const employeeId = req.user?.employeeId ? String(req.user.employeeId) : null;
  if (!employeeId) return returnFunction(res, 403, false, 'No employee record linked to your account.');

  const { leaveTypeId, startDate, endDate, halfDay, reason, attachmentUrl } = req.body;
  const [employee, leaveType] = await Promise.all([
    findOne('employees', { id: employeeId }),
    findOne('leave_types', { id: leaveTypeId }),
  ]);
  if (!employee) return returnFunction(res, 404, false, 'Employee record not found.');
  if (!leaveType || !leaveType.isActive) return returnFunction(res, 404, false, 'Leave type not found or inactive.');
  if (leaveType.requiresAttachment && !attachmentUrl) return returnFunction(res, 400, false, `${leaveType.name} requires a supporting attachment.`);

  const eligibility = checkEligibility(employee, leaveType);
  if (!eligibility.eligible) return returnFunction(res, 400, false, eligibility.message);

  const notice = checkMinNotice(leaveType, startDate);
  if (!notice.ok) return returnFunction(res, 400, false, notice.message);

  const overlap = await checkOverlap(employeeId, startDate, endDate);
  if (overlap) return returnFunction(res, 409, false, 'You already have a leave request for this period.');

  const totalDays = await calculateLeaveDays({ startDate, endDate, countPublicHolidays: leaveType.countPublicHolidays, halfDay });
  if (totalDays <= 0) return returnFunction(res, 400, false, 'Selected dates contain no working days.');

  const maxConsecutive = checkMaxConsecutive(leaveType, totalDays);
  if (!maxConsecutive.ok) return returnFunction(res, 400, false, maxConsecutive.message);

  const year = new Date(startDate).getFullYear();
  const balance = await findOne('leave_balances', { employeeId: employee.id, leaveTypeId: leaveType.id, year });
  if (!balance) return returnFunction(res, 400, false, `No ${leaveType.name} balance record found for ${year}. Contact HR.`);
  if (totalDays > balance.closingBalance) {
    return returnFunction(res, 400, false, `Insufficient balance: ${balance.closingBalance} day(s) remaining, ${totalDays} requested.`);
  }

  const teamOverlap = await checkTeamOverlap(employee.department, startDate, endDate, employee.id);

  const approvalChain = leaveType.requiresApproval ? await resolveApprovalChain(employee, totalDays) : [];
  const status = approvalChain.length ? 'pending' : 'approved';

  const now = new Date();
  const doc = {
    employeeId: employee.id, leaveTypeId: leaveType.id,
    startDate: new Date(startDate), endDate: new Date(endDate), totalDays,
    halfDay: halfDay || null, reason: reason || '', attachmentUrl: attachmentUrl || null,
    status, approvalChain: JSON.stringify(approvalChain), currentApprovalLevel: approvalChain.length ? 1 : 0,
    rejectionReason: null, cancelledAt: null, cancelledBy: null,
    revokedAt: null, revokedBy: null, disputeReason: null, disputeSource: null, disputeResolvedAt: null, disputeResolvedBy: null,
    proposedDays: null, counterOfferReason: null,
    payrollRunId: null, createdAt: now, updatedAt: now,
  };
  const result = await insertOne('leave_requests', doc);

  await knex('leave_balances').where({ id: balance.id }).update({ pending: knex.raw('"pending" + ?', [totalDays]), updatedAt: now });
  await recomputeClosing(employee.id, leaveType.id, year);

  await logAudit({ leaveRequestId: result.id, employeeId: employee.id, action: 'submitted', performedBy: req.user.id, performedByName: employee.fullName, newValue: { status, totalDays } });

  const employeeUser = await knex('users').where({ employeeId: employee.id }).select('email').first();
  const emailTokens = {
    employeeName: employee.fullName, leaveType: leaveType.name, totalDays,
    startDate: new Date(startDate).toDateString(), endDate: new Date(endDate).toDateString(),
  };
  const reviewUrl = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/en/leave/requests/${result.id}`;

  if (approvalChain.length) {
    const firstApprover = approvalChain[0];
    notifyEmployee(employee.id, { title: 'Leave Request Submitted', body: `Your ${leaveType.name} request (${totalDays} day(s)) is pending approval.`, type: 'leave', link: `/my/leave/requests/${result.id}` }).catch(() => {});
    if (employeeUser?.email) {
      sendTemplatedEmail({
        trigger: 'leaveRequestSubmitted', to: employeeUser.email, tokens: emailTokens,
        fallbackSubject: 'Your leave request has been submitted',
        fallbackHtml: `<p>Dear ${employee.fullName},</p><p>Your ${leaveType.name} request for ${totalDays} day(s), from ${emailTokens.startDate} to ${emailTokens.endDate}, has been submitted and is pending approval.</p>`,
      }).catch(() => {});
    }
    const inboxItem = {
      type: 'leave', subType: 'leave_request', title: `Leave request: ${employee.fullName}`,
      subtitle: `${leaveType.name} · ${totalDays} day(s) · ${new Date(startDate).toDateString()} - ${new Date(endDate).toDateString()}`,
      referenceId: result.id, referenceModel: 'leave_requests', requiresAction: true,
      triggeredBy: employee.id,
    };
    // notifyManager silently no-ops if the employee has no managerId on file — HR must
    // always get a copy regardless, otherwise a leave request can go completely
    // unnoticed by anyone until it's disputed (the only other place HR was notified).
    notifyManager(employee.id, inboxItem).catch(() => {});
    notifyHR(inboxItem).catch(() => {});

    // Approver previously only got an in-app inbox item — easy to miss, and this is
    // the one point in the whole leave flow where someone other than the employee
    // needs to actually take action, so it gets its own email too.
    const approverUser = await knex('users').where({ id: firstApprover.approverId }).select('email').first();
    if (approverUser?.email) {
      const tokens = { ...emailTokens, approverName: firstApprover.approverName || 'there', reviewUrl };
      sendTemplatedEmail({
        trigger: 'leaveRequestAwaitingApproval', to: approverUser.email, tokens,
        fallbackSubject: `Leave request awaiting your approval — ${employee.fullName}`,
        fallbackHtml: `<p>Dear ${tokens.approverName},</p><p>${employee.fullName} has requested ${leaveType.name} for ${totalDays} day(s), from ${emailTokens.startDate} to ${emailTokens.endDate}.</p><p><a href="${reviewUrl}">Review this request</a></p>`,
      }).catch(() => {});
    }
  } else {
    notifyEmployee(employee.id, { title: 'Leave Request Approved', body: `Your ${leaveType.name} request was auto-approved (no approval required for this leave type).`, type: 'leave', link: `/my/leave/requests/${result.id}` }).catch(() => {});
    if (employeeUser?.email) {
      sendTemplatedEmail({
        trigger: 'leaveRequestApproved', to: employeeUser.email, tokens: emailTokens,
        fallbackSubject: 'Your leave request has been approved',
        fallbackHtml: `<p>Dear ${employee.fullName},</p><p>Your ${leaveType.name} request for ${totalDays} day(s), from ${emailTokens.startDate} to ${emailTokens.endDate}, has been approved.</p>`,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 201, true, 'Leave request submitted.', {
    _id: result.id, totalDays, status, approvalChain,
    teamOverlapWarning: teamOverlap.warn ? `${teamOverlap.count} other employee(s) from your department are already off during this period.` : null,
  });
};

const updateMyDraftRequest = async (req, res) => {
  const employeeId = req.user?.employeeId ? String(req.user.employeeId) : null;
  const request = await findOne('leave_requests', { id: req.params.id, employeeId });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'draft') return returnFunction(res, 400, false, 'Only draft requests can be edited.');
  const ALLOWED = ['leaveTypeId', 'startDate', 'endDate', 'halfDay', 'reason', 'attachmentUrl'];
  const update = { updatedAt: new Date() };
  for (const key of ALLOWED) if (req.body[key] !== undefined) update[key] = req.body[key];
  await updateOne('leave_requests', { id: request.id }, update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Restores balance (pending -= totalDays) — shared by reject/cancel/revoke.
const restorePendingBalance = async (request) => {
  const year = new Date(request.startDate).getFullYear();
  await knex('leave_balances').where({ employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year })
    .update({ pending: knex.raw('"pending" - ?', [request.totalDays]), updatedAt: new Date() });
  await recomputeClosing(request.employeeId, request.leaveTypeId, year);
};

const approveLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { id: req.params.id });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'pending') return returnFunction(res, 400, false, 'This request is not pending.');

  const currentStep = request.approvalChain.find(c => c.level === request.currentApprovalLevel);
  const authorized = isHR(req) || (currentStep && currentStep.approverId === req.user.id);
  if (!authorized) return returnFunction(res, 403, false, 'You are not authorized to approve this request at its current level.');

  const now = new Date();
  const updatedChain = request.approvalChain.map(c => c.level === request.currentApprovalLevel
    ? { ...c, status: 'approved', actedAt: now, comment: req.body.comment || null }
    : c);
  const nextLevel = updatedChain.find(c => c.level === request.currentApprovalLevel + 1);

  if (nextLevel) {
    await updateOne('leave_requests', { id: request.id }, {
      approvalChain: JSON.stringify(updatedChain), currentApprovalLevel: nextLevel.level, updatedAt: now,
    });
    notifyEmployee(request.employeeId, { title: 'Leave Request Update', body: 'Your leave request was approved at one level and is now awaiting the next approver.', type: 'leave', link: `/my/leave/requests/${request.id}` }).catch(() => {});
    await logAudit({ leaveRequestId: request.id, employeeId: request.employeeId, action: 'approved', performedBy: req.user.id, performedByName: req.user.name, comment: `Level ${request.currentApprovalLevel} approved` });

    const [nextApproverUser, emp, leaveType] = await Promise.all([
      knex('users').where({ id: nextLevel.approverId }).select('email').first(),
      knex('employees').where({ id: request.employeeId }).select('fullName').first(),
      knex('leave_types').where({ id: request.leaveTypeId }).select('name').first(),
    ]);
    if (nextApproverUser?.email) {
      const reviewUrl = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/en/leave/requests/${request.id}`;
      const tokens = {
        approverName: nextLevel.approverName || 'there', employeeName: emp?.fullName || 'An employee',
        leaveType: leaveType?.name || 'leave', totalDays: request.totalDays,
        startDate: new Date(request.startDate).toDateString(), endDate: new Date(request.endDate).toDateString(), reviewUrl,
      };
      sendTemplatedEmail({
        trigger: 'leaveRequestAwaitingApproval', to: nextApproverUser.email, tokens,
        fallbackSubject: `Leave request awaiting your approval — ${tokens.employeeName}`,
        fallbackHtml: `<p>Dear ${tokens.approverName},</p><p>${tokens.employeeName} has requested ${tokens.leaveType} for ${tokens.totalDays} day(s), from ${tokens.startDate} to ${tokens.endDate}.</p><p><a href="${reviewUrl}">Review this request</a></p>`,
      }).catch(() => {});
    }
    return returnFunction(res, 200, true, 'Approved at this level. Awaiting next approver.');
  }

  const year = new Date(request.startDate).getFullYear();
  await updateOne('leave_requests', { id: request.id }, { approvalChain: JSON.stringify(updatedChain), status: 'approved', updatedAt: now });
  await knex('leave_balances').where({ employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year })
    .update({ pending: knex.raw('"pending" - ?', [request.totalDays]), used: knex.raw('"used" + ?', [request.totalDays]), updatedAt: now });
  await recomputeClosing(request.employeeId, request.leaveTypeId, year);

  const today = new Date();
  if (new Date(request.startDate) <= today && today <= new Date(request.endDate)) {
    await updateOne('employees', { id: request.employeeId }, { status: 'on_leave', updatedAt: now });
  }

  await logAudit({ leaveRequestId: request.id, employeeId: request.employeeId, action: 'approved', performedBy: req.user.id, performedByName: req.user.name, comment: 'Final approval' });
  notifyEmployee(request.employeeId, { title: 'Leave Request Approved', body: 'Your leave request has been fully approved.', type: 'leave', link: `/my/leave/requests/${request.id}` }).catch(() => {});

  {
    const [approvedEmployeeUser, emp, leaveType] = await Promise.all([
      knex('users').where({ employeeId: request.employeeId }).select('email').first(),
      knex('employees').where({ id: request.employeeId }).select('fullName').first(),
      knex('leave_types').where({ id: request.leaveTypeId }).select('name').first(),
    ]);
    if (approvedEmployeeUser?.email) {
      const tokens = {
        employeeName: emp?.fullName || 'there', leaveType: leaveType?.name || 'leave', totalDays: request.totalDays,
        startDate: new Date(request.startDate).toDateString(), endDate: new Date(request.endDate).toDateString(),
      };
      sendTemplatedEmail({
        trigger: 'leaveRequestApproved', to: approvedEmployeeUser.email, tokens,
        fallbackSubject: 'Your leave request has been approved',
        fallbackHtml: `<p>Dear ${tokens.employeeName},</p><p>Your ${tokens.leaveType} request for ${tokens.totalDays} day(s), from ${tokens.startDate} to ${tokens.endDate}, has been approved.</p>`,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, 'Leave request approved.');
};

const rejectLeaveRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['rejectionReason'])) return;
  const request = await findOne('leave_requests', { id: req.params.id });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'pending') return returnFunction(res, 400, false, 'This request is not pending.');

  const currentStep = request.approvalChain.find(c => c.level === request.currentApprovalLevel);
  const authorized = isHR(req) || (currentStep && currentStep.approverId === req.user.id);
  if (!authorized) return returnFunction(res, 403, false, 'You are not authorized to reject this request at its current level.');

  const now = new Date();
  const updatedChain = request.approvalChain.map(c => c.level === request.currentApprovalLevel
    ? { ...c, status: 'rejected', actedAt: now, comment: req.body.rejectionReason }
    : c);
  await updateOne('leave_requests', { id: request.id }, {
    approvalChain: JSON.stringify(updatedChain), status: 'rejected', rejectionReason: req.body.rejectionReason, updatedAt: now,
  });
  await restorePendingBalance(request);

  await logAudit({ leaveRequestId: request.id, employeeId: request.employeeId, action: 'rejected', performedBy: req.user.id, performedByName: req.user.name, comment: req.body.rejectionReason });
  notifyEmployee(request.employeeId, { title: 'Leave Request Rejected', body: req.body.rejectionReason, type: 'leave', link: `/my/leave/requests/${request.id}` }).catch(() => {});

  {
    const [rejectedEmployeeUser, emp, leaveType] = await Promise.all([
      knex('users').where({ employeeId: request.employeeId }).select('email').first(),
      knex('employees').where({ id: request.employeeId }).select('fullName').first(),
      knex('leave_types').where({ id: request.leaveTypeId }).select('name').first(),
    ]);
    if (rejectedEmployeeUser?.email) {
      const tokens = { employeeName: emp?.fullName || 'there', leaveType: leaveType?.name || 'leave', rejectionReason: req.body.rejectionReason };
      sendTemplatedEmail({
        trigger: 'leaveRequestRejected', to: rejectedEmployeeUser.email, tokens,
        fallbackSubject: 'Your leave request was not approved',
        fallbackHtml: `<p>Dear ${tokens.employeeName},</p><p>Your ${tokens.leaveType} request was not approved.</p><p>Reason: ${tokens.rejectionReason}</p>`,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, 'Leave request rejected.');
};

// ── Partial Approval (Counter-Offer) ─────────────────────────────────────────
// HR proposes fewer days than requested instead of a flat approve/reject; the
// employee then accepts or disputes it from their own portal.

const counterOfferLeaveRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['proposedDays'])) return;
  const request = await findOne('leave_requests', { id: req.params.id });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'pending') return returnFunction(res, 400, false, 'This request is not pending.');

  const proposedDays = Number(req.body.proposedDays);
  if (!(proposedDays > 0) || !(proposedDays < request.totalDays)) {
    return returnFunction(res, 400, false, 'Proposed days must be greater than 0 and less than the requested total days.');
  }

  const now = new Date();
  const counterOfferReason = req.body.counterOfferReason || '';
  await updateOne('leave_requests', { id: request.id }, {
    status: 'counter_offered', proposedDays, counterOfferReason, updatedAt: now,
  });

  await logAudit({
    leaveRequestId: request.id, employeeId: request.employeeId, action: 'counterOffered',
    performedBy: req.user.id, performedByName: req.user.name, comment: counterOfferReason,
    previousValue: { totalDays: request.totalDays }, newValue: { proposedDays },
  });

  notifyEmployee(request.employeeId, {
    title: 'Leave Counter-Offer',
    body: `Your leave request has been counter-offered. You have been proposed ${proposedDays} days instead of ${request.totalDays}. Please review and respond from your portal.`,
    type: 'leave',
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Counter-offer sent to employee.');
};

const acceptCounterOffer = async (req, res) => {
  const request = await findOne('leave_requests', { id: req.params.id, employeeId: String(req.user.employeeId) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'counter_offered') return returnFunction(res, 400, false, 'This request has no pending counter-offer.');

  const now = new Date();
  const originalTotalDays = request.totalDays;
  const newTotalDays = request.proposedDays;

  await updateOne('leave_requests', { id: request.id }, {
    status: 'approved', totalDays: newTotalDays, updatedAt: now,
  });

  // Only the accepted (smaller) day count is actually consumed — release the rest
  // of what was reserved as `pending` back to the employee's available balance.
  const year = new Date(request.startDate).getFullYear();
  await knex('leave_balances').where({ employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year })
    .update({ pending: knex.raw('"pending" - ?', [originalTotalDays]), used: knex.raw('"used" + ?', [newTotalDays]), updatedAt: now });
  await recomputeClosing(request.employeeId, request.leaveTypeId, year);

  const today = new Date();
  if (new Date(request.startDate) <= today && today <= new Date(request.endDate)) {
    await updateOne('employees', { id: request.employeeId }, { status: 'on_leave', updatedAt: now });
  }

  await logAudit({
    leaveRequestId: request.id, employeeId: request.employeeId, action: 'counterAccepted',
    performedBy: req.user.id, performedByName: req.user.name,
    comment: `Accepted ${newTotalDays} day(s) instead of ${originalTotalDays}`,
  });

  notifyByRoles(HR_ROLE_LIST, {
    title: 'Counter-Offer Accepted',
    body: `${req.user.name || 'An employee'} accepted the counter-offer of ${newTotalDays} day(s) for their leave request.`,
    type: 'leave',
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Counter-offer accepted. Leave approved.');
};

const disputeCounterOffer = async (req, res) => {
  if (!validateRequiredFields(req, res, ['reason'])) return;
  const request = await findOne('leave_requests', { id: req.params.id, employeeId: String(req.user.employeeId) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'counter_offered') return returnFunction(res, 400, false, 'This request has no pending counter-offer.');

  const now = new Date();
  await updateOne('leave_requests', { id: request.id }, {
    status: 'disputed', disputeReason: req.body.reason, disputeSource: 'counterOffer', updatedAt: now,
  });

  await logAudit({
    leaveRequestId: request.id, employeeId: request.employeeId, action: 'counterDisputed',
    performedBy: req.user.id, performedByName: req.user.name, comment: req.body.reason,
  });

  notifyHR({
    type: 'leave', subType: 'leave_dispute', title: 'Leave Counter-Offer Disputed',
    subtitle: req.body.reason, referenceId: request.id, referenceModel: 'leave_requests', requiresAction: true,
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Dispute submitted. HR will review.');
};

const cancelLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { id: req.params.id });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);

  const isOwner = request.employeeId === String(req.user.employeeId);
  if (!isHR(req) && !isOwner) return returnFunction(res, 403, false, 'You cannot cancel this request.');
  if (isOwner && !isHR(req) && request.status !== 'pending' && request.status !== 'draft') {
    return returnFunction(res, 400, false, 'Only pending or draft requests can be cancelled.');
  }
  if (!['pending', 'draft', 'approved'].includes(request.status)) {
    return returnFunction(res, 400, false, 'This request cannot be cancelled.');
  }

  const now = new Date();
  const originalStatus = request.status;
  await updateOne('leave_requests', { id: request.id }, {
    status: 'cancelled', cancelledAt: now, cancelledBy: req.user.id, updatedAt: now,
  });

  if (originalStatus === 'pending') {
    await restorePendingBalance(request);
  } else if (originalStatus === 'approved') {
    const year = new Date(request.startDate).getFullYear();
    await knex('leave_balances').where({ employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year })
      .update({ used: knex.raw('"used" - ?', [request.totalDays]), updatedAt: now });
    await recomputeClosing(request.employeeId, request.leaveTypeId, year);
  }

  await logAudit({ leaveRequestId: request.id, employeeId: request.employeeId, action: 'cancelled', performedBy: req.user.id, performedByName: req.user.name });
  return returnFunction(res, 200, true, 'Leave request cancelled.');
};

// ── Bonus features ported from the old system ─────────────────────────────────

const revokeLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { id: req.params.id });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'approved') return returnFunction(res, 400, false, 'Only approved requests can be revoked.');

  const now = new Date();
  await updateOne('leave_requests', { id: request.id }, { status: 'cancelled', revokedAt: now, revokedBy: req.user.id, updatedAt: now });
  const year = new Date(request.startDate).getFullYear();
  await knex('leave_balances').where({ employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year })
    .update({ used: knex.raw('"used" - ?', [request.totalDays]), updatedAt: now });
  await recomputeClosing(request.employeeId, request.leaveTypeId, year);

  await logAudit({ leaveRequestId: request.id, employeeId: request.employeeId, action: 'revoked', performedBy: req.user.id, performedByName: req.user.name });
  notifyEmployee(request.employeeId, { title: 'Leave Approval Revoked', body: 'Your previously approved leave has been revoked by HR.', type: 'leave', link: `/my/leave/requests/${request.id}` }).catch(() => {});
  return returnFunction(res, 200, true, 'Leave request revoked.');
};

const disputeLeaveRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['disputeReason'])) return;
  const request = await findOne('leave_requests', { id: req.params.id, employeeId: String(req.user.employeeId) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'rejected') return returnFunction(res, 400, false, 'Only rejected requests can be disputed.');

  await updateOne('leave_requests', { id: request.id }, { status: 'disputed', disputeReason: req.body.disputeReason, disputeSource: 'rejection', updatedAt: new Date() });
  await logAudit({ leaveRequestId: request.id, employeeId: request.employeeId, action: 'disputed', performedBy: req.user.id, performedByName: req.user.name, comment: req.body.disputeReason });
  notifyHR({ type: 'leave', subType: 'leave_dispute', title: 'Leave Rejection Disputed', subtitle: req.body.disputeReason, referenceId: request.id, referenceModel: 'leave_requests', requiresAction: true }).catch(() => {});
  return returnFunction(res, 200, true, 'Dispute submitted. HR will review.');
};

const resolveDispute = async (req, res) => {
  if (!validateRequiredFields(req, res, ['resolution'])) return;
  const request = await findOne('leave_requests', { id: req.params.id });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'disputed') return returnFunction(res, 400, false, 'Request is not disputed.');

  const now = new Date();
  const { resolution, comment } = req.body;
  const year = new Date(request.startDate).getFullYear();

  // A counter-offer dispute is a fundamentally different case from a rejection dispute:
  // rejectLeaveRequest already zeroes `pending` before a rejection-dispute ever starts,
  // but counterOfferLeaveRequest/disputeCounterOffer never touch `pending` — the full
  // original day count is still reserved here. Reusing the rejection-dispute branches
  // below as-is would either double-decrement `used` (overturned) or leave `pending`
  // permanently stuck with no request left to release it (upheld). There's also no
  // "flat rejection" outcome that makes sense here — HR never rejected this request
  // outright, they counter-offered — so anything other than 'overturned' upholds HR's
  // counter-offer (an approval at the proposed days), not a rejection.
  if (request.disputeSource === 'counterOffer') {
    const finalDays = resolution === 'overturned' ? request.totalDays : request.proposedDays;
    await updateOne('leave_requests', { id: request.id }, {
      status: 'approved', totalDays: finalDays, disputeResolvedAt: now, disputeResolvedBy: req.user.id, updatedAt: now,
    });
    await knex('leave_balances').where({ employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year })
      .update({ pending: knex.raw('"pending" - ?', [request.totalDays]), used: knex.raw('"used" + ?', [finalDays]), updatedAt: now });
    await recomputeClosing(request.employeeId, request.leaveTypeId, year);

    const today = new Date();
    if (new Date(request.startDate) <= today && today <= new Date(request.endDate)) {
      await updateOne('employees', { id: request.employeeId }, { status: 'on_leave', updatedAt: now });
    }

    await logAudit({
      leaveRequestId: request.id, employeeId: request.employeeId, action: 'disputeResolved',
      performedBy: req.user.id, performedByName: req.user.name,
      comment: `${resolution} (counter-offer dispute): approved ${finalDays} day(s) — ${comment || ''}`,
    });
    notifyEmployee(request.employeeId, {
      title: 'Leave Dispute Resolved',
      body: `Your dispute was ${resolution}. Your leave has been approved for ${finalDays} day(s).`,
      type: 'leave',
      link: `/my/leave/requests/${request.id}`,
    }).catch(() => {});
    return returnFunction(res, 200, true, 'Dispute resolved.');
  }

  if (resolution === 'overturned') {
    const updatedChain = request.approvalChain.map(c => ({ ...c, status: 'approved', actedAt: now }));
    await updateOne('leave_requests', { id: request.id }, { status: 'approved', approvalChain: JSON.stringify(updatedChain), disputeResolvedAt: now, disputeResolvedBy: req.user.id, updatedAt: now });
    await knex('leave_balances').where({ employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year })
      .update({ used: knex.raw('"used" + ?', [request.totalDays]), updatedAt: now });
    await recomputeClosing(request.employeeId, request.leaveTypeId, year);
  } else {
    await updateOne('leave_requests', { id: request.id }, { status: 'rejected', disputeResolvedAt: now, disputeResolvedBy: req.user.id, updatedAt: now });
  }

  await logAudit({ leaveRequestId: request.id, employeeId: request.employeeId, action: 'disputeResolved', performedBy: req.user.id, performedByName: req.user.name, comment: `${resolution}: ${comment || ''}` });
  notifyEmployee(request.employeeId, { title: 'Leave Dispute Resolved', body: `Your dispute was ${resolution}.`, type: 'leave', link: `/my/leave/requests/${request.id}` }).catch(() => {});
  return returnFunction(res, 200, true, 'Dispute resolved.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  Team Calendar
// ══════════════════════════════════════════════════════════════════════════════

const getLeaveCalendar = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  let query = knex('leave_requests').where({ status: 'approved' });
  if (scopedIds !== null) query = query.whereIn('employeeId', scopedIds);
  if (req.query.startDate) query = query.where('endDate', '>=', new Date(req.query.startDate));
  if (req.query.endDate) query = query.where('startDate', '<=', new Date(req.query.endDate));
  if (req.query.leaveTypeId) query = query.where({ leaveTypeId: req.query.leaveTypeId });

  let requests = await query;
  let enriched = await enrichRequests(requests);
  if (req.query.departmentId) enriched = enriched.filter(r => r.employee?.department === req.query.departmentId);

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Payroll Integration
// ══════════════════════════════════════════════════════════════════════════════

const getPayrollFeed = async (req, res) => {
  const requests = await findMany('leave_requests', { status: 'approved', payrollRunId: null });
  const enriched = await enrichRequests(requests);
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const markPayrollFeedProcessed = async (req, res) => {
  if (!validateRequiredFields(req, res, ['requestIds', 'payrollRunId'])) return;
  const { requestIds, payrollRunId } = req.body;
  await knex('leave_requests').whereIn('id', requestIds.map(String)).update({ payrollRunId: String(payrollRunId), updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Leave records marked as processed for this payroll run.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  Analytics — role scoped
// ══════════════════════════════════════════════════════════════════════════════

const getLeaveAnalytics = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  let query = knex('leave_requests');
  if (scopedIds !== null) query = query.whereIn('employeeId', scopedIds);
  const requests = await query;
  const leaveTypes = await findMany('leave_types', {});
  const typeById = Object.fromEntries(leaveTypes.map(t => [t.id, t]));

  const now = new Date();
  const byMonth = {};
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    byMonth[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`] = 0;
  }
  const approved = requests.filter(r => r.status === 'approved');
  for (const r of approved) {
    const d = new Date(r.startDate);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (byMonth[key] !== undefined) byMonth[key] += Number(r.totalDays);
  }

  const byType = {};
  for (const r of approved) {
    const key = r.leaveTypeId;
    byType[key] = (byType[key] || 0) + Number(r.totalDays);
  }
  const leaveTypeBreakdown = Object.entries(byType).map(([id, days]) => ({ leaveTypeId: id, name: typeById[id]?.name || 'Unknown', days }));

  const byDept = {};
  const employeeIds = [...new Set(approved.map(r => r.employeeId))];
  const employees = employeeIds.length ? await knex('employees').whereIn('id', employeeIds).select('id', 'department') : [];
  const deptById = Object.fromEntries(employees.map(e => [e.id, e.department]));
  for (const r of approved) {
    const dept = deptById[r.employeeId] || 'Unknown';
    byDept[dept] = (byDept[dept] || 0) + Number(r.totalDays);
  }

  const byEmployee = {};
  for (const r of approved) {
    const key = r.employeeId;
    byEmployee[key] = (byEmployee[key] || 0) + Number(r.totalDays);
  }
  const topEntries = Object.entries(byEmployee).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topEmpIds = topEntries.map(([id]) => id);
  const topEmpDocs = topEmpIds.length ? await knex('employees').whereIn('id', topEmpIds).select('id', 'fullName', 'department') : [];
  const topEmpById = Object.fromEntries(topEmpDocs.map(e => [e.id, e]));
  const topEmployees = topEntries.map(([id, days]) => ({ employeeId: id, days, employee: topEmpById[id] || null }));

  const pending = requests.filter(r => r.status === 'pending');
  const pendingAging = pending.map(r => ({ _id: r.id, daysWaiting: Math.floor((now - new Date(r.createdAt)) / 86400000) }));

  const allBalances = await (scopedIds !== null ? knex('leave_balances').whereIn('employeeId', scopedIds) : knex('leave_balances'));
  const leaveLiabilityDays = allBalances.reduce((sum, b) => sum + Math.max(0, Number(b.closingBalance)), 0);

  return returnFunction(res, 200, true, req.locale.success, {
    absenceTrendByMonth: Object.entries(byMonth).map(([month, days]) => ({ month, days })),
    leaveTypeBreakdown,
    departmentAbsence: Object.entries(byDept).map(([department, days]) => ({ department, days })),
    topLeaveTakers: topEmployees,
    leaveLiabilityDays,
    pendingRequestsAging: pendingAging,
    totalRequests: requests.length,
    pendingCount: pending.length,
  });
};

// ══════════════════════════════════════════════════════════════════════════════
//  Blackout Periods — bonus feature ported from old system, HR manages
// ══════════════════════════════════════════════════════════════════════════════

const listBlackouts = async (req, res) => {
  const blackouts = await findMany('leave_blackouts', {}, { orderBy: 'startDate' });
  return returnFunction(res, 200, true, req.locale.success, blackouts);
};

const addBlackout = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'startDate', 'endDate'])) return;
  const { name, startDate, endDate, departments } = req.body;
  const result = await insertOne('leave_blackouts', {
    name: name.trim(), startDate: new Date(startDate), endDate: new Date(endDate),
    departments: departments || [], createdBy: req.user?.id || null, createdAt: new Date(),
  });
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const deleteBlackout = async (req, res) => {
  const existing = await findOne('leave_blackouts', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await deleteOne('leave_blackouts', { id: existing.id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Employee Self-Service — always scoped to req.user.employeeId
// ══════════════════════════════════════════════════════════════════════════════

// Self-service leave-type picker for the apply flow — same active-type data as
// listLeaveTypes but reachable by any authenticated employee (that route is HR-only).
const getMyLeaveTypeOptions = async (req, res) => {
  const types = await findMany('leave_types', { isActive: true }, { orderBy: 'name' });
  return returnFunction(res, 200, true, req.locale.success, types);
};

const getMyBalances = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  const balances = await findMany('leave_balances', { employeeId: String(req.user.employeeId), year });
  const enriched = await enrichBalances(balances);
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getMyRequests = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const filter = { employeeId: String(req.user.employeeId) };
  if (req.query.status) filter.status = req.query.status;
  const requests = await findMany('leave_requests', filter, { orderBy: { column: 'createdAt', order: 'desc' } });
  const enriched = await enrichRequests(requests);
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getMyRequestDetail = async (req, res) => {
  const request = await findOne('leave_requests', { id: req.params.id, employeeId: String(req.user.employeeId) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  const enriched = await enrichRequest(request);
  const auditLog = await findMany('leave_audit_log', { leaveRequestId: request.id }, { orderBy: 'timestamp' });
  return returnFunction(res, 200, true, req.locale.success, { ...enriched, auditLog });
};

const uploadMyAttachment = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, 'A file is required.');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { attachmentUrl: `/uploads/${req.file.filename}` });
};

const getMyCalendar = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, { mine: [], team: [] });
  const empId = String(req.user.employeeId);
  const employee = await knex('employees').where({ id: empId }).select('department').first();
  const mine = await knex('leave_requests').where({ employeeId: empId }).whereIn('status', ['pending', 'approved']);

  let team = [];
  if (employee?.department) {
    const deptEmployees = await knex('employees').where({ department: employee.department }).whereNot('id', empId).select('id');
    team = deptEmployees.length
      ? await knex('leave_requests').whereIn('employeeId', deptEmployees.map(e => e.id)).where({ status: 'approved' })
      : [];
  }

  const holidays = await findMany('public_holidays', {});
  return returnFunction(res, 200, true, req.locale.success, {
    mine: await enrichRequests(mine),
    team: await enrichRequests(team),
    holidays,
  });
};

module.exports = {
  createLeaveType, listLeaveTypes, getLeaveType, updateLeaveType, deleteLeaveType,
  createPublicHoliday, listPublicHolidays, updatePublicHoliday, deletePublicHoliday,
  createAccrualPolicy, listAccrualPolicies, getAccrualPolicy, updateAccrualPolicy, deleteAccrualPolicy,
  runAccrualPolicies, runYearEndCarryForward,
  getLeaveBalances, getEmployeeLeaveBalances, adjustLeaveBalance,
  listLeaveRequests, exportLeaveRequestsCSV, getLeaveRequest, createLeaveRequest, updateMyDraftRequest,
  approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
  counterOfferLeaveRequest, acceptCounterOffer, disputeCounterOffer,
  revokeLeaveRequest, disputeLeaveRequest, resolveDispute,
  getLeaveCalendar, getPayrollFeed, markPayrollFeedProcessed, getLeaveAnalytics,
  listBlackouts, addBlackout, deleteBlackout,
  getMyLeaveTypeOptions, getMyBalances, getMyRequests, getMyRequestDetail, uploadMyAttachment, getMyCalendar,
};
