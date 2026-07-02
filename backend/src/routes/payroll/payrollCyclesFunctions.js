const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { generatePayslipFromResult } = require('../../services/payslipService');

// ── List Cycles ───────────────────────────────────────────────────────────────

const listCycles = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const [total, data] = await Promise.all([
    countDocuments('payroll_cycles', filter),
    findMany('payroll_cycles', filter, { skip, limit, sort: { 'period.year': -1, 'period.month': -1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

// ── Get Single Cycle ──────────────────────────────────────────────────────────

const getCycle = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, cycle);
};

// ── Create Cycle ──────────────────────────────────────────────────────────────

const createCycle = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'month', 'year'])) return;
  const { name, month, year, payDate, payGroup, currency } = req.body;
  const m = parseInt(month), y = parseInt(year);
  const startDate = new Date(y, m - 1, 1);
  const endDate   = new Date(y, m, 0);

  const existing = await findOne('payroll_cycles', { 'period.month': m, 'period.year': y });
  if (existing) return returnFunction(res, 409, false, `A payroll cycle for ${month}/${year} already exists.`);

  const doc = {
    name,
    period:       { month: m, year: y, startDate, endDate },
    payDate:       payDate ? new Date(payDate) : null,
    status:        'open',
    payGroup:      payGroup  || 'all',
    currency:      currency  || 'KES',
    totalGross:    0, totalDeductions: 0, totalNet: 0, totalEmployerCost: 0, employeeCount: 0,
    hasExceptions: false, exceptionCount: 0,
    lockedAt: null, lockedBy: null, closedAt: null, closedBy: null,
    createdBy: req.user?._id ?? null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('payroll_cycles', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// ── Advance Cycle Status ──────────────────────────────────────────────────────

const STATUS_FLOW = { open: 'review', review: 'locked', locked: 'closed' };

const advanceCycleStatus = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  const next = STATUS_FLOW[cycle.status];
  if (!next) return returnFunction(res, 400, false, 'Cycle is already closed.');

  if (next === 'locked') return lockCycleInternal(req, res, cycle);
  if (next === 'closed') return closeCycleInternal(req, res, cycle);

  await updateOne('payroll_cycles', { _id: cycle._id }, { $set: { status: next, updatedAt: new Date() } });
  return returnFunction(res, 200, true, `Cycle moved to ${next}.`);
};

// ── Get Cycle Results ─────────────────────────────────────────────────────────

const getCycleResults = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = { cycleId: new ObjectId(req.params.id) };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.hasException === 'true') filter.hasException = true;
  const [total, results] = await Promise.all([
    countDocuments('payroll_results', filter),
    findMany('payroll_results', filter, { skip, limit, sort: { createdAt: 1 } }),
  ]);
  const enriched = await Promise.all(results.map(async r => {
    const emp = await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1, bankAccount: 1 } });
    return { ...r, employee: emp ?? null };
  }));
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

// ── Get Exceptions ────────────────────────────────────────────────────────────

const getCycleExceptions = async (req, res) => {
  const results = await findMany('payroll_results', { cycleId: new ObjectId(req.params.id), hasException: true }, {});
  const enriched = await Promise.all(results.map(async r => {
    const emp = await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    return { ...r, employee: emp ?? null };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── Approve Employees ─────────────────────────────────────────────────────────

const approveEmployees = async (req, res) => {
  const { cycleId } = req.params;
  const { employeeIds, approveAll } = req.body;
  const filter = { cycleId: new ObjectId(cycleId), status: 'pending' };
  if (!approveAll && employeeIds?.length) {
    filter.employeeId = { $in: employeeIds.map(id => new ObjectId(id)) };
  }
  await global.dbo.collection('payroll_results').updateMany(filter, {
    $set: { status: 'approved', approvedBy: req.user?._id ?? null, approvedAt: new Date(), updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Approved successfully.');
};

// ── Lock Cycle → Calculate Results ───────────────────────────────────────────

const lockCycle = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  return lockCycleInternal(req, res, cycle);
};

async function lockCycleInternal(req, res, cycle) {
  if (cycle.status !== 'review') return returnFunction(res, 400, false, 'Cycle must be in Review to lock.');

  // Get all active employees (or filtered by payGroup)
  const empFilter = { status: 'active' };
  const employees = await findMany('employees', empFilter, {});

  // Delete any previous results for this cycle
  await global.dbo.collection('payroll_results').deleteMany({ cycleId: cycle._id });

  let totalGross = 0, totalDeductions = 0, totalNet = 0, totalEmployerCost = 0, exceptionCount = 0;

  // Get all required alert concepts
  const alertConcepts = await findMany('payroll_concepts', { alertIfUndefined: true, isActive: true }, {});

  for (const emp of employees) {
    // Get this employee's active compensations for this period
    const comps = await findMany('employee_compensations', {
      employeeId: emp._id,
      isActive:   true,
      $or: [
        { effectiveTo: null },
        { effectiveTo: { $gte: cycle.period.startDate } },
      ],
    }, {});

    const earnings             = comps.filter(c => c.category === 'earnings');
    const deductions           = comps.filter(c => c.category === 'deductions');
    const benefits             = comps.filter(c => c.category === 'benefits');
    const employerContributions= comps.filter(c => c.category === 'employer_contributions');

    const grossPay           = earnings.reduce((s, c) => s + (c.amount || 0), 0);
    const totalDeds          = deductions.reduce((s, c) => s + (c.amount || 0), 0);
    const netPay             = grossPay - totalDeds;
    const empContribTotal    = employerContributions.reduce((s, c) => s + (c.amount || 0), 0);
    const totalEmpCost       = grossPay + empContribTotal;

    // Check exceptions
    const exceptions = [];
    if (!emp.bankAccount) exceptions.push({ type: 'missing_bank',     message: 'No bank account on file.',               severity: 'error'   });
    if (grossPay === 0)   exceptions.push({ type: 'zero_gross',       message: 'Gross pay is zero.',                     severity: 'warning' });

    // Check alert concepts
    for (const ac of alertConcepts) {
      const has = comps.some(c => String(c.conceptId) === String(ac._id));
      if (!has) exceptions.push({ type: 'undefined_concept', message: `Required concept "${ac.name}" not defined.`, severity: 'warning' });
    }

    // Compare to last cycle (variance check)
    const lastResult = await findOne('payroll_results',
      { employeeId: emp._id, cycleId: { $ne: cycle._id } },
      { sort: { createdAt: -1 } }
    );
    const isProRata = Boolean(emp.hireDate && new Date(emp.hireDate) > cycle.period.startDate);
    if (lastResult && lastResult.grossPay > 0) {
      const variance = Math.abs(grossPay - lastResult.grossPay) / lastResult.grossPay;
      if (variance > 0.10) {
        exceptions.push({ type: 'large_variance', message: `Gross changed by ${Math.round(variance * 100)}% vs last cycle.`, severity: 'warning' });
      }
    }
    if (isProRata) exceptions.push({ type: 'new_hire', message: 'New hire — pro-rata may apply.', severity: 'warning' });

    // Pull overtime from attendance records for this cycle period
    const attendanceRecs = await global.dbo.collection('attendance_records').find({
      employeeId: emp._id,
      date: {
        $gte: cycle.period.startDate.toISOString().slice(0, 10),
        $lte: cycle.period.endDate.toISOString().slice(0, 10),
      },
    }).toArray();
    const overtimeHours = attendanceRecs.reduce((sum, r) => sum + (r.overtimeHours || 0), 0);
    const overtimeRate  = emp.grossPay ? (emp.grossPay / 22 / 8) * 1.5 : 0;
    const overtimeAmount = Math.round(overtimeHours * overtimeRate);
    const adjustedGross = grossPay + overtimeAmount;
    const adjustedNet   = adjustedGross - totalDeds;

    // Pull approved expense reimbursements for this cycle period
    const expenseDocs = await global.dbo.collection('expense_claims').find({
      employeeId: emp._id,
      status: 'approved',
      approvedAt: { $gte: cycle.period.startDate, $lte: cycle.period.endDate },
      payrollCycleId: null,
    }).toArray();
    const expenseReimbursements = expenseDocs.reduce((s, e) => s + (e.amount || 0), 0);
    const expenseIds = expenseDocs.map(e => e._id);
    if (expenseIds.length) {
      await global.dbo.collection('expense_claims').updateMany(
        { _id: { $in: expenseIds } },
        { $set: { payrollCycleId: cycle._id, updatedAt: new Date() } }
      );
    }

    const resultDoc = {
      cycleId:      cycle._id,
      employeeId:   emp._id,
      earnings:     earnings.map(c => ({ conceptId: c.conceptId, conceptName: c.conceptName, conceptCode: c.conceptCode, subCategory: c.subCategory, amount: c.amount, isTaxable: true })),
      deductions:   deductions.map(c => ({ conceptId: c.conceptId, conceptName: c.conceptName, conceptCode: c.conceptCode, subCategory: c.subCategory, amount: c.amount })),
      benefits:     benefits.map(c => ({ conceptId: c.conceptId, conceptName: c.conceptName, amount: c.amount })),
      employerContributions: employerContributions.map(c => ({ conceptId: c.conceptId, conceptName: c.conceptName, amount: c.amount })),
      grossPay: adjustedGross, totalDeductions: totalDeds, netPay: adjustedNet, totalEmployerCost: totalEmpCost + overtimeAmount,
      isProRata, proRataReason: isProRata ? 'new_hire' : null, proRataDays: null, workingDaysInCycle: 22,
      overtimeHours, overtimeAmount, expenseReimbursements,
      hasException:  exceptions.length > 0,
      exceptions,
      status:        'pending',
      approvedBy:    null, approvedAt: null,
      payslipUrl:    null, payslipSentAt: null,
      createdAt:     new Date(), updatedAt: new Date(),
    };
    await insertOne('payroll_results', resultDoc);

    totalGross         += adjustedGross;
    totalDeductions    += totalDeds;
    totalNet           += adjustedNet;
    totalEmployerCost  += (totalEmpCost + overtimeAmount);
    if (exceptions.length > 0) exceptionCount++;
  }

  await updateOne('payroll_cycles', { _id: cycle._id }, {
    $set: {
      status: 'locked',
      totalGross, totalDeductions, totalNet, totalEmployerCost,
      employeeCount:  employees.length,
      hasExceptions:  exceptionCount > 0,
      exceptionCount,
      lockedAt: new Date(), lockedBy: req.user?._id ?? null,
      updatedAt: new Date(),
    },
  });

  return returnFunction(res, 200, true, 'Cycle locked and payroll calculated.');
}

// ── Close Cycle → Distribute Payslips ────────────────────────────────────────

const closeCycle = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  return closeCycleInternal(req, res, cycle);
};

async function closeCycleInternal(req, res, cycle) {
  if (cycle.status !== 'locked') return returnFunction(res, 400, false, 'Cycle must be locked to close.');

  // Block close if any results are still pending approval
  const pendingCount = await countDocuments('payroll_results', { cycleId: cycle._id, status: 'pending' });
  if (pendingCount > 0) {
    return returnFunction(res, 400, false, `Cannot close cycle: ${pendingCount} payroll result(s) are still pending approval. Approve or remove them first.`);
  }

  const results = await findMany('payroll_results', { cycleId: cycle._id }, {});

  // Generate payslips for each employee
  for (const result of results) {
    try {
      const emp = await findOne('employees', { _id: result.employeeId }, { projection: { fullName: 1, staffNumber: 1, designation: 1, department: 1, bankAccount: 1 } });
      const pdfBuffer = await generatePayslipFromResult(emp, result, cycle);
      // Store PDF reference (in production: upload to storage, store URL)
      const payslipDoc = {
        employeeId:  result.employeeId,
        cycleId:     cycle._id,
        resultId:    result._id,
        period:      { month: cycle.period.month, year: cycle.period.year },
        grossPay:    result.grossPay,
        netPay:      result.netPay,
        status:      'paid',
        pdfData:     pdfBuffer.toString('base64'),
        generatedAt: new Date(),
        createdAt:   new Date(),
      };
      const slip = await insertOne('payslips', payslipDoc);
      await updateOne('payroll_results', { _id: result._id }, {
        $set: { payslipUrl: `/api/payroll/payslips/${slip.insertedId}/pdf`, payslipSentAt: new Date(), status: 'paid', updatedAt: new Date() },
      });
    } catch (err) {
      // Log and continue — don't fail the whole cycle for one payslip
      console.error(`Payslip generation failed for employee ${result.employeeId}:`, err.message);
    }
  }

  await updateOne('payroll_cycles', { _id: cycle._id }, {
    $set: { status: 'closed', closedAt: new Date(), closedBy: req.user?._id ?? null, updatedAt: new Date() },
  });

  return returnFunction(res, 200, true, 'Cycle closed and payslips distributed.');
}

// ── Export CSV ────────────────────────────────────────────────────────────────

const exportCycleCSV = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  const results = await findMany('payroll_results', { cycleId: cycle._id }, {});
  const rows = await Promise.all(results.map(async r => {
    const emp = await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    return [
      emp?.staffNumber ?? '', emp?.fullName ?? '', emp?.department ?? '',
      r.grossPay, r.totalDeductions, r.netPay, r.totalEmployerCost, r.status,
    ].join(',');
  }));
  const csv = ['Staff No,Name,Department,Gross,Deductions,Net,Employer Cost,Status', ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${cycle.period.year}-${cycle.period.month}.csv"`);
  return res.send(csv);
};

// ── Bank Disbursement File ────────────────────────────────────────────────────
// Generates a bank EFT CSV: one row per employee with bank details + net pay.
// Only approved results are included; cycle must be locked or closed.

const exportBankFile = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['locked', 'closed'].includes(cycle.status)) {
    return returnFunction(res, 400, false, 'Bank file can only be exported once the cycle is locked or closed.');
  }

  const results = await findMany('payroll_results', { cycleId: cycle._id, status: { $in: ['approved', 'paid'] } }, {});
  if (!results.length) return returnFunction(res, 400, false, 'No approved payroll results to export.');

  const rows = await Promise.all(results.map(async r => {
    const emp = await findOne('employees', { _id: r.employeeId }, {
      projection: { fullName: 1, staffNumber: 1, bankName: 1, bankAccountNumber: 1, mpesaNumber: 1, paymentMethod: 1 },
    });
    const account = emp?.bankAccountNumber || emp?.mpesaNumber || '';
    const bank    = emp?.bankName || '';
    const method  = emp?.paymentMethod || 'bank_transfer';
    return [
      emp?.staffNumber ?? '',
      `"${(emp?.fullName ?? '').replace(/"/g, '')}"`,
      method,
      bank,
      account,
      r.netPay.toFixed(2),
      cycle.currency || 'KES',
      `"${cycle.name}"`,
    ].join(',');
  }));

  const header = 'StaffNo,Name,PaymentMethod,BankName,AccountNumber,NetAmount,Currency,PayrollPeriod';
  const csv = [header, ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="bank-file-${cycle.period.year}-${cycle.period.month}.csv"`);
  return res.send(csv);
};

// ── Get Single Result ─────────────────────────────────────────────────────────

const getEmployeeResult = async (req, res) => {
  const result = await findOne('payroll_results', {
    cycleId:    new ObjectId(req.params.cycleId),
    employeeId: new ObjectId(req.params.employeeId),
  });
  if (!result) return returnFunction(res, 404, false, req.locale.notFound);
  const emp = await findOne('employees', { _id: result.employeeId });
  return returnFunction(res, 200, true, req.locale.success, { ...result, employee: emp ?? null });
};

module.exports = {
  listCycles, getCycle, createCycle, advanceCycleStatus,
  getCycleResults, getCycleExceptions, approveEmployees,
  lockCycle, closeCycle, exportCycleCSV, exportBankFile, getEmployeeResult,
};
