const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { generatePayslip } = require('../../services/pdfService');
const { notifyEmployee } = require('../../functions/HR/notifyUser');
const { buildCalculator, loadTaxConfig } = require('../../functions/taxCalculator');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const listPayroll = async (req, res) => {
  const filter = {};
  if (req.query.month) filter.month = parseInt(req.query.month);
  if (req.query.year)  filter.year  = parseInt(req.query.year);

  const { page, limit, skip } = getPagination(req.query);
  const [total, records] = await Promise.all([
    countDocuments('payroll_summaries', filter),
    findMany('payroll_summaries', filter, { skip, limit, sort: { year: -1, month: -1 } }),
  ]);

  // Batch-load employee names (avoids N+1)
  const prEmpIds = [...new Set(records.map(r => r.employeeId))];
  const prEmps = await findMany('employees', { _id: { $in: prEmpIds } }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
  const prEmpMap = Object.fromEntries(prEmps.map(e => [String(e._id), e]));
  const enriched = records.map(r => ({ ...r, employee: prEmpMap[String(r.employeeId)] ?? null }));

  // Monthly totals (only when filtering by a specific month/year)
  let totals = null;
  if (req.query.month && req.query.year) {
    const allForMonth = await findMany('payroll_summaries', filter, {});
    totals = allForMonth.reduce(
      (acc, r) => ({
        grossPay: acc.grossPay + (r.grossPay || 0),
        netPay:   acc.netPay   + (r.netPay   || 0),
        paye:     acc.paye     + (r.deductions?.paye  || 0),
        nssf:     acc.nssf     + (r.deductions?.nssf  || 0),
        sha:      acc.sha      + (r.deductions?.sha   || 0),
        count:    acc.count    + 1,
      }),
      { grossPay: 0, netPay: 0, paye: 0, nssf: 0, sha: 0, count: 0 },
    );
  }

  return returnFunction(res, 200, true, req.locale.success, { ...paginatedResponse(enriched, total, page, limit), totals });
};

const getEmployeePayroll = async (req, res) => {
  const data = await findMany('payroll_summaries',
    { employeeId: new ObjectId(req.params.employeeId) },
    { sort: { year: -1, month: -1 } }
  );
  return returnFunction(res, 200, true, req.locale.success, data);
};

const buildPayrollDoc = async (emp, month, year, generatedBy, otherDeductions = [], otherAllowances = []) => {
  const grossPay = emp.grossPay || 0;
  if (!grossPay) return null;

  const empJobGroupId = emp.jobGroupId ? String(emp.jobGroupId) : null;

  // Load configurable tax engine (falls back to Kenya defaults if not configured)
  const taxConfig = await loadTaxConfig();
  const tax = buildCalculator(taxConfig);

  // Fixed allowances matching employee's job group
  const allFixedAllowances = await findMany('fixed_allowances', { isEnabled: true });
  const fixedAllowances = allFixedAllowances.filter(a => {
    const ids = (a.jobGroupIds || []).map(String);
    return ids.length === 0 || (empJobGroupId && ids.includes(empJobGroupId));
  });

  const fixedAllowancesTotal = fixedAllowances.reduce((s, a) => s + (a.amount || 0), 0);
  const otherAllowancesTotal = otherAllowances.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  const allowancesTotal = fixedAllowancesTotal + otherAllowancesTotal;
  const totalEarnings   = grossPay + allowancesTotal;

  const paye = tax.calcIncomeTax(totalEarnings);
  const nssf = tax.calcPension(totalEarnings);
  const sha  = tax.calcHealth(totalEarnings);

  // Auto-apply configured deduction types matching the employee's job group
  const allDeductionTypes = await findMany('deduction_types', { isEnabled: true });
  const autoDeductions = allDeductionTypes
    .filter(d => {
      const ids = (d.jobGroupIds || []).map(String);
      return ids.length === 0 || (empJobGroupId && ids.includes(empJobGroupId));
    })
    .map(d => ({
      label: d.name,
      amount: d.type === 'percentage'
        ? Math.round(totalEarnings * ((d.percentage || 0) / 100) * 100) / 100
        : (d.amount || 0),
    }));

  const allOtherDeductions = [...autoDeductions, ...otherDeductions];
  const extraDeductions     = allOtherDeductions.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
  const netPay = Math.round((totalEarnings - paye - nssf - sha - extraDeductions) * 100) / 100;

  return {
    employeeId: emp._id,
    month:  parseInt(month),
    year:   parseInt(year),
    grossPay,
    allowances: fixedAllowances.map(a => ({ name: a.name, amount: a.amount })),
    otherAllowances,
    allowancesTotal,
    totalEarnings,
    // Keep paye/nssf/sha field names for backward compat with existing records & PDF service
    deductions: { paye, nssf, sha, otherDeductions: allOtherDeductions },
    // Store labels and currency so payslips display the correct names for any country
    taxLabels: {
      incomeTax: tax.incomeTaxName,
      pension:   tax.pensionName,
      health:    tax.healthName,
      currency:  tax.currency,
    },
    currency: tax.currency,
    netPay,
    generatedAt: new Date(),
    generatedBy: new ObjectId(generatedBy),
  };
};

const createPayroll = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'month', 'year'])) return;
  const { employeeId, month, year, otherDeductions, otherAllowances } = req.body;

  // Block future months
  const now = new Date();
  const reqMonth = parseInt(month);
  const reqYear  = parseInt(year);
  if (reqYear > now.getFullYear() || (reqYear === now.getFullYear() && reqMonth > now.getMonth() + 1)) {
    return returnFunction(res, 400, false, 'Cannot generate payroll for a future period.');
  }

  const emp = await findOne('employees', { _id: new ObjectId(employeeId) });
  if (!emp) return returnFunction(res, 404, false, 'Employee not found.');
  if (!emp.grossPay) return returnFunction(res, 400, false, `No gross pay set for ${emp.fullName}. Update their profile first.`);

  const alreadyGenerated = await findOne('payroll_summaries', {
    employeeId: new ObjectId(employeeId), month: reqMonth, year: reqYear,
  });
  if (alreadyGenerated) {
    return returnFunction(res, 409, false, `Payroll for ${emp.fullName} (${MONTHS[reqMonth - 1]} ${reqYear}) has already been generated.`);
  }

  const doc = await buildPayrollDoc(emp, reqMonth, reqYear, req.user._id, otherDeductions || [], otherAllowances || []);

  await global.dbo.collection('payroll_summaries').insertOne(doc);

  notifyEmployee(employeeId, {
    type: 'payroll',
    title: 'Payslip Ready',
    body: `Your payslip for ${MONTHS[reqMonth - 1]} ${reqYear} is now available. Net pay: ${doc.currency} ${doc.netPay.toLocaleString()}.`,
    link: '/staff-portal',
  }).catch(() => {});

  return returnFunction(res, 200, true, req.locale.success, doc);
};

const downloadPayslip = async (req, res) => {
  const { employeeId, month, year } = req.params;
  const [employee, payroll] = await Promise.all([
    findOne('employees', { _id: new ObjectId(employeeId) }),
    findOne('payroll_summaries', { employeeId: new ObjectId(employeeId), month: parseInt(month), year: parseInt(year) }),
  ]);
  if (!employee || !payroll) return returnFunction(res, 404, false, req.locale.notFound);

  let jobGroupName = null;
  if (employee.jobGroupId) {
    const jg = await findOne('job_groups', { _id: employee.jobGroupId });
    if (jg) jobGroupName = jg.name;
  }

  const buffer = await generatePayslip({ ...employee, jobGroupName }, payroll);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${employee.staffNumber}-${month}-${year}.pdf"`);
  res.send(buffer);
};

// ── Bulk generate payroll with optional filters ───────────────────────────────
const bulkGeneratePayroll = async (req, res) => {
  if (!validateRequiredFields(req, res, ['month', 'year'])) return;
  const { month, year, department, jobGroupId, employmentType, employeeIds } = req.body;

  // Block future months
  const now = new Date();
  const reqMonth = parseInt(month);
  const reqYear  = parseInt(year);
  if (reqYear > now.getFullYear() || (reqYear === now.getFullYear() && reqMonth > now.getMonth() + 1)) {
    return returnFunction(res, 400, false, 'Cannot generate payroll for a future period.');
  }

  // Build employee filter
  const empFilter = { status: { $in: ['active', 'on_leave'] } };
  if (department)      empFilter.department     = department;
  if (jobGroupId)      empFilter.jobGroupId     = jobGroupId;
  if (employmentType)  empFilter.employmentType = employmentType;

  // Manual employee selection overrides filters
  let employees;
  if (Array.isArray(employeeIds) && employeeIds.length) {
    employees = await findMany('employees', { _id: { $in: employeeIds.map(id => new ObjectId(id)) } });
  } else {
    employees = await findMany('employees', empFilter);
  }

  if (!employees.length) return returnFunction(res, 400, false, 'No employees matched the filters.');

  const results = { generated: 0, skipped: 0, skippedNames: [], errors: [] };

  for (const emp of employees) {
    try {
      if (!emp.grossPay) {
        results.skipped++;
        results.skippedNames.push(`${emp.fullName} (no gross pay)`);
        continue;
      }

      const existing = await findOne('payroll_summaries', { employeeId: emp._id, month: reqMonth, year: reqYear });
      if (existing) {
        results.skipped++;
        results.skippedNames.push(`${emp.fullName} (already generated)`);
        continue;
      }

      const doc = await buildPayrollDoc(emp, reqMonth, reqYear, req.user._id);
      await global.dbo.collection('payroll_summaries').insertOne(doc);
      results.generated++;

      notifyEmployee(emp._id, {
        type: 'payroll',
        title: 'Payslip Ready',
        body: `Your payslip for ${MONTHS[reqMonth - 1]} ${reqYear} has been generated. Net pay: ${doc.currency} ${doc.netPay.toLocaleString()}.`,
        link: '/staff-portal',
      }).catch(() => {});
    } catch (e) {
      results.errors.push({ employeeId: emp._id, name: emp.fullName, error: e.message });
    }
  }

  return returnFunction(res, 200, true,
    `Bulk payroll complete: ${results.generated} generated, ${results.skipped} skipped (no gross pay set).`,
    results
  );
};

const disbursePayroll = async (req, res) => {
  const { payrollId } = req.params;
  const { companyAccountId } = req.body;
  if (!companyAccountId) return returnFunction(res, 400, false, 'Company account is required.');

  const payroll = await findOne('payroll_summaries', { _id: new ObjectId(payrollId) });
  if (!payroll) return returnFunction(res, 404, false, 'Payroll record not found.');
  if (payroll.paymentStatus === 'paid') return returnFunction(res, 409, false, 'This payroll has already been paid.');

  const [companyAccount, employee] = await Promise.all([
    findOne('company_accounts', { _id: new ObjectId(companyAccountId) }),
    findOne('employees', { _id: payroll.employeeId }, { projection: { fullName: 1, paymentMethod: 1, bankName: 1, bankAccountNumber: 1, mpesaNumber: 1 } }),
  ]);
  if (!companyAccount) return returnFunction(res, 404, false, 'Company account not found.');

  const now = new Date();
  const disbursement = {
    payrollId: payroll._id,
    employeeId: payroll.employeeId,
    month: payroll.month,
    year: payroll.year,
    netPay: payroll.netPay,
    companyAccountId: new ObjectId(companyAccountId),
    companyAccountName: companyAccount.name,
    employeePaymentMethod: employee?.paymentMethod || 'bank_transfer',
    employeeBankName: employee?.bankName || null,
    employeeAccountNumber: employee?.bankAccountNumber || null,
    employeeMpesaNumber: employee?.mpesaNumber || null,
    processedBy: new ObjectId(req.user._id),
    processedAt: now,
  };

  const result = await global.dbo.collection('disbursements').insertOne(disbursement);

  await global.dbo.collection('payroll_summaries').updateOne(
    { _id: payroll._id },
    { $set: { paymentStatus: 'paid', paidAt: now, companyAccountId: new ObjectId(companyAccountId), disbursementId: result.insertedId } }
  );

  notifyEmployee(payroll.employeeId, {
    type: 'payment',
    title: 'Salary Disbursed',
    body: `Your salary of ${payroll.currency || 'KES'} ${payroll.netPay.toLocaleString()} for ${MONTHS[payroll.month - 1]} ${payroll.year} has been processed.`,
    link: '/staff-portal',
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Payment disbursed successfully.', { disbursementId: result.insertedId });
};

module.exports = { listPayroll, getEmployeePayroll, createPayroll, downloadPayslip, bulkGeneratePayroll, disbursePayroll };
