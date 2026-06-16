const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { calculateWorkingDays } = require('../../functions/HR/leaveCalculator');
const { notifyEmployee } = require('../../functions/HR/notifyUser');

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
  if (req.query.employeeId) filter.employeeId = new ObjectId(req.query.employeeId);
  if (req.query.leaveType) filter.leaveType = req.query.leaveType;

  const { page, limit, skip } = getPagination(req.query);
  const [total, records] = await Promise.all([
    countDocuments('leave_requests', filter),
    findMany('leave_requests', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  // Join employee name for HR view (not needed when staff sees own requests)
  const enriched = await Promise.all(records.map(async (r) => {
    const emp = await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    return { ...r, employee: emp ?? null };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const createLeaveRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'leaveType', 'startDate', 'endDate', 'reason'])) return;

  const year = new Date(req.body.startDate).getFullYear();
  const numberOfDays = calculateWorkingDays(req.body.startDate, req.body.endDate);

  const balance = await findOne('leave_balances', { employeeId: new ObjectId(req.body.employeeId), year });
  if (!balance) return returnFunction(res, 400, false, 'No leave balance record found for this employee.');

  const typeBalance = balance.balances[req.body.leaveType];
  if (!typeBalance) return returnFunction(res, 400, false, 'Invalid leave type.');
  if (typeBalance.remaining !== null && typeBalance.remaining < numberOfDays) {
    return returnFunction(res, 400, false, `Insufficient ${req.body.leaveType} leave balance. Available: ${typeBalance.remaining} days, Requested: ${numberOfDays} days.`);
  }

  const doc = {
    employeeId: new ObjectId(req.body.employeeId),
    leaveType: req.body.leaveType,
    startDate: req.body.startDate,
    endDate: req.body.endDate,
    numberOfDays,
    reason: req.body.reason,
    status: 'pending',
    approvedBy: null,
    approvedAt: null,
    comments: null,
    createdAt: new Date(),
  };

  const result = await insertOne('leave_requests', doc);
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

  // Group by department
  const grouped = {};
  await Promise.all(requests.map(async (r) => {
    const emp = await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1, department: 1 } });
    if (!emp) return;
    if (!grouped[emp.department]) grouped[emp.department] = [];
    grouped[emp.department].push({ ...r, employee: emp });
  }));

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

module.exports = { getLeaveBalances, listLeaveRequests, createLeaveRequest, approveLeaveRequest, rejectLeaveRequest, deleteLeaveRequest, revokeLeaveRequest, resolveDispute, getLeaveCalendar, getLeaveConflicts };
