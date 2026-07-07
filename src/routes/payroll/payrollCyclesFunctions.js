const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { generatePayslipFromResult } = require('../../services/payslipService');
const { generateP9Form } = require('../../services/p9Service');
const { buildCalculator, loadTaxConfig } = require('../../functions/taxCalculator');
const { calculateWorkingDays } = require('../../functions/HR/leaveCalculator');
const { sendEmail } = require('../../services/emailService');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

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

// ── Compare Two Cycles ────────────────────────────────────────────────────────
// GET /api/payroll/cycles/compare?cycleA=<id>&cycleB=<id>
// Side-by-side totals plus a per-employee gross/deductions/net diff (union of both cycles'
// employees, so someone added or dropped between runs still shows up with a 0 on one side).

const compareCycles = async (req, res) => {
  const { cycleA, cycleB } = req.query;
  if (!cycleA || !cycleB) return returnFunction(res, 400, false, 'cycleA and cycleB are required.');

  const [cA, cB] = await Promise.all([
    findOne('payroll_cycles', { _id: new ObjectId(cycleA) }),
    findOne('payroll_cycles', { _id: new ObjectId(cycleB) }),
  ]);
  if (!cA || !cB) return returnFunction(res, 404, false, req.locale.notFound);

  const [resultsA, resultsB] = await Promise.all([
    findMany('payroll_results', { cycleId: cA._id }, {}),
    findMany('payroll_results', { cycleId: cB._id }, {}),
  ]);
  const mapA = Object.fromEntries(resultsA.map((r) => [String(r.employeeId), r]));
  const mapB = Object.fromEntries(resultsB.map((r) => [String(r.employeeId), r]));
  const employeeIds = [...new Set([...Object.keys(mapA), ...Object.keys(mapB)])].map((id) => new ObjectId(id));

  const employees = employeeIds.length
    ? await findMany('employees', { _id: { $in: employeeIds } }, { projection: { fullName: 1, staffNumber: 1, department: 1 } })
    : [];
  const empMap = Object.fromEntries(employees.map((e) => [String(e._id), e]));

  const employeeDiffs = employeeIds.map((id) => {
    const key = String(id);
    const rA = mapA[key], rB = mapB[key];
    const grossA = rA?.grossPay || 0, grossB = rB?.grossPay || 0;
    const dedA = rA?.totalDeductions || 0, dedB = rB?.totalDeductions || 0;
    const netA = rA?.netPay || 0, netB = rB?.netPay || 0;
    return {
      employeeId: key,
      employee: empMap[key] || null,
      inCycleA: !!rA, inCycleB: !!rB,
      grossA, grossB, grossDiff: Math.round((grossB - grossA) * 100) / 100,
      deductionsA: dedA, deductionsB: dedB, deductionsDiff: Math.round((dedB - dedA) * 100) / 100,
      netA, netB, netDiff: Math.round((netB - netA) * 100) / 100,
    };
  }).sort((a, b) => Math.abs(b.netDiff) - Math.abs(a.netDiff));

  return returnFunction(res, 200, true, req.locale.success, {
    cycleA: { _id: cA._id, name: cA.name, period: cA.period, totalGross: cA.totalGross, totalDeductions: cA.totalDeductions, totalNet: cA.totalNet, totalEmployerCost: cA.totalEmployerCost, employeeCount: cA.employeeCount, currency: cA.currency },
    cycleB: { _id: cB._id, name: cB.name, period: cB.period, totalGross: cB.totalGross, totalDeductions: cB.totalDeductions, totalNet: cB.totalNet, totalEmployerCost: cB.totalEmployerCost, employeeCount: cB.employeeCount, currency: cB.currency },
    employeeDiffs,
  });
};

// ── Create Cycle ──────────────────────────────────────────────────────────────

const PAY_FREQUENCIES = ['weekly', 'biweekly', 'monthly'];

const createCycle = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const { name, payDate, payGroup, currency, runType } = req.body;
  const payFrequency = PAY_FREQUENCIES.includes(req.body.payFrequency) ? req.body.payFrequency : 'monthly';
  const isOffCycle = runType === 'off_cycle';

  let startDate, endDate;
  if (payFrequency === 'monthly' && req.body.month && req.body.year) {
    const m = parseInt(req.body.month), y = parseInt(req.body.year);
    startDate = new Date(y, m - 1, 1);
    endDate   = new Date(y, m, 0);
  } else if (req.body.startDate && req.body.endDate) {
    startDate = new Date(req.body.startDate);
    endDate   = new Date(req.body.endDate);
  } else {
    return returnFunction(res, 400, false, 'Provide either month+year (monthly) or an explicit startDate+endDate (weekly/biweekly/off-cycle).');
  }
  if (endDate < startDate) return returnFunction(res, 400, false, 'endDate must be on or after startDate.');

  // Regular (non off-cycle) runs of the same frequency can't overlap — that's what off-cycle
  // runs are for. Off-cycle runs are exempt so bonuses/corrections/terminations can always
  // be processed alongside the normal schedule without colliding with it.
  if (!isOffCycle) {
    const overlapping = await findOne('payroll_cycles', {
      payFrequency, runType: { $ne: 'off_cycle' },
      'period.startDate': { $lte: endDate },
      'period.endDate': { $gte: startDate },
    });
    if (overlapping) return returnFunction(res, 409, false, `A ${payFrequency} payroll cycle already covers this period ("${overlapping.name}").`);
  }

  const month = endDate.getMonth() + 1;
  const year  = endDate.getFullYear();

  const doc = {
    name,
    period:        { month, year, startDate, endDate },
    payDate:       payDate ? new Date(payDate) : null,
    status:        'open',
    payGroup:      payGroup || 'all',
    payFrequency,
    runType:       isOffCycle ? 'off_cycle' : 'regular',
    offCycleReason: isOffCycle ? (req.body.offCycleReason || null) : null,
    targetEmployeeIds: Array.isArray(req.body.employeeIds) && req.body.employeeIds.length
      ? req.body.employeeIds.map((id) => new ObjectId(id))
      : null,
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
    const emp = await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1, bankAccountNumber: 1 } });
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
  const { id: cycleId } = req.params;
  const { employeeIds, approveAll } = req.body;
  const filter = { cycleId: new ObjectId(cycleId), status: 'pending' };
  if (!approveAll && employeeIds?.length) {
    filter.employeeId = { $in: employeeIds.map(id => new ObjectId(id)) };
  }
  const result = await global.dbo.collection('payroll_results').updateMany(filter, {
    $set: { status: 'approved', approvedBy: req.user?._id ?? null, approvedAt: new Date(), updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, `${result.modifiedCount} employee(s) approved.`);
};

// ── Lock Cycle → Calculate Results ───────────────────────────────────────────

const lockCycle = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  return lockCycleInternal(req, res, cycle);
};

// Prorates pay for employees who didn't work the full cycle period — new hires
// (dateOfHire falls inside the period) and mid-period terminations. There is no
// dedicated termination-date field on the employee record, so `updatedAt` at the
// moment status flips to 'terminated' is used as the last-working-day proxy.
const calculateProration = (emp, periodStart, periodEnd) => {
  const totalDays = Math.round((periodEnd - periodStart) / 86400000) + 1;
  let effectiveStart = periodStart;
  let effectiveEnd   = periodEnd;
  let reason = null;

  if (emp.dateOfHire && new Date(emp.dateOfHire) > periodStart) {
    effectiveStart = new Date(emp.dateOfHire);
    reason = 'new_hire';
  }
  if (emp.status === 'terminated' && emp.updatedAt && new Date(emp.updatedAt) < periodEnd) {
    effectiveEnd = new Date(emp.updatedAt);
    reason = reason ? 'new_hire_and_termination' : 'termination';
  }

  if (effectiveStart > effectiveEnd) return { factor: 0, isProRata: true, reason, workedDays: 0, totalDays };
  const workedDays = Math.round((effectiveEnd - effectiveStart) / 86400000) + 1;
  return { factor: Math.min(1, workedDays / totalDays), isProRata: workedDays < totalDays, reason, workedDays, totalDays };
};

async function lockCycleInternal(req, res, cycle) {
  if (cycle.status !== 'review') return returnFunction(res, 400, false, 'Cycle must be in Review to lock.');

  // A hand-picked target list (typical for off-cycle bonus/correction runs) bypasses the
  // usual pay-group/frequency matching entirely. Otherwise: active employees, plus anyone
  // terminated during this period (so their prorated pay still gets run), narrowed to this
  // cycle's pay frequency and — optionally — a specific pay group.
  let empFilter;
  if (cycle.targetEmployeeIds?.length) {
    empFilter = { _id: { $in: cycle.targetEmployeeIds } };
  } else {
    const cycleFrequency = cycle.payFrequency || 'monthly';
    // Employees created before pay-frequency existed have no payFrequency field at all —
    // treat that as 'monthly' (the default every employee effectively had before this
    // feature shipped) rather than excluding them from every monthly run.
    const frequencyMatch = cycleFrequency === 'monthly'
      ? { $or: [{ payFrequency: 'monthly' }, { payFrequency: { $exists: false } }, { payFrequency: null }] }
      : { payFrequency: cycleFrequency };
    empFilter = {
      $and: [
        { $or: [
          { status: 'active' },
          { status: 'terminated', updatedAt: { $gte: cycle.period.startDate } },
        ] },
        frequencyMatch,
      ],
    };
    if (cycle.payGroup && cycle.payGroup !== 'all') empFilter.$and.push({ payGroup: cycle.payGroup });
  }
  const employees = await findMany('employees', empFilter, {});

  // Delete any previous results for this cycle
  await global.dbo.collection('payroll_results').deleteMany({ cycleId: cycle._id });

  let totalGross = 0, totalDeductions = 0, totalNet = 0, totalEmployerCost = 0, exceptionCount = 0;

  // Load tax config once for all employees (avoids N+1 DB calls)
  const taxConfig = await loadTaxConfig();
  const taxCalc   = buildCalculator(taxConfig);

  // Get all required alert concepts
  const alertConcepts = await findMany('payroll_concepts', { alertIfUndefined: true, isActive: true }, {});

  // Public holidays inside this period, loaded once (avoids N+1 DB calls in the leave calc below)
  const cycleStartStr = cycle.period.startDate.toISOString().slice(0, 10);
  const cycleEndStr   = cycle.period.endDate.toISOString().slice(0, 10);
  const holidays = await global.dbo.collection('public_holidays').find({ date: { $gte: cycleStartStr, $lte: cycleEndStr } }, { projection: { date: 1 } }).toArray();
  const holidaySet = new Set(holidays.map(h => h.date));

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
    const empContribTotal    = employerContributions.reduce((s, c) => s + (c.amount || 0), 0);

    // Real proration — new hires / mid-cycle terminations only get paid for days actually
    // worked in this period. Fixed voluntary deductions (loans, etc.) are not prorated.
    const proration    = calculateProration(emp, cycle.period.startDate, cycle.period.endDate);
    const proratedGross = Math.round(grossPay * proration.factor * 100) / 100;
    const totalEmpCost  = proratedGross + empContribTotal;

    // Check exceptions
    const exceptions = [];
    if (!emp.bankAccountNumber && !emp.mpesaNumber) exceptions.push({ type: 'missing_bank', message: 'No bank account or M-Pesa number on file.', severity: 'error' });
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
    if (lastResult && lastResult.grossPay > 0) {
      const variance = Math.abs(grossPay - lastResult.grossPay) / lastResult.grossPay;
      if (variance > 0.10) {
        exceptions.push({ type: 'large_variance', message: `Gross changed by ${Math.round(variance * 100)}% vs last cycle.`, severity: 'warning' });
      }
    }
    if (proration.isProRata) {
      const label = proration.reason === 'termination' ? 'Terminated mid-cycle'
        : proration.reason === 'new_hire_and_termination' ? 'New hire, terminated mid-cycle'
        : 'New hire';
      exceptions.push({ type: 'pro_rata', message: `${label} — pay prorated to ${proration.workedDays}/${proration.totalDays} days.`, severity: 'warning' });
    }

    // Pull overtime from attendance records for this cycle period
    const attendanceRecs = await global.dbo.collection('attendance_records').find({
      employeeId: emp._id,
      date: {
        $gte: cycle.period.startDate.toISOString().slice(0, 10),
        $lte: cycle.period.endDate.toISOString().slice(0, 10),
      },
    }).toArray();
    const overtimeHours  = attendanceRecs.reduce((sum, r) => sum + (r.overtimeHours || 0), 0);
    const overtimeRate   = emp.grossPay ? (emp.grossPay / 22 / 8) * 1.5 : 0;
    const overtimeAmount = Math.round(overtimeHours * overtimeRate);
    const adjustedGross  = proratedGross + overtimeAmount;

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

    // Pull approved leave overlapping this cycle period. Every approved leave type shows as
    // its own named line on the payslip; only 'unpaid' leave actually deducts from net pay —
    // the daily rate is the standard 22-working-day monthly rate, matching the overtime calc.
    const leaveDocs = await global.dbo.collection('leave_requests').find({
      employeeId: emp._id, status: 'approved',
      startDate: { $lte: cycleEndStr }, endDate: { $gte: cycleStartStr },
    }).toArray();
    const dailyRate = grossPay ? grossPay / 22 : 0;
    const leave = leaveDocs.map((lr) => {
      const clampedStart = lr.startDate < cycleStartStr ? cycleStartStr : lr.startDate;
      const clampedEnd    = lr.endDate   > cycleEndStr   ? cycleEndStr   : lr.endDate;
      const days = calculateWorkingDays(clampedStart, clampedEnd, holidaySet);
      const amount = lr.leaveType === 'unpaid' ? Math.round(dailyRate * days * 100) / 100 : 0;
      return { leaveType: lr.leaveType, startDate: clampedStart, endDate: clampedEnd, days, amount };
    });
    const leaveDeductionTotal = Math.round(leave.reduce((s, l) => s + l.amount, 0) * 100) / 100;

    // Statutory deductions — computed from gross using the tax engine
    const statPAYE = taxCalc.calcIncomeTax(adjustedGross);
    const statNSSF = taxCalc.calcPension(adjustedGross);
    const statSHA  = taxCalc.calcHealth(adjustedGross);
    const statAHL  = taxCalc.calcHousingLevy(adjustedGross);
    const totalStatutory = Math.round((statPAYE + statNSSF + statSHA + statAHL) * 100) / 100;

    // Net pay = gross − statutory deductions − voluntary deductions − unpaid leave + expense reimbursements
    const adjustedNet = Math.round(
      (adjustedGross - totalStatutory - totalDeds - leaveDeductionTotal + expenseReimbursements) * 100
    ) / 100;

    const resultDoc = {
      cycleId:      cycle._id,
      employeeId:   emp._id,
      earnings:     earnings.map(c => ({ conceptId: c.conceptId, conceptName: c.conceptName, conceptCode: c.conceptCode, subCategory: c.subCategory, amount: c.amount, isTaxable: true })),
      deductions:   deductions.map(c => ({ conceptId: c.conceptId, conceptName: c.conceptName, conceptCode: c.conceptCode, subCategory: c.subCategory, amount: c.amount })),
      benefits:     benefits.map(c => ({ conceptId: c.conceptId, conceptName: c.conceptName, amount: c.amount })),
      employerContributions: employerContributions.map(c => ({ conceptId: c.conceptId, conceptName: c.conceptName, amount: c.amount })),
      // Statutory deductions stored separately so the payslip PDF can render them as their own section
      statutoryDeductions: {
        paye: statPAYE, nssf: statNSSF, sha: statSHA, ahl: statAHL,
        total: totalStatutory,
        labels: {
          paye: taxCalc.incomeTaxName,
          nssf: taxCalc.pensionName,
          sha:  taxCalc.healthName,
          ahl:  taxCalc.housingLevyName,
        },
      },
      grossPay:          adjustedGross,
      totalDeductions:   totalDeds + totalStatutory + leaveDeductionTotal,
      netPay:            adjustedNet,
      totalEmployerCost: totalEmpCost + overtimeAmount,
      isProRata: proration.isProRata, proRataReason: proration.reason, proRataDays: proration.workedDays, workingDaysInCycle: proration.totalDays,
      overtimeHours, overtimeAmount, expenseReimbursements,
      leave, leaveDeductionTotal,
      hasException:  exceptions.length > 0,
      exceptions,
      status:        'pending',
      approvedBy:    null, approvedAt: null,
      payslipUrl:    null, payslipSentAt: null,
      createdAt:     new Date(), updatedAt: new Date(),
    };
    await insertOne('payroll_results', resultDoc);

    totalGross        += adjustedGross;
    totalDeductions   += totalDeds + totalStatutory;
    totalNet          += adjustedNet;
    totalEmployerCost += (totalEmpCost + overtimeAmount);
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
      const emp = await findOne('employees', { _id: result.employeeId }, { projection: { fullName: 1, staffNumber: 1, designation: 1, department: 1, bankAccountNumber: 1 } });
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

// ── Email Payslips ────────────────────────────────────────────────────────────
// POST /api/payroll/cycles/:id/email-payslips
// Emails each employee their payslip PDF for this closed cycle.

const emailPayslips = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { _id: new ObjectId(req.params.id) });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  if (cycle.status !== 'closed') {
    return returnFunction(res, 400, false, 'Cycle must be closed before emailing payslips.');
  }

  const results = await findMany('payroll_results', { cycleId: cycle._id, status: 'paid' }, {});
  if (!results.length) {
    return returnFunction(res, 400, false, 'No paid payroll results found in this cycle.');
  }

  let sent = 0, skipped = 0, failed = 0;
  const period = `${MONTHS[cycle.period.month - 1]} ${cycle.period.year}`;

  for (const result of results) {
    try {
      const [emp, user] = await Promise.all([
        findOne('employees', { _id: result.employeeId }, {
          projection: { fullName: 1, staffNumber: 1, designation: 1, department: 1, bankAccountNumber: 1 },
        }),
        findOne('users', { employeeId: result.employeeId }, { projection: { email: 1 } }),
      ]);

      if (!user?.email) { skipped++; continue; }

      const pdfBuffer = await generatePayslipFromResult(emp, result, cycle);
      const cur       = cycle.currency || 'KES';
      const netFmt    = `${cur} ${(result.netPay || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;

      await sendEmail({
        to: user.email,
        subject: `Your Payslip — ${period}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:8px">
            <h2 style="color:#1e293b;margin-top:0">Payslip for ${period}</h2>
            <p style="color:#475569">Dear <strong>${emp?.fullName ?? 'Employee'}</strong>,</p>
            <p style="color:#475569">Your payslip for <strong>${period}</strong> is attached to this email.</p>
            <div style="background:#6366f1;color:#fff;border-radius:6px;padding:12px 16px;margin:16px 0;display:inline-block">
              <span style="font-size:13px;opacity:0.85">Net Pay</span><br>
              <span style="font-size:20px;font-weight:bold">${netFmt}</span>
            </div>
            <p style="color:#64748b;font-size:13px">
              If you have any questions about your payslip, please contact the HR department.
            </p>
          </div>
        `,
        attachments: [{
          filename: `payslip-${emp?.staffNumber ?? 'emp'}-${cycle.period.year}-${String(cycle.period.month).padStart(2, '0')}.pdf`,
          content:     pdfBuffer,
          contentType: 'application/pdf',
        }],
      });

      await updateOne('payroll_results', { _id: result._id }, {
        $set: { payslipSentAt: new Date(), updatedAt: new Date() },
      });
      sent++;
    } catch (err) {
      console.error(`Payslip email failed for employee ${result.employeeId}:`, err.message);
      failed++;
    }
  }

  return returnFunction(res, 200, true,
    `Payslips emailed: ${sent} sent, ${skipped} skipped (no user email), ${failed} failed.`,
    { sent, skipped, failed, total: results.length },
  );
};

// ── P9A Form (Kenya KRA Annual PAYE Deduction Card) ───────────────────────────
// GET /api/payroll/p9/:employeeId?year=2025
const downloadP9Form = async (req, res) => {
  const { employeeId } = req.params;
  const year = parseInt(req.query.year) || new Date().getFullYear() - 1;

  const employee = await findOne('employees', { _id: new ObjectId(employeeId) });
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  const results  = await findMany('payroll_results', { employeeId: new ObjectId(employeeId) }, {});
  const cycleIds = [...new Set(results.map(r => String(r.cycleId)))];
  const cycles   = cycleIds.length
    ? await findMany('payroll_cycles', { _id: { $in: cycleIds.map(id => new ObjectId(id)) } })
    : [];
  const cycleMap = Object.fromEntries(cycles.map(c => [String(c._id), c]));

  const monthMap = {};
  for (const r of results) {
    const cycle = cycleMap[String(r.cycleId)];
    if (!cycle || cycle.period?.year !== year) continue;
    const m  = cycle.period.month;
    const sd = r.statutoryDeductions || {};
    monthMap[m] = {
      month: m, grossPay: r.grossPay || 0,
      paye: sd.paye || 0, nssf: sd.nssf || 0, sha: sd.sha || 0, ahl: sd.ahl || 0,
      netPay: r.netPay || 0,
    };
  }

  const monthlyData = Object.values(monthMap).sort((a, b) => a.month - b.month);

  const buffer = await generateP9Form(employee, year, monthlyData);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="P9A-${employee.staffNumber || employeeId}-${year}.pdf"`);
  res.send(buffer);
};

module.exports = {
  listCycles, getCycle, createCycle, advanceCycleStatus, compareCycles,
  getCycleResults, getCycleExceptions, approveEmployees,
  lockCycle, closeCycle, exportCycleCSV, exportBankFile, getEmployeeResult,
  emailPayslips, downloadP9Form,
};
