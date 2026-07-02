const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne } = require('../../functions/Database/commonDBFunctions');
const { getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { generatePayslip } = require('../../services/pdfService');

// Employee's own payslips (reads from payroll_summaries — the actual source of truth)
const getMyPayslips = async (req, res) => {
  const employeeId = req.user?.employeeId;
  if (!employeeId) return returnFunction(res, 403, false, 'No employee record linked to this user.');
  const { page, limit, skip } = getPagination(req.query);
  const filter = { employeeId: new ObjectId(employeeId) };
  const [total, data] = await Promise.all([
    global.dbo.collection('payroll_summaries').countDocuments(filter),
    global.dbo.collection('payroll_summaries').find(filter)
      .sort({ year: -1, month: -1 }).skip(skip).limit(limit).toArray(),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

// Download single payslip as PDF — generated on-the-fly from payroll_summaries
const downloadPayslipPDF = async (req, res) => {
  const payroll = await findOne('payroll_summaries', { _id: new ObjectId(req.params.id) });
  if (!payroll) return returnFunction(res, 404, false, req.locale.notFound);

  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(payroll.employeeId) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Access denied.');
  }

  const employee = await findOne('employees', { _id: payroll.employeeId });
  if (!employee) return returnFunction(res, 404, false, 'Employee record not found.');

  let jobGroupName = null;
  if (employee.jobGroupId) {
    const jg = await findOne('job_groups', { _id: employee.jobGroupId });
    if (jg) jobGroupName = jg.name;
  }

  const buffer = await generatePayslip({ ...employee, jobGroupName }, payroll);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="payslip-${payroll.year}-${String(payroll.month).padStart(2, '0')}.pdf"`);
  return res.send(buffer);
};

// Get single payslip metadata
const getPayslip = async (req, res) => {
  const payroll = await findOne('payroll_summaries', { _id: new ObjectId(req.params.id) });
  if (!payroll) return returnFunction(res, 404, false, req.locale.notFound);
  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(payroll.employeeId) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Access denied.');
  }
  return returnFunction(res, 200, true, req.locale.success, payroll);
};

// HR: all payslips for an employee
const getEmployeePayslips = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = { employeeId: new ObjectId(req.params.employeeId) };
  const [total, data] = await Promise.all([
    global.dbo.collection('payroll_summaries').countDocuments(filter),
    global.dbo.collection('payroll_summaries').find(filter)
      .sort({ year: -1, month: -1 }).skip(skip).limit(limit).toArray(),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

module.exports = { getMyPayslips, downloadPayslipPDF, getPayslip, getEmployeePayslips };
