const { ObjectId } = require('mongodb');
const PDFDocument = require('pdfkit');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, deleteOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
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
    enrollmentTotals,
    pendingLeave, pendingExpenses, pendingTimesheets, pendingPRs,
    probationCount, certExpiryCount, contractEndCount, pipCount,
  ] = await Promise.all([
    countDocuments('employees', {}),
    countDocuments('employees', { status: 'active' }),
    countDocuments('employees', { status: 'on_leave' }),
    countDocuments('offboarding_records', { status: { $nin: ['completed'] } }),
    countDocuments('employees', { status: 'terminated', terminationDate: { $gte: startOfMonth } }),
    countDocuments('jobRequisitions', { status: 'open' }),
    findMany('payroll_cycles', { 'period.month': month, 'period.year': year }, {}),
    findMany('payroll_cycles', { 'period.month': lastMonth, 'period.year': lastMonthYear }, {}),
    global.dbo.collection('attendance_records').aggregate([
      { $match: { date: { $gte: weekStr } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray(),
    findOne('review_cycles', { status: 'completed' }, { sort: { updatedAt: -1 }, projection: { _id: 1 } }),
    Promise.all([countDocuments('enrollments', {}), countDocuments('enrollments', { status: 'completed' })]),
    countDocuments('leave_requests', { status: 'pending' }),
    countDocuments('expense_claims', { status: 'submitted' }),
    countDocuments('timesheets', { status: 'submitted' }),
    countDocuments('purchase_requests', { status: 'pending' }),
    countDocuments('employees', { status: 'active', probationEndDate: { $gte: now, $lte: in30 } }),
    countDocuments('certificates', { expiresAt: { $gte: now, $lte: in30 } }),
    countDocuments('employees', { status: 'active', contractEndDate: { $gte: now, $lte: in30 } }),
    countDocuments('performanceImprovementPlans', { status: 'active' }),
  ]);

  const [totalEnrollments, completedEnrollments] = enrollmentTotals;

  const sumPayroll = async (cycles) => {
    const cycleIds = cycles.map((c) => c._id);
    if (!cycleIds.length) return { gross: 0, net: 0 };
    const results = await findMany('payroll_results', { cycleId: { $in: cycleIds } }, {});
    return {
      gross: results.reduce((s, r) => s + (r.grossPay || 0), 0),
      net: results.reduce((s, r) => s + (r.netPay || 0), 0),
    };
  };
  const [thisMonthPayroll, lastMonthPayroll] = await Promise.all([sumPayroll(thisMonthCycles), sumPayroll(lastMonthCyclesArr)]);

  const presentCount = weekAttendance.filter((a) => ['present', 'remote', 'late'].includes(a._id)).reduce((s, a) => s + a.count, 0);
  const totalAttRecords = weekAttendance.reduce((s, a) => s + a.count, 0);
  const attendanceRateThisWeek = totalAttRecords > 0 ? Math.round((presentCount / totalAttRecords) * 100) : 0;

  let avgPerformanceRating = null;
  if (lastCompletedCycle) {
    const reviews = await findMany('reviews', { cycleId: lastCompletedCycle._id, reviewType: 'manager', status: 'submitted', overallRating: { $ne: null } }, {});
    if (reviews.length) avgPerformanceRating = Math.round((reviews.reduce((s, r) => s + r.overallRating, 0) / reviews.length) * 10) / 10;
  }

  // Leave liability: sum of each employee's unused (positive) leave balance days × their
  // own daily rate (grossPay / 22 — same standard-working-days convention the payroll
  // engine itself uses for overtime/proration, see payrollCyclesFunctions.js).
  const balances = await findMany('leave_balances', { year, closingBalance: { $gt: 0 } }, {});
  const empIds = [...new Set(balances.map((b) => String(b.employeeId)))].map((id) => new ObjectId(id));
  const emps = empIds.length ? await findMany('employees', { _id: { $in: empIds } }, { projection: { grossPay: 1 } }) : [];
  const grossPayMap = new Map(emps.map((e) => [String(e._id), e.grossPay || 0]));
  const leaveLiability = balances.reduce((sum, b) => {
    const dailyRate = (grossPayMap.get(String(b.employeeId)) || 0) / 22;
    return sum + b.closingBalance * dailyRate;
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
    const count = await countDocuments('employees', { dateOfHire: { $lt: nextD }, $or: [{ terminationDate: null }, { terminationDate: { $gte: d } }] });
    headcountTrend.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, count });
  }

  const payrollTrend = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const cycles = await findMany('payroll_cycles', { 'period.month': d.getMonth() + 1, 'period.year': d.getFullYear() }, {});
    const cycleIds = cycles.map((c) => c._id);
    const results = cycleIds.length ? await findMany('payroll_results', { cycleId: { $in: cycleIds } }, {}) : [];
    payrollTrend.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, cost: results.reduce((s, r) => s + (r.grossPay || 0), 0) });
  }

  const attendanceTrend = [];
  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay() - i * 7);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
    const records = await global.dbo.collection('attendance_records').aggregate([
      { $match: { date: { $gte: weekStart.toISOString().slice(0, 10), $lte: weekEnd.toISOString().slice(0, 10) } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray();
    const present = records.filter((r) => ['present', 'remote', 'late'].includes(r._id)).reduce((s, r) => s + r.count, 0);
    const total = records.reduce((s, r) => s + r.count, 0);
    attendanceTrend.push({ weekStart: weekStart.toISOString().slice(0, 10), rate: total > 0 ? Math.round((present / total) * 100) : 0 });
  }

  const headcountByDept = await global.dbo.collection('employees').aggregate([
    { $match: { status: 'active' } },
    { $group: { _id: '$department', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  const now2 = new Date();
  const leaveByType = await global.dbo.collection('leave_requests').aggregate([
    { $match: { status: 'approved', startDate: { $gte: new Date(now2.getFullYear(), now2.getMonth(), 1) } } },
    { $lookup: { from: 'leave_types', localField: 'leaveTypeId', foreignField: '_id', as: 'lt' } },
    { $unwind: { path: '$lt', preserveNullAndEmptyArrays: true } },
    { $group: { _id: { $ifNull: ['$lt.name', 'Unknown'] }, days: { $sum: '$totalDays' } } },
  ]).toArray();

  return returnFunction(res, 200, true, req.locale.success, {
    headcountTrend, payrollTrend, attendanceTrend,
    headcountByDepartment: headcountByDept.map((d) => ({ department: d._id || 'Unassigned', count: d.count })),
    leaveByTypeThisMonth: leaveByType.map((l) => ({ type: l._id, days: l.days })),
  });
};

// ── Workforce: Movement (promotions/transfers/salary changes) ────────────────
// job_history is auto-logged by employeesFunctions.js on every tracked field change —
// changeType values: titleChange (proxy for promotion), departmentChange (transfer),
// managerChange, salaryChange, statusChange, termination.
const getWorkforceMovement = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const start = new Date(year, 0, 1), end = new Date(year + 1, 0, 1);

  const entries = await findMany('job_history', { effectiveDate: { $gte: start, $lt: end }, changeType: { $in: ['titleChange', 'departmentChange', 'salaryChange'] } }, { sort: { effectiveDate: -1 } });
  const empIds = [...new Set(entries.map((e) => String(e.employeeId)))].map((id) => new ObjectId(id));
  const emps = empIds.length ? await findMany('employees', { _id: { $in: empIds } }, { projection: { fullName: 1, department: 1 } }) : [];
  const empMap = new Map(emps.map((e) => [String(e._id), e]));

  const promotions = entries.filter((e) => e.changeType === 'titleChange');
  const transfers = entries.filter((e) => e.changeType === 'departmentChange');
  const salaryChanges = entries.filter((e) => e.changeType === 'salaryChange');

  const byDept = (list) => {
    const counts = {};
    for (const e of list) {
      const dept = empMap.get(String(e.employeeId))?.department || 'Unassigned';
      counts[dept] = (counts[dept] || 0) + 1;
    }
    return Object.entries(counts).map(([department, count]) => ({ department, count }));
  };

  const enrich = (list) => list.map((e) => ({
    employeeId: e.employeeId, employeeName: empMap.get(String(e.employeeId))?.fullName || 'Unknown',
    department: empMap.get(String(e.employeeId))?.department || '—',
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

  const cycles = await findMany('payroll_cycles', { 'period.month': month, 'period.year': year }, {});
  const cycleIds = cycles.map((c) => c._id);
  const results = cycleIds.length ? await findMany('payroll_results', { cycleId: { $in: cycleIds } }, {}) : [];

  const totals = results.reduce((acc, r) => {
    acc.gross += r.grossPay || 0;
    acc.paye += r.statutoryDeductions?.paye || 0;
    acc.sha += r.statutoryDeductions?.sha || 0;
    acc.nssf += r.statutoryDeductions?.nssf || 0;
    acc.ahl += r.statutoryDeductions?.ahl || 0;
    acc.otherDeductions += r.otherDeductions || 0;
    acc.net += r.netPay || 0;
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
    const cycles = await findMany('payroll_cycles', { 'period.month': d.getMonth() + 1, 'period.year': d.getFullYear() }, {});
    const cycleIds = cycles.map((c) => c._id);
    const results = cycleIds.length ? await findMany('payroll_results', { cycleId: { $in: cycleIds } }, { projection: { overtimeAmount: 1, employeeId: 1 } }) : [];
    trend.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, cost: results.reduce((s, r) => s + (r.overtimeAmount || 0), 0) });
  }

  // Current month by department
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  const cycles = await findMany('payroll_cycles', { 'period.month': d.getMonth() + 1, 'period.year': d.getFullYear() }, {});
  const cycleIds = cycles.map((c) => c._id);
  const results = cycleIds.length ? await findMany('payroll_results', { cycleId: { $in: cycleIds } }, { projection: { overtimeAmount: 1, employeeId: 1 } }) : [];
  const empIds = [...new Set(results.map((r) => String(r.employeeId)))].map((id) => new ObjectId(id));
  const emps = empIds.length ? await findMany('employees', { _id: { $in: empIds } }, { projection: { department: 1 } }) : [];
  const deptMap = new Map(emps.map((e) => [String(e._id), e.department]));
  const byDept = {};
  for (const r of results) {
    const dept = deptMap.get(String(r.employeeId)) || 'Unassigned';
    byDept[dept] = (byDept[dept] || 0) + (r.overtimeAmount || 0);
  }

  return returnFunction(res, 200, true, req.locale.success, {
    trend,
    byDepartmentThisMonth: Object.entries(byDept).map(([department, cost]) => ({ department, cost })),
  });
};

// ── Leave: Liability (dedicated, standalone view of the exec-dashboard figure) ─
const getLeaveLiabilityReport = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const balances = await findMany('leave_balances', { year, closingBalance: { $gt: 0 } }, {});
  const empIds = [...new Set(balances.map((b) => String(b.employeeId)))].map((id) => new ObjectId(id));
  const emps = empIds.length ? await findMany('employees', { _id: { $in: empIds } }, { projection: { fullName: 1, department: 1, grossPay: 1 } }) : [];
  const empMap = new Map(emps.map((e) => [String(e._id), e]));

  const byDept = {};
  const perEmployee = [];
  for (const b of balances) {
    const emp = empMap.get(String(b.employeeId));
    const dailyRate = (emp?.grossPay || 0) / 22;
    const value = b.closingBalance * dailyRate;
    const dept = emp?.department || 'Unassigned';
    if (!byDept[dept]) byDept[dept] = { department: dept, totalDays: 0, value: 0 };
    byDept[dept].totalDays += b.closingBalance;
    byDept[dept].value += value;
    perEmployee.push({ employeeId: b.employeeId, employeeName: emp?.fullName || 'Unknown', department: dept, unusedDays: b.closingBalance, value: Math.round(value) });
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
  const requests = await findMany('leave_requests', {
    status: 'approved',
    startDate: { $gte: new Date(`${year}-01-01`), $lte: new Date(`${year}-12-31T23:59:59`) },
  }, { projection: { startDate: 1, endDate: 1, totalDays: 1 } });

  const dayOfWeekCounts = [0, 0, 0, 0, 0, 0, 0]; // Sun..Sat
  const monthCounts = Array(12).fill(0);
  for (const r of requests) {
    const start = new Date(r.startDate);
    dayOfWeekCounts[start.getDay()] += 1;
    monthCounts[start.getMonth()] += r.totalDays || 1;
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
  const filter = period ? { period } : {};
  const goals = await findMany('goals', filter, { projection: { department: 1, category: 1, status: 1, progress: 1 } });

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
const getPerformanceFeedbackReport = async (req, res) => {
  const months = Math.min(parseInt(req.query.months) || 6, 12);
  const now = new Date();
  const since = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
  const feedback = await findMany('feedback', { createdAt: { $gte: since } }, { projection: { createdAt: 1, type: 1 } });

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
  const pips = await findMany('performanceImprovementPlans', {}, { sort: { createdAt: -1 } });
  const empIds = [...new Set(pips.map((p) => String(p.employeeId)))].map((id) => new ObjectId(id));
  const mgrIds = [...new Set(pips.filter((p) => p.managerId).map((p) => String(p.managerId)))].map((id) => new ObjectId(id));
  const allIds = [...new Set([...empIds, ...mgrIds])].map((id) => new ObjectId(id));
  const emps = allIds.length ? await findMany('employees', { _id: { $in: allIds } }, { projection: { fullName: 1 } }) : [];
  const empMap = new Map(emps.map((e) => [String(e._id), e.fullName]));

  const enriched = pips.map((p) => ({
    _id: p._id, employeeName: empMap.get(String(p.employeeId)) || 'Unknown', managerName: p.managerId ? (empMap.get(String(p.managerId)) || 'Unknown') : '—',
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
  const requisitions = await findMany('jobRequisitions', { status: { $in: ['open', 'pendingApproval'] } }, {});
  const requisitionIds = requisitions.map((r) => r._id);
  const applications = requisitionIds.length ? await findMany('applications', { requisitionId: { $in: requisitionIds } }, {}) : [];

  const byDept = {};
  for (const r of requisitions) {
    const dept = r.department || 'Unassigned';
    const apps = applications.filter((a) => String(a.requisitionId) === String(r._id));
    if (!byDept[dept]) byDept[dept] = { department: dept, openPositions: 0, applicants: 0 };
    byDept[dept].openPositions++;
    byDept[dept].applicants += apps.length;
  }

  const hired = await findMany('applications', { status: 'hired' }, { projection: { requisitionId: 1, updatedAt: 1 } });
  const reqMap = new Map(requisitions.map((r) => [String(r._id), r]));
  const fillTimes = hired.map((a) => {
    const req_ = reqMap.get(String(a.requisitionId));
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
  const requisitions = await findMany('jobRequisitions', {}, { projection: { pipelineStages: 1 } });
  const applications = await findMany('applications', {}, { projection: { stageHistory: 1, status: 1 } });

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
const getTrainingCompletionByDept = async (req, res) => {
  const enrollments = await findMany('enrollments', {}, { projection: { employeeId: 1, status: 1 } });
  const userIds = [...new Set(enrollments.map((e) => String(e.employeeId)))].map((id) => new ObjectId(id));
  const users = userIds.length ? await findMany('users', { _id: { $in: userIds } }, { projection: { department: 1 } }) : [];
  const deptMap = new Map(users.map((u) => [String(u._id), u.department]));

  const byDept = {};
  for (const e of enrollments) {
    const dept = deptMap.get(String(e.employeeId)) || 'Unassigned';
    if (!byDept[dept]) byDept[dept] = { department: dept, total: 0, completed: 0 };
    byDept[dept].total++;
    if (e.status === 'completed') byDept[dept].completed++;
  }
  return returnFunction(res, 200, true, req.locale.success,
    Object.values(byDept).map((d) => ({ ...d, completionRate: d.total ? Math.round((d.completed / d.total) * 100) : 0 })));
};

// ── Training: Engagement (most enrolled courses, completion trend) ────────────
const getTrainingEngagement = async (req, res) => {
  const enrollments = await findMany('enrollments', { courseId: { $ne: null } }, { projection: { courseId: 1, status: 1, createdAt: 1 } });
  const courseIds = [...new Set(enrollments.map((e) => String(e.courseId)))].map((id) => new ObjectId(id));
  const courses = courseIds.length ? await findMany('courses', { _id: { $in: courseIds } }, { projection: { title: 1 } }) : [];
  const titleMap = new Map(courses.map((c) => [String(c._id), c.title]));

  const byCourse = {};
  for (const e of enrollments) {
    const k = String(e.courseId);
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
  const [pendingExpenseClaims, pendingExpenseAmount, pendingPRs, pendingInvoices] = await Promise.all([
    countDocuments('expense_claims', { status: 'submitted' }),
    global.dbo.collection('expense_claims').aggregate([
      { $match: { status: 'submitted' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]).toArray(),
    countDocuments('purchase_requests', { status: 'pending' }),
    countDocuments('vendor_invoices', { status: { $in: ['received', 'underReview', 'matched'] } }),
  ]);

  return returnFunction(res, 200, true, req.locale.success, {
    pendingExpenseClaims: { count: pendingExpenseClaims, amount: pendingExpenseAmount[0]?.total || 0 },
    pendingPurchaseRequests: pendingPRs,
    pendingInvoiceApprovals: pendingInvoices,
  });
};

// ── Awards / IT Assets (unchanged — no duplication concern found in the audit) ─

const getAwardsReport = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const awards = await findMany('employee_awards', { year }, {});

  const byType = {}; const byDept = {}; const byEmp = {};
  for (const a of awards) {
    const t = a.awardTypeName || 'Other';
    const d = a.department || 'Unknown';
    byType[t] = (byType[t] || 0) + 1;
    byDept[d] = (byDept[d] || 0) + 1;
    const ek = String(a.employeeId);
    if (!byEmp[ek]) byEmp[ek] = { employeeName: a.employeeName, staffNumber: a.staffNumber || '—', department: d, count: 0, awards: [] };
    byEmp[ek].count++;
    byEmp[ek].awards.push(t);
  }
  const employees = Object.values(byEmp).sort((a, b) => b.count - a.count);
  return returnFunction(res, 200, true, req.locale.success, { year, summary: { total: awards.length, uniqueRecipients: employees.length }, byType, byDepartment: byDept, employees });
};

const getITAssetsReport = async (req, res) => {
  const [devices, software] = await Promise.all([
    findMany('devices', {}, {}),
    findMany('software_apps', {}, {}),
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
      const k = String(d.assignedTo);
      if (!empCache[k]) empCache[k] = await findOne('employees', { _id: d.assignedTo }, { projection: { fullName: 1, department: 1 } });
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

  const employees = await findMany('employees', { status: 'active' }, { projection: { fullName: 1, department: 1, managerId: 1 } });

  const [reviews, attendanceRecords, recentFeedback, recentOneOnOnes] = await Promise.all([
    findMany('reviews', { reviewType: 'manager', status: 'submitted', overallRating: { $ne: null } }, { sort: { submittedAt: -1 }, projection: { employeeId: 1, overallRating: 1 } }),
    findMany('attendance_records', { date: { $gte: since90Str } }, { projection: { employeeId: 1, status: 1 } }),
    findMany('feedback', { createdAt: { $gte: since60 } }, { projection: { recipientId: 1 } }),
    findMany('oneOnOnes', {}, { sort: { scheduledAt: -1 }, projection: { employeeId: 1, scheduledAt: 1 } }),
  ]);

  const latestRatingByEmp = new Map();
  for (const r of reviews) {
    const k = String(r.employeeId);
    if (!latestRatingByEmp.has(k)) latestRatingByEmp.set(k, r.overallRating);
  }
  const orgAvgRating = latestRatingByEmp.size
    ? [...latestRatingByEmp.values()].reduce((a, b) => a + b, 0) / latestRatingByEmp.size
    : null;

  const attendanceByEmp = new Map();
  for (const r of attendanceRecords) {
    const k = String(r.employeeId);
    if (!attendanceByEmp.has(k)) attendanceByEmp.set(k, { total: 0, absent: 0 });
    const entry = attendanceByEmp.get(k);
    entry.total++;
    if (r.status === 'absent') entry.absent++;
  }
  const absenceRates = [...attendanceByEmp.values()].map((e) => (e.total ? e.absent / e.total : 0));
  const orgAvgAbsenceRate = absenceRates.length ? absenceRates.reduce((a, b) => a + b, 0) / absenceRates.length : 0;

  const feedbackRecipientSet = new Set(recentFeedback.map((f) => String(f.recipientId)));

  const lastCheckInByEmp = new Map();
  for (const o of recentOneOnOnes) {
    const k = String(o.employeeId);
    if (!lastCheckInByEmp.has(k)) lastCheckInByEmp.set(k, o.scheduledAt);
  }

  const managerIds = [...new Set(employees.filter((e) => e.managerId).map((e) => String(e.managerId)))];
  const managers = managerIds.length ? await findMany('employees', { _id: { $in: managerIds.map((id) => new ObjectId(id)) } }, { projection: { fullName: 1 } }) : [];
  const managerNameMap = new Map(managers.map((m) => [String(m._id), m.fullName]));

  const flagged = [];
  for (const emp of employees) {
    const k = String(emp._id);
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
        employeeId: emp._id, employeeName: emp.fullName, department: emp.department || '—',
        managerName: emp.managerId ? (managerNameMap.get(String(emp.managerId)) || 'Unknown') : '—',
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
  const filter = { status: 'active' };
  if (req.query.department) filter.department = req.query.department;

  const employees = await findMany('employees', filter, { projection: { fullName: 1, department: 1, grossPay: 1, userId: 1 } });
  const empIds = employees.map((e) => e._id);

  const recentCycles = await findMany('payroll_cycles', { 'period.year': { $gte: since3mo.getFullYear() } }, { projection: { _id: 1 } });
  const cycleIds = recentCycles.map((c) => c._id);
  const payrollResults = cycleIds.length
    ? await findMany('payroll_results', { cycleId: { $in: cycleIds }, employeeId: { $in: empIds } }, { projection: { employeeId: 1, overtimeAmount: 1 } })
    : [];
  const overtimeByEmp = new Map();
  for (const r of payrollResults) {
    const k = String(r.employeeId);
    overtimeByEmp.set(k, (overtimeByEmp.get(k) || 0) + (r.overtimeAmount || 0));
  }

  const expenseClaims = await findMany('expense_claims', { employeeId: { $in: empIds }, status: { $in: ['approved', 'reimbursed'] }, createdAt: { $gte: since3mo } }, { projection: { employeeId: 1, amount: 1 } });
  const expensesByEmp = new Map();
  for (const c of expenseClaims) {
    const k = String(c.employeeId);
    expensesByEmp.set(k, (expensesByEmp.get(k) || 0) + (c.amount || 0));
  }

  // Training completion is tracked against users._id, not employees._id — see the
  // established enrollment.employeeId=users._id convention from the training module.
  const userIds = employees.filter((e) => e.userId).map((e) => e.userId);
  const completedEnrollments = userIds.length
    ? await findMany('enrollments', { employeeId: { $in: userIds }, status: 'completed' }, { projection: { employeeId: 1 } })
    : [];
  const coursesCompletedByUser = new Map();
  for (const e of completedEnrollments) {
    const k = String(e.employeeId);
    coursesCompletedByUser.set(k, (coursesCompletedByUser.get(k) || 0) + 1);
  }

  const rows = employees.map((e) => {
    const overtimeCost = overtimeByEmp.get(String(e._id)) || 0;
    const expenseCost = expensesByEmp.get(String(e._id)) || 0;
    const coursesCompleted = e.userId ? (coursesCompletedByUser.get(String(e.userId)) || 0) : 0;
    return {
      employeeId: e._id, employeeName: e.fullName, department: e.department || '—',
      baseSalary: e.grossPay || 0, overtimeCost3mo: Math.round(overtimeCost), expenseReimbursements3mo: Math.round(expenseCost),
      coursesCompleted3mo: coursesCompleted,
      // No per-course cost exists anywhere in the training module's data model — reporting
      // a fabricated constant here would misrepresent real spend, so this is left null
      // rather than invented.
      trainingCost3mo: null,
      totalCost: Math.round((e.grossPay || 0) + overtimeCost + expenseCost),
    };
  });
  rows.sort((a, b) => b.totalCost - a.totalCost);

  return returnFunction(res, 200, true, req.locale.success, rows);
};

const getDepartmentHealthInsight = async (req, res) => {
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const weekStr = startOfWeek.toISOString().slice(0, 10);

  const employees = await findMany('employees', { status: 'active' }, { projection: { department: 1 } });
  const depts = [...new Set(employees.map((e) => e.department || 'Unassigned'))];

  const [attendanceThisWeek, reviews, openReqs, activePips, balances, allEmpsWithPay] = await Promise.all([
    findMany('attendance_records', { date: { $gte: weekStr } }, { projection: { employeeId: 1, status: 1 } }),
    findMany('reviews', { reviewType: 'manager', status: 'submitted', overallRating: { $ne: null } }, { sort: { submittedAt: -1 }, projection: { employeeId: 1, overallRating: 1 } }),
    findMany('jobRequisitions', { status: 'open' }, { projection: { department: 1 } }),
    findMany('performanceImprovementPlans', { status: 'active' }, { projection: { employeeId: 1 } }),
    findMany('leave_balances', { year: now.getFullYear(), closingBalance: { $gt: 0 } }, { projection: { employeeId: 1, closingBalance: 1 } }),
    findMany('employees', { status: 'active' }, { projection: { department: 1, grossPay: 1 } }),
  ]);

  const empDeptMap = new Map(employees.map((e) => [String(e._id), e.department || 'Unassigned']));
  const grossPayMap = new Map(allEmpsWithPay.map((e) => [String(e._id), e.grossPay || 0]));

  const latestRatingByEmp = new Map();
  for (const r of reviews) {
    const k = String(r.employeeId);
    if (!latestRatingByEmp.has(k)) latestRatingByEmp.set(k, r.overallRating);
  }

  const scorecard = depts.map((dept) => {
    const deptEmpIds = employees.filter((e) => (e.department || 'Unassigned') === dept).map((e) => String(e._id));
    const deptEmpSet = new Set(deptEmpIds);

    const deptAttendance = attendanceThisWeek.filter((a) => deptEmpSet.has(String(a.employeeId)));
    const present = deptAttendance.filter((a) => ['present', 'remote', 'late'].includes(a.status)).length;
    const attendanceRate = deptAttendance.length ? Math.round((present / deptAttendance.length) * 100) : null;

    const deptRatings = deptEmpIds.map((id) => latestRatingByEmp.get(id)).filter((r) => r != null);
    const avgRating = deptRatings.length ? Math.round((deptRatings.reduce((a, b) => a + b, 0) / deptRatings.length) * 10) / 10 : null;

    const deptBalances = balances.filter((b) => empDeptMap.get(String(b.employeeId)) === dept);
    const leaveLiability = Math.round(deptBalances.reduce((sum, b) => sum + b.closingBalance * ((grossPayMap.get(String(b.employeeId)) || 0) / 22), 0));

    const openRoles = openReqs.filter((r) => r.department === dept).length;
    const activePipCount = activePips.filter((p) => deptEmpSet.has(String(p.employeeId))).length;

    return { department: dept, headcount: deptEmpIds.length, attendanceRate, avgPerformanceRating: avgRating, leaveLiability, openRoles, activePips: activePipCount };
  });

  return returnFunction(res, 200, true, req.locale.success, scorecard);
};

const getManagerEffectivenessInsight = async (req, res) => {
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const weekStr = startOfWeek.toISOString().slice(0, 10);
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());

  const allEmployees = await findMany('employees', {}, { projection: { fullName: 1, managerId: 1, status: 1 } });
  const managerIds = [...new Set(allEmployees.filter((e) => e.managerId).map((e) => String(e.managerId)))];
  if (!managerIds.length) return returnFunction(res, 200, true, req.locale.success, []);

  const managers = await findMany('employees', { _id: { $in: managerIds.map((id) => new ObjectId(id)) } }, { projection: { fullName: 1 } });
  const managerMap = new Map(managers.map((m) => [String(m._id), m.fullName]));

  const [attendanceThisWeek, reviews, oneOnOnesLast90Days, terminationsLast12mo] = await Promise.all([
    findMany('attendance_records', { date: { $gte: weekStr } }, { projection: { employeeId: 1, status: 1 } }),
    findMany('reviews', { reviewType: 'manager', status: 'submitted', overallRating: { $ne: null } }, { sort: { submittedAt: -1 }, projection: { employeeId: 1, overallRating: 1 } }),
    findMany('oneOnOnes', { scheduledAt: { $gte: new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()) } }, { projection: { managerId: 1 } }),
    findMany('employees', { status: 'terminated', terminationDate: { $gte: twelveMonthsAgo } }, { projection: { managerId: 1 } }),
  ]);

  const latestRatingByEmp = new Map();
  for (const r of reviews) {
    const k = String(r.employeeId);
    if (!latestRatingByEmp.has(k)) latestRatingByEmp.set(k, r.overallRating);
  }

  const result = managerIds.map((mgrId) => {
    const teamIds = allEmployees.filter((e) => String(e.managerId) === mgrId).map((e) => String(e._id));
    const teamSet = new Set(teamIds);
    const activeTeamCount = allEmployees.filter((e) => String(e.managerId) === mgrId && e.status === 'active').length;

    const teamAttendance = attendanceThisWeek.filter((a) => teamSet.has(String(a.employeeId)));
    const present = teamAttendance.filter((a) => ['present', 'remote', 'late'].includes(a.status)).length;
    const teamAttendanceRate = teamAttendance.length ? Math.round((present / teamAttendance.length) * 100) : null;

    const teamRatings = teamIds.map((id) => latestRatingByEmp.get(id)).filter((r) => r != null);
    const teamAvgRating = teamRatings.length ? Math.round((teamRatings.reduce((a, b) => a + b, 0) / teamRatings.length) * 10) / 10 : null;

    const checkInsLastMonth = oneOnOnesLast90Days.filter((o) => String(o.managerId) === mgrId).length;
    const teamTurnoverCount = terminationsLast12mo.filter((t) => String(t.managerId) === mgrId).length;
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
// this runs arbitrary HR-supplied filters against real collections, so it must never
// accept a raw field name straight into a Mongo query.

const SOURCE_CONFIG = {
  employees: {
    collection: 'employees',
    dateField: 'dateOfHire',
    fields: ['fullName', 'department', 'designation', 'employmentType', 'status', 'dateOfHire', 'grossPay', 'gender', 'nationality'],
  },
  attendance: {
    collection: 'attendance_records',
    dateField: 'date',
    fields: ['employeeId', 'date', 'status', 'checkInTime', 'checkOutTime'],
  },
  leave: {
    collection: 'leave_requests',
    dateField: 'startDate',
    fields: ['employeeId', 'leaveTypeId', 'startDate', 'endDate', 'totalDays', 'status'],
  },
  payroll: {
    collection: 'payroll_results',
    dateField: 'createdAt',
    fields: ['employeeId', 'grossPay', 'netPay', 'overtimeAmount', 'cycleId'],
  },
  performance: {
    collection: 'reviews',
    dateField: 'submittedAt',
    fields: ['employeeId', 'overallRating', 'reviewType', 'status', 'submittedAt'],
  },
  expenses: {
    collection: 'expense_claims',
    dateField: 'date',
    fields: ['employeeId', 'category', 'amount', 'currency', 'date', 'status'],
  },
};

const OPERATORS = {
  eq: (v) => v, ne: (v) => ({ $ne: v }), gt: (v) => ({ $gt: v }), gte: (v) => ({ $gte: v }),
  lt: (v) => ({ $lt: v }), lte: (v) => ({ $lte: v }), in: (v) => ({ $in: Array.isArray(v) ? v : [v] }),
  contains: (v) => ({ $regex: String(v), $options: 'i' }),
};

// Runs the report definition against its primary data source and returns raw rows —
// shared by preview, full run, saved-report run, export, and the scheduled-email cron.
const runCustomReportDefinition = async (def) => {
  const primarySource = def.dataSources[0];
  const config = SOURCE_CONFIG[primarySource];
  if (!config) throw new Error(`Unknown data source: ${primarySource}`);

  const allowedFields = new Set(config.fields);
  const filter = {};
  for (const f of def.filters || []) {
    // 'department' lives on employees, not on attendance/leave/payroll/performance/expenses —
    // a filter on it against one of those sources is resolved by first finding which
    // employees match, then constraining the primary query by employeeId. This is what
    // makes "employee + attendance fields, filtered by department" actually work instead
    // of silently dropping the filter because 'department' isn't in that source's allowlist.
    if (f.field === 'department' && primarySource !== 'employees' && allowedFields.has('employeeId')) {
      const matching = await findMany('employees', { department: OPERATORS[f.operator] ? OPERATORS[f.operator](f.value) : f.value }, { projection: { _id: 1 } });
      const ids = matching.map((e) => e._id);
      filter.employeeId = filter.employeeId ? { $in: ids.filter((id) => (filter.employeeId.$in || []).some((i) => String(i) === String(id))) } : { $in: ids };
      continue;
    }
    if (!allowedFields.has(f.field) || !OPERATORS[f.operator]) continue;
    filter[f.field] = OPERATORS[f.operator](f.value);
  }
  if (def.dateRange?.start || def.dateRange?.end) {
    filter[config.dateField] = {
      ...(def.dateRange.start ? { $gte: new Date(def.dateRange.start) } : {}),
      ...(def.dateRange.end ? { $lte: new Date(def.dateRange.end) } : {}),
    };
  }

  const requestedFields = (def.fields || []).filter((f) => allowedFields.has(f));
  const projection = requestedFields.length
    ? Object.fromEntries(requestedFields.map((f) => [f, 1]))
    : undefined;

  let rows = await findMany(config.collection, filter, projection ? { projection, limit: 5000 } : { limit: 5000 });

  // employeeId-bearing sources get department/name enrichment when 'employees' is
  // also selected — the closest thing to a join this builder supports, since a full
  // arbitrary multi-collection join engine is out of scope for what HR actually needs here.
  if (primarySource !== 'employees' && def.dataSources.includes('employees') && rows.some((r) => r.employeeId)) {
    const empIds = [...new Set(rows.map((r) => String(r.employeeId)).filter(Boolean))].map((id) => new ObjectId(id));
    const emps = empIds.length ? await findMany('employees', { _id: { $in: empIds } }, { projection: { fullName: 1, department: 1 } }) : [];
    const empMap = new Map(emps.map((e) => [String(e._id), e]));
    rows = rows.map((r) => ({ ...r, employeeName: empMap.get(String(r.employeeId))?.fullName, department: empMap.get(String(r.employeeId))?.department }));
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
    const doc = { ...def, schedule: null, createdBy: new ObjectId(req.user._id), createdAt: new Date(), updatedAt: new Date() };
    const inserted = await insertOne('customReports', doc);
    return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: inserted.insertedId, ...result });
  }

  return returnFunction(res, 200, true, req.locale.success, result);
};

const listCustomReports = async (req, res) => {
  const reports = await findMany('customReports', {}, { sort: { createdAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, reports);
};

const runSavedCustomReport = async (req, res) => {
  const report = await findOne('customReports', { _id: new ObjectId(req.params.id) });
  if (!report) return returnFunction(res, 404, false, req.locale.notFound);
  const result = await runCustomReportDefinition(report);
  return returnFunction(res, 200, true, req.locale.success, result);
};

const scheduleCustomReport = async (req, res) => {
  if (!validateRequiredFields(req, res, ['frequency', 'recipients'])) return;
  if (!['weekly', 'monthly'].includes(req.body.frequency)) return returnFunction(res, 400, false, 'Frequency must be "weekly" or "monthly".');

  const report = await findOne('customReports', { _id: new ObjectId(req.params.id) });
  if (!report) return returnFunction(res, 404, false, req.locale.notFound);

  const nextRunAt = new Date();
  nextRunAt.setDate(nextRunAt.getDate() + (req.body.frequency === 'weekly' ? 7 : 30));

  await updateOne('customReports', { _id: report._id }, {
    $set: { schedule: { frequency: req.body.frequency, recipients: req.body.recipients, lastRunAt: null, nextRunAt } },
  });
  return returnFunction(res, 200, true, 'Report scheduled.');
};

const deleteCustomReport = async (req, res) => {
  await deleteOne('customReports', { _id: new ObjectId(req.params.id) });
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
  const due = await findMany('customReports', { 'schedule.nextRunAt': { $lte: new Date() } }, {});
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

      await updateOne('customReports', { _id: report._id }, { $set: { 'schedule.lastRunAt': new Date(), 'schedule.nextRunAt': nextRunAt } });
    } catch (err) {
      console.error(`[CRON] scheduled report ${report._id} failed:`, err);
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
