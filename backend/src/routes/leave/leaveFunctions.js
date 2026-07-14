const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, deleteOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyByRoles, notifyEmployee } = require('../../functions/HR/notifyUser');
const { notifyHR, notifyManager } = require('../inbox/inboxFunctions');
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
    const emps = await findMany('employees', { department: user.department }, { projection: { _id: 1 } });
    return emps.map(e => e._id);
  }
  // staff acting as a manager (has direct reports) sees those + themselves;
  // otherwise this scope is empty (they should use /my/* instead).
  if (!user.employeeId) return [];
  const directReports = await findMany('employees', { managerId: new ObjectId(user.employeeId) }, { projection: { _id: 1 } });
  const ids = directReports.map(e => e._id);
  ids.push(new ObjectId(user.employeeId));
  return ids;
};

const enrichRequest = async (request) => {
  const [employee, leaveType] = await Promise.all([
    findOne('employees', { _id: request.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1 } }),
    findOne('leave_types', { _id: request.leaveTypeId }, { projection: { name: 1, code: 1, color: 1, isPaid: 1 } }),
  ]);
  return { ...request, employee: employee || null, leaveType: leaveType || null };
};

const enrichBalance = async (balance) => {
  const leaveType = await findOne('leave_types', { _id: balance.leaveTypeId }, { projection: { name: 1, code: 1, color: 1, isPaid: 1 } });
  return { ...balance, leaveType: leaveType || null };
};

const recomputeClosing = async (employeeId, leaveTypeId, year) => {
  const bal = await findOne('leave_balances', { employeeId: new ObjectId(employeeId), leaveTypeId: new ObjectId(leaveTypeId), year });
  if (!bal) return null;
  const closingBalance = bal.openingBalance + bal.accrued + bal.carriedOver - bal.used - bal.pending;
  await updateOne('leave_balances', { _id: bal._id }, { $set: { closingBalance, updatedAt: new Date() } });
  return closingBalance;
};

const logAudit = async ({ leaveRequestId, employeeId, action, performedBy, performedByName, previousValue, newValue, comment }) => {
  await insertOne('leave_audit_log', {
    leaveRequestId: leaveRequestId ? new ObjectId(leaveRequestId) : null,
    employeeId: new ObjectId(employeeId),
    action, performedBy: performedBy ? new ObjectId(performedBy) : null, performedByName: performedByName || null,
    previousValue: previousValue ?? null, newValue: newValue ?? null, comment: comment || null,
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
    appliesTo: appliesTo || {}, createdBy: req.user?._id || null, createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('leave_types', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listLeaveTypes = async (req, res) => {
  const types = await findMany('leave_types', {}, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, types);
};

const getLeaveType = async (req, res) => {
  const type = await findOne('leave_types', { _id: new ObjectId(req.params.id) });
  if (!type) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, type);
};

const updateLeaveType = async (req, res) => {
  const existing = await findOne('leave_types', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const ALLOWED = [
    'name', 'description', 'isPaid', 'isCarryOverAllowed', 'maxCarryOverDays', 'carryOverExpiryMonths',
    'requiresApproval', 'requiresAttachment', 'minNoticeDays', 'maxConsecutiveDays', 'eligibilityMonths',
    'countPublicHolidays', 'color', 'appliesTo', 'isActive',
  ];
  const update = { updatedAt: new Date() };
  for (const key of ALLOWED) if (req.body[key] !== undefined) update[key] = req.body[key];
  if (req.body.code !== undefined) update.code = req.body.code.trim().toUpperCase();
  await updateOne('leave_types', { _id: existing._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteLeaveType = async (req, res) => {
  const existing = await findOne('leave_types', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('leave_types', { _id: existing._id }, { $set: { isActive: false, updatedAt: new Date() } });
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
    isRecurringAnnually: !!isRecurringAnnually, appliesTo: appliesTo || [],
    createdBy: req.user?._id || null, createdAt: new Date(),
  };
  const result = await insertOne('public_holidays', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listPublicHolidays = async (req, res) => {
  const filter = {};
  if (req.query.year) {
    filter.date = { $gte: `${req.query.year}-01-01`, $lte: `${req.query.year}-12-31` };
  }
  const holidays = await findMany('public_holidays', filter, { sort: { date: 1 } });
  return returnFunction(res, 200, true, req.locale.success, holidays);
};

const updatePublicHoliday = async (req, res) => {
  const existing = await findOne('public_holidays', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const update = {};
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.date !== undefined) update.date = new Date(req.body.date).toISOString().split('T')[0];
  if (req.body.isRecurringAnnually !== undefined) update.isRecurringAnnually = !!req.body.isRecurringAnnually;
  if (req.body.appliesTo !== undefined) update.appliesTo = req.body.appliesTo;
  await updateOne('public_holidays', { _id: existing._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deletePublicHoliday = async (req, res) => {
  const existing = await findOne('public_holidays', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await deleteOne('public_holidays', { _id: existing._id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Accrual Policies — HR only
// ══════════════════════════════════════════════════════════════════════════════

const createAccrualPolicy = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'leaveTypeId', 'accrualFrequency', 'accrualAmount', 'maxAnnualEntitlement'])) return;
  const { name, leaveTypeId, accrualFrequency, accrualAmount, maxAnnualEntitlement, appliesTo } = req.body;
  const doc = {
    name: name.trim(), leaveTypeId: new ObjectId(leaveTypeId), accrualFrequency,
    accrualAmount: Number(accrualAmount), maxAnnualEntitlement: Number(maxAnnualEntitlement),
    appliesTo: appliesTo || {}, isActive: true, createdBy: req.user?._id || null, createdAt: new Date(),
  };
  const result = await insertOne('leave_accrual_policies', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listAccrualPolicies = async (req, res) => {
  const policies = await findMany('leave_accrual_policies', {}, { sort: { createdAt: -1 } });
  const enriched = await Promise.all(policies.map(async p => ({
    ...p, leaveType: await findOne('leave_types', { _id: p.leaveTypeId }, { projection: { name: 1, code: 1 } }),
  })));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getAccrualPolicy = async (req, res) => {
  const policy = await findOne('leave_accrual_policies', { _id: new ObjectId(req.params.id) });
  if (!policy) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, policy);
};

const updateAccrualPolicy = async (req, res) => {
  const existing = await findOne('leave_accrual_policies', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const update = {};
  const { name, leaveTypeId, accrualFrequency, accrualAmount, maxAnnualEntitlement, appliesTo, isActive } = req.body;
  if (name !== undefined) update.name = name.trim();
  if (leaveTypeId !== undefined) update.leaveTypeId = new ObjectId(leaveTypeId);
  if (accrualFrequency !== undefined) update.accrualFrequency = accrualFrequency;
  if (accrualAmount !== undefined) update.accrualAmount = Number(accrualAmount);
  if (maxAnnualEntitlement !== undefined) update.maxAnnualEntitlement = Number(maxAnnualEntitlement);
  if (appliesTo !== undefined) update.appliesTo = appliesTo;
  if (isActive !== undefined) update.isActive = isActive;
  await updateOne('leave_accrual_policies', { _id: existing._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteAccrualPolicy = async (req, res) => {
  const existing = await findOne('leave_accrual_policies', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await deleteOne('leave_accrual_policies', { _id: existing._id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const runAccrualPolicies = async (req, res) => {
  const result = await runAccrual(req.user?._id || null);
  return returnFunction(res, 200, true, `Accrual run complete. ${result.processed} balance(s) updated.`, result);
};

const runYearEndCarryForward = async (req, res) => {
  const result = await runYearEndCarryOver(req.user?._id || null);
  return returnFunction(res, 200, true, `Carry-over run complete. ${result.processed} balance(s) created.`, result);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Leave Balances
// ══════════════════════════════════════════════════════════════════════════════

const getLeaveBalances = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  const filter = {};
  if (scopedIds !== null) filter.employeeId = { $in: scopedIds };
  if (req.query.year) filter.year = Number(req.query.year);
  const balances = await findMany('leave_balances', filter);
  const enriched = await Promise.all(balances.map(async (b) => {
    const withType = await enrichBalance(b);
    const employee = await findOne('employees', { _id: b.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    return { ...withType, employee: employee || null };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getEmployeeLeaveBalances = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.some(id => String(id) === req.params.employeeId)) {
    return returnFunction(res, 403, false, 'You cannot view this employee\'s leave balances.');
  }
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  const balances = await findMany('leave_balances', { employeeId: new ObjectId(req.params.employeeId), year });
  const enriched = await Promise.all(balances.map(enrichBalance));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const adjustLeaveBalance = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'leaveTypeId', 'amount', 'reason'])) return;
  const { employeeId, leaveTypeId, amount, reason } = req.body;
  const year = req.body.year ? Number(req.body.year) : new Date().getFullYear();
  const numAmount = Number(amount);
  if (!numAmount) return returnFunction(res, 400, false, 'Amount must not be zero.');

  let balance = await findOne('leave_balances', { employeeId: new ObjectId(employeeId), leaveTypeId: new ObjectId(leaveTypeId), year });
  if (!balance) {
    const { insertedId } = await insertOne('leave_balances', {
      employeeId: new ObjectId(employeeId), leaveTypeId: new ObjectId(leaveTypeId), year,
      openingBalance: 0, accrued: 0, used: 0, pending: 0, carriedOver: 0, carryOverExpiry: null,
      closingBalance: 0, lastAccrualDate: null, updatedAt: new Date(),
    });
    balance = { _id: insertedId, openingBalance: 0 };
  }

  const previousOpening = balance.openingBalance;
  await updateOne('leave_balances', { _id: balance._id }, { $inc: { openingBalance: numAmount }, $set: { updatedAt: new Date() } });
  const closingBalance = await recomputeClosing(employeeId, leaveTypeId, year);

  await logAudit({
    employeeId, action: 'balanceAdjusted', performedBy: req.user?._id, performedByName: req.user?.name,
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
  const filter = {};
  if (scopedIds !== null) filter.employeeId = { $in: scopedIds };
  if (req.query.employeeId) {
    if (scopedIds !== null && !scopedIds.some(id => String(id) === String(req.query.employeeId))) {
      filter.employeeId = { $in: [] };
    } else {
      filter.employeeId = new ObjectId(req.query.employeeId);
    }
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.leaveTypeId) filter.leaveTypeId = new ObjectId(req.query.leaveTypeId);
  if (req.query.startDate || req.query.endDate) {
    filter.startDate = {};
    if (req.query.startDate) filter.startDate.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.startDate.$lte = new Date(req.query.endDate);
  }

  const [total, requests] = await Promise.all([
    countDocuments('leave_requests', filter),
    findMany('leave_requests', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);
  let enriched = await Promise.all(requests.map(enrichRequest));

  if (req.query.department) enriched = enriched.filter(r => r.employee?.department === req.query.department);
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    enriched = enriched.filter(r => r.employee?.fullName.toLowerCase().includes(q));
  }

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  const scopedIds = await getScopedEmployeeIds(req.user);
  if (scopedIds !== null && !scopedIds.some(id => String(id) === String(request.employeeId))) {
    return returnFunction(res, 403, false, 'You cannot view this leave request.');
  }
  const enriched = await enrichRequest(request);
  const auditLog = await findMany('leave_audit_log', { leaveRequestId: request._id }, { sort: { timestamp: 1 } });
  return returnFunction(res, 200, true, req.locale.success, { ...enriched, auditLog });
};

const createLeaveRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['leaveTypeId', 'startDate', 'endDate'])) return;
  const employeeId = req.user?.employeeId;
  if (!employeeId) return returnFunction(res, 403, false, 'No employee record linked to your account.');

  const { leaveTypeId, startDate, endDate, halfDay, reason, attachmentUrl } = req.body;
  const [employee, leaveType] = await Promise.all([
    findOne('employees', { _id: new ObjectId(employeeId) }),
    findOne('leave_types', { _id: new ObjectId(leaveTypeId) }),
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
  const balance = await findOne('leave_balances', { employeeId: employee._id, leaveTypeId: leaveType._id, year });
  if (!balance) return returnFunction(res, 400, false, `No ${leaveType.name} balance record found for ${year}. Contact HR.`);
  if (totalDays > balance.closingBalance) {
    return returnFunction(res, 400, false, `Insufficient balance: ${balance.closingBalance} day(s) remaining, ${totalDays} requested.`);
  }

  const teamOverlap = await checkTeamOverlap(employee.department, startDate, endDate, employee._id);

  const approvalChain = leaveType.requiresApproval ? await resolveApprovalChain(employee, totalDays) : [];
  const status = approvalChain.length ? 'pending' : 'approved';

  const now = new Date();
  const doc = {
    employeeId: employee._id, leaveTypeId: leaveType._id,
    startDate: new Date(startDate), endDate: new Date(endDate), totalDays,
    halfDay: halfDay || null, reason: reason || '', attachmentUrl: attachmentUrl || null,
    status, approvalChain, currentApprovalLevel: approvalChain.length ? 1 : 0,
    rejectionReason: null, cancelledAt: null, cancelledBy: null,
    revokedAt: null, revokedBy: null, disputeReason: null, disputeResolvedAt: null, disputeResolvedBy: null,
    payrollRunId: null, createdAt: now, updatedAt: now,
  };
  const result = await insertOne('leave_requests', doc);

  await updateOne('leave_balances', { _id: balance._id }, { $inc: { pending: totalDays }, $set: { updatedAt: now } });
  await recomputeClosing(employee._id, leaveType._id, year);

  await logAudit({ leaveRequestId: result.insertedId, employeeId: employee._id, action: 'submitted', performedBy: req.user._id, performedByName: employee.fullName, newValue: { status, totalDays } });

  if (approvalChain.length) {
    const firstApprover = approvalChain[0];
    notifyEmployee(employee._id, { title: 'Leave Request Submitted', body: `Your ${leaveType.name} request (${totalDays} day(s)) is pending approval.`, type: 'leave' }).catch(() => {});
    notifyManager(employee._id, {
      type: 'leave', subType: 'leave_request', title: `Leave request: ${employee.fullName}`,
      subtitle: `${leaveType.name} · ${totalDays} day(s) · ${new Date(startDate).toDateString()} - ${new Date(endDate).toDateString()}`,
      referenceId: result.insertedId, referenceModel: 'leave_requests', requiresAction: true,
    }).catch(() => {});
  } else {
    notifyEmployee(employee._id, { title: 'Leave Request Approved', body: `Your ${leaveType.name} request was auto-approved (no approval required for this leave type).`, type: 'leave' }).catch(() => {});
  }

  return returnFunction(res, 201, true, 'Leave request submitted.', {
    _id: result.insertedId, totalDays, status, approvalChain,
    teamOverlapWarning: teamOverlap.warn ? `${teamOverlap.count} other employee(s) from your department are already off during this period.` : null,
  });
};

const updateMyDraftRequest = async (req, res) => {
  const employeeId = req.user?.employeeId;
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id), employeeId: new ObjectId(employeeId) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'draft') return returnFunction(res, 400, false, 'Only draft requests can be edited.');
  const ALLOWED = ['leaveTypeId', 'startDate', 'endDate', 'halfDay', 'reason', 'attachmentUrl'];
  const update = { updatedAt: new Date() };
  for (const key of ALLOWED) if (req.body[key] !== undefined) update[key] = req.body[key];
  await updateOne('leave_requests', { _id: request._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Restores balance (pending -= totalDays) — shared by reject/cancel/revoke.
const restorePendingBalance = async (request) => {
  const year = new Date(request.startDate).getFullYear();
  await global.dbo.collection('leave_balances').updateOne(
    { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year },
    { $inc: { pending: -request.totalDays }, $set: { updatedAt: new Date() } }
  );
  await recomputeClosing(request.employeeId, request.leaveTypeId, year);
};

const approveLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'pending') return returnFunction(res, 400, false, 'This request is not pending.');

  const currentStep = request.approvalChain.find(c => c.level === request.currentApprovalLevel);
  const authorized = isHR(req) || (currentStep && String(currentStep.approverId) === String(req.user._id));
  if (!authorized) return returnFunction(res, 403, false, 'You are not authorized to approve this request at its current level.');

  const now = new Date();
  const updatedChain = request.approvalChain.map(c => c.level === request.currentApprovalLevel
    ? { ...c, status: 'approved', actedAt: now, comment: req.body.comment || null }
    : c);
  const nextLevel = updatedChain.find(c => c.level === request.currentApprovalLevel + 1);

  if (nextLevel) {
    await updateOne('leave_requests', { _id: request._id }, {
      $set: { approvalChain: updatedChain, currentApprovalLevel: nextLevel.level, updatedAt: now },
    });
    notifyEmployee(request.employeeId, { title: 'Leave Request Update', body: 'Your leave request was approved at one level and is now awaiting the next approver.', type: 'leave' }).catch(() => {});
    await logAudit({ leaveRequestId: request._id, employeeId: request.employeeId, action: 'approved', performedBy: req.user._id, performedByName: req.user.name, comment: `Level ${request.currentApprovalLevel} approved` });
    return returnFunction(res, 200, true, 'Approved at this level. Awaiting next approver.');
  }

  const year = new Date(request.startDate).getFullYear();
  await updateOne('leave_requests', { _id: request._id }, { $set: { approvalChain: updatedChain, status: 'approved', updatedAt: now } });
  await global.dbo.collection('leave_balances').updateOne(
    { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year },
    { $inc: { pending: -request.totalDays, used: request.totalDays }, $set: { updatedAt: now } }
  );
  await recomputeClosing(request.employeeId, request.leaveTypeId, year);

  const today = new Date();
  if (new Date(request.startDate) <= today && today <= new Date(request.endDate)) {
    await updateOne('employees', { _id: request.employeeId }, { $set: { status: 'on_leave', updatedAt: now } });
  }

  await logAudit({ leaveRequestId: request._id, employeeId: request.employeeId, action: 'approved', performedBy: req.user._id, performedByName: req.user.name, comment: 'Final approval' });
  notifyEmployee(request.employeeId, { title: 'Leave Request Approved', body: 'Your leave request has been fully approved.', type: 'leave' }).catch(() => {});

  return returnFunction(res, 200, true, 'Leave request approved.');
};

const rejectLeaveRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['rejectionReason'])) return;
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'pending') return returnFunction(res, 400, false, 'This request is not pending.');

  const currentStep = request.approvalChain.find(c => c.level === request.currentApprovalLevel);
  const authorized = isHR(req) || (currentStep && String(currentStep.approverId) === String(req.user._id));
  if (!authorized) return returnFunction(res, 403, false, 'You are not authorized to reject this request at its current level.');

  const now = new Date();
  const updatedChain = request.approvalChain.map(c => c.level === request.currentApprovalLevel
    ? { ...c, status: 'rejected', actedAt: now, comment: req.body.rejectionReason }
    : c);
  await updateOne('leave_requests', { _id: request._id }, {
    $set: { approvalChain: updatedChain, status: 'rejected', rejectionReason: req.body.rejectionReason, updatedAt: now },
  });
  await restorePendingBalance(request);

  await logAudit({ leaveRequestId: request._id, employeeId: request.employeeId, action: 'rejected', performedBy: req.user._id, performedByName: req.user.name, comment: req.body.rejectionReason });
  notifyEmployee(request.employeeId, { title: 'Leave Request Rejected', body: req.body.rejectionReason, type: 'leave' }).catch(() => {});

  return returnFunction(res, 200, true, 'Leave request rejected.');
};

const cancelLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);

  const isOwner = String(request.employeeId) === String(req.user.employeeId);
  if (!isHR(req) && !isOwner) return returnFunction(res, 403, false, 'You cannot cancel this request.');
  if (isOwner && !isHR(req) && request.status !== 'pending' && request.status !== 'draft') {
    return returnFunction(res, 400, false, 'Only pending or draft requests can be cancelled.');
  }
  if (!['pending', 'draft', 'approved'].includes(request.status)) {
    return returnFunction(res, 400, false, 'This request cannot be cancelled.');
  }

  const now = new Date();
  await updateOne('leave_requests', { _id: request._id }, {
    $set: { status: 'cancelled', cancelledAt: now, cancelledBy: req.user._id, updatedAt: now },
  });

  if (request.status === 'pending') {
    await restorePendingBalance(request);
  } else if (request.status === 'approved') {
    const year = new Date(request.startDate).getFullYear();
    await global.dbo.collection('leave_balances').updateOne(
      { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year },
      { $inc: { used: -request.totalDays }, $set: { updatedAt: now } }
    );
    await recomputeClosing(request.employeeId, request.leaveTypeId, year);
  }

  await logAudit({ leaveRequestId: request._id, employeeId: request.employeeId, action: 'cancelled', performedBy: req.user._id, performedByName: req.user.name });
  return returnFunction(res, 200, true, 'Leave request cancelled.');
};

// ── Bonus features ported from the old system ─────────────────────────────────

const revokeLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'approved') return returnFunction(res, 400, false, 'Only approved requests can be revoked.');

  const now = new Date();
  await updateOne('leave_requests', { _id: request._id }, { $set: { status: 'cancelled', revokedAt: now, revokedBy: req.user._id, updatedAt: now } });
  const year = new Date(request.startDate).getFullYear();
  await global.dbo.collection('leave_balances').updateOne(
    { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year },
    { $inc: { used: -request.totalDays }, $set: { updatedAt: now } }
  );
  await recomputeClosing(request.employeeId, request.leaveTypeId, year);

  await logAudit({ leaveRequestId: request._id, employeeId: request.employeeId, action: 'revoked', performedBy: req.user._id, performedByName: req.user.name });
  notifyEmployee(request.employeeId, { title: 'Leave Approval Revoked', body: 'Your previously approved leave has been revoked by HR.', type: 'leave' }).catch(() => {});
  return returnFunction(res, 200, true, 'Leave request revoked.');
};

const disputeLeaveRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['disputeReason'])) return;
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id), employeeId: new ObjectId(req.user.employeeId) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'rejected') return returnFunction(res, 400, false, 'Only rejected requests can be disputed.');

  await updateOne('leave_requests', { _id: request._id }, { $set: { status: 'disputed', disputeReason: req.body.disputeReason, updatedAt: new Date() } });
  await logAudit({ leaveRequestId: request._id, employeeId: request.employeeId, action: 'disputed', performedBy: req.user._id, performedByName: req.user.name, comment: req.body.disputeReason });
  notifyHR({ type: 'leave', subType: 'leave_dispute', title: 'Leave Rejection Disputed', subtitle: req.body.disputeReason, referenceId: request._id, referenceModel: 'leave_requests', requiresAction: true }).catch(() => {});
  return returnFunction(res, 200, true, 'Dispute submitted. HR will review.');
};

const resolveDispute = async (req, res) => {
  if (!validateRequiredFields(req, res, ['resolution'])) return;
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'disputed') return returnFunction(res, 400, false, 'Request is not disputed.');

  const now = new Date();
  const { resolution, comment } = req.body;
  if (resolution === 'overturned') {
    const updatedChain = request.approvalChain.map(c => ({ ...c, status: 'approved', actedAt: now }));
    await updateOne('leave_requests', { _id: request._id }, { $set: { status: 'approved', approvalChain: updatedChain, disputeResolvedAt: now, disputeResolvedBy: req.user._id, updatedAt: now } });
    const year = new Date(request.startDate).getFullYear();
    await global.dbo.collection('leave_balances').updateOne(
      { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year },
      { $inc: { used: request.totalDays }, $set: { updatedAt: now } }
    );
    await recomputeClosing(request.employeeId, request.leaveTypeId, year);
  } else {
    await updateOne('leave_requests', { _id: request._id }, { $set: { status: 'rejected', disputeResolvedAt: now, disputeResolvedBy: req.user._id, updatedAt: now } });
  }

  await logAudit({ leaveRequestId: request._id, employeeId: request.employeeId, action: 'disputeResolved', performedBy: req.user._id, performedByName: req.user.name, comment: `${resolution}: ${comment || ''}` });
  notifyEmployee(request.employeeId, { title: 'Leave Dispute Resolved', body: `Your dispute was ${resolution}.`, type: 'leave' }).catch(() => {});
  return returnFunction(res, 200, true, 'Dispute resolved.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  Team Calendar
// ══════════════════════════════════════════════════════════════════════════════

const getLeaveCalendar = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  const filter = { status: 'approved' };
  if (scopedIds !== null) filter.employeeId = { $in: scopedIds };
  if (req.query.startDate) filter.endDate = { $gte: new Date(req.query.startDate) };
  if (req.query.endDate) filter.startDate = { $lte: new Date(req.query.endDate) };
  if (req.query.leaveTypeId) filter.leaveTypeId = new ObjectId(req.query.leaveTypeId);

  let requests = await findMany('leave_requests', filter);
  let enriched = await Promise.all(requests.map(enrichRequest));
  if (req.query.departmentId) enriched = enriched.filter(r => r.employee?.department === req.query.departmentId);

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Payroll Integration
// ══════════════════════════════════════════════════════════════════════════════

const getPayrollFeed = async (req, res) => {
  const requests = await findMany('leave_requests', { status: 'approved', payrollRunId: null });
  const enriched = await Promise.all(requests.map(enrichRequest));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const markPayrollFeedProcessed = async (req, res) => {
  if (!validateRequiredFields(req, res, ['requestIds', 'payrollRunId'])) return;
  const { requestIds, payrollRunId } = req.body;
  await global.dbo.collection('leave_requests').updateMany(
    { _id: { $in: requestIds.map(id => new ObjectId(id)) } },
    { $set: { payrollRunId: new ObjectId(payrollRunId), updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Leave records marked as processed for this payroll run.');
};

// ══════════════════════════════════════════════════════════════════════════════
//  Analytics — role scoped
// ══════════════════════════════════════════════════════════════════════════════

const getLeaveAnalytics = async (req, res) => {
  const scopedIds = await getScopedEmployeeIds(req.user);
  const filter = {};
  if (scopedIds !== null) filter.employeeId = { $in: scopedIds };
  const requests = await findMany('leave_requests', filter);
  const leaveTypes = await findMany('leave_types', {});
  const typeById = Object.fromEntries(leaveTypes.map(t => [String(t._id), t]));

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
    if (byMonth[key] !== undefined) byMonth[key] += r.totalDays;
  }

  const byType = {};
  for (const r of approved) {
    const key = String(r.leaveTypeId);
    byType[key] = (byType[key] || 0) + r.totalDays;
  }
  const leaveTypeBreakdown = Object.entries(byType).map(([id, days]) => ({ leaveTypeId: id, name: typeById[id]?.name || 'Unknown', days }));

  const byDept = {};
  const employeeIds = [...new Set(approved.map(r => String(r.employeeId)))].map(id => new ObjectId(id));
  const employees = await findMany('employees', { _id: { $in: employeeIds } }, { projection: { department: 1 } });
  const deptById = Object.fromEntries(employees.map(e => [String(e._id), e.department]));
  for (const r of approved) {
    const dept = deptById[String(r.employeeId)] || 'Unknown';
    byDept[dept] = (byDept[dept] || 0) + r.totalDays;
  }

  const byEmployee = {};
  for (const r of approved) {
    const key = String(r.employeeId);
    byEmployee[key] = (byEmployee[key] || 0) + r.totalDays;
  }
  const topEmployees = await Promise.all(
    Object.entries(byEmployee).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(async ([id, days]) => ({ employeeId: id, days, employee: await findOne('employees', { _id: new ObjectId(id) }, { projection: { fullName: 1, department: 1 } }) }))
  );

  const pending = requests.filter(r => r.status === 'pending');
  const pendingAging = pending.map(r => ({ _id: r._id, daysWaiting: Math.floor((now - new Date(r.createdAt)) / 86400000) }));

  const allBalances = await findMany('leave_balances', filter.employeeId ? { employeeId: filter.employeeId } : {});
  const leaveLiabilityDays = allBalances.reduce((sum, b) => sum + Math.max(0, b.closingBalance), 0);

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
  const blackouts = await findMany('leave_blackouts', {}, { sort: { startDate: 1 } });
  return returnFunction(res, 200, true, req.locale.success, blackouts);
};

const addBlackout = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'startDate', 'endDate'])) return;
  const { name, startDate, endDate, departments } = req.body;
  const result = await insertOne('leave_blackouts', {
    name: name.trim(), startDate: new Date(startDate), endDate: new Date(endDate),
    departments: departments || [], createdBy: req.user?._id || null, createdAt: new Date(),
  });
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const deleteBlackout = async (req, res) => {
  const existing = await findOne('leave_blackouts', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await deleteOne('leave_blackouts', { _id: existing._id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ══════════════════════════════════════════════════════════════════════════════
//  Employee Self-Service — always scoped to req.user.employeeId
// ══════════════════════════════════════════════════════════════════════════════

// Self-service leave-type picker for the apply flow — same active-type data as
// listLeaveTypes but reachable by any authenticated employee (that route is HR-only).
const getMyLeaveTypeOptions = async (req, res) => {
  const types = await findMany('leave_types', { isActive: true }, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, types);
};

const getMyBalances = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
  const balances = await findMany('leave_balances', { employeeId: new ObjectId(req.user.employeeId), year });
  const enriched = await Promise.all(balances.map(enrichBalance));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getMyRequests = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const filter = { employeeId: new ObjectId(req.user.employeeId) };
  if (req.query.status) filter.status = req.query.status;
  const requests = await findMany('leave_requests', filter, { sort: { createdAt: -1 } });
  const enriched = await Promise.all(requests.map(enrichRequest));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getMyRequestDetail = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id), employeeId: new ObjectId(req.user.employeeId) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  const enriched = await enrichRequest(request);
  const auditLog = await findMany('leave_audit_log', { leaveRequestId: request._id }, { sort: { timestamp: 1 } });
  return returnFunction(res, 200, true, req.locale.success, { ...enriched, auditLog });
};

const uploadMyAttachment = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, 'A file is required.');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { attachmentUrl: `/uploads/${req.file.filename}` });
};

const getMyCalendar = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, { mine: [], team: [] });
  const employee = await findOne('employees', { _id: new ObjectId(req.user.employeeId) }, { projection: { department: 1 } });
  const mine = await findMany('leave_requests', { employeeId: new ObjectId(req.user.employeeId), status: { $in: ['pending', 'approved'] } });

  let team = [];
  if (employee?.department) {
    const deptEmployees = await findMany('employees', { department: employee.department, _id: { $ne: new ObjectId(req.user.employeeId) } }, { projection: { _id: 1 } });
    team = await findMany('leave_requests', { employeeId: { $in: deptEmployees.map(e => e._id) }, status: 'approved' });
  }

  const holidays = await findMany('public_holidays', {});
  return returnFunction(res, 200, true, req.locale.success, {
    mine: await Promise.all(mine.map(enrichRequest)),
    team: await Promise.all(team.map(enrichRequest)),
    holidays,
  });
};

module.exports = {
  createLeaveType, listLeaveTypes, getLeaveType, updateLeaveType, deleteLeaveType,
  createPublicHoliday, listPublicHolidays, updatePublicHoliday, deletePublicHoliday,
  createAccrualPolicy, listAccrualPolicies, getAccrualPolicy, updateAccrualPolicy, deleteAccrualPolicy,
  runAccrualPolicies, runYearEndCarryForward,
  getLeaveBalances, getEmployeeLeaveBalances, adjustLeaveBalance,
  listLeaveRequests, getLeaveRequest, createLeaveRequest, updateMyDraftRequest,
  approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
  revokeLeaveRequest, disputeLeaveRequest, resolveDispute,
  getLeaveCalendar, getPayrollFeed, markPayrollFeedProcessed, getLeaveAnalytics,
  listBlackouts, addBlackout, deleteBlackout,
  getMyLeaveTypeOptions, getMyBalances, getMyRequests, getMyRequestDetail, uploadMyAttachment, getMyCalendar,
};
