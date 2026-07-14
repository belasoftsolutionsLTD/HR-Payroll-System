const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');

// Staff loans/advances are deliberately separate from employee_compensations — that
// collection is a flat recurring amount with no concept of a principal or payoff, which
// is fine for something like a welfare contribution but wrong for a loan (it would keep
// deducting forever with no awareness of how much has been repaid). A loan needs its own
// running balance that the payroll engine decrements each cycle and auto-completes once
// it hits zero.

// List loans for one employee (all statuses, most recent first)
const getEmployeeLoans = async (req, res) => {
  const loans = await findMany('staff_loans', { employeeId: new ObjectId(req.params.employeeId) }, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, loans);
};

// All employees with an active loan (for a payroll-wide "who has a loan running" view)
const listActiveLoanSummaries = async (req, res) => {
  const loans = await findMany('staff_loans', { status: 'active' }, { sort: { createdAt: -1 } });
  const empIds = [...new Set(loans.map((l) => String(l.employeeId)))].map((id) => new ObjectId(id));
  const employees = empIds.length
    ? await findMany('employees', { _id: { $in: empIds } }, { projection: { fullName: 1, staffNumber: 1, department: 1 } })
    : [];
  const empMap = Object.fromEntries(employees.map((e) => [String(e._id), e]));
  const enriched = loans.map((l) => ({ ...l, employee: empMap[String(l.employeeId)] ?? null }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createLoan = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'principal', 'monthlyInstallment'])) return;
  const { employeeId, principal, monthlyInstallment, loanType, startDate, notes } = req.body;

  const emp = await findOne('employees', { _id: new ObjectId(employeeId) }, { projection: { fullName: 1 } });
  if (!emp) return returnFunction(res, 404, false, 'Employee not found.');

  const principalNum = Number(principal);
  const installmentNum = Number(monthlyInstallment);
  if (!(principalNum > 0)) return returnFunction(res, 400, false, 'Principal must be greater than 0.');
  if (!(installmentNum > 0)) return returnFunction(res, 400, false, 'Monthly installment must be greater than 0.');

  const doc = {
    employeeId: new ObjectId(employeeId),
    loanType: loanType || 'Staff Loan',
    principal: principalNum,
    monthlyInstallment: installmentNum,
    balanceRemaining: principalNum,
    totalRepaid: 0,
    status: 'active',
    startDate: startDate ? new Date(startDate) : new Date(),
    completedAt: null,
    notes: notes || null,
    createdBy: req.user?._id ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('staff_loans', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

// Adjust the installment amount, or write off / cancel the remaining balance early.
const updateLoan = async (req, res) => {
  const loan = await findOne('staff_loans', { _id: new ObjectId(req.params.id) });
  if (!loan) return returnFunction(res, 404, false, req.locale.notFound);
  if (loan.status !== 'active') return returnFunction(res, 400, false, 'Only an active loan can be edited.');

  const update = { updatedAt: new Date() };
  if (req.body.monthlyInstallment !== undefined) {
    const installmentNum = Number(req.body.monthlyInstallment);
    if (!(installmentNum > 0)) return returnFunction(res, 400, false, 'Monthly installment must be greater than 0.');
    update.monthlyInstallment = installmentNum;
  }
  if (req.body.notes !== undefined) update.notes = req.body.notes;

  if (req.body.action === 'cancel') {
    update.status = 'cancelled';
    update.completedAt = new Date();
  }

  await updateOne('staff_loans', { _id: loan._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

module.exports = { getEmployeeLoans, listActiveLoanSummaries, createLoan, updateLoan };
