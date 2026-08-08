const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md) —
// payroll_concepts, employee_compensations, payroll_cycles, payroll_results (+ its child
// tables), payslips, employees, departments, users, compensation_audit_logs (Phase 2),
// leave_requests/leave_types/public_holidays (Phase 3a), timesheets (Phase 3b),
// expense_claims/GL accounting (Phase 8), and tax_config/overtime_config/company_settings
// (Phase 10) are all Postgres now — this file is fully migrated, no more Mongo helpers.
const { findOne, findMany, insertOne, updateOne, countDocuments, knex, newId, addChildRow } = require('../../functions/Database/pgDBFunctions');
const { generatePayslipFromResult } = require('../../services/payslipService');
const { generateP9Form } = require('../../services/p9Service');
const { buildCalculator, loadTaxConfig } = require('../../functions/taxCalculator');
const { calculateWorkingDays } = require('../../functions/HR/leaveCalculator');
const { sendEmail } = require('../../services/emailService');
const { notifyEmployee } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');
const { isPayrollReady, getMissingCriticalFields } = require('../employees/employeesFunctions');
const { resolveConceptPass1, resolveConceptPass2 } = require('../../lib/payroll/resolveConceptPayItems');
const { logCompensationChange } = require('./payrollCompensationsFunctions');
const { postJournalEntry, resolveSystemAccount } = require('../../lib/accounting/glEngine');
const { logPostingFailure } = require('../accounting/accountingPostingFailuresFunctions');

const round2 = (n) => Math.round(n * 100) / 100;

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// PAYE/NSSF/SHA/AHL can each be individually promoted from the legacy tax_config engine
// to a real payroll_concept (statutoryKey set on a deductions-category concept) — soft,
// reversible, per-org: any line without a claiming concept falls back to taxCalc.
const STATUTORY_CALC_FN = {
  paye: (taxCalc, base) => taxCalc.calcIncomeTax(base),
  nssf: (taxCalc, base) => taxCalc.calcPension(base),
  sha:  (taxCalc, base) => taxCalc.calcHealth(base),
  ahl:  (taxCalc, base) => taxCalc.calcHousingLevy(base),
};

function resolveStatutoryLine(key, statutoryItems, taxCalc, adjustedGross) {
  const claimed = (statutoryItems || []).find((i) => i.statutoryKey === key);
  if (claimed) return claimed.amount;
  return STATUTORY_CALC_FN[key](taxCalc, adjustedGross);
}

// Reassembles a payroll_results row's five line-item child tables (+ exceptions) back
// into the Mongo-document shape generatePayslipFromResult/the API response already
// expect (result.earnings/deductions/benefits/employerContributions/leave/exceptions,
// result.statutoryDeductions{paye,nssf,sha,ahl,total,labels}) — the child tables and
// flattened statutory columns are the real storage; this view is reconstructed on read.
async function attachLineItems(result) {
  const [earnings, deductions, benefits, employerContributions, leave, exceptions] = await Promise.all([
    knex('payroll_result_earnings').where({ resultId: result.id }).orderBy('position'),
    knex('payroll_result_deductions').where({ resultId: result.id }).orderBy('position'),
    knex('payroll_result_benefits').where({ resultId: result.id }).orderBy('position'),
    knex('payroll_result_employer_contributions').where({ resultId: result.id }).orderBy('position'),
    knex('payroll_result_leave').where({ resultId: result.id }).orderBy('position'),
    knex('payroll_result_exceptions').where({ resultId: result.id }).orderBy('position'),
  ]);
  return {
    ...result,
    earnings, deductions, benefits, employerContributions, leave, exceptions,
    statutoryDeductions: {
      paye: result.statutoryPaye, nssf: result.statutoryNssf, sha: result.statutorySha, ahl: result.statutoryAhl,
      total: result.statutoryTotal, labels: result.statutoryLabels,
    },
  };
}

// ── List Cycles ───────────────────────────────────────────────────────────────

const listCycles = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const [total, data] = await Promise.all([
    countDocuments('payroll_cycles', filter),
    findMany('payroll_cycles', filter, { skip, limit, orderBy: [{ column: 'periodYear', order: 'desc' }, { column: 'periodMonth', order: 'desc' }] }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(data, total, page, limit));
};

// ── Get Single Cycle ──────────────────────────────────────────────────────────

const getCycle = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { id: req.params.id });
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
    findOne('payroll_cycles', { id: cycleA }),
    findOne('payroll_cycles', { id: cycleB }),
  ]);
  if (!cA || !cB) return returnFunction(res, 404, false, req.locale.notFound);

  const [resultsA, resultsB] = await Promise.all([
    findMany('payroll_results', { cycleId: cA.id }),
    findMany('payroll_results', { cycleId: cB.id }),
  ]);
  const mapA = Object.fromEntries(resultsA.map((r) => [r.employeeId, r]));
  const mapB = Object.fromEntries(resultsB.map((r) => [r.employeeId, r]));
  const employeeIds = [...new Set([...Object.keys(mapA), ...Object.keys(mapB)])];

  const employees = employeeIds.length
    ? await knex('employees').whereIn('id', employeeIds).select('id', 'fullName', 'staffNumber', 'department')
    : [];
  const empMap = Object.fromEntries(employees.map((e) => [e.id, e]));

  const employeeDiffs = employeeIds.map((key) => {
    const rA = mapA[key], rB = mapB[key];
    const grossA = Number(rA?.grossPay) || 0, grossB = Number(rB?.grossPay) || 0;
    const dedA = Number(rA?.totalDeductions) || 0, dedB = Number(rB?.totalDeductions) || 0;
    const netA = Number(rA?.netPay) || 0, netB = Number(rB?.netPay) || 0;
    return {
      employeeId: key,
      employee: empMap[key] || null,
      inCycleA: !!rA, inCycleB: !!rB,
      grossA, grossB, grossDiff: Math.round((grossB - grossA) * 100) / 100,
      deductionsA: dedA, deductionsB: dedB, deductionsDiff: Math.round((dedB - dedA) * 100) / 100,
      netA, netB, netDiff: Math.round((netB - netA) * 100) / 100,
    };
  }).sort((a, b) => Math.abs(b.netDiff) - Math.abs(a.netDiff));

  const cycleSummary = (c) => ({ _id: c.id, name: c.name, period: { month: c.periodMonth, year: c.periodYear }, totalGross: c.totalGross, totalDeductions: c.totalDeductions, totalNet: c.totalNet, totalEmployerCost: c.totalEmployerCost, employeeCount: c.employeeCount, currency: c.currency });

  return returnFunction(res, 200, true, req.locale.success, {
    cycleA: cycleSummary(cA), cycleB: cycleSummary(cB), employeeDiffs,
  });
};

// ── Create Cycle ──────────────────────────────────────────────────────────────

const PAY_FREQUENCIES = ['weekly', 'biweekly', 'monthly'];

const createCycle = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name'])) return;
  const { name, payDate, payGroup, currency, runType, departmentId, jobGroupId, employmentType } = req.body;
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

  // Payroll can only be generated for the current period or earlier — never ahead of time.
  const currentPeriodEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
  if (startDate > currentPeriodEnd) {
    return returnFunction(res, 400, false, 'Payroll cannot be generated for a future period.');
  }

  // Regular (non off-cycle) runs of the same frequency can't overlap — that's what off-cycle
  // runs are for. Off-cycle runs are exempt so bonuses/corrections/terminations can always
  // be processed alongside the normal schedule without colliding with it.
  if (!isOffCycle) {
    const overlapping = await knex('payroll_cycles')
      .where({ payFrequency }).whereNot('runType', 'off_cycle')
      .where('periodStartDate', '<=', endDate).where('periodEndDate', '>=', startDate)
      .first();
    if (overlapping) return returnFunction(res, 409, false, `A ${payFrequency} payroll cycle already covers this period ("${overlapping.name}").`);
  }

  const month = endDate.getMonth() + 1;
  const year  = endDate.getFullYear();

  const doc = {
    name,
    periodMonth: month, periodYear: year, periodStartDate: startDate, periodEndDate: endDate,
    payDate:       payDate ? new Date(payDate) : null,
    status:        'open',
    payGroup:      payGroup || 'all',
    payFrequency,
    runType:       isOffCycle ? 'off_cycle' : 'regular',
    offCycleReason: isOffCycle ? (req.body.offCycleReason || null) : null,
    targetEmployeeIds: Array.isArray(req.body.employeeIds) && req.body.employeeIds.length
      ? req.body.employeeIds.map((id) => String(id))
      : null,
    departmentId:  departmentId || null,
    jobGroupId:    jobGroupId   || null,
    employmentType: employmentType || null,
    currency:      currency  || 'KES',
    totalGross:    0, totalDeductions: 0, totalNet: 0, totalEmployerCost: 0, employeeCount: 0,
    hasExceptions: false, exceptionCount: 0,
    isLocking: false, isClosing: false,
    lockedAt: null, lockedBy: null, closedAt: null, closedBy: null,
    createdBy: req.user?.id ?? null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('payroll_cycles', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

// ── Advance Cycle Status ──────────────────────────────────────────────────────

const STATUS_FLOW = { open: 'review', review: 'locked', locked: 'closed' };

const advanceCycleStatus = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { id: req.params.id });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  const next = STATUS_FLOW[cycle.status];
  if (!next) return returnFunction(res, 400, false, 'Cycle is already closed.');

  if (next === 'locked') return lockCycleInternal(req, res, cycle);
  if (next === 'closed') return closeCycleInternal(req, res, cycle);

  await updateOne('payroll_cycles', { id: cycle.id }, { status: next, updatedAt: new Date() });
  return returnFunction(res, 200, true, `Cycle moved to ${next}.`);
};

// ── Get Cycle Results ─────────────────────────────────────────────────────────

const getCycleResults = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = { cycleId: req.params.id };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.hasException === 'true') filter.hasException = true;
  const [total, results] = await Promise.all([
    countDocuments('payroll_results', filter),
    findMany('payroll_results', filter, { skip, limit, orderBy: 'createdAt' }),
  ]);
  const resultEmpIds = [...new Set(results.map(r => r.employeeId))];
  const resultEmps = resultEmpIds.length
    ? await knex('employees').whereIn('id', resultEmpIds).select('id', 'fullName', 'staffNumber', 'department', 'designation', 'bankAccountNumber')
    : [];
  const resultEmpById = Object.fromEntries(resultEmps.map(e => [e.id, e]));
  const enriched = results.map(r => ({ ...r, employee: resultEmpById[r.employeeId] ?? null }));
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

// ── Get Exceptions ────────────────────────────────────────────────────────────

const getCycleExceptions = async (req, res) => {
  const results = await findMany('payroll_results', { cycleId: req.params.id, hasException: true });
  const excEmpIds = [...new Set(results.map(r => r.employeeId))];
  const excEmps = excEmpIds.length
    ? await knex('employees').whereIn('id', excEmpIds).select('id', 'fullName', 'staffNumber', 'department')
    : [];
  const excEmpById = Object.fromEntries(excEmps.map(e => [e.id, e]));
  const enriched = await Promise.all(results.map(async (r) => ({ ...(await attachLineItems(r)), employee: excEmpById[r.employeeId] ?? null })));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── Approve Employees ─────────────────────────────────────────────────────────

const approveEmployees = async (req, res) => {
  const { id: cycleId } = req.params;
  const { employeeIds, approveAll } = req.body;
  let query = knex('payroll_results').where({ cycleId, status: 'pending' });
  if (!approveAll && employeeIds?.length) {
    query = query.whereIn('employeeId', employeeIds.map(String));
  }
  const updated = await query.update({ status: 'approved', approvedBy: req.user?.id ?? null, approvedAt: new Date(), updatedAt: new Date() });
  return returnFunction(res, 200, true, `${updated} employee(s) approved.`);
};

// ── Lock Cycle → Calculate Results ───────────────────────────────────────────

const lockCycle = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { id: req.params.id });
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

// Atomically claims the cycle before running the real (long-running) lock logic, so two
// near-simultaneous requests — a double-click, or two HR users — can't both pass the
// status check and race each other into calculating duplicate/conflicting results. The
// claim is released in a finally block so a mid-run crash can't leave the cycle stuck.
async function lockCycleInternal(req, res, cycle) {
  if (cycle.status !== 'review') return returnFunction(res, 400, false, 'Cycle must be in Review to lock.');
  const claimed = await knex('payroll_cycles').where({ id: cycle.id, status: 'review', isLocking: false }).update({ isLocking: true });
  if (claimed !== 1) {
    return returnFunction(res, 409, false, 'This cycle is already being locked by another request.');
  }
  try {
    return await doLockCycleInternal(req, res, cycle);
  } finally {
    await knex('payroll_cycles').where({ id: cycle.id }).update({ isLocking: false }).catch(() => {});
  }
}

async function doLockCycleInternal(req, res, cycle) {

  // A hand-picked target list (typical for off-cycle bonus/correction runs) bypasses the
  // usual pay-group/frequency matching entirely. Otherwise: active employees, plus anyone
  // terminated during this period (so their prorated pay still gets run), narrowed to this
  // cycle's pay frequency and — optionally — a specific pay group.
  let employeeQuery = knex('employees');
  if (cycle.targetEmployeeIds?.length) {
    employeeQuery = employeeQuery.whereIn('id', cycle.targetEmployeeIds);
  } else {
    const cycleFrequency = cycle.payFrequency || 'monthly';
    employeeQuery = employeeQuery.where((qb) => {
      qb.where({ status: 'active' })
        .orWhere((qb2) => qb2.where({ status: 'terminated' }).where('updatedAt', '>=', cycle.periodStartDate));
    });
    // Employees created before pay-frequency existed have no payFrequency field at all —
    // treat that as 'monthly' (the default every employee effectively had before this
    // feature shipped) rather than excluding them from every monthly run.
    if (cycleFrequency === 'monthly') {
      employeeQuery = employeeQuery.where((qb) => qb.where({ payFrequency: 'monthly' }).orWhereNull('payFrequency'));
    } else {
      employeeQuery = employeeQuery.where({ payFrequency: cycleFrequency });
    }
    if (cycle.payGroup && cycle.payGroup !== 'all') employeeQuery = employeeQuery.where({ payGroup: cycle.payGroup });
    if (cycle.jobGroupId) employeeQuery = employeeQuery.where({ jobGroupId: cycle.jobGroupId });
    if (cycle.employmentType) employeeQuery = employeeQuery.where({ employmentType: cycle.employmentType });
    if (cycle.departmentId) {
      const dept = await findOne('departments', { id: cycle.departmentId });
      employeeQuery = employeeQuery.where({ department: dept?.name ?? '__none__' });
    }
  }
  const allEmployeesInScope = await employeeQuery;

  // Pay employees with a complete profile first — anyone missing a critical payroll
  // field (Gross Pay, Job Group) is excluded from this run entirely rather than
  // silently getting a broken/incorrect payslip. They're recorded on the cycle so HR
  // can see exactly who was skipped and why, fix their profile, and include them next run.
  const employees = allEmployeesInScope.filter(isPayrollReady);
  const excludedEmployees = allEmployeesInScope.filter(e => !isPayrollReady(e)).map(e => ({
    employeeId: e.id, fullName: e.fullName, staffNumber: e.staffNumber || null,
    missingFields: getMissingCriticalFields(e),
  }));

  // Delete any previous results for this cycle — CASCADEs into their line-item child tables.
  await knex('payroll_results').where({ cycleId: cycle.id }).del();

  let totalGross = 0, totalDeductions = 0, totalNet = 0, totalEmployerCost = 0, exceptionCount = 0;
  const matchedTimesheetIds = [];
  const conceptLoanApplications = []; // { assignmentId, installmentApplied } — loan-like employee_compensations, balance decremented after lock succeeds

  // Load tax config once for all employees (avoids N+1 DB calls) — the fallback for any
  // statutory line (PAYE/NSSF/SHA/AHL) no payroll_concept has claimed via statutoryKey
  // yet; see resolveStatutoryLine below. tax_config is Postgres now (Phase 10).
  const taxConfig = await loadTaxConfig();
  const taxCalc   = buildCalculator(taxConfig);

  // HR-defined overtime multipliers (weekday/weekend × day/night) — no hardcoded
  // defaults; falls back to 1x (no premium) for any bucket HR hasn't configured yet.
  // overtime_config is Postgres now (Phase 10).
  const overtimeConfig = await knex('overtime_config').first();
  const otRate = (key) => overtimeConfig?.[key] != null ? overtimeConfig[key] : 1;

  // payroll_concepts + employee_compensations targeting (scope:'individual'/'group') is
  // the payroll engine — the legacy job-group Allowances/Deductions + inline staff_loans
  // path was decommissioned once useUnifiedConceptsEngine was proven on a real cycle
  // lock (see the Concepts unification plan; git history has the removed code if it's
  // ever needed for reference).
  const allConcepts = await findMany('payroll_concepts', { isActive: true });
  const conceptById = Object.fromEntries(allConcepts.map((c) => [c.id, c]));
  const groupAssignments = await findMany('employee_compensations', { scope: 'group', isActive: true });

  // Get all required alert concepts
  const alertConcepts = await findMany('payroll_concepts', { alertIfUndefined: true, isActive: true });

  // Public holidays inside this period, loaded once (avoids N+1 DB calls in the leave calc
  // below). public_holidays now lives in Postgres (Phase 3a).
  const cycleStartStr = cycle.periodStartDate.toISOString().slice(0, 10);
  const cycleEndStr   = cycle.periodEndDate.toISOString().slice(0, 10);
  const holidays = await knex('public_holidays').where('date', '>=', cycleStartStr).where('date', '<=', cycleEndStr).select('date');
  const holidaySet = new Set(holidays.map(h => h.date));

  for (const emp of employees) {
    // Get this employee's active compensations for this period
    const comps = await knex('employee_compensations')
      .where({ employeeId: emp.id, isActive: true })
      .where((qb) => qb.whereNull('effectiveTo').orWhere('effectiveTo', '>=', cycle.periodStartDate));

    const conceptEngineWarnings = [];

    // Basic Pay is itself a concept (code 'BASIC', auto-synced from emp.grossPay — see
    // syncBasicPay.js), so it's the canonical basic_salary value for formula/percentage
    // evaluation. hours_worked isn't known yet at this point in the loop (overtime/
    // timesheets are pulled further down) — formulas referencing it in an earnings/
    // pass-1 concept get 0 here; this is a known limitation, not a bug.
    const basicPayComp = comps.find(c => c.conceptCode === 'BASIC');
    const basicSalary = Number(basicPayComp?.amount ?? emp.grossPay ?? 0);
    const pass1 = resolveConceptPass1({
      emp, individualComps: comps, groupAssignments, conceptById,
      context: { basic_salary: basicSalary, hours_worked: 0 },
    });
    conceptEngineWarnings.push(...pass1.warnings);

    const benefits = pass1.benefitsItems;
    const employerContributions = pass1.employerContributionItems;
    const jgAllowanceItems = pass1.earningsItems;
    const taxableJgAllowanceTotal = pass1.taxableEarningsTotal;
    const nonTaxableJgAllowanceTotal = pass1.nonTaxableEarningsTotal;
    const jgFixedDeductionItems = pass1.deductionItemsPass1;
    const jgFixedDeductionTotal = pass1.deductionTotalPass1;
    const grossPay = taxableJgAllowanceTotal;
    const empContribTotal = pass1.employerContributionTotal;

    // Real proration — new hires / mid-cycle terminations only get paid for days actually
    // worked in this period. Fixed voluntary deductions (loans, etc.) are not prorated.
    const proration    = calculateProration(emp, cycle.periodStartDate, cycle.periodEndDate);
    const proratedGross = Math.round(grossPay * proration.factor * 100) / 100;
    const totalEmpCost  = proratedGross + empContribTotal;

    // Check exceptions
    const exceptions = [];
    if (!emp.bankAccountNumber && !emp.mpesaNumber) exceptions.push({ type: 'missing_bank', message: 'No bank account or M-Pesa number on file.', severity: 'error' });
    if (grossPay === 0)   exceptions.push({ type: 'zero_gross',       message: 'Gross pay is zero.',                     severity: 'warning' });

    // Check alert concepts
    for (const ac of alertConcepts) {
      const has = comps.some(c => c.conceptId === ac.id);
      if (!has) exceptions.push({ type: 'undefined_concept', message: `Required concept "${ac.name}" not defined.`, severity: 'warning' });
    }

    // Compare to last cycle (variance check)
    const lastResult = await knex('payroll_results').where({ employeeId: emp.id }).whereNot('cycleId', cycle.id).orderBy('createdAt', 'desc').first();
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

    // Pull overtime from approved, not-yet-processed timesheets covering this cycle
    // period — not raw attendance_records. A timesheet must go through the manager
    // approval gate before its overtime hours affect pay, and each one is stamped
    // with this cycle's id below so it's never counted into a payroll run twice.
    // timesheets now lives in Postgres (Phase 3b).
    const cycleTimesheets = await knex('timesheets')
      .where({ employeeId: emp.id, status: 'approved' }).whereNull('payrollRunId')
      .where('weekStart', '>=', cycle.periodStartDate).where('weekStart', '<=', cycle.periodEndDate);
    matchedTimesheetIds.push(...cycleTimesheets.map((t) => t.id));
    const overtimeMinutesTotal = cycleTimesheets.reduce((sum, t) => sum + (t.overtimeMinutes || 0), 0);
    const overtimeHours  = Math.round((overtimeMinutesTotal / 60) * 100) / 100;

    // Base hourly rate, then each overtime bucket (weekday/weekend × day/night) is paid
    // at that hour × HR's own configured multiplier for that bucket — replaces the old
    // single flat 1.5x applied to every overtime hour regardless of when it was worked.
    const hourlyRate = emp.grossPay ? emp.grossPay / 22 / 8 : 0;
    const otBreakdownTotals = cycleTimesheets.reduce((acc, t) => {
      const b = t.overtimeBreakdown || {};
      acc.weekdayDayMins   += b.weekdayDayMins || 0;
      acc.weekdayNightMins += b.weekdayNightMins || 0;
      acc.weekendDayMins   += b.weekendDayMins || 0;
      acc.weekendNightMins += b.weekendNightMins || 0;
      return acc;
    }, { weekdayDayMins: 0, weekdayNightMins: 0, weekendDayMins: 0, weekendNightMins: 0 });
    const bucketedMinutes = otBreakdownTotals.weekdayDayMins + otBreakdownTotals.weekdayNightMins
      + otBreakdownTotals.weekendDayMins + otBreakdownTotals.weekendNightMins;
    let overtimeAmount = Math.round(
      hourlyRate * (
        (otBreakdownTotals.weekdayDayMins / 60) * otRate('weekdayDayRate') +
        (otBreakdownTotals.weekdayNightMins / 60) * otRate('weekdayNightRate') +
        (otBreakdownTotals.weekendDayMins / 60) * otRate('weekendDayRate') +
        (otBreakdownTotals.weekendNightMins / 60) * otRate('weekendNightRate')
      )
    );
    // Timesheets predating this breakdown (or manually adjusted with no bucket data)
    // fall back to a flat 1x on the unaccounted minutes rather than dropping that pay.
    const unbucketedMinutes = Math.max(0, overtimeMinutesTotal - bucketedMinutes);
    if (unbucketedMinutes > 0) overtimeAmount += Math.round(hourlyRate * (unbucketedMinutes / 60));
    const adjustedGross  = proratedGross + overtimeAmount;

    // Percentage/formula/bracket-type deductions resolve now that adjustedGross is
    // known. Loan-like assignments resolve here too — unlike a flat deduction, a loan
    // has a running balance; the installment is capped at min(evaluated amount,
    // balanceRemaining) so the final payment never overshoots, and the balance itself is
    // only decremented (loan marked completed) after this cycle successfully locks,
    // mirroring how timesheets are only stamped processed once the lock actually goes
    // through — see the deferred-write loop after the cycle is marked locked.
    const pass2 = resolveConceptPass2({
      emp, individualComps: comps, groupAssignments, conceptById,
      context: { basic_salary: basicSalary, gross_salary: proratedGross, adjusted_gross: adjustedGross, hours_worked: overtimeHours },
      loanApplications: conceptLoanApplications,
    });
    conceptEngineWarnings.push(...pass2.warnings);
    const jgPercentageDeductionItems = pass2.deductionItemsPass2;
    const jgPercentageDeductionTotal = pass2.deductionTotalPass2;
    const loanDeductionItems = pass2.loanItems;
    const loanDeductionTotal = pass2.loanTotal;
    const conceptStatutoryItems = pass2.statutoryItems;

    const totalDeds = jgFixedDeductionTotal + jgPercentageDeductionTotal + loanDeductionTotal;

    // Surface any concept-evaluation problem (malformed formula, missing base, unknown
    // variable) as a payslip exception rather than a silently-wrong number — matches
    // this file's existing philosophy of degrading one employee's bad data into a
    // visible warning instead of either crashing the run or hiding the issue.
    for (const w of conceptEngineWarnings) {
      exceptions.push({ type: 'concept_evaluation', message: w, severity: 'warning' });
    }

    // Pull approved expense reimbursements for this cycle period. expense_claims is
    // Postgres now (Phase 8).
    const expenseDocs = await knex('expense_claims')
      .where({ employeeId: emp.id, status: 'approved' })
      .where('approvedAt', '>=', cycle.periodStartDate).where('approvedAt', '<=', cycle.periodEndDate)
      .whereNull('payrollCycleId');
    const expenseReimbursements = expenseDocs.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const expenseIds = expenseDocs.map((e) => e.id);
    if (expenseIds.length) {
      await knex('expense_claims').whereIn('id', expenseIds).update({ payrollCycleId: cycle.id, updatedAt: new Date() });
    }

    // Pull approved leave overlapping this cycle period. Every approved leave type shows as
    // its own named line on the payslip; only 'unpaid' leave actually deducts from net pay —
    // the daily rate is the standard 22-working-day monthly rate, matching the overtime calc.
    // leave_requests/leave_types now live in Postgres (Phase 3a).
    const leaveDocs = await knex('leave_requests')
      .where({ employeeId: emp.id, status: 'approved' })
      .where('startDate', '<=', cycle.periodEndDate).where('endDate', '>=', cycle.periodStartDate);
    const leaveTypeIds = [...new Set(leaveDocs.map(lr => lr.leaveTypeId))];
    const leaveTypes = leaveTypeIds.length ? await knex('leave_types').whereIn('id', leaveTypeIds) : [];
    const leaveTypeById = Object.fromEntries(leaveTypes.map(lt => [lt.id, lt]));
    const dailyRate = grossPay ? grossPay / 22 : 0;
    const leave = leaveDocs.map((lr) => {
      const clampedStart = lr.startDate < cycle.periodStartDate ? cycleStartStr : lr.startDate.toISOString().slice(0, 10);
      const clampedEnd    = lr.endDate   > cycle.periodEndDate   ? cycleEndStr   : lr.endDate.toISOString().slice(0, 10);
      const days = calculateWorkingDays(clampedStart, clampedEnd, holidaySet);
      const leaveType = leaveTypeById[lr.leaveTypeId];
      const amount = leaveType && !leaveType.isPaid ? Math.round(dailyRate * days * 100) / 100 : 0;
      return { leaveType: leaveType?.name || 'Unknown', startDate: clampedStart, endDate: clampedEnd, days, amount };
    });
    const leaveDeductionTotal = Math.round(leave.reduce((s, l) => s + l.amount, 0) * 100) / 100;

    // Statutory deductions — each line falls back to the legacy tax engine unless a real
    // payroll_concept has claimed that statutoryKey (see resolveStatutoryLine above).
    const statPAYE = resolveStatutoryLine('paye', conceptStatutoryItems, taxCalc, adjustedGross);
    const statNSSF = resolveStatutoryLine('nssf', conceptStatutoryItems, taxCalc, adjustedGross);
    const statSHA  = resolveStatutoryLine('sha',  conceptStatutoryItems, taxCalc, adjustedGross);
    const statAHL  = resolveStatutoryLine('ahl',  conceptStatutoryItems, taxCalc, adjustedGross);
    const totalStatutory = Math.round((statPAYE + statNSSF + statSHA + statAHL) * 100) / 100;

    // Net pay = gross − statutory deductions − voluntary deductions − unpaid leave + expense
    // reimbursements + non-taxable job-group allowances (never entered gross, so add them back here)
    const adjustedNet = Math.round(
      (adjustedGross - totalStatutory - totalDeds - leaveDeductionTotal + expenseReimbursements + nonTaxableJgAllowanceTotal) * 100
    ) / 100;

    // Deductions exceeding gross pay is never a valid state to silently finalize — this
    // would otherwise flow undetected all the way into a real bank-payment file (see
    // exportBankFile's matching guard). 'error' severity, unlike the 'warning' checks
    // above, actually blocks closeCycleInternal until HR resolves it.
    if (adjustedNet < 0) {
      exceptions.push({ type: 'negative_net_pay', message: `Net pay is negative (${adjustedNet.toFixed(2)}) — deductions exceed what this employee earned this cycle.`, severity: 'error' });
    }

    const resultRow = {
      cycleId: cycle.id, employeeId: emp.id,
      grossPay: adjustedGross,
      totalDeductions: totalDeds + totalStatutory + leaveDeductionTotal,
      netPay: adjustedNet,
      totalEmployerCost: totalEmpCost + overtimeAmount,
      isProRata: proration.isProRata, proRataReason: proration.reason, proRataDays: proration.workedDays, workingDaysInCycle: proration.totalDays,
      overtimeHours, overtimeAmount, expenseReimbursements,
      leaveDeductionTotal,
      // Statutory deductions stored flattened so payroll_results stays a plain row —
      // reassembled into the {paye,nssf,sha,ahl,total,labels} shape by attachLineItems.
      statutoryPaye: statPAYE, statutoryNssf: statNSSF, statutorySha: statSHA, statutoryAhl: statAHL, statutoryTotal: totalStatutory,
      statutoryLabels: JSON.stringify({
        paye: conceptStatutoryItems.find(i => i.statutoryKey === 'paye')?.conceptName || taxCalc.incomeTaxName,
        nssf: conceptStatutoryItems.find(i => i.statutoryKey === 'nssf')?.conceptName || taxCalc.pensionName,
        sha:  conceptStatutoryItems.find(i => i.statutoryKey === 'sha')?.conceptName  || taxCalc.healthName,
        ahl:  conceptStatutoryItems.find(i => i.statutoryKey === 'ahl')?.conceptName  || taxCalc.housingLevyName,
      }),
      hasException:  exceptions.length > 0,
      engine:        'concepts',
      status:        'pending',
      approvedBy:    null, approvedAt: null,
      payslipUrl:    null, payslipSentAt: null,
      createdAt:     new Date(), updatedAt: new Date(),
    };
    const insertedResult = await insertOne('payroll_results', resultRow);

    // Five line-item child tables + exceptions — see the migration's file header.
    const withPosition = (items) => items.map((item, position) => ({ resultId: insertedResult.id, position, ...item }));
    const earningsRows = withPosition(jgAllowanceItems.map((i) => ({
      conceptId: i.conceptId ? String(i.conceptId) : null, conceptName: i.conceptName ?? null, conceptCode: i.conceptCode ?? null,
      subCategory: i.subCategory ?? null, amount: i.amount, source: i.source ?? null, isTaxable: i.isTaxable ?? null,
    })));
    const deductionRows = withPosition([...jgFixedDeductionItems, ...jgPercentageDeductionItems, ...loanDeductionItems].map((i) => ({
      conceptId: i.conceptId ? String(i.conceptId) : null, conceptName: i.conceptName ?? null, conceptCode: i.conceptCode ?? null,
      subCategory: i.subCategory ?? null, amount: i.amount, source: i.source ?? null,
      loanAssignmentId: i.loanAssignmentId ? String(i.loanAssignmentId) : null, balanceAfter: i.balanceAfter ?? null,
    })));
    const benefitsRows = withPosition(benefits.map((c) => ({ conceptId: c.conceptId ? String(c.conceptId) : null, conceptName: c.conceptName ?? null, amount: c.amount })));
    const employerContribRows = withPosition(employerContributions.map((c) => ({ conceptId: c.conceptId ? String(c.conceptId) : null, conceptName: c.conceptName ?? null, amount: c.amount })));
    const leaveRows = withPosition(leave.map((l) => ({ leaveType: l.leaveType, startDate: l.startDate, endDate: l.endDate, days: l.days, amount: l.amount })));
    const exceptionRows = withPosition(exceptions.map((e) => ({ type: e.type, message: e.message, severity: e.severity })));

    if (earningsRows.length) await knex('payroll_result_earnings').insert(earningsRows);
    if (deductionRows.length) await knex('payroll_result_deductions').insert(deductionRows);
    if (benefitsRows.length) await knex('payroll_result_benefits').insert(benefitsRows);
    if (employerContribRows.length) await knex('payroll_result_employer_contributions').insert(employerContribRows);
    if (leaveRows.length) await knex('payroll_result_leave').insert(leaveRows);
    if (exceptionRows.length) await knex('payroll_result_exceptions').insert(exceptionRows);

    totalGross        += adjustedGross;
    totalDeductions   += totalDeds + totalStatutory;
    totalNet          += adjustedNet;
    totalEmployerCost += (totalEmpCost + overtimeAmount);
    if (exceptions.length > 0) exceptionCount++;
  }

  await updateOne('payroll_cycles', { id: cycle.id }, {
    status: 'locked',
    totalGross, totalDeductions, totalNet, totalEmployerCost,
    employeeCount:  employees.length,
    hasExceptions:  exceptionCount > 0,
    exceptionCount,
    excludedEmployees: JSON.stringify(excludedEmployees),
    lockedAt: new Date(), lockedBy: req.user?.id ?? null,
    updatedAt: new Date(),
  });

  if (matchedTimesheetIds.length) {
    await knex('timesheets').whereIn('id', matchedTimesheetIds).update({ payrollRunId: cycle.id, updatedAt: new Date() });
  }

  // A fully-repaid loan is auto-unassigned via isActive:false, the same soft-delete
  // convention every other compensation row already uses (no new concept needed) —
  // logged to the audit trail so it's visible, not a silent flip.
  for (const { assignmentId, installmentApplied } of conceptLoanApplications) {
    const assignment = await findOne('employee_compensations', { id: String(assignmentId) });
    if (!assignment) continue;
    const newBalance = Math.round((assignment.balanceRemaining - installmentApplied) * 100) / 100;
    const isPaidOff = newBalance <= 0;
    await updateOne('employee_compensations', { id: assignment.id }, {
      balanceRemaining: Math.max(0, newBalance),
      totalRepaid: Math.round(((assignment.totalRepaid || 0) + installmentApplied) * 100) / 100,
      loanStatus: isPaidOff ? 'completed' : 'active',
      isActive: isPaidOff ? false : assignment.isActive,
      updatedAt: new Date(),
    });
    if (isPaidOff) {
      logCompensationChange(assignment.employeeId, assignment.id, assignment.conceptName, 'updated',
        [{ field: 'loanStatus', oldValue: 'active', newValue: 'completed' },
         { field: 'isActive', oldValue: true, newValue: false }],
        null);
    }
  }

  const message = excludedEmployees.length
    ? `Cycle locked and payroll calculated for ${employees.length} employee(s). ${excludedEmployees.length} employee(s) were excluded due to incomplete profiles — see the Excluded tab.`
    : 'Cycle locked and payroll calculated.';
  return returnFunction(res, 200, true, message, { employeeCount: employees.length, excludedEmployees });
}

// ── Close Cycle → Distribute Payslips ────────────────────────────────────────

const closeCycle = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { id: req.params.id });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  return closeCycleInternal(req, res, cycle);
};

// Same atomic-claim pattern as lockCycleInternal above — see that comment.
async function closeCycleInternal(req, res, cycle) {
  if (cycle.status !== 'locked') return returnFunction(res, 400, false, 'Cycle must be locked to close.');
  const claimed = await knex('payroll_cycles').where({ id: cycle.id, status: 'locked', isClosing: false }).update({ isClosing: true });
  if (claimed !== 1) {
    return returnFunction(res, 409, false, 'This cycle is already being closed by another request.');
  }
  try {
    return await doCloseCycleInternal(req, res, cycle);
  } finally {
    await knex('payroll_cycles').where({ id: cycle.id }).update({ isClosing: false }).catch(() => {});
  }
}

async function doCloseCycleInternal(req, res, cycle) {

  // Block close if any results are still pending approval
  const pendingCount = await countDocuments('payroll_results', { cycleId: cycle.id, status: 'pending' });
  if (pendingCount > 0) {
    return returnFunction(res, 400, false, `Cannot close cycle: ${pendingCount} payroll result(s) are still pending approval. Approve or remove them first.`);
  }

  // Block close if any result still has an unresolved error-severity exception (missing
  // bank/M-Pesa details, negative net pay) — 'warning' severity is informational and
  // doesn't block; 'error' means this payslip cannot correctly be paid as calculated.
  // Approving a result doesn't clear its exceptions, so this check is independent of
  // (and layered on top of) the pending-approval gate above. A real child table (not a
  // JSONB path query) is exactly why this stayed a plain WHERE — see the migration.
  const errorExceptionCount = await knex('payroll_result_exceptions')
    .whereIn('resultId', knex('payroll_results').where({ cycleId: cycle.id }).select('id'))
    .where({ severity: 'error' }).count('* as count').first()
    .then((r) => Number(r.count));
  if (errorExceptionCount > 0) {
    return returnFunction(res, 400, false, `Cannot close cycle: ${errorExceptionCount} payroll result(s) have an unresolved error (missing bank/M-Pesa details, or negative net pay). Fix these employees' records and re-lock the cycle first.`);
  }

  const results = await findMany('payroll_results', { cycleId: cycle.id });
  const period = `${MONTHS[cycle.periodMonth - 1]} ${cycle.periodYear}`;
  const notifyMessage = `Your payslip for ${period} has been generated. You can view and download it from your portal.`;
  // company_settings is Postgres now (Phase 10).
  const companySettings = await knex('company_settings').first();
  const branding = { companyName: companySettings?.companyName, logoPath: companySettings?.logoPath };

  // Generate payslips for each employee
  for (const result of results) {
    try {
      const emp = await knex('employees').where({ id: result.employeeId }).first();
      const fullResult = await attachLineItems(result);
      const pdfBuffer = await generatePayslipFromResult(emp, fullResult, { period: { month: cycle.periodMonth, year: cycle.periodYear }, currency: cycle.currency, name: cycle.name }, branding);

      // Write the PDF to disk once — pdfPath is referenced from both the payslips row
      // (the dedicated payslip UI) and the employee's Documents/Payslips folder, per the
      // plan's "drop the inline-base64 PDF blob" instruction (matches how certificates
      // already do it).
      const uploadDir = process.env.UPLOAD_DIR || 'uploads';
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const payslipId = newId();
      const filePath = path.join(uploadDir, `payslip-${payslipId}.pdf`);
      fs.writeFileSync(filePath, pdfBuffer);

      const payslipDoc = {
        id: payslipId,
        employeeId:  result.employeeId,
        cycleId:     cycle.id,
        resultId:    result.id,
        periodMonth: cycle.periodMonth, periodYear: cycle.periodYear,
        grossPay:    result.grossPay,
        netPay:      result.netPay,
        status:      'paid',
        pdfPath:     filePath,
        generatedAt: new Date(),
        createdAt:   new Date(),
      };
      const slip = await insertOne('payslips', payslipDoc);
      await updateOne('payroll_results', { id: result.id }, { payslipUrl: `/api/payroll/payslips/${slip.id}/pdf`, payslipSentAt: new Date(), status: 'paid', updatedAt: new Date() });

      // Also land a copy under the employee's Documents (Payslips folder) — the payslip
      // module keeps its own file reference in `payslips` for the dedicated payslip UI,
      // but Documents' download flow (downloadDocument) reads employee_documents, so a
      // row has to exist there too for the Payslips folder to actually show it. Points
      // at the SAME file on disk — no second copy.
      try {
        await addChildRow('employee_documents', {
          employeeId: result.employeeId, docType: 'payslip', fileName: `Payslip - ${period}.pdf`, filePath, uploadedAt: new Date(),
        });
      } catch (docErr) {
        console.error(`Payslip document upload failed for employee ${result.employeeId}:`, docErr.message);
      }

      // Notify the employee (in-app + email) — separate from the manual emailPayslips action.
      notifyEmployee(result.employeeId, {
        title: 'Payslip Generated', body: notifyMessage, type: 'payroll',
        link: `/payroll/payslips/${slip.id}`,
      }).catch(() => {});

      const user = await knex('users').where({ employeeId: result.employeeId }).first();
      if (user?.email) {
        sendTemplatedEmail({
          trigger: 'payslipGenerated',
          to: user.email,
          tokens: { employeeName: emp?.fullName ?? 'Employee', period },
          fallbackSubject: `Your Payslip — ${period}`,
          fallbackHtml: `<p>Dear ${emp?.fullName ?? 'Employee'},</p><p>${notifyMessage}</p>`,
        }).catch(() => {});
      }
    } catch (err) {
      // Log and continue — don't fail the whole cycle for one payslip
      console.error(`Payslip generation failed for employee ${result.employeeId}:`, err.message);
    }
  }

  await updateOne('payroll_cycles', { id: cycle.id }, { status: 'closed', closedAt: new Date(), closedBy: req.user?.id ?? null, updatedAt: new Date() });

  // Salary Expense / Salary Payable, net-pay-denominated (statutory withholdings and
  // employer contributions are not separately booked as GL liabilities in v1 — everything
  // nets through at the net-pay figure). Never blocks the close itself. Lines are split
  // per department so a department_head's 'viewer' reports scope correctly later.
  // GL accounting (gl_accounts/gl_journal_entries) is Postgres now (Phase 7) — this
  // block only ever went through glEngine's postJournalEntry/resolveSystemAccount
  // exports, whose call signature and return shape were kept identical across that
  // rewrite, so nothing here needed to change (verified live, not just assumed).
  {
    const employeeIds = [...new Set(results.map((r) => r.employeeId))];
    const employees = employeeIds.length ? await knex('employees').whereIn('id', employeeIds).select('id', 'department') : [];
    const deptByEmployee = Object.fromEntries(employees.map((e) => [e.id, e.department || null]));

    const netByDept = {};
    for (const r of results) {
      const dept = deptByEmployee[r.employeeId] || null;
      netByDept[dept] = round2((netByDept[dept] || 0) + (Number(r.netPay) || 0));
    }
    const totalNet = round2(Object.values(netByDept).reduce((s, v) => s + v, 0));

    if (totalNet > 0) {
      const payload = {
        date: new Date(), description: `Payroll cycle closed — ${period}`, source: 'payroll_cycle_close', sourceModule: 'payroll',
        referenceId: cycle.id, referenceModel: 'payroll_cycles', lines: [],
      };
      try {
        const expenseAcct = await resolveSystemAccount('salary_expense');
        const payableAcct = await resolveSystemAccount('salary_payable');
        const lines = [];
        for (const [dept, amount] of Object.entries(netByDept)) {
          if (amount <= 0) continue;
          const department = dept === 'null' ? null : dept;
          lines.push({ accountId: expenseAcct._id, debit: amount, department });
          lines.push({ accountId: payableAcct._id, credit: amount, department });
        }
        payload.lines = lines;
        await postJournalEntry({ ...payload, postedBy: req.user?.id || null });
      } catch (err) {
        await logPostingFailure({ source: 'payroll_cycle_close', sourceModule: 'payroll', referenceId: cycle.id, referenceModel: 'payroll_cycles', attemptedPayload: payload, error: err });
      }
    }
  }

  return returnFunction(res, 200, true, 'Cycle closed and payslips distributed.');
}

// ── Export CSV ────────────────────────────────────────────────────────────────

const exportCycleCSV = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { id: req.params.id });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  const results = await findMany('payroll_results', { cycleId: cycle.id });
  const employeeIds = [...new Set(results.map(r => r.employeeId))];
  const employees = employeeIds.length ? await knex('employees').whereIn('id', employeeIds).select('id', 'fullName', 'staffNumber', 'department') : [];
  const empById = Object.fromEntries(employees.map(e => [e.id, e]));
  const rows = results.map(r => {
    const emp = empById[r.employeeId];
    return [
      emp?.staffNumber ?? '', emp?.fullName ?? '', emp?.department ?? '',
      r.grossPay, r.totalDeductions, r.netPay, r.totalEmployerCost, r.status,
    ].join(',');
  });
  const csv = ['Staff No,Name,Department,Gross,Deductions,Net,Employer Cost,Status', ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${cycle.periodYear}-${cycle.periodMonth}.csv"`);
  return res.send(csv);
};

// ── Bank Disbursement File ────────────────────────────────────────────────────
// Generates a bank EFT CSV: one row per employee with bank details + net pay.
// Only approved results are included; cycle must be locked or closed.

const exportBankFile = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { id: req.params.id });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  if (!['locked', 'closed'].includes(cycle.status)) {
    return returnFunction(res, 400, false, 'Bank file can only be exported once the cycle is locked or closed.');
  }

  const results = await knex('payroll_results').where({ cycleId: cycle.id }).whereIn('status', ['approved', 'paid']);
  if (!results.length) return returnFunction(res, 400, false, 'No approved payroll results to export.');

  // Never let a broken payment instruction (negative/zero net pay from a deduction
  // config error) reach the file HR actually uploads to the bank — block the whole
  // export rather than silently drop rows, so nobody accidentally goes unpaid without
  // HR noticing. Same "error" exceptions closeCycleInternal blocks on.
  const resultIds = results.map(r => r.id);
  const errorResultIds = new Set((await knex('payroll_result_exceptions').whereIn('resultId', resultIds).where({ severity: 'error' }).select('resultId')).map(e => e.resultId));
  const badRows = results.filter(r => r.netPay <= 0 || errorResultIds.has(r.id));
  if (badRows.length) {
    return returnFunction(res, 400, false, `Cannot export bank file: ${badRows.length} result(s) have a negative/zero net pay or an unresolved error. Fix these employees' records and re-lock the cycle before exporting.`);
  }

  const employeeIds = [...new Set(results.map(r => r.employeeId))];
  const employees = employeeIds.length
    ? await knex('employees').whereIn('id', employeeIds).select('id', 'fullName', 'staffNumber', 'bankName', 'bankAccountNumber', 'mpesaNumber', 'paymentMethod')
    : [];
  const empById = Object.fromEntries(employees.map(e => [e.id, e]));

  const rows = results.map(r => {
    const emp = empById[r.employeeId];
    const account = emp?.bankAccountNumber || emp?.mpesaNumber || '';
    const bank    = emp?.bankName || '';
    const method  = emp?.paymentMethod || 'bank_transfer';
    return [
      emp?.staffNumber ?? '',
      `"${(emp?.fullName ?? '').replace(/"/g, '')}"`,
      method,
      bank,
      account,
      Number(r.netPay).toFixed(2),
      cycle.currency || 'KES',
      `"${cycle.name}"`,
    ].join(',');
  });

  const header = 'StaffNo,Name,PaymentMethod,BankName,AccountNumber,NetAmount,Currency,PayrollPeriod';
  const csv = [header, ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="bank-file-${cycle.periodYear}-${cycle.periodMonth}.csv"`);
  return res.send(csv);
};

// ── Get Single Result ─────────────────────────────────────────────────────────

const getEmployeeResult = async (req, res) => {
  const result = await findOne('payroll_results', { cycleId: req.params.cycleId, employeeId: req.params.employeeId });
  if (!result) return returnFunction(res, 404, false, req.locale.notFound);
  const emp = await findOne('employees', { id: result.employeeId });
  const fullResult = await attachLineItems(result);
  return returnFunction(res, 200, true, req.locale.success, { ...fullResult, employee: emp ?? null });
};

// ── Email Payslips ────────────────────────────────────────────────────────────
// POST /api/payroll/cycles/:id/email-payslips
// Emails each employee their payslip PDF for this closed cycle.

const emailPayslips = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { id: req.params.id });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);
  if (cycle.status !== 'closed') {
    return returnFunction(res, 400, false, 'Cycle must be closed before emailing payslips.');
  }

  const results = await findMany('payroll_results', { cycleId: cycle.id, status: 'paid' });
  if (!results.length) {
    return returnFunction(res, 400, false, 'No paid payroll results found in this cycle.');
  }

  let sent = 0, skipped = 0, failed = 0;
  const period = `${MONTHS[cycle.periodMonth - 1]} ${cycle.periodYear}`;
  // company_settings is Postgres now (Phase 10).
  const companySettings = await knex('company_settings').first();
  const branding = { companyName: companySettings?.companyName, logoPath: companySettings?.logoPath };

  for (const result of results) {
    try {
      const [emp, user] = await Promise.all([
        knex('employees').where({ id: result.employeeId }).first(),
        knex('users').where({ employeeId: result.employeeId }).first(),
      ]);

      if (!user?.email) { skipped++; continue; }

      const fullResult = await attachLineItems(result);
      const pdfBuffer = await generatePayslipFromResult(emp, fullResult, { period: { month: cycle.periodMonth, year: cycle.periodYear }, currency: cycle.currency, name: cycle.name }, branding);
      const cur       = cycle.currency || 'KES';
      const netFmt    = `${cur} ${(Number(result.netPay) || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;

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
          filename: `payslip-${emp?.staffNumber ?? 'emp'}-${cycle.periodYear}-${String(cycle.periodMonth).padStart(2, '0')}.pdf`,
          content:     pdfBuffer,
          contentType: 'application/pdf',
        }],
      });

      await updateOne('payroll_results', { id: result.id }, { payslipSentAt: new Date(), updatedAt: new Date() });
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

// ── Bulk Payslip ZIP Download ─────────────────────────────────────────────────
// GET /api/payroll/cycles/:cycleId/payslips/zip
// Streams every payslip PDF for this cycle bundled into a single ZIP.

const downloadPayslipsZip = async (req, res) => {
  const cycle = await findOne('payroll_cycles', { id: req.params.cycleId });
  if (!cycle) return returnFunction(res, 404, false, req.locale.notFound);

  const results = await findMany('payroll_results', { cycleId: cycle.id });
  if (!results.length) return returnFunction(res, 400, false, 'No payroll results found for this cycle.');
  // company_settings is Postgres now (Phase 10).
  const companySettings = await knex('company_settings').first();
  const branding = { companyName: companySettings?.companyName, logoPath: companySettings?.logoPath };

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="payslips-${cycle.id}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  // archiver's 'error' event fires asynchronously — throwing here would be an uncaught
  // exception (AsyncHandler only catches the synchronously-returned promise's rejection),
  // which would crash the whole Node process for every concurrent user, not just this
  // request. Log and tear down just this response instead.
  archive.on('error', (err) => {
    console.error('Payslip ZIP stream error:', err.message);
    if (!res.headersSent) return returnFunction(res, 500, false, 'Failed to generate ZIP.');
    res.destroy(err);
  });
  archive.pipe(res);

  for (const result of results) {
    try {
      const emp = await knex('employees').where({ id: result.employeeId }).first();
      const fullResult = await attachLineItems(result);
      const pdfBuffer = await generatePayslipFromResult(emp, fullResult, { period: { month: cycle.periodMonth, year: cycle.periodYear }, currency: cycle.currency, name: cycle.name }, branding);
      const filename = `payslip-${emp?.staffNumber ?? result.employeeId}-${cycle.periodYear}-${String(cycle.periodMonth).padStart(2, '0')}.pdf`;
      archive.append(pdfBuffer, { name: filename });
    } catch (err) {
      // Same philosophy as closeCycleInternal — one bad payslip doesn't sink the whole ZIP.
      console.error(`Payslip ZIP: skipping employee ${result.employeeId}:`, err.message);
    }
  }

  await archive.finalize();
};

// ── P9A Form (Kenya KRA Annual PAYE Deduction Card) ───────────────────────────
// GET /api/payroll/p9/:employeeId?year=2025
const downloadP9Form = async (req, res) => {
  const { employeeId } = req.params;
  const year = parseInt(req.query.year) || new Date().getFullYear() - 1;

  const employee = await findOne('employees', { id: employeeId });
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  const results  = await findMany('payroll_results', { employeeId });
  const cycleIds = [...new Set(results.map(r => r.cycleId))];
  const cycles   = cycleIds.length ? await knex('payroll_cycles').whereIn('id', cycleIds) : [];
  const cycleMap = Object.fromEntries(cycles.map(c => [c.id, c]));

  const monthMap = {};
  for (const r of results) {
    const cycle = cycleMap[r.cycleId];
    if (!cycle || cycle.periodYear !== year) continue;
    const m = cycle.periodMonth;
    monthMap[m] = {
      month: m, grossPay: Number(r.grossPay) || 0,
      paye: Number(r.statutoryPaye) || 0, nssf: Number(r.statutoryNssf) || 0, sha: Number(r.statutorySha) || 0, ahl: Number(r.statutoryAhl) || 0,
      netPay: Number(r.netPay) || 0,
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
  emailPayslips, downloadP9Form, downloadPayslipsZip,
  resolveStatutoryLine,
};
