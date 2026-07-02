const { ObjectId } = require('mongodb');
const path = require('path');
const fs = require('fs');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { generateStaffNumber } = require('../../functions/HR/staffNumberGenerator');
const { assignDefaultTasks } = require('../onboarding/onboardingFunctions');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');

const DEPARTMENTS = ['Administration','Human Resources','Finance & Accounts','Information Technology','Operations','Sales & Marketing','Customer Service','Legal & Compliance','Procurement','Logistics & Supply Chain','Research & Development','Communications','Health & Safety','Facilities Management','Executive'];

const revertExpiredLeaveStatuses = async () => {
  const today = new Date().toISOString().slice(0, 10);
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
  const { designation, employmentType, staffCategory, status, search } = req.query;
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
  if (staffCategory) filter.staffCategory = staffCategory;
  if (status) filter.status = status;
  if (search) filter.$or = [
    { fullName: { $regex: search, $options: 'i' } },
    { staffNumber: { $regex: search, $options: 'i' } },
  ];

  const { page, limit, skip } = getPagination(req.query, 500);
  const [total, data] = await Promise.all([
    countDocuments('employees', filter),
    findMany('employees', filter, { skip, limit, sort: { createdAt: -1 }, projection: { password: 0 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

const getEmployee = async (req, res) => {
  const employee = await findOne('employees', { _id: new ObjectId(req.params.id) });
  if (!employee) return returnFunction(res, 404, false, req.locale.notFound);
  let manager = null;
  if (employee.managerId) {
    manager = await findOne('employees', { _id: employee.managerId }, { projection: { fullName: 1, designation: 1, department: 1 } });
  }
  return returnFunction(res, 200, true, req.locale.success, { ...employee, manager: manager ?? null });
};

const createEmployee = async (req, res) => {
  const required = ['fullName', 'nationalId', 'designation', 'employmentType', 'department', 'dateOfHire', 'salaryGrade', 'email'];
  if (!validateRequiredFields(req, res, required)) return;

  const existing = await findOne('employees', { nationalId: req.body.nationalId });
  if (existing) return returnFunction(res, 409, false, 'An employee with this National ID already exists.');

  const hireYear = new Date(req.body.dateOfHire).getFullYear();
  const staffNumber = await generateStaffNumber(hireYear);

  const doc = {
    fullName: req.body.fullName,
    nationalId: req.body.nationalId,
    staffNumber,
    designation: req.body.designation,
    employmentType: req.body.employmentType,
    department: req.body.department,
    jobGroupId: req.body.jobGroupId || null,
    dateOfHire: new Date(req.body.dateOfHire),
    dateOfBirth: req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : null,
    contractEndDate: req.body.contractEndDate ? new Date(req.body.contractEndDate) : null,
    salaryGrade: req.body.salaryGrade,
    grossPay: req.body.grossPay ? Number(req.body.grossPay) : null,
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
    staffCategory: req.body.staffCategory,
    location:    req.body.location    || null,
    costCenter:  req.body.costCenter  || null,
    managerId:   req.body.managerId   ? new ObjectId(req.body.managerId) : null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('employees', doc);

  // Create leave_balances for current year
  const year = new Date().getFullYear();
  await insertOne('leave_balances', {
    employeeId: result.insertedId,
    year,
    balances: {
      annual:        { allocated: 21,   used: 0, remaining: 21 },
      sick:          { allocated: 30,   used: 0, remaining: 30 },
      maternity:     { allocated: 90,   used: 0, remaining: 90 },
      paternity:     { allocated: 14,   used: 0, remaining: 14 },
      unpaid:        { allocated: null, used: 0, remaining: null },
      compassionate: { allocated: 3,    used: 0, remaining: 3 },
      study:         { allocated: 5,    used: 0, remaining: 5 },
      emergency:     { allocated: 3,    used: 0, remaining: 3 },
    },
  });

  // Auto-assign onboarding tasks from templates (fire-and-forget)
  assignDefaultTasks(result.insertedId, req.body.dateOfHire).catch(() => {});

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
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  delete update.staffNumber;
  delete update.nationalId;
  if (update.dateOfHire) update.dateOfHire = new Date(update.dateOfHire);
  if (update.contractEndDate) update.contractEndDate = new Date(update.contractEndDate);
  await updateOne('employees', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const patchEmployeeStatus = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  const allowed = ['active', 'on_leave', 'suspended', 'terminated'];
  if (!allowed.includes(req.body.status)) return returnFunction(res, 400, false, 'Invalid status.');
  await updateOne('employees', { _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteEmployee = async (req, res) => {
  await updateOne('employees', { _id: new ObjectId(req.params.id) }, { $set: { status: 'terminated', updatedAt: new Date() } });
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

module.exports = { listEmployees, getEmployee, createEmployee, updateEmployee, patchEmployeeStatus, deleteEmployee, uploadDocument, downloadDocument, getOrgChart };
