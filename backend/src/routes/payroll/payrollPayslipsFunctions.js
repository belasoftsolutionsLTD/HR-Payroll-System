const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');

// Single source of truth for "an employee's payslips" — reads the Cycles engine's
// output (payslips + payroll_results), never the retired payroll_summaries collection.
// Shared by the payroll module's own routes and by /api/me/payslips (see meFunctions.js)
// so there is exactly one query implementation instead of two drifting copies.
const getEmployeePayslipRecords = async (employeeId, { skip, limit } = {}) => {
  const filter = { employeeId: new ObjectId(employeeId) };
  const findOpts = { sort: { 'period.year': -1, 'period.month': -1 }, projection: { pdfData: 0 } };
  if (skip !== undefined) findOpts.skip = skip;
  if (limit !== undefined) findOpts.limit = limit;

  const [total, slips] = await Promise.all([
    countDocuments('payslips', filter),
    findMany('payslips', filter, findOpts),
  ]);

  const resultIds = slips.filter((s) => s.resultId).map((s) => s.resultId);
  const results = resultIds.length ? await findMany('payroll_results', { _id: { $in: resultIds } }) : [];
  const resultMap = Object.fromEntries(results.map((r) => [String(r._id), r]));

  const enriched = slips.map((s) => ({ ...s, result: resultMap[String(s.resultId)] || null }));
  return { total, data: enriched };
};

// Employee's own payslips (paginated) — reads from the Cycles engine's payslips collection.
const getMyPayslips = async (req, res) => {
  const employeeId = req.user?.employeeId;
  if (!employeeId) return returnFunction(res, 403, false, 'No employee record linked to this user.');
  const { page, limit, skip } = getPagination(req.query);
  const { total, data } = await getEmployeePayslipRecords(employeeId, { skip, limit });
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

// Download single payslip as PDF — served from the PDF generated when the cycle was closed.
const downloadPayslipPDF = async (req, res) => {
  const slip = await findOne('payslips', { _id: new ObjectId(req.params.id) });
  if (!slip) return returnFunction(res, 404, false, req.locale.notFound);

  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(slip.employeeId) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Access denied.');
  }
  if (!slip.pdfData) return returnFunction(res, 404, false, 'PDF not available for this payslip.');

  const buffer = Buffer.from(slip.pdfData, 'base64');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="payslip-${slip.period.year}-${String(slip.period.month).padStart(2, '0')}.pdf"`);
  return res.send(buffer);
};

// Get single payslip metadata (with its full earnings/deductions breakdown via payroll_results)
const getPayslip = async (req, res) => {
  const slip = await findOne('payslips', { _id: new ObjectId(req.params.id) }, { projection: { pdfData: 0 } });
  if (!slip) return returnFunction(res, 404, false, req.locale.notFound);

  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(slip.employeeId) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Access denied.');
  }

  const result = slip.resultId ? await findOne('payroll_results', { _id: slip.resultId }) : null;
  return returnFunction(res, 200, true, req.locale.success, { ...slip, result });
};

// HR: all payslips for a given employee (employee-profile Payroll history)
const getEmployeePayslips = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { total, data } = await getEmployeePayslipRecords(req.params.employeeId, { skip, limit });
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

module.exports = { getEmployeePayslipRecords, getMyPayslips, downloadPayslipPDF, getPayslip, getEmployeePayslips };
