// Postgres migration (Phase 10) — this is the file every earlier phase's own
// notes deliberately deferred ("reportFunctions.js again deliberately
// excluded... its own future phase"), because it reads from ~20 collections
// across nearly every module — it could only be safely rewritten once
// everything it touches was already Postgres. That's true as of this phase.
// customReports is the one genuinely new table here (built in Phase 10);
// `feedback`/`one_on_ones` were already Postgres since Phase 5 but this file
// had never been updated to read them via knex, so it had been silently
// reading frozen, stale Mongo data for both since that phase shipped.
const PDFDocument = require('pdfkit');
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { sendEmail } = require('../../services/emailService');

// Reused directly from the module that already computes it — see the audit this build
// started from (a lot of this analytics already existed, scattered per-module; this file
// is a cross-module layer on top, not a third copy of the same aggregation).
const { getHeadcountAnalytics, getTurnoverAnalytics, getTenureAnalytics, getDemographicsAnalytics } = require('../employees/employeesFunctions');
const { getAttendanceSummary, getOvertimeAnalytics, getLateArrivalsAnalytics, getAbsenteeismAnalytics } = require('../attendance/attendanceFunctions');
const { getLeaveAnalytics } = require('../leave/leaveFunctions');
const { getPayrollAnalytics } = require('../payroll/payrollAnalyticsFunctions');
const { getAnalytics: getPerformanceAnalytics } = require('../performance/performanceFunctions');
const { getSourceEffectiveness } = require('../recruitment/recruitmentFunctions');
const { getComplianceReport } = require('../training/trainingFunctions');
const { getAnalytics: getExpenseClaimsAnalytics } = require('../expenses/expenseClaimsFunctions');
const { getProcurementSpend, getVendorAnalytics } = require('../spending/spendingFunctions');

module.exports.getHeadcountAnalytics = getHeadcountAnalytics;
module.exports.getTurnoverAnalytics = getTurnoverAnalytics;
module.exports.getTenureAnalytics = getTenureAnalytics;
module.exports.getDemographicsAnalytics = getDemographicsAnalytics;
module.exports.getAttendanceSummary = getAttendanceSummary;
module.exports.getOvertimeAnalytics = getOvertimeAnalytics;
module.exports.getLateArrivalsAnalytics = getLateArrivalsAnalytics;
module.exports.getAbsenteeismAnalytics = getAbsenteeismAnalytics;
module.exports.getLeaveAnalytics = getLeaveAnalytics;
module.exports.getPayrollAnalytics = getPayrollAnalytics;
module.exports.getPerformanceAnalytics = getPerformanceAnalytics;
module.exports.getSourceEffectiveness = getSourceEffectiveness;
module.exports.getComplianceReport = getComplianceReport;
module.exports.getExpenseClaimsAnalytics = getExpenseClaimsAnalytics;
module.exports.getProcurementSpend = getProcurementSpend;
module.exports.getVendorAnalytics = getVendorAnalytics;

const countRows = async (table, cb) => {
  let q = knex(table);
  if (cb) q = cb(q);
  const [{ count }] = await q.count('* as count');
  return Number(count);
};

// ── Executive Dashboard ───────────────────────────────────────────────────────

const getExecutiveDashboard = async (req, res) => {
  const now = new Date();
  const month = now.getMonth() + 1, year = now.getFullYear();
  const lastMonthDate = new Date(year, now.getMonth() - 1, 1);
  const lastMonth = lastMonthDate.getMonth() + 1, lastMonthYear = lastMonthDate.getFullYear();
  const startOfMonth = new Date(year, now.getMonth(), 1);
  const in30 = new Date(now.getTime() + 30 * 86400000);
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const weekStr = startOfWeek.toISOString().slice(0, 10);

  const [
    total, active, onLeave, offboarding, terminatedThisMonth,
    openPositions,
    thisMonthCycles, lastMonthCyclesArr,
    weekAttendance,
    lastCompletedCycle,
    totalEnrollments, completedEnrollments,
    pendingLeave, pendingExpenses, pendingTimesheets, pendingPRs,
    probationCount, certExpiryCount, contractEndCount, pipCount,
  ] = await Promise.all([
    countRows('employees'),
    countRows('employees', (q) => q.where({ status: 'active' })),
    countRows('employees', (q) => q.where({ status: 'on_leave' })),
    countRows('offboarding_records', (q) => q.whereNot({ status: 'completed' })),
    countRows('employees', (q) => q.where({ status: 'terminated' }).where('terminationDate', '>=', startOfMonth)),
    countRows('job_requisitions', (q) => q.where({ status: 'open' })),
    knex('payroll_cycles').where({ periodMonth: month, periodYear: year }),
    knex('payroll_cycles').where({ periodMonth: lastMonth, periodYear: lastMonthYear }),
    knex('attendance_records').where('date', '>=', weekStr).select('status').count('* as count').groupBy('status'),
    knex('review_cycles').where({ status: 'completed' }).orderBy('updatedAt', 'desc').first(),
    countRows('enrollments'),
    countRows('enrollments', (q) => q.where({ status: 'completed' })),
    countRows('leave_requests', (q) => q.where({ status: 'pending' })),
    countRows('expense_claims', (q) => q.where({ status: 'submitted' })),
    countRows('timesheets', (q) => q.where({ status: 'submitted' })),
    countRows('purchase_requests', (q) => q.where({ status: 'pending' })),
    countRows('employees', (q) => q.where({ status: 'active' }).where('probationEndDate', '>=', now).where('probationEndDate', '<=', in30)),
    countRows('certificates', (q) => q.where('expiresAt', '>=', now).where('expiresAt', '<=', in30)),
    countRows('employees', (q) => q.where({ status: 'active' }).where('contractEndDate', '>=', now).where('contractEndDate', '<=', in30)),
    countRows('performance_improvement_plans', (q) => q.where({ status: 'active' })),
  ]);

  const sumPayroll = async (cycles) => {
    const cycleIds = cycles.map((c) => c.id);
    if (!cycleIds.length) return { gross: 0, net: 0 };
    const results = await knex('payroll_results').whereIn('cycleId', cycleIds);
    return {
      gross: results.reduce((s, r) => s + (Number(r.grossPay) || 0), 0),
      net: results.reduce((s, r) => s + (Number(r.netPay) || 0), 0),
    };
  };
  const [thisMonthPayroll, lastMonthPayroll] = await Promise.all([sumPayroll(thisMonthCycles), sumPayroll(lastMonthCyclesArr)]);

  const presentCount = weekAttendance.filter((a) => ['present', 'remote', 'late'].includes(a.status)).reduce((s, a) => s + Number(a.count), 0);
  const totalAttRecords = weekAttendance.reduce((s, a) => s + Number(a.count), 0);
  const attendanceRateThisWeek = totalAttRecords > 0 ? Math.round((presentCount / totalAttRecords) * 100) : 0;

  let avgPerformanceRating = null;
  if (lastCompletedCycle) {
    const reviews = await knex('reviews').where({ cycleId: lastCompletedCycle.id, reviewType: 'manager', status: 'submitted' }).whereNotNull('overallRating');
    if (reviews.length) avgPerformanceRating = Math.round((reviews.reduce((s, r) => s + Number(r.overallRating), 0) / reviews.length) * 10) / 10;
  }

  // Leave liability: sum of each employee's unused (positive) leave balance days × their
  // own daily rate (grossPay / 22 — same standard-working-days convention the payroll
  // engine itself uses for overtime/proration, see payrollCyclesFunctions.js).
  const balances = await knex('leave_balances').where({ year }).where('closingBalance', '>', 0);
  const empIds = [...new Set(balances.map((b) => b.employeeId))];
  const emps = empIds.length ? await knex('employees').whereIn('id', empIds).select('id', 'grossPay') : [];
  const grossPayMap = new Map(emps.map((e) => [e.id, Number(e.grossPay) || 0]));
  const leaveLiability = balances.reduce((sum, b) => {
    const dailyRate = (grossPayMap.get(b.employeeId) || 0) / 22;
    return sum + Number(b.closingBalance) * dailyRate;
  }, 0);

  return returnFunction(res, 200, true, req.locale.success, {
    headcount: { total, active, onLeave, offboarding, terminatedThisMonth },
    openPositions,
    payrollCost: { thisMonth: thisMonthPayroll.gross, lastMonth: lastMonthPayroll.gross },
    leaveLiability: Math.round(leaveLiability),
    attendanceRateThisWeek,
    avgPerformanceRating,
    trainingCompletionRate: totalEnrollments > 0 ? Math.round((completedEnrollments / totalEnrollments) * 100) : 0,
    pendingApprovals: {
      total: pendingLeave + pendingExpenses + pendingTimesheets + pendingPRs,
      leave: pendingLeave, expenses: pendingExpenses, timesheets: pendingTimesheets, purchaseRequests: pendingPRs,
    },
    alerts: { probationEndings: probationCount, certsExpiring: certExpiryCount, contractEndings: contractEndCount, activePIPs: pipCount },
  });
};

// ── Trend charts (12mo headcount, 12mo payroll, 12wk attendance) ──────────────

const getExecutiveTrends = async (req, res) => {
  const now = new Date();

  const headcountTrend = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const nextD = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const count = await countRows('employees', (q) => q.where('dateOfHire', '<', nextD)
      .where((qb) => qb.whereNull('terminationDate').orWhere('terminationDate', '>=', d)));
    headcountTrend.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, count });
  }

  const payrollTrend = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const cycles = await knex('payroll_cycles').where({ periodMonth: d.getMonth() + 1, periodYear: d.getFullYear() });
    const cycleIds = cycles.map((c) => c.id);
    const results = cycleIds.length ? await knex('payroll_results').whereIn('cycleId', cycleIds) : [];
    payrollTrend.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, cost: results.reduce((s, r) => s + (Number(r.grossPay) || 0), 0) });
  }

  const attendanceTrend = [];
  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay() - i * 7);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
    const records = await knex('attendance_records')
      .where('date', '>=', weekStart.toISOString().slice(0, 10)).where('date', '<=', weekEnd.toISOString().slice(0, 10))
      .select('status').count('* as count').groupBy('status');
    const present = records.filter((r) => ['present', 'remote', 'late'].includes(r.status)).reduce((s, r) => s + Number(r.count), 0);
    const total = records.reduce((s, r) => s + Number(r.count), 0);
    attendanceTrend.push({ weekStart: weekStart.toISOString().slice(0, 10), rate: total > 0 ? Math.round((present / total) * 100) : 0 });
  }

  const headcountByDept = await knex('employees').where({ status: 'active' }).select('department').count('* as count').groupBy('department').orderBy('count', 'desc');

  const now2 = new Date();
  const startOfThisMonth = new Date(now2.getFullYear(), now2.getMonth(), 1);
  const leaveByTypeRaw = await knex('leave_requests').where({ status: 'approved' }).where('startDate', '>=', startOfThisMonth)
    .select('leaveTypeId').sum('totalDays as days').groupBy('leaveTypeId');
  const leaveTypeIds = leaveByTypeRaw.map((l) => l.leaveTypeId).filter(Boolean);
  const leaveTypes = leaveTypeIds.length ? await knex('leave_types').whereIn('id', leaveTypeIds).select('id', 'name') : [];
  const leaveTypeNameMap = new Map(leaveTypes.map((lt) => [lt.id, lt.name]));

  return returnFunction(res, 200, true, req.locale.success, {
    headcountTrend, payrollTrend, attendanceTrend,
    headcountByDepartment: headcountByDept.map((d) => ({ department: d.department || 'Unassigned', count: Number(d.count) })),
    leaveByTypeThisMonth: leaveByTypeRaw.map((l) => ({ type: leaveTypeNameMap.get(l.leaveTypeId) || 'Unknown', days: Number(l.days) || 0 })),
  });
};

// ── Workforce: Movement (promotions/transfers/salary changes) ────────────────
// job_history is auto-logged by employeesFunctions.js on every tracked field change —
// changeType values: titleChange (proxy for promotion), departmentChange (transfer),
// managerChange, salaryChange, statusChange, termination.
const getWorkforceMovement = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const start = new Date(year, 0, 1), end = new Date(year + 1, 0, 1);

  const entries = await knex('job_history').where('effectiveDate', '>=', start).where('effectiveDate', '<', end)
    .whereIn('changeType', ['titleChange', 'departmentChange', 'salaryChange']).orderBy('effectiveDate', 'desc');
  const empIds = [...new Set(entries.map((e) => e.employeeId))];
  const emps = empIds.length ? await knex('employees').whereIn('id', empIds).select('id', 'fullName', 'department') : [];
  const empMap = new Map(emps.map((e) => [e.id, e]));

  const promotions = entries.filter((e) => e.changeType === 'titleChange');
  const transfers = entries.filter((e) => e.changeType === 'departmentChange');
  const salaryChanges = entries.filter((e) => e.changeType === 'salaryChange');

  const byDept = (list) => {
    const counts = {};
    for (const e of list) {
      const dept = empMap.get(e.employeeId)?.department || 'Unassigned';
      counts[dept] = (counts[dept] || 0) + 1;
    }
    return Object.entries(counts).map(([department, count]) => ({ department, count }));
  };

  const enrich = (list) => list.map((e) => ({
    employeeId: e.employeeId, employeeName: empMap.get(e.employeeId)?.fullName || 'Unknown',
    department: empMap.get(e.employeeId)?.department || '—',
    effectiveDate: e.effectiveDate, previousValues: e.previousValues, newValues: e.newValues, reason: e.reason,
  }));

  return returnFunction(res, 200, true, req.locale.success, {
    year,
    promotionsByDept: byDept(promotions),
    transfers: enrich(transfers),
    salaryChangeCount: salaryChanges.length,
  });
};

// ── Payroll: Breakdown (earnings vs deductions vs net) ────────────────────────
const getPayrollBreakdown = async (req, res) => {
  const now = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year = parseInt(req.query.year) || now.getFullYear();

  const cycles = await knex('payroll_cycles').where({ periodMonth: month, periodYear: year });
  const cycleIds = cycles.map((c) => c.id);
  const results = cycleIds.length ? await knex('payroll_results').whereIn('cycleId', cycleIds) : [];

  const totals = results.reduce((acc, r) => {
    acc.gross += Number(r.grossPay) || 0;
    acc.paye += Number(r.statutoryPaye) || 0;
    acc.sha += Number(r.statutorySha) || 0;
    acc.nssf += Number(r.statutoryNssf) || 0;
    acc.ahl += Number(r.statutoryAhl) || 0;
    // "otherDeductions" = totalDeductions minus the statutory portion — statutory
    // deductions are folded into totalDeductions in the Postgres schema, unlike the
    // original Mongo shape which kept otherDeductions as an explicitly separate field.
    acc.otherDeductions += (Number(r.totalDeductions) || 0) - (Number(r.statutoryTotal) || 0);
    acc.net += Number(r.netPay) || 0;
    return acc;
  }, { gross: 0, paye: 0, sha: 0, nssf: 0, ahl: 0, otherDeductions: 0, net: 0 });

  return returnFunction(res, 200, true, req.locale.success, { month, year, headcount: results.length, ...totals });
};

// ── Payroll: Overtime cost trend by department ────────────────────────────────
const getPayrollOvertimeCost = async (req, res) => {
  const now = new Date();
  const months = Math.min(parseInt(req.query.months) || 6, 12);
  const trend = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const cycles = await knex('payroll_cycles').where({ periodMonth: d.getMonth() + 1, periodYear: d.getFullYear() });
    const cycleIds = cycles.map((c) => c.id);
    const results = cycleIds.length ? await knex('payroll_results').whereIn('cycleId', cycleIds).select('overtimeAmount', 'employeeId') : [];
    trend.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, cost: results.reduce((s, r) => s + (Number(r.overtimeAmount) || 0), 0) });
  }

  // Current month by department
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  const cycles = await knex('payroll_cycles').where({ periodMonth: d.getMonth() + 1, periodYear: d.getFullYear() });
  const cycleIds = cycles.map((c) => c.id);
  const results = cycleIds.length ? await knex('payroll_results').whereIn('cycleId', cycleIds).select('overtimeAmount', 'employeeId') : [];
  const empIds = [...new Set(results.map((r) => r.employeeId))];
  const emps = empIds.length ? await knex('employees').whereIn('id', empIds).select('id', 'department') : [];
  const deptMap = new Map(emps.map((e) => [e.id, e.department]));
  const byDept = {};
  for (const r of results) {
    const dept = deptMap.get(r.employeeId) || 'Unassigned';
    byDept[dept] = (byDept[dept] || 0) + (Number(r.overtimeAmount) || 0);
  }

  return returnFunction(res, 200, true, req.locale.success, {
    trend,
    byDepartmentThisMonth: Object.entries(byDept).map(([department, cost]) => ({ department, cost })),
  });
};

// ── Leave: Liability (dedicated, standalone view of the exec-dashboard figure) ─
const getLeaveLiabilityReport = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const balances = await knex('leave_balances').where({ year }).where('closingBalance', '>', 0);
  const empIds = [...new Set(balances.map((b) => b.employeeId))];
  const emps = empIds.length ? await knex('employees').whereIn('id', empIds).select('id', 'fullName', 'department', 'grossPay') : [];
  const empMap = new Map(emps.map((e) => [e.id, e]));

  const byDept = {};
  const perEmployee = [];
  for (const b of balances) {
    const emp = empMap.get(b.employeeId);
    const dailyRate = (Number(emp?.grossPay) || 0) / 22;
    const value = Number(b.closingBalance) * dailyRate;
    const dept = emp?.department || 'Unassigned';
    if (!byDept[dept]) byDept[dept] = { department: dept, totalDays: 0, value: 0 };
    byDept[dept].totalDays += Number(b.closingBalance);
    byDept[dept].value += value;
    perEmployee.push({ employeeId: b.employeeId, employeeName: emp?.fullName || 'Unknown', department: dept, unusedDays: Number(b.closingBalance), value: Math.round(value) });
  }
  perEmployee.sort((a, b) => b.value - a.value);

  return returnFunction(res, 200, true, req.locale.success, {
    year,
    total: { days: perEmployee.reduce((s, e) => s + e.unusedDays, 0), value: Math.round(perEmployee.reduce((s, e) => s + e.value, 0)) },
    byDepartment: Object.values(byDept).map((d) => ({ ...d, value: Math.round(d.value) })),
    topExposure: perEmployee.slice(0, 20),
  });
};

// ── Leave: Patterns (day-of-week heatmap) ─────────────────────────────────────
const getLeavePatterns = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const requests = await knex('leave_requests').where({ status: 'approved' })
    .where('startDate', '>=', new Date(`${year}-01-01`)).where('startDate', '<=', new Date(`${year}-12-31T23:59:59`))
    .select('startDate', 'endDate', 'totalDays');

  const dayOfWeekCounts = [0, 0, 0, 0, 0, 0, 0]; // Sun..Sat
  const monthCounts = Array(12).fill(0);
  for (const r of requests) {
    const start = new Date(r.startDate);
    dayOfWeekCounts[start.getDay()] += 1;
    monthCounts[start.getMonth()] += Number(r.totalDays) || 1;
  }
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return returnFunction(res, 200, true, req.locale.success, {
    year,
    byDayOfWeek: DOW.map((day, i) => ({ day, count: dayOfWeekCounts[i] })),
    byMonth: monthCounts.map((days, i) => ({ month: i + 1, days })),
  });
};

// ── Performance: Goals by department + type ───────────────────────────────────
const getPerformanceGoalsReport = async (req, res) => {
  const period = req.query.period;
  let query = knex('goals').select('department', 'category', 'status', 'progress');
  if (period) query = query.where({ period });
  const goals = await query;

  const byDept = {};
  const byCategory = {};
  for (const g of goals) {
    const dept = g.department || 'Unassigned';
    if (!byDept[dept]) byDept[dept] = { department: dept, total: 0, completed: 0 };
    byDept[dept].total++;
    if (g.status === 'completed') byDept[dept].completed++;

    const cat = g.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = { category: cat, total: 0, completed: 0 };
    byCategory[cat].total++;
    if (g.status === 'completed') byCategory[cat].completed++;
  }

  const withRate = (obj) => Object.values(obj).map((r) => ({ ...r, completionRate: r.total ? Math.round((r.completed / r.total) * 100) : 0 }));
  return returnFunction(res, 200, true, req.locale.success, { byDepartment: withRate(byDept), byCategory: withRate(byCategory) });
};

// ── Performance: Feedback volume trend ────────────────────────────────────────
// feedback is Postgres since Phase 5 — this handler had never been updated to read
// it via knex (see file header); it had been silently reading frozen Mongo data.
const getPerformanceFeedbackReport = async (req, res) => {
  const months = Math.min(parseInt(req.query.months) || 6, 12);
  const now = new Date();
  const since = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
  const feedback = await knex('feedback').where('createdAt', '>=', since).select('createdAt', 'type');

  const trend = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const nextD = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const inMonth = feedback.filter((f) => new Date(f.createdAt) >= d && new Date(f.createdAt) < nextD);
    trend.push({
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      total: inMonth.length,
      positive: inMonth.filter((f) => f.type === 'positive' || f.type === 'recognition').length,
      constructive: inMonth.filter((f) => f.type === 'constructive').length,
    });
  }
  return returnFunction(res, 200, true, req.locale.success, { trend });
};

// ── Performance: Active PIPs and outcomes ─────────────────────────────────────
const getPipReport = async (req, res) => {
  const pips = await knex('performance_improvement_plans').orderBy('createdAt', 'desc');
  const allIds = [...new Set([...pips.map((p) => p.employeeId), ...pips.filter((p) => p.managerId).map((p) => p.managerId)])];
  const emps = allIds.length ? await knex('employees').whereIn('id', allIds).select('id', 'fullName') : [];
  const empMap = new Map(emps.map((e) => [e.id, e.fullName]));

  const enriched = pips.map((p) => ({
    id: p.id, employeeName: empMap.get(p.employeeId) || 'Unknown', managerName: p.managerId ? (empMap.get(p.managerId) || 'Unknown') : '—',
    startDate: p.startDate, endDate: p.endDate, status: p.status, outcome: p.outcome,
  }));

  return returnFunction(res, 200, true, req.locale.success, {
    active: enriched.filter((p) => p.status === 'active'),
    completed: enriched.filter((p) => p.status === 'completed'),
    outcomeSummary: { passed: enriched.filter((p) => p.outcome === 'passed').length, failed: enriched.filter((p) => p.outcome === 'failed').length },
  });
};

// ── Recruitment: Org-wide pipeline + funnel (existing getRequisitionFunnel is per-req) ─
const getRecruitmentPipeline = async (req, res) => {
  const requisitions = await knex('job_requisitions').whereIn('status', ['open', 'pendingApproval']);
  const requisitionIds = requisitions.map((r) => r.id);
  const applications = requisitionIds.length ? await knex('applications').whereIn('requisitionId', requisitionIds) : [];

  const byDept = {};
  for (const r of requisitions) {
    const dept = r.department || 'Unassigned';
    const apps = applications.filter((a) => a.requisitionId === r.id);
    if (!byDept[dept]) byDept[dept] = { department: dept, openPositions: 0, applicants: 0 };
    byDept[dept].openPositions++;
    byDept[dept].applicants += apps.length;
  }

  const hired = await knex('applications').where({ status: 'hired' }).select('requisitionId', 'updatedAt');
  const reqMap = new Map(requisitions.map((r) => [r.id, r]));
  const fillTimes = hired.map((a) => {
    const req_ = reqMap.get(a.requisitionId);
    if (!req_) return null;
    return (new Date(a.updatedAt) - new Date(req_.createdAt)) / 86400000;
  }).filter((d) => d != null && d >= 0);
  const avgTimeToHire = fillTimes.length ? Math.round(fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length) : null;

  return returnFunction(res, 200, true, req.locale.success, {
    byDepartment: Object.values(byDept),
    totalOpenPositions: requisitions.length,
    totalApplicants: applications.length,
    avgTimeToHireDays: avgTimeToHire,
  });
};

const getRecruitmentFunnel = async (req, res) => {
  const requisitions = await knex('job_requisitions').select('pipelineStages');
  const applications = await knex('applications').select('stageHistory', 'status');

  const stageNames = new Map();
  requisitions.forEach((r) => (r.pipelineStages || []).forEach((s) => stageNames.set(s.id, s.name)));

  const reached = {};
  for (const a of applications) {
    const stageIds = new Set((a.stageHistory || []).map((h) => h.stageId));
    for (const stageId of stageIds) {
      const name = stageNames.get(stageId) || stageId;
      reached[name] = (reached[name] || 0) + 1;
    }
  }
  const totalApplicants = applications.length;
  const funnel = Object.entries(reached)
    .map(([stageName, count]) => ({ stageName, count, conversionRate: totalApplicants ? Math.round((count / totalApplicants) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);

  return returnFunction(res, 200, true, req.locale.success, { totalApplicants, funnel });
};

// ── Training: Completion by department ────────────────────────────────────────
// enrollment.employeeId is actually users._id (the established training-module
// convention — see the training module build notes), so department comes from
// `users`, not `employees`.
const getTrainingCompletionByDept = async (req, res) => {
  const enrollments = await knex('enrollments').select('employeeId', 'status');
  const userIds = [...new Set(enrollments.map((e) => e.employeeId))];
  const users = userIds.length ? await knex('users').whereIn('id', userIds).select('id', 'department') : [];
  const deptMap = new Map(users.map((u) => [u.id, u.department]));

  const byDept = {};
  for (const e of enrollments) {
    const dept = deptMap.get(e.employeeId) || 'Unassigned';
    if (!byDept[dept]) byDept[dept] = { department: dept, total: 0, completed: 0 };
    byDept[dept].total++;
    if (e.status === 'completed') byDept[dept].completed++;
  }
  return returnFunction(res, 200, true, req.locale.success,
    Object.values(byDept).map((d) => ({ ...d, completionRate: d.total ? Math.round((d.completed / d.total) * 100) : 0 })));
};

// ── Training: Engagement (most enrolled courses, completion trend) ────────────
const getTrainingEngagement = async (req, res) => {
  const enrollments = await knex('enrollments').whereNotNull('courseId').select('courseId', 'status', 'createdAt');
  const courseIds = [...new Set(enrollments.map((e) => e.courseId))];
  const courses = courseIds.length ? await knex('courses').whereIn('id', courseIds).select('id', 'title') : [];
  const titleMap = new Map(courses.map((c) => [c.id, c.title]));

  const byCourse = {};
  for (const e of enrollments) {
    const k = e.courseId;
    if (!byCourse[k]) byCourse[k] = { courseId: e.courseId, title: titleMap.get(k) || 'Unknown', enrollments: 0, completed: 0 };
    byCourse[k].enrollments++;
    if (e.status === 'completed') byCourse[k].completed++;
  }
  const mostEnrolled = Object.values(byCourse).sort((a, b) => b.enrollments - a.enrollments).slice(0, 10);

  const months = 6;
  const now = new Date();
  const trend = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const nextD = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const inMonth = enrollments.filter((e) => new Date(e.createdAt) >= d && new Date(e.createdAt) < nextD);
    trend.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, enrollments: inMonth.length, completed: inMonth.filter((e) => e.status === 'completed').length });
  }

  return returnFunction(res, 200, true, req.locale.success, { mostEnrolled, completionTrend: trend });
};

// ── Spend: Pending (across expense claims + procurement) ─────────────────────
const getSpendPending = async (req, res) => {
  const [pendingExpenseClaims, [{ total: pendingExpenseAmount }], pendingPRs, pendingInvoices] = await Promise.all([
    countRows('expense_claims', (q) => q.where({ status: 'submitted' })),
    knex('expense_claims').where({ status: 'submitted' }).sum('amount as total'),
    countRows('purchase_requests', (q) => q.where({ status: 'pending' })),
    countRows('vendor_invoices', (q) => q.whereIn('status', ['received', 'underReview', 'matched'])),
  ]);

  return returnFunction(res, 200, true, req.locale.success, {
    pendingExpenseClaims: { count: pendingExpenseClaims, amount: Number(pendingExpenseAmount) || 0 },
    pendingPurchaseRequests: pendingPRs,
    pendingInvoiceApprovals: pendingInvoices,
  });
};

// ── Awards / IT Assets (unchanged — no duplication concern found in the audit) ─

const getAwardsReport = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const awards = await knex('employee_awards').where({ year });

  const byType = {}; const byDept = {}; const byEmp = {};
  for (const a of awards) {
    const t = a.awardTypeName || 'Other';
    const d = a.department || 'Unknown';
    byType[t] = (byType[t] || 0) + 1;
    byDept[d] = (byDept[d] || 0) + 1;
    const ek = a.employeeId;
    if (!byEmp[ek]) byEmp[ek] = { employeeName: a.employeeName, staffNumber: a.staffNumber || '—', department: d, count: 0, awards: [] };
    byEmp[ek].count++;
    byEmp[ek].awards.push(t);
  }
  const employees = Object.values(byEmp).sort((a, b) => b.count - a.count);
  return returnFunction(res, 200, true, req.locale.success, { year, summary: { total: awards.length, uniqueRecipients: employees.length }, byType, byDepartment: byDept, employees });
};

const getITAssetsReport = async (req, res) => {
  const [devices, software] = await Promise.all([
    knex('devices'),
    knex('software_apps'),
  ]);

  const byCategory = {}; const byStatus = {};
  for (const d of devices) {
    const cat = d.type || 'Other';
    if (!byCategory[cat]) byCategory[cat] = { total: 0, assigned: 0, unassigned: 0 };
    byCategory[cat].total++;
    if (d.assignedTo) byCategory[cat].assigned++; else byCategory[cat].unassigned++;
    const s = d.status || 'unassigned';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  const empCache = {};
  const deviceList = await Promise.all(devices.map(async (d) => {
    let assigneeName = 'Unassigned', assigneeDept = '—';
    if (d.assignedTo) {
      const k = d.assignedTo;
      if (!(k in empCache)) empCache[k] = await knex('employees').where({ id: d.assignedTo }).select('fullName', 'department').first();
      assigneeName = empCache[k]?.fullName || 'Unknown';
      assigneeDept = empCache[k]?.department || '—';
    }
    return { name: d.name, type: d.type || 'Other', brand: d.brand || '—', serialNumber: d.serialNumber || '—', status: d.status || 'unassigned', assigneeName, assigneeDepartment: assigneeDept };
  }));

  return returnFunction(res, 200, true, req.locale.success, {
    devices: { total: devices.length, assigned: devices.filter((d) => d.assignedTo).length, unassigned: devices.filter((d) => !d.assignedTo).length, byCategory, byStatus, list: deviceList },
    software: { totalApps: software.length, totalLicenses: software.reduce((s, a) => s + (a.totalLicenses || 0), 0), usedLicenses: software.reduce((s, a) => s + (a.assignedLicenses || 0), 0), list: software },
  });
};

// ── Cross-Module Insights ──────────────────────────────────────────────────────
// The genuinely unique value of this module — nothing else in the codebase joins
// performance + attendance + feedback + 1-on-1s this way.

const getAttritionRiskInsight = async (req, res) => {
  const now = new Date();
  const since60 = new Date(now.getTime() - 60 * 86400000);
  const since90 = new Date(now.getTime() - 90 * 86400000);
  const since90Str = since90.toISOString().slice(0, 10);

  const employees = await knex('employees').where({ status: 'active' }).select('id', 'fullName', 'department', 'managerId');

  const [reviews, attendanceRecords, recentFeedback, recentOneOnOnes] = await Promise.all([
    knex('reviews').where({ reviewType: 'manager', status: 'submitted' }).whereNotNull('overallRating').orderBy('submittedAt', 'desc').select('employeeId', 'overallRating'),
    knex('attendance_records').where('date', '>=', since90Str).select('employeeId', 'status'),
    knex('feedback').where('createdAt', '>=', since60).select('recipientId'),
    knex('one_on_ones').orderBy('scheduledAt', 'desc').select('employeeId', 'scheduledAt'),
  ]);

  const latestRatingByEmp = new Map();
  for (const r of reviews) {
    if (!latestRatingByEmp.has(r.employeeId)) latestRatingByEmp.set(r.employeeId, Number(r.overallRating));
  }
  const orgAvgRating = latestRatingByEmp.size
    ? [...latestRatingByEmp.values()].reduce((a, b) => a + b, 0) / latestRatingByEmp.size
    : null;

  const attendanceByEmp = new Map();
  for (const r of attendanceRecords) {
    if (!attendanceByEmp.has(r.employeeId)) attendanceByEmp.set(r.employeeId, { total: 0, absent: 0 });
    const entry = attendanceByEmp.get(r.employeeId);
    entry.total++;
    if (r.status === 'absent') entry.absent++;
  }
  const absenceRates = [...attendanceByEmp.values()].map((e) => (e.total ? e.absent / e.total : 0));
  const orgAvgAbsenceRate = absenceRates.length ? absenceRates.reduce((a, b) => a + b, 0) / absenceRates.length : 0;

  const feedbackRecipientSet = new Set(recentFeedback.map((f) => f.recipientId));

  const lastCheckInByEmp = new Map();
  for (const o of recentOneOnOnes) {
    if (!lastCheckInByEmp.has(o.employeeId)) lastCheckInByEmp.set(o.employeeId, o.scheduledAt);
  }

  const managerIds = [...new Set(employees.filter((e) => e.managerId).map((e) => e.managerId))];
  const managers = managerIds.length ? await knex('employees').whereIn('id', managerIds).select('id', 'fullName') : [];
  const managerNameMap = new Map(managers.map((m) => [m.id, m.fullName]));

  const flagged = [];
  for (const emp of employees) {
    const k = emp.id;
    const rating = latestRatingByEmp.get(k);
    const attendance = attendanceByEmp.get(k);
    const absenceRate = attendance && attendance.total ? attendance.absent / attendance.total : 0;
    const hasRecentFeedback = feedbackRecipientSet.has(k);

    const signals = [];
    if (rating != null && orgAvgRating != null && rating < orgAvgRating) signals.push('Below-average performance rating');
    if (absenceRate > orgAvgAbsenceRate && absenceRate > 0) signals.push('Above-average absenteeism');
    if (!hasRecentFeedback) signals.push('No feedback received in 60+ days');

    if (signals.length >= 3) {
      const lastCheckIn = lastCheckInByEmp.get(k);
      flagged.push({
        employeeId: emp.id, employeeName: emp.fullName, department: emp.department || '—',
        managerName: emp.managerId ? (managerNameMap.get(emp.managerId) || 'Unknown') : '—',
        riskSignals: signals,
        daysSinceLastCheckIn: lastCheckIn ? Math.floor((now - new Date(lastCheckIn)) / 86400000) : null,
      });
    }
  }

  return returnFunction(res, 200, true, req.locale.success, flagged);
};

const getCostPerEmployeeInsight = async (req, res) => {
  const now = new Date();
  const since3mo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  let query = knex('employees').where({ status: 'active' });
  if (req.query.department) query = query.where({ department: req.query.department });

  const employees = await query.select('id', 'fullName', 'department', 'grossPay');
  const empIds = employees.map((e) => e.id);

  const recentCycles = await knex('payroll_cycles').where('periodYear', '>=', since3mo.getFullYear()).select('id');
  const cycleIds = recentCycles.map((c) => c.id);
  const payrollResults = (cycleIds.length && empIds.length)
    ? await knex('payroll_results').whereIn('cycleId', cycleIds).whereIn('employeeId', empIds).select('employeeId', 'overtimeAmount')
    : [];
  const overtimeByEmp = new Map();
  for (const r of payrollResults) {
    overtimeByEmp.set(r.employeeId, (overtimeByEmp.get(r.employeeId) || 0) + (Number(r.overtimeAmount) || 0));
  }

  const expenseClaims = empIds.length
    ? await knex('expense_claims').whereIn('employeeId', empIds).whereIn('status', ['approved', 'reimbursed']).where('createdAt', '>=', since3mo).select('employeeId', 'amount')
    : [];
  const expensesByEmp = new Map();
  for (const c of expenseClaims) {
    expensesByEmp.set(c.employeeId, (expensesByEmp.get(c.employeeId) || 0) + (Number(c.amount) || 0));
  }

  // Training completion is tracked against users._id, not employees._id — see the
  // established enrollment.employeeId=users._id convention from the training module.
  const users = empIds.length ? await knex('users').whereIn('employeeId', empIds).select('id', 'employeeId') : [];
  const userIdByEmployee = new Map(users.map((u) => [u.employeeId, u.id]));
  const userIds = users.map((u) => u.id);
  const completedEnrollments = userIds.length
    ? await knex('enrollments').whereIn('employeeId', userIds).where({ status: 'completed' }).select('employeeId')
    : [];
  const coursesCompletedByUser = new Map();
  for (const e of completedEnrollments) {
    coursesCompletedByUser.set(e.employeeId, (coursesCompletedByUser.get(e.employeeId) || 0) + 1);
  }

  const rows = employees.map((e) => {
    const overtimeCost = overtimeByEmp.get(e.id) || 0;
    const expenseCost = expensesByEmp.get(e.id) || 0;
    const userId = userIdByEmployee.get(e.id);
    const coursesCompleted = userId ? (coursesCompletedByUser.get(userId) || 0) : 0;
    return {
      employeeId: e.id, employeeName: e.fullName, department: e.department || '—',
      baseSalary: Number(e.grossPay) || 0, overtimeCost3mo: Math.round(overtimeCost), expenseReimbursements3mo: Math.round(expenseCost),
      coursesCompleted3mo: coursesCompleted,
      // No per-course cost exists anywhere in the training module's data model — reporting
      // a fabricated constant here would misrepresent real spend, so this is left null
      // rather than invented.
      trainingCost3mo: null,
      totalCost: Math.round((Number(e.grossPay) || 0) + overtimeCost + expenseCost),
    };
  });
  rows.sort((a, b) => b.totalCost - a.totalCost);

  return returnFunction(res, 200, true, req.locale.success, rows);
};

const getDepartmentHealthInsight = async (req, res) => {
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const weekStr = startOfWeek.toISOString().slice(0, 10);

  const employees = await knex('employees').where({ status: 'active' }).select('id', 'department');
  const depts = [...new Set(employees.map((e) => e.department || 'Unassigned'))];

  const [attendanceThisWeek, reviews, openReqs, activePips, balances, allEmpsWithPay] = await Promise.all([
    knex('attendance_records').where('date', '>=', weekStr).select('employeeId', 'status'),
    knex('reviews').where({ reviewType: 'manager', status: 'submitted' }).whereNotNull('overallRating').orderBy('submittedAt', 'desc').select('employeeId', 'overallRating'),
    knex('job_requisitions').where({ status: 'open' }).select('department'),
    knex('performance_improvement_plans').where({ status: 'active' }).select('employeeId'),
    knex('leave_balances').where({ year: now.getFullYear() }).where('closingBalance', '>', 0).select('employeeId', 'closingBalance'),
    knex('employees').where({ status: 'active' }).select('id', 'department', 'grossPay'),
  ]);

  const empDeptMap = new Map(employees.map((e) => [e.id, e.department || 'Unassigned']));
  const grossPayMap = new Map(allEmpsWithPay.map((e) => [e.id, Number(e.grossPay) || 0]));

  const latestRatingByEmp = new Map();
  for (const r of reviews) {
    if (!latestRatingByEmp.has(r.employeeId)) latestRatingByEmp.set(r.employeeId, Number(r.overallRating));
  }

  const scorecard = depts.map((dept) => {
    const deptEmpIds = employees.filter((e) => (e.department || 'Unassigned') === dept).map((e) => e.id);
    const deptEmpSet = new Set(deptEmpIds);

    const deptAttendance = attendanceThisWeek.filter((a) => deptEmpSet.has(a.employeeId));
    const present = deptAttendance.filter((a) => ['present', 'remote', 'late'].includes(a.status)).length;
    const attendanceRate = deptAttendance.length ? Math.round((present / deptAttendance.length) * 100) : null;

    const deptRatings = deptEmpIds.map((id) => latestRatingByEmp.get(id)).filter((r) => r != null);
    const avgRating = deptRatings.length ? Math.round((deptRatings.reduce((a, b) => a + b, 0) / deptRatings.length) * 10) / 10 : null;

    const deptBalances = balances.filter((b) => empDeptMap.get(b.employeeId) === dept);
    const leaveLiability = Math.round(deptBalances.reduce((sum, b) => sum + Number(b.closingBalance) * ((grossPayMap.get(b.employeeId) || 0) / 22), 0));

    const openRoles = openReqs.filter((r) => r.department === dept).length;
    const activePipCount = activePips.filter((p) => deptEmpSet.has(p.employeeId)).length;

    return { department: dept, headcount: deptEmpIds.length, attendanceRate, avgPerformanceRating: avgRating, leaveLiability, openRoles, activePips: activePipCount };
  });

  return returnFunction(res, 200, true, req.locale.success, scorecard);
};

const getManagerEffectivenessInsight = async (req, res) => {
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const weekStr = startOfWeek.toISOString().slice(0, 10);
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());

  const allEmployees = await knex('employees').select('id', 'fullName', 'managerId', 'status');
  const managerIds = [...new Set(allEmployees.filter((e) => e.managerId).map((e) => e.managerId))];
  if (!managerIds.length) return returnFunction(res, 200, true, req.locale.success, []);

  const managers = await knex('employees').whereIn('id', managerIds).select('id', 'fullName');
  const managerMap = new Map(managers.map((m) => [m.id, m.fullName]));

  const [attendanceThisWeek, reviews, oneOnOnesLast30Days, terminationsLast12mo] = await Promise.all([
    knex('attendance_records').where('date', '>=', weekStr).select('employeeId', 'status'),
    knex('reviews').where({ reviewType: 'manager', status: 'submitted' }).whereNotNull('overallRating').orderBy('submittedAt', 'desc').select('employeeId', 'overallRating'),
    knex('one_on_ones').where('scheduledAt', '>=', new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())).select('managerId'),
    knex('employees').where({ status: 'terminated' }).where('terminationDate', '>=', twelveMonthsAgo).select('managerId'),
  ]);

  const latestRatingByEmp = new Map();
  for (const r of reviews) {
    if (!latestRatingByEmp.has(r.employeeId)) latestRatingByEmp.set(r.employeeId, Number(r.overallRating));
  }

  const result = managerIds.map((mgrId) => {
    const teamIds = allEmployees.filter((e) => e.managerId === mgrId).map((e) => e.id);
    const teamSet = new Set(teamIds);
    const activeTeamCount = allEmployees.filter((e) => e.managerId === mgrId && e.status === 'active').length;

    const teamAttendance = attendanceThisWeek.filter((a) => teamSet.has(a.employeeId));
    const present = teamAttendance.filter((a) => ['present', 'remote', 'late'].includes(a.status)).length;
    const teamAttendanceRate = teamAttendance.length ? Math.round((present / teamAttendance.length) * 100) : null;

    const teamRatings = teamIds.map((id) => latestRatingByEmp.get(id)).filter((r) => r != null);
    const teamAvgRating = teamRatings.length ? Math.round((teamRatings.reduce((a, b) => a + b, 0) / teamRatings.length) * 10) / 10 : null;

    const checkInsLastMonth = oneOnOnesLast30Days.filter((o) => o.managerId === mgrId).length;
    const teamTurnoverCount = terminationsLast12mo.filter((t) => t.managerId === mgrId).length;
    const teamTurnoverRate = activeTeamCount + teamTurnoverCount > 0 ? Math.round((teamTurnoverCount / (activeTeamCount + teamTurnoverCount)) * 100) : 0;

    return {
      managerId: mgrId, managerName: managerMap.get(mgrId) || 'Unknown', teamSize: activeTeamCount,
      teamAttendanceRate, teamAvgPerformanceRating: teamAvgRating,
      checkInFrequencyPerMonth: checkInsLastMonth, teamTurnoverRate12mo: teamTurnoverRate,
    };
  });

  return returnFunction(res, 200, true, req.locale.success, result);
};

module.exports.getAttritionRiskInsight = getAttritionRiskInsight;
module.exports.getCostPerEmployeeInsight = getCostPerEmployeeInsight;
module.exports.getDepartmentHealthInsight = getDepartmentHealthInsight;
module.exports.getManagerEffectivenessInsight = getManagerEffectivenessInsight;

module.exports.getExecutiveDashboard = getExecutiveDashboard;
module.exports.getExecutiveTrends = getExecutiveTrends;
module.exports.getWorkforceMovement = getWorkforceMovement;
module.exports.getPayrollBreakdown = getPayrollBreakdown;
module.exports.getPayrollOvertimeCost = getPayrollOvertimeCost;
module.exports.getLeaveLiabilityReport = getLeaveLiabilityReport;
module.exports.getLeavePatterns = getLeavePatterns;
module.exports.getPerformanceGoalsReport = getPerformanceGoalsReport;
module.exports.getPerformanceFeedbackReport = getPerformanceFeedbackReport;
module.exports.getPipReport = getPipReport;
module.exports.getRecruitmentPipeline = getRecruitmentPipeline;
module.exports.getRecruitmentFunnel = getRecruitmentFunnel;
module.exports.getTrainingCompletionByDept = getTrainingCompletionByDept;
module.exports.getTrainingEngagement = getTrainingEngagement;
module.exports.getSpendPending = getSpendPending;
module.exports.getAwardsReport = getAwardsReport;
module.exports.getITAssetsReport = getITAssetsReport;

// ── Custom Report Builder ──────────────────────────────────────────────────────
// Deliberately restricted to a fixed allowlist of sources/fields/date-fields per source —
// this runs arbitrary HR-supplied filters against real tables, so it must never accept a
// raw field name straight into a knex query (identifier interpolation is exactly the
// class of bug SQL-injection-via-column-name lives in, so every field that reaches a
// query below is checked against `allowedFields` first).

const SOURCE_CONFIG = {
  employees: {
    table: 'employees',
    dateField: 'dateOfHire',
    fields: ['fullName', 'department', 'designation', 'employmentType', 'status', 'dateOfHire', 'grossPay', 'gender', 'nationality'],
  },
  attendance: {
    table: 'attendance_records',
    dateField: 'date',
    fields: ['employeeId', 'date', 'status', 'checkInTime', 'checkOutTime'],
  },
  leave: {
    table: 'leave_requests',
    dateField: 'startDate',
    fields: ['employeeId', 'leaveTypeId', 'startDate', 'endDate', 'totalDays', 'status'],
  },
  payroll: {
    table: 'payroll_results',
    dateField: 'createdAt',
    fields: ['employeeId', 'grossPay', 'netPay', 'overtimeAmount', 'cycleId'],
  },
  performance: {
    table: 'reviews',
    dateField: 'submittedAt',
    fields: ['employeeId', 'overallRating', 'reviewType', 'status', 'submittedAt'],
  },
  expenses: {
    table: 'expense_claims',
    dateField: 'date',
    fields: ['employeeId', 'category', 'amount', 'currency', 'date', 'status'],
  },
};

// Applies one filter condition to a knex query builder — the knex equivalent of the
// old per-operator Mongo fragment builder.
const applyOperator = (query, field, operator, value) => {
  switch (operator) {
    case 'eq':       return query.where({ [field]: value });
    case 'ne':       return query.whereNot({ [field]: value });
    case 'gt':       return query.where(field, '>', value);
    case 'gte':      return query.where(field, '>=', value);
    case 'lt':       return query.where(field, '<', value);
    case 'lte':      return query.where(field, '<=', value);
    case 'in':       return query.whereIn(field, Array.isArray(value) ? value : [value]);
    case 'contains': return query.whereILike(field, `%${value}%`);
    default:         return query;
  }
};

// Runs the report definition against its primary data source and returns raw rows —
// shared by preview, full run, saved-report run, export, and the scheduled-email cron.
const runCustomReportDefinition = async (def) => {
  const primarySource = def.dataSources[0];
  const config = SOURCE_CONFIG[primarySource];
  if (!config) throw new Error(`Unknown data source: ${primarySource}`);

  const allowedFields = new Set(config.fields);
  let query = knex(config.table);

  for (const f of def.filters || []) {
    // 'department' lives on employees, not on attendance/leave/payroll/performance/expenses —
    // a filter on it against one of those sources is resolved by first finding which
    // employees match, then constraining the primary query by employeeId. This is what
    // makes "employee + attendance fields, filtered by department" actually work instead
    // of silently dropping the filter because 'department' isn't in that source's allowlist.
    if (f.field === 'department' && primarySource !== 'employees' && allowedFields.has('employeeId')) {
      const matching = await applyOperator(knex('employees'), 'department', f.operator, f.value).select('id');
      query = query.whereIn('employeeId', matching.map((e) => e.id));
      continue;
    }
    if (!allowedFields.has(f.field) || !['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'].includes(f.operator)) continue;
    query = applyOperator(query, f.field, f.operator, f.value);
  }
  if (def.dateRange?.start) query = query.where(config.dateField, '>=', new Date(def.dateRange.start));
  if (def.dateRange?.end) query = query.where(config.dateField, '<=', new Date(def.dateRange.end));

  const requestedFields = (def.fields || []).filter((f) => allowedFields.has(f));
  if (requestedFields.length) query = query.select(requestedFields); // otherwise select(*) via knex's default

  let rows = await query.limit(5000);

  // employeeId-bearing sources get department/name enrichment when 'employees' is
  // also selected — the closest thing to a join this builder supports, since a full
  // arbitrary multi-table join engine is out of scope for what HR actually needs here.
  if (primarySource !== 'employees' && def.dataSources.includes('employees') && rows.some((r) => r.employeeId)) {
    const empIds = [...new Set(rows.map((r) => r.employeeId).filter(Boolean))];
    const emps = empIds.length ? await knex('employees').whereIn('id', empIds).select('id', 'fullName', 'department') : [];
    const empMap = new Map(emps.map((e) => [e.id, e]));
    rows = rows.map((r) => ({ ...r, employeeName: empMap.get(r.employeeId)?.fullName, department: empMap.get(r.employeeId)?.department }));
  }

  if (def.groupBy && (allowedFields.has(def.groupBy) || def.groupBy === 'department')) {
    const groups = {};
    for (const row of rows) {
      const key = row[def.groupBy] ?? 'Unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(row);
    }
    return { rows, grouped: Object.entries(groups).map(([key, groupRows]) => ({ key, count: groupRows.length, rows: groupRows })) };
  }

  return { rows, grouped: null };
};

const buildCustomReport = async (req, res) => {
  if (!validateRequiredFields(req, res, ['dataSources'])) return;
  const def = {
    name: req.body.name || 'Untitled Report',
    dataSources: req.body.dataSources,
    fields: req.body.fields || [],
    filters: req.body.filters || [],
    groupBy: req.body.groupBy || null,
    dateRange: req.body.dateRange || {},
    format: req.body.format === 'csv' ? 'csv' : 'json',
  };

  const result = await runCustomReportDefinition(def);

  if (req.body.save) {
    const doc = {
      id: newId(), name: def.name, dataSources: JSON.stringify(def.dataSources), fields: JSON.stringify(def.fields),
      filters: JSON.stringify(def.filters), groupBy: def.groupBy, dateRange: JSON.stringify(def.dateRange), format: def.format,
      schedule: null, createdBy: req.user?.id ?? null, createdAt: new Date(), updatedAt: new Date(),
    };
    const [saved] = await knex('customReports').insert(doc).returning('*');
    return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id, ...result });
  }

  return returnFunction(res, 200, true, req.locale.success, result);
};

const listCustomReports = async (req, res) => {
  const reports = await knex('customReports').orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, reports);
};

const runSavedCustomReport = async (req, res) => {
  const report = await knex('customReports').where({ id: req.params.id }).first();
  if (!report) return returnFunction(res, 404, false, req.locale.notFound);
  const result = await runCustomReportDefinition(report);
  return returnFunction(res, 200, true, req.locale.success, result);
};

const scheduleCustomReport = async (req, res) => {
  if (!validateRequiredFields(req, res, ['frequency', 'recipients'])) return;
  if (!['weekly', 'monthly'].includes(req.body.frequency)) return returnFunction(res, 400, false, 'Frequency must be "weekly" or "monthly".');

  const report = await knex('customReports').where({ id: req.params.id }).first();
  if (!report) return returnFunction(res, 404, false, req.locale.notFound);

  const nextRunAt = new Date();
  nextRunAt.setDate(nextRunAt.getDate() + (req.body.frequency === 'weekly' ? 7 : 30));

  await knex('customReports').where({ id: report.id }).update({
    schedule: JSON.stringify({ frequency: req.body.frequency, recipients: req.body.recipients, lastRunAt: null, nextRunAt }),
    updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Report scheduled.');
};

const deleteCustomReport = async (req, res) => {
  await knex('customReports').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Report deleted.');
};

// ── Export (CSV / PDF) ──────────────────────────────────────────────────────────
// Generic exporter for whatever tabular data the frontend already has (a custom report's
// rows, or any of the per-domain report responses above) — mirrors the CSV-header pattern
// already used across the codebase (attendance/leave/employees/expense-claims exports).

const rowsToCSV = (rows) => {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object' || rows[0][k] === null);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => {
      const v = row[h];
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[,"\n]/.test(s) ? `"${s}"` : s;
    }).join(','));
  }
  return lines.join('\n');
};

const rowsToPDFBuffer = (title, rows) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);

  doc.fontSize(16).text(title, { align: 'left' });
  doc.moveDown();

  if (!rows.length) {
    doc.fontSize(10).text('No data for the selected report.');
    doc.end();
    return;
  }

  const headers = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object' || rows[0][k] === null);
  const colWidth = Math.max(60, Math.floor((doc.page.width - 80) / headers.length));

  doc.fontSize(9).font('Helvetica-Bold');
  headers.forEach((h, i) => doc.text(h, 40 + i * colWidth, doc.y, { width: colWidth, continued: false }));
  doc.moveDown(0.5);
  doc.font('Helvetica');

  rows.slice(0, 500).forEach((row) => {
    const y = doc.y;
    headers.forEach((h, i) => doc.text(String(row[h] ?? ''), 40 + i * colWidth, y, { width: colWidth }));
    doc.moveDown(0.3);
    if (doc.y > doc.page.height - 60) doc.addPage({ margin: 40, size: 'A4', layout: 'landscape' });
  });

  doc.end();
});

const exportReport = async (req, res) => {
  const { reportType, params, format } = req.body;
  if (!reportType || !format) return returnFunction(res, 400, false, 'reportType and format are required.');

  let rows;
  if (reportType === 'custom') {
    const result = await runCustomReportDefinition(params);
    rows = result.rows;
  } else {
    // Any of the per-domain report functions above already shape their own response —
    // for export purposes we just need the flat rows a given report already computed,
    // so the frontend passes them straight through as `params.rows` instead of this
    // endpoint re-deriving the same query a second time.
    rows = Array.isArray(params?.rows) ? params.rows : [];
  }

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${reportType}-${Date.now()}.csv"`);
    return res.send(rowsToCSV(rows));
  }
  if (format === 'pdf') {
    const buffer = await rowsToPDFBuffer(params?.title || reportType, rows);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${reportType}-${Date.now()}.pdf"`);
    return res.send(buffer);
  }
  return returnFunction(res, 400, false, 'format must be "csv" or "pdf".');
};

// Invoked by the daily cron (cronTasks.js) — checks for due schedules and emails the CSV.
const runDueScheduledReports = async () => {
  const due = await knex('customReports').whereRaw(`"schedule"->>'nextRunAt' <= ?`, [new Date().toISOString()]);
  for (const report of due) {
    try {
      const { rows } = await runCustomReportDefinition(report);
      const csv = rowsToCSV(rows);
      const nextRunAt = new Date();
      nextRunAt.setDate(nextRunAt.getDate() + (report.schedule.frequency === 'weekly' ? 7 : 30));

      await Promise.all(report.schedule.recipients.map((to) => sendEmail({
        to,
        subject: `Scheduled Report: ${report.name}`,
        html: `<p>Your scheduled report "${report.name}" is attached.</p>`,
        attachments: [{ filename: `${report.name}.csv`, content: csv, contentType: 'text/csv' }],
      })));

      await knex('customReports').where({ id: report.id }).update({
        schedule: JSON.stringify({ ...report.schedule, lastRunAt: new Date(), nextRunAt }),
        updatedAt: new Date(),
      });
    } catch (err) {
      console.error(`[CRON] scheduled report ${report.id} failed:`, err);
    }
  }
};

module.exports.buildCustomReport = buildCustomReport;
module.exports.listCustomReports = listCustomReports;
module.exports.runSavedCustomReport = runSavedCustomReport;
module.exports.scheduleCustomReport = scheduleCustomReport;
module.exports.deleteCustomReport = deleteCustomReport;
module.exports.exportReport = exportReport;
module.exports.runDueScheduledReports = runDueScheduledReports;
