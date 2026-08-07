const fs = require('fs');
const returnFunction = require('../../functions/returnFunction');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 2) —
// payslips/payroll_results now live in Postgres. pdfData (base64) is now pdfPath (a real
// file on disk), matching how employee_documents/certifications already do it.
const { findOne, findMany, countDocuments, knex } = require('../../functions/Database/pgDBFunctions');
const { getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');

// Single source of truth for "an employee's payslips" — reads the Cycles engine's
// output (payslips + payroll_results), never the retired payroll_summaries collection.
// Shared by the payroll module's own routes and by /api/me/payslips (see meFunctions.js)
// so there is exactly one query implementation instead of two drifting copies.
const getEmployeePayslipRecords = async (employeeId, { skip, limit } = {}) => {
  const filter = { employeeId };
  const findOpts = { orderBy: [{ column: 'periodYear', order: 'desc' }, { column: 'periodMonth', order: 'desc' }] };
  if (skip !== undefined) findOpts.offset = skip;
  if (limit !== undefined) findOpts.limit = limit;

  const [total, slips] = await Promise.all([
    countDocuments('payslips', filter),
    findMany('payslips', filter, findOpts),
  ]);

  const resultIds = slips.filter((s) => s.resultId).map((s) => s.resultId);
  const results = resultIds.length ? await knex('payroll_results').whereIn('id', resultIds) : [];
  const resultMap = Object.fromEntries(results.map((r) => [r.id, r]));

  const enriched = slips.map((s) => ({ ...s, result: resultMap[s.resultId] || null }));
  return { total, data: enriched };
};

// Employee's own payslips (paginated) — reads from the Cycles engine's payslips collection.
const getMyPayslips = async (req, res) => {
  const employeeId = req.user?.employeeId;
  if (!employeeId) return returnFunction(res, 403, false, 'No employee record linked to this user.');
  const { page, limit, skip } = getPagination(req.query);
  const { total, data } = await getEmployeePayslipRecords(String(employeeId), { skip, limit });
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

// Download single payslip as PDF — served from the PDF generated when the cycle was closed.
const downloadPayslipPDF = async (req, res) => {
  const slip = await findOne('payslips', { id: req.params.id });
  if (!slip) return returnFunction(res, 404, false, req.locale.notFound);

  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(slip.employeeId) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Access denied.');
  }
  if (!slip.pdfPath || !fs.existsSync(slip.pdfPath)) return returnFunction(res, 404, false, 'PDF not available for this payslip.');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="payslip-${slip.periodYear}-${String(slip.periodMonth).padStart(2, '0')}.pdf"`);
  return res.sendFile(require('path').resolve(slip.pdfPath));
};

// Get single payslip metadata (with its full earnings/deductions breakdown via payroll_results)
const getPayslip = async (req, res) => {
  const slip = await findOne('payslips', { id: req.params.id });
  if (!slip) return returnFunction(res, 404, false, req.locale.notFound);

  const isHR = ['super_admin', 'hr_manager'].includes(req.user?.role);
  if (!isHR && String(slip.employeeId) !== String(req.user?.employeeId)) {
    return returnFunction(res, 403, false, 'Access denied.');
  }

  const result = slip.resultId ? await findOne('payroll_results', { id: slip.resultId }) : null;
  return returnFunction(res, 200, true, req.locale.success, { ...slip, result });
};

// HR: all payslips for a given employee (employee-profile Payroll history)
const getEmployeePayslips = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { total, data } = await getEmployeePayslipRecords(req.params.employeeId, { skip, limit });
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

module.exports = { getEmployeePayslipRecords, getMyPayslips, downloadPayslipPDF, getPayslip, getEmployeePayslips };
