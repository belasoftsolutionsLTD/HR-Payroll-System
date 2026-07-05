const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { calculateWorkingDaysDB } = require('../../functions/HR/leaveCalculator');
const { notifyEmployee } = require('../../functions/HR/notifyUser');
const { createInboxItem, notifyHR, notifyManager } = require('../inbox/inboxFunctions');

const getLeaveBalances = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const balance = await findOne('leave_balances', { employeeId: new ObjectId(req.params.employeeId), year });
  if (!balance) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, balance);
};

const listLeaveRequests = async (req, res) => {
  const role = req.user.role;
  const filter = {};

  if (role === 'staff') {
    const emp = await findOne('employees', { _id: req.user.employeeId });
    if (emp) filter.employeeId = emp._id;
  }

  if (req.query.status) filter.status = req.query.status;
  if (req.query.employeeId && role !== 'staff') filter.employeeId = new ObjectId(req.query.employeeId);
  if (req.query.leaveType) filter.leaveType = req.query.leaveType;

  const { page, limit, skip } = getPagination(req.query);
  const [total, records] = await Promise.all([
    countDocuments('leave_requests', filter),
    findMany('leave_requests', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  // Batch-load employees for HR view (avoids N+1)
  const empIds = [...new Set(records.map(r => r.employeeId))];
  const emps = await findMany('employees', { _id: { $in: empIds } }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
  const empMap = Object.fromEntries(emps.map(e => [String(e._id), e]));
  const enriched = records.map(r => ({ ...r, employee: empMap[String(r.employeeId)] ?? null }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const createLeaveRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'leaveType', 'startDate', 'endDate', 'reason'])) return;
  if (new Date(req.body.endDate) < new Date(req.body.startDate)) {
    return returnFunction(res, 400, false, 'Invalid leave date range. End date must be on or after the start date.');
  }

  const year = new Date(req.body.startDate).getFullYear();
  const isHalfDay = req.body.isHalfDay === true || req.body.isHalfDay === 'true';
  let numberOfDays = await calculateWorkingDaysDB(req.body.startDate, req.body.endDate);
  if (numberOfDays < 1) return returnFunction(res, 400, false, 'Invalid leave time range.');
  if (isHalfDay) numberOfDays = 0.5;

  const balance = await findOne('leave_balances', { employeeId: new ObjectId(req.body.employeeId), year });
  if (!balance) return returnFunction(res, 400, false, 'No leave balance record found for this employee.');

  const typeBalance = balance.balances[req.body.leaveType];
  if (!typeBalance) return returnFunction(res, 400, false, 'Invalid leave type.');
  if (typeBalance.remaining !== null && typeBalance.remaining < numberOfDays) {
    return returnFunction(res, 400, false, `Insufficient ${req.body.leaveType} leave balance. Available: ${typeBalance.remaining} days, Requested: ${numberOfDays} days.`);
  }

  // Block overlapping pending/approved requests
  const overlap = await findOne('leave_requests', {
    employeeId: new ObjectId(req.body.employeeId),
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: req.body.endDate },
    endDate:   { $gte: req.body.startDate },
  });
  if (overlap) return returnFunction(res, 400, false, 'A leave request already exists for overlapping dates.');

  // Check blackout periods
  const blackout = await global.dbo.collection('leave_blackouts').findOne({
    startDate: { $lte: req.body.endDate },
    endDate:   { $gte: req.body.startDate },
    $or: [{ leaveTypes: { $size: 0 } }, { leaveTypes: req.body.leaveType }],
  });
  if (blackout) {
    return returnFunction(res, 400, false, `Leave cannot be requested during the "${blackout.name}" blackout period (${blackout.startDate} – ${blackout.endDate}).`);
  }

  // Check minimum notice period
  const leaveConfig = await findOne('leave_config', { _id: 'global' });
  const minNotice = leaveConfig?.minNoticeDays?.[req.body.leaveType] ?? 0;
  if (minNotice > 0) {
    const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);
    const startD = new Date(req.body.startDate);
    const daysNotice = Math.ceil((startD - todayDate) / (1000 * 60 * 60 * 24));
    if (daysNotice < minNotice) {
      return returnFunction(res, 400, false, `${req.body.leaveType} leave requires at least ${minNotice} day${minNotice !== 1 ? 's' : ''} advance notice (${daysNotice} day${daysNotice !== 1 ? 's' : ''} given).`);
    }
  }

  const doc = {
    employeeId: new ObjectId(req.body.employeeId),
    leaveType: req.body.leaveType,
    startDate: req.body.startDate,
    endDate: req.body.endDate,
    numberOfDays,
    isHalfDay: isHalfDay || false,
    halfDayPeriod: isHalfDay ? (req.body.halfDayPeriod || 'morning') : null,
    reason: req.body.reason,
    status: 'pending',
    approvedBy: null,
    approvedAt: null,
    comments: null,
    createdAt: new Date(),
  };

  const result = await insertOne('leave_requests', doc);

  // Inbox: notify manager + HR that a leave request was submitted
  const emp = await findOne('employees', { _id: doc.employeeId }, { projection: { fullName: 1, department: 1 } });
  const empName = emp?.fullName || 'An employee';
  const inboxPayload = {
    type: 'leave', subType: 'leave_request',
    title: `Leave request from ${empName}`,
    subtitle: `${req.body.leaveType} leave · ${req.body.startDate} – ${req.body.endDate} · ${numberOfDays} day${numberOfDays !== 1 ? 's' : ''}`,
    referenceId: result.insertedId, referenceModel: 'leave_requests',
    requiresAction: true, triggeredBy: req.user._id,
  };
  await Promise.all([
    notifyManager(doc.employeeId, inboxPayload),
    notifyHR(inboxPayload),
  ]);

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, numberOfDays });
};

const approveLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'pending') return returnFunction(res, 400, false, 'Request is no longer pending.');

  await updateOne('leave_requests', { _id: request._id }, {
    $set: { status: 'approved', approvedBy: new ObjectId(req.user._id), approvedAt: new Date(), comments: req.body.comments || null },
  });

  notifyEmployee(request.employeeId, {
    type: 'leave',
    title: 'Leave Approved ✓',
    body: `Your ${request.leaveType} leave from ${request.startDate} to ${request.endDate} (${request.numberOfDays} day${request.numberOfDays !== 1 ? 's' : ''}) has been approved.`,
    link: '/staff-portal',
  }).catch(() => {});

  // Deduct from leave_balances
  const year = new Date(request.startDate).getFullYear();
  const path = `balances.${request.leaveType}`;
  await updateOne('leave_balances', { employeeId: request.employeeId, year }, {
    $inc: { [`${path}.used`]: request.numberOfDays, [`${path}.remaining`]: -request.numberOfDays },
  });

  // Set employee status to on_leave
  const today = new Date().toISOString().slice(0, 10);
  if (request.startDate <= today && today <= request.endDate) {
    await updateOne('employees', { _id: request.employeeId }, { $set: { status: 'on_leave', updatedAt: new Date() } });
  }

  // Inbox: notify employee of approval
  const empUserApprove = await findOne('users', { employeeId: request.employeeId });
  if (empUserApprove) {
    await createInboxItem({
      recipientId: empUserApprove._id, type: 'general', subType: 'leave_approved',
      title: 'Leave request approved ✓',
      subtitle: `Your ${request.leaveType} leave (${request.startDate} – ${request.endDate}) has been approved.`,
      referenceId: request._id, referenceModel: 'leave_requests',
      requiresAction: false, triggeredBy: req.user._id,
    });
  }

  return returnFunction(res, 200, true, 'Leave request approved.');
};

const rejectLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'pending') return returnFunction(res, 400, false, 'Request is no longer pending.');

  await updateOne('leave_requests', { _id: request._id }, {
    $set: { status: 'rejected', approvedBy: new ObjectId(req.user._id), approvedAt: new Date(), comments: req.body.comments || null },
  });

  notifyEmployee(request.employeeId, {
    type: 'leave',
    title: 'Leave Request Declined',
    body: `Your ${request.leaveType} leave from ${request.startDate} to ${request.endDate} was not approved.${req.body.comments ? ` Reason: ${req.body.comments}` : ''}`,
    link: '/staff-portal',
  }).catch(() => {});

  // Inbox: notify employee of rejection
  const empUserReject = await findOne('users', { employeeId: request.employeeId });
  if (empUserReject) {
    await createInboxItem({
      recipientId: empUserReject._id, type: 'general', subType: 'leave_declined',
      title: 'Leave request declined',
      subtitle: `Your ${request.leaveType} leave (${request.startDate} – ${request.endDate}) was not approved.`,
      referenceId: request._id, referenceModel: 'leave_requests',
      requiresAction: false, triggeredBy: req.user._id,
    });
  }

  return returnFunction(res, 200, true, 'Leave request rejected.');
};

const deleteLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);

  // If approved, restore the leave balance before deleting
  if (request.status === 'approved') {
    const year = new Date(request.startDate).getFullYear();
    const path = `balances.${request.leaveType}`;
    await updateOne('leave_balances', { employeeId: request.employeeId, year }, {
      $inc: { [`${path}.used`]: -request.numberOfDays, [`${path}.remaining`]: request.numberOfDays },
    });
  }

  await global.dbo.collection('leave_requests').deleteOne({ _id: request._id });
  return returnFunction(res, 200, true, 'Leave request deleted.');
};

const revokeLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'approved') return returnFunction(res, 400, false, 'Only approved requests can be revoked.');

  await updateOne('leave_requests', { _id: request._id }, {
    $set: { status: 'rejected', comments: req.body.comments || 'Revoked by HR', approvedBy: new ObjectId(req.user._id), approvedAt: new Date() },
  });

  // Restore leave balance
  const year = new Date(request.startDate).getFullYear();
  const path = `balances.${request.leaveType}`;
  await updateOne('leave_balances', { employeeId: request.employeeId, year }, {
    $inc: { [`${path}.used`]: -request.numberOfDays, [`${path}.remaining`]: request.numberOfDays },
  });

  // Restore employee status if currently on_leave
  await updateOne('employees', { _id: request.employeeId, status: 'on_leave' }, { $set: { status: 'active', updatedAt: new Date() } });

  notifyEmployee(request.employeeId, {
    type: 'leave',
    title: 'Leave Revoked',
    body: `Your ${request.leaveType} leave (${request.startDate} – ${request.endDate}) has been revoked.${req.body.comments ? ` Reason: ${req.body.comments}` : ''}`,
    link: '/staff-portal',
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Leave revoked.');
};

const resolveDispute = async (req, res) => {
  if (!validateRequiredFields(req, res, ['resolution'])) return;
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (request.status !== 'disputed') return returnFunction(res, 400, false, 'Request is not disputed.');

  const newStatus = req.body.resolution === 'approve' ? 'approved' : 'rejected';

  await updateOne('leave_requests', { _id: request._id }, {
    $set: { status: newStatus, comments: req.body.comments || null, disputeResolvedAt: new Date(), disputeResolvedBy: new ObjectId(req.user._id) },
  });

  if (newStatus === 'approved') {
    const year = new Date(request.startDate).getFullYear();
    const path = `balances.${request.leaveType}`;
    await updateOne('leave_balances', { employeeId: request.employeeId, year }, {
      $inc: { [`${path}.used`]: request.numberOfDays, [`${path}.remaining`]: -request.numberOfDays },
    });
  }

  notifyEmployee(request.employeeId, {
    type: 'leave',
    title: newStatus === 'approved' ? 'Dispute Resolved – Approved ✓' : 'Dispute Resolved – Declined',
    body: `Your leave dispute has been reviewed and ${newStatus}.${req.body.comments ? ` Note: ${req.body.comments}` : ''}`,
    link: '/staff-portal',
  }).catch(() => {});

  return returnFunction(res, 200, true, `Dispute resolved as ${newStatus}.`);
};

const getLeaveCalendar = async (req, res) => {
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year) || new Date().getFullYear();

  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = `${year}-${String(month).padStart(2, '0')}-31`;

  const requests = await findMany('leave_requests', {
    status: 'approved',
    startDate: { $lte: end },
    endDate: { $gte: start },
  });

  // Batch-load employees then group by department
  const calEmpIds = [...new Set(requests.map(r => r.employeeId))];
  const calEmps = await findMany('employees', { _id: { $in: calEmpIds } }, { projection: { fullName: 1, department: 1 } });
  const calEmpMap = Object.fromEntries(calEmps.map(e => [String(e._id), e]));
  const grouped = {};
  for (const r of requests) {
    const emp = calEmpMap[String(r.employeeId)];
    if (!emp) continue;
    if (!grouped[emp.department]) grouped[emp.department] = [];
    grouped[emp.department].push({ ...r, employee: emp });
  }

  return returnFunction(res, 200, true, req.locale.success, grouped);
};

const getLeaveConflicts = async (req, res) => {
  const { department, startDate, endDate } = req.query;
  if (!department || !startDate || !endDate) return returnFunction(res, 400, false, req.locale.missingRequiredFields);

  const deptEmployees = await findMany('employees', { department }, { projection: { _id: 1, fullName: 1 } });
  const ids = deptEmployees.map((e) => e._id);

  const conflicts = await findMany('leave_requests', {
    employeeId: { $in: ids },
    status: 'approved',
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  });

  const enriched = await Promise.all(conflicts.map(async (c) => {
    const emp = deptEmployees.find((e) => String(e._id) === String(c.employeeId));
    return { ...c, employee: emp };
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── New: current user's own balances in array format ─────────────────────────

const getMyBalances = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const empId = req.user.employeeId;
  if (!empId) return returnFunction(res, 200, true, req.locale.success, []);

  const record = await findOne('leave_balances', { employeeId: empId, year });
  if (!record) return returnFunction(res, 200, true, req.locale.success, []);

  const TYPE_COLORS = {
    annual: '#6366f1', sick: '#3b82f6', maternity: '#8b5cf6',
    paternity: '#06b6d4', unpaid: '#64748b', compassionate: '#f59e0b',
    study: '#10b981', emergency: '#ef4444',
  };
  const TYPE_LABELS = {
    annual: 'Annual Leave', sick: 'Sick Leave', maternity: 'Maternity Leave',
    paternity: 'Paternity Leave', unpaid: 'Unpaid Leave',
    compassionate: 'Compassionate Leave', study: 'Study Leave', emergency: 'Emergency Leave',
  };

  const balances = Object.entries(record.balances || {}).map(([type, b]) => ({
    leaveType: type,
    leaveTypeName: TYPE_LABELS[type] ?? (type.charAt(0).toUpperCase() + type.slice(1) + ' Leave'),
    totalDays:     b.allocated ?? b.total ?? 0,
    usedDays:      b.used ?? 0,
    pendingDays:   b.pending ?? 0,
    remainingDays: b.remaining ?? ((b.allocated ?? b.total ?? 0) - (b.used ?? 0)),
    color:         TYPE_COLORS[type] ?? '#6366f1',
  }));

  return returnFunction(res, 200, true, req.locale.success, balances);
};

// ── Calendar for date range ───────────────────────────────────────────────────

const getCalendarEntries = async (req, res) => {
  const from = req.query.from || new Date().toISOString().split('T')[0].slice(0, 7) + '-01';
  const to   = req.query.to   || new Date().toISOString().split('T')[0].slice(0, 7) + '-31';
  const dept = req.query.dept;

  const filter = {
    status: 'approved',
    startDate: { $lte: to },
    endDate: { $gte: from },
  };

  if (dept) {
    const deptEmps = await findMany('employees', { department: dept }, { projection: { _id: 1 } });
    filter.employeeId = { $in: deptEmps.map(e => e._id) };
  }

  const requests = await findMany('leave_requests', filter, { sort: { startDate: 1 } });
  const holidays = await findMany('public_holidays', { date: { $gte: from, $lte: to } }, { sort: { date: 1 } });

  const calEntEmpIds = [...new Set(requests.map(r => r.employeeId))];
  const calEntEmps = await findMany('employees', { _id: { $in: calEntEmpIds } }, { projection: { fullName: 1, department: 1 } });
  const calEntEmpMap = Object.fromEntries(calEntEmps.map(e => [String(e._id), e]));
  const enriched = requests.map(r => ({ ...r, employee: calEntEmpMap[String(r.employeeId)] ?? null }));

  return returnFunction(res, 200, true, req.locale.success, { leaves: enriched, holidays });
};

// ── Today's absences ──────────────────────────────────────────────────────────

const getTodayAbsences = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const onLeave = await findMany('leave_requests', {
    status: 'approved',
    startDate: { $lte: today },
    endDate:   { $gte: today },
  });

  const absEmpIds = [...new Set(onLeave.map(r => r.employeeId))];
  const absEmps = await findMany('employees', { _id: { $in: absEmpIds } }, { projection: { fullName: 1, department: 1, designation: 1 } });
  const absEmpMap = Object.fromEntries(absEmps.map(e => [String(e._id), e]));
  const enriched = onLeave.map(r => ({ ...r, employee: absEmpMap[String(r.employeeId)] ?? null }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── Upcoming leaves (next N days) ─────────────────────────────────────────────

const getUpcomingLeaves = async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const today = new Date().toISOString().split('T')[0];
  const future = new Date(); future.setDate(future.getDate() + days);
  const to = future.toISOString().split('T')[0];

  const requests = await findMany('leave_requests', {
    status: { $in: ['approved', 'pending'] },
    startDate: { $gt: today, $lte: to },
  }, { sort: { startDate: 1 }, limit: 20 });

  const upEmpIds = [...new Set(requests.map(r => r.employeeId))];
  const upEmps = await findMany('employees', { _id: { $in: upEmpIds } }, { projection: { fullName: 1, department: 1 } });
  const upEmpMap = Object.fromEntries(upEmps.map(e => [String(e._id), e]));
  const enriched = requests.map(r => ({ ...r, employee: upEmpMap[String(r.employeeId)] ?? null }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── Cancel own request (employee) ─────────────────────────────────────────────

const cancelLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);

  const empId = req.user.employeeId;
  if (empId && String(request.employeeId) !== String(empId)) {
    return returnFunction(res, 403, false, 'You can only cancel your own requests.');
  }
  if (!['pending', 'approved'].includes(request.status)) {
    return returnFunction(res, 400, false, 'Cannot cancel a request that is already ' + request.status);
  }

  // Restore balance if it was approved
  if (request.status === 'approved') {
    const year = new Date(request.startDate).getFullYear();
    const path = `balances.${request.leaveType}`;
    await updateOne('leave_balances', { employeeId: request.employeeId, year }, {
      $inc: { [`${path}.used`]: -(request.numberOfDays || request.totalDays || 0),
               [`${path}.remaining`]: (request.numberOfDays || request.totalDays || 0) },
    });
  }

  await updateOne('leave_requests', { _id: request._id }, {
    $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: new ObjectId(req.user._id) },
  });

  return returnFunction(res, 200, true, 'Leave request cancelled.');
};

// ── Single request by ID ──────────────────────────────────────────────────────

const getLeaveRequest = async (req, res) => {
  const request = await findOne('leave_requests', { _id: new ObjectId(req.params.id) });
  if (!request) return returnFunction(res, 404, false, req.locale.notFound);
  if (req.user.role === 'staff' && req.user.employeeId && String(request.employeeId) !== String(req.user.employeeId)) {
    return returnFunction(res, 403, false, 'You can only view your own leave requests.');
  }
  const emp = await findOne('employees', { _id: request.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1 } });
  let approver = null;
  if (request.approvedBy) approver = await findOne('users', { _id: new ObjectId(request.approvedBy) }, { projection: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, { ...request, employee: emp, approverName: approver?.name });
};

// ── Export CSV ────────────────────────────────────────────────────────────────

const exportLeaveRequests = async (req, res) => {
  const filter = {};
  if (req.query.status)     filter.status     = req.query.status;
  if (req.query.leaveType)  filter.leaveType  = req.query.leaveType;
  if (req.query.from && req.query.to) filter.startDate = { $gte: req.query.from, $lte: req.query.to };

  const records = await findMany('leave_requests', filter, { sort: { createdAt: -1 }, limit: 5000 });
  const expEmpIds = [...new Set(records.map(r => r.employeeId))];
  const expEmps = await findMany('employees', { _id: { $in: expEmpIds } }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
  const expEmpMap = Object.fromEntries(expEmps.map(e => [String(e._id), e]));
  const enriched = records.map(r => ({ ...r, employee: expEmpMap[String(r.employeeId)] ?? null }));

  const header = 'Employee,Staff No,Department,Leave Type,From,To,Days,Status,Submitted On\n';
  const rows = enriched.map(r =>
    [r.employee?.fullName, r.employee?.staffNumber, r.employee?.department,
     r.leaveType, r.startDate, r.endDate,
     r.numberOfDays ?? r.totalDays, r.status,
     new Date(r.createdAt).toLocaleDateString('en-KE')].join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leave-requests.csv"');
  return res.send(header + rows);
};

// ── Leave balance adjustment (admin) ─────────────────────────────────────────

const adjustLeaveBalance = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'leaveType', 'adjustment'])) return;
  const year = parseInt(req.body.year) || new Date().getFullYear();
  const path = `balances.${req.body.leaveType}`;
  await global.dbo.collection('leave_balances').updateOne(
    { employeeId: new ObjectId(req.body.employeeId), year },
    { $inc: { [`${path}.remaining`]: Number(req.body.adjustment) }, $set: { updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Balance adjusted.');
};

// ── Policies ──────────────────────────────────────────────────────────────────

const listPolicies = async (req, res) => {
  const policies = await findMany('leave_policies', {}, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, policies);
};

const createPolicy = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const { ObjectId: ObjId } = require('mongodb');
  const doc = {
    name:          req.body.name,
    description:   req.body.description || '',
    isDefault:     req.body.isDefault || false,
    countries:     req.body.countries || [],
    leaveTypes:    (req.body.leaveTypes || []).map(lt => ({ ...lt, _id: new ObjId() })),
    approvalChain: req.body.approvalChain || { approverType: 'manager', escalateAfterDays: 3 },
    assignedTo:    req.body.assignedTo || { type: 'all' },
    createdBy:     new ObjId(req.user._id),
    createdAt:     new Date(),
    updatedAt:     new Date(),
  };
  if (doc.isDefault) await global.dbo.collection('leave_policies').updateMany({}, { $set: { isDefault: false } });
  const result = await insertOne('leave_policies', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const getPolicy = async (req, res) => {
  const policy = await findOne('leave_policies', { _id: new ObjectId(req.params.id) });
  if (!policy) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, policy);
};

const updatePolicy = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  if (update.isDefault) await global.dbo.collection('leave_policies').updateMany({}, { $set: { isDefault: false } });
  await updateOne('leave_policies', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deletePolicy = async (req, res) => {
  await global.dbo.collection('leave_policies').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const setDefaultPolicy = async (req, res) => {
  await global.dbo.collection('leave_policies').updateMany({}, { $set: { isDefault: false } });
  await updateOne('leave_policies', { _id: new ObjectId(req.params.id) }, { $set: { isDefault: true } });
  return returnFunction(res, 200, true, 'Policy set as default.');
};

// ── Public holidays ───────────────────────────────────────────────────────────

const listHolidays = async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const filter = { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } };
  const holidays = await findMany('public_holidays', filter, { sort: { date: 1 } });
  return returnFunction(res, 200, true, req.locale.success, holidays);
};

const addHoliday = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'date'])) return;
  const doc = { name: req.body.name, date: req.body.date, country: req.body.country || 'KE', isRecurring: req.body.isRecurring || false, createdAt: new Date() };
  const result = await insertOne('public_holidays', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const deleteHoliday = async (req, res) => {
  await global.dbo.collection('public_holidays').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Analytics ─────────────────────────────────────────────────────────────────

const getLeaveAnalytics = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const from = `${year}-01-01`;
  const to   = `${year}-12-31`;

  const [allRequests, employees] = await Promise.all([
    findMany('leave_requests', { status: 'approved', startDate: { $gte: from }, endDate: { $lte: to } }),
    findMany('employees', { status: 'active' }, { projection: { _id: 1, fullName: 1, department: 1 } }),
  ]);

  const totalDays = allRequests.reduce((s, r) => s + (r.numberOfDays || r.totalDays || 0), 0);
  const avgDays   = employees.length > 0 ? Math.round((totalDays / employees.length) * 10) / 10 : 0;

  // By type
  const byType = {};
  for (const r of allRequests) {
    const t = r.leaveType;
    byType[t] = (byType[t] || 0) + (r.numberOfDays || r.totalDays || 0);
  }
  const mostUsedType = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];

  // By month
  const byMonth = Array(12).fill(0);
  for (const r of allRequests) {
    const m = new Date(r.startDate).getMonth();
    if (m >= 0 && m < 12) byMonth[m] += (r.numberOfDays || r.totalDays || 0);
  }

  // By department
  const byDept = {};
  for (const r of allRequests) {
    const emp = employees.find(e => String(e._id) === String(r.employeeId));
    if (!emp?.department) continue;
    byDept[emp.department] = (byDept[emp.department] || 0) + (r.numberOfDays || r.totalDays || 0);
  }

  // Employees with zero days
  const empIdsWithLeave = new Set(allRequests.map(r => String(r.employeeId)));
  const zeroCount = employees.filter(e => !empIdsWithLeave.has(String(e._id))).length;

  // Top employees
  const byEmp = {};
  for (const r of allRequests) {
    const k = String(r.employeeId);
    byEmp[k] = (byEmp[k] || 0) + (r.numberOfDays || r.totalDays || 0);
  }
  const topEmp = await Promise.all(
    Object.entries(byEmp).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(async ([id, days]) => {
        const emp = employees.find(e => String(e._id) === id);
        return { employee: emp, days };
      })
  );

  return returnFunction(res, 200, true, req.locale.success, {
    totalDays, avgDays, mostUsedType: mostUsedType ? { type: mostUsedType[0], days: mostUsedType[1] } : null,
    zeroCount, byType, byMonth, byDept, topEmployees: topEmp,
  });
};

// ── Monthly Leave Accrual ─────────────────────────────────────────────────────
// Kenya statutory annual leave = 21 days → accrual = 21/12 = 1.75 days/month.
// Run on the 1st of each month (or via cron). Idempotent: tracks last accrual month.

const runLeaveAccrual = async (req, res) => {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12
  const accrualKey = `${year}-${String(month).padStart(2, '0')}`;
  const ACCRUAL_AMOUNT = parseFloat(process.env.LEAVE_ACCRUAL_DAYS || '1.75');

  const activeEmployees = await findMany('employees', { status: { $in: ['active', 'on_leave'] } }, { projection: { _id: 1 } });
  let processed = 0, skipped = 0;

  for (const emp of activeEmployees) {
    const balance = await findOne('leave_balances', { employeeId: emp._id, year });
    if (!balance) { skipped++; continue; }

    // Idempotency: skip if already accrued this month
    if ((balance.lastAccrualMonth || '') === accrualKey) { skipped++; continue; }

    const current = balance.balances?.annual || { allocated: 0, used: 0, remaining: 0 };
    const newAllocated = parseFloat(((current.allocated || 0) + ACCRUAL_AMOUNT).toFixed(2));
    const newRemaining = parseFloat(((current.remaining || 0) + ACCRUAL_AMOUNT).toFixed(2));

    await updateOne('leave_balances', { _id: balance._id }, {
      $set: {
        'balances.annual.allocated': newAllocated,
        'balances.annual.remaining': newRemaining,
        lastAccrualMonth: accrualKey,
        updatedAt: new Date(),
      },
    });
    processed++;
  }

  const result = { accrualMonth: accrualKey, accrualAmount: ACCRUAL_AMOUNT, processed, skipped };
  if (!res) return result; // called from cron — no HTTP response
  return returnFunction(res, 200, true, `Accrual complete. Processed: ${processed}, Skipped: ${skipped}.`, result);
};

// ── Blackout periods ──────────────────────────────────────────────────────────

const listBlackouts = async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const blackouts = await findMany('leave_blackouts', {
    $or: [
      { startDate: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } },
      { endDate:   { $gte: `${year}-01-01`, $lte: `${year}-12-31` } },
    ],
  }, { sort: { startDate: 1 } });
  return returnFunction(res, 200, true, req.locale.success, blackouts);
};

const addBlackout = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'startDate', 'endDate'])) return;
  if (req.body.endDate < req.body.startDate) {
    return returnFunction(res, 400, false, 'End date must be on or after start date.');
  }
  const doc = {
    name:       req.body.name,
    startDate:  req.body.startDate,
    endDate:    req.body.endDate,
    leaveTypes: req.body.leaveTypes || [],        // [] = all leave types blocked
    reason:     req.body.reason || '',
    createdBy:  new ObjectId(req.user._id),
    createdAt:  new Date(),
  };
  const result = await insertOne('leave_blackouts', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const deleteBlackout = async (req, res) => {
  await global.dbo.collection('leave_blackouts').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Leave configuration (min notice days, etc.) ───────────────────────────────

const getLeaveConfig = async (req, res) => {
  const config = await findOne('leave_config', { _id: 'global' }) ?? { _id: 'global', minNoticeDays: {} };
  return returnFunction(res, 200, true, req.locale.success, config);
};

const updateLeaveConfig = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  await global.dbo.collection('leave_config').updateOne(
    { _id: 'global' },
    { $set: update },
    { upsert: true },
  );
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Year-end carry-forward ────────────────────────────────────────────────────
// Reads carryover settings from the default policy and carries remaining
// annual/other leave days into the next year's balance. Idempotent.

const runYearEndCarryForward = async (req, res) => {
  const now      = new Date();
  const fromYear = parseInt(req.body?.year) || now.getFullYear() - 1;
  const toYear   = fromYear + 1;

  // Resolve carryover settings from the default policy
  const policy = await findOne('leave_policies', { isDefault: true });
  const KNOWN_KEYS = {
    'annual leave': 'annual', 'sick leave': 'sick', 'maternity leave': 'maternity',
    'paternity leave': 'paternity', 'unpaid leave': 'unpaid',
    'compassionate leave': 'compassionate', 'study leave': 'study', 'emergency leave': 'emergency',
  };
  const carrySettings = {};
  for (const pt of policy?.leaveTypes ?? []) {
    const key = KNOWN_KEYS[pt.name.toLowerCase()];
    if (key) carrySettings[key] = { type: pt.carryoverType, max: pt.carryoverMax ?? 0 };
  }
  const getCarryAmount = (type, remaining) => {
    const s = carrySettings[type];
    if (!s || s.type === 'none' || !remaining) return 0;
    if (s.type === 'unlimited') return Math.max(0, remaining);
    if (s.type === 'limited')   return Math.min(Math.max(0, remaining), s.max);
    return 0;
  };

  const defaultBalances = {
    annual:        { allocated: 21,   used: 0, remaining: 21 },
    sick:          { allocated: 30,   used: 0, remaining: 30 },
    maternity:     { allocated: 90,   used: 0, remaining: 90 },
    paternity:     { allocated: 14,   used: 0, remaining: 14 },
    unpaid:        { allocated: null, used: 0, remaining: null },
    compassionate: { allocated: 3,    used: 0, remaining: 3 },
    study:         { allocated: 5,    used: 0, remaining: 5 },
    emergency:     { allocated: 3,    used: 0, remaining: 3 },
  };

  const employees = await findMany('employees', { status: { $in: ['active', 'on_leave'] } }, { projection: { _id: 1 } });
  let processed = 0, carried = 0;

  for (const emp of employees) {
    const fromBalance = await findOne('leave_balances', { employeeId: emp._id, year: fromYear });
    if (!fromBalance) continue;

    // Ensure next-year balance exists
    let toBalance = await findOne('leave_balances', { employeeId: emp._id, year: toYear });
    if (!toBalance) {
      await insertOne('leave_balances', { employeeId: emp._id, year: toYear, balances: defaultBalances });
      toBalance = await findOne('leave_balances', { employeeId: emp._id, year: toYear });
    }

    // Apply carry-forward increments
    const $inc = {};
    for (const [type, b] of Object.entries(fromBalance.balances || {})) {
      const carry = getCarryAmount(type, b.remaining);
      if (carry > 0 && toBalance.balances?.[type]) {
        $inc[`balances.${type}.allocated`] = carry;
        $inc[`balances.${type}.remaining`] = carry;
        carried += carry;
      }
    }
    if (Object.keys($inc).length > 0) {
      await updateOne('leave_balances', { employeeId: emp._id, year: toYear }, { $inc, $set: { updatedAt: new Date() } });
    }
    processed++;
  }

  const result = { fromYear, toYear, processed, totalDaysCarried: parseFloat(carried.toFixed(2)) };
  if (!res) { console.log(`[CRON] Year-end carry-forward ${fromYear}→${toYear}: ${processed} employees, ${carried} days carried`); return result; }
  return returnFunction(res, 200, true, `Carry-forward complete: ${processed} employee${processed !== 1 ? 's' : ''} processed, ${carried} day${carried !== 1 ? 's' : ''} carried to ${toYear}.`, result);
};

module.exports = {
  getLeaveBalances, listLeaveRequests, createLeaveRequest,
  approveLeaveRequest, rejectLeaveRequest, deleteLeaveRequest,
  revokeLeaveRequest, resolveDispute, getLeaveCalendar, getLeaveConflicts,
  getMyBalances, getCalendarEntries, getTodayAbsences, getUpcomingLeaves,
  cancelLeaveRequest, getLeaveRequest, exportLeaveRequests, adjustLeaveBalance,
  listPolicies, createPolicy, getPolicy, updatePolicy, deletePolicy, setDefaultPolicy,
  listHolidays, addHoliday, deleteHoliday, getLeaveAnalytics,
  runLeaveAccrual,
  // leave governance
  listBlackouts, addBlackout, deleteBlackout,
  getLeaveConfig, updateLeaveConfig,
  runYearEndCarryForward,
};
