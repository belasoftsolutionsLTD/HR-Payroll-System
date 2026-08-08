// Postgres migration (Phase 10 cross-cutting sweep) — this whole file was still reading
// Mongo via commonDBFunctions/global.dbo even though employees (Phase 1), payroll_cycles
// (Phase 2), and employee_compensations (Phase 2) have all been Postgres for many phases —
// every /api/finance/workspace/* endpoint had been silently serving stale, frozen Mongo
// data (a pre-existing bug of the same class reportFunctions.js's `feedback` staleness
// was, just never caught until this sweep). Rewritten against the real schema: employees
// has no `jobTitle`/`exitDate` columns (uses `designation`/`terminationDate` instead —
// the original Mongo field names never actually existed on this collection either, so
// those two fields were always undefined even before Postgres). payroll_cycles' `totals`
// object was flattened into totalGross/totalDeductions/totalNet/totalEmployerCost columns
// back in Phase 2, and `headcountProcessed` is `employeeCount`.
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');

// ── Compensation by Group ─────────────────────────────────────────────────────
const getCompensationByGroup = async (req, res) => {
  const groupBy = ['department', 'location', 'costCenter'].includes(req.query.groupBy) ? req.query.groupBy : 'department';

  const employees = await knex('employees').where({ status: 'active' }).select('id', 'fullName', 'department', 'location', 'costCenter');
  const empIds = employees.map(e => e.id);

  const compensations = empIds.length
    ? await knex('employee_compensations').whereIn('employeeId', empIds).where({ isActive: true })
        .whereIn('category', ['earnings', 'benefits', 'employer_contributions'])
    : [];

  const compMap = {};
  compensations.forEach(c => {
    if (!compMap[c.employeeId]) compMap[c.employeeId] = { earnings: 0, benefits: 0, employer: 0 };
    if (c.category === 'earnings') compMap[c.employeeId].earnings += Number(c.amount) || 0;
    if (c.category === 'benefits') compMap[c.employeeId].benefits += Number(c.amount) || 0;
    if (c.category === 'employer_contributions') compMap[c.employeeId].employer += Number(c.amount) || 0;
  });

  const groups = {};
  employees.forEach(emp => {
    const gKey = emp[groupBy] || 'Unassigned';
    if (!groups[gKey]) groups[gKey] = { name: gKey, headcount: 0, earnings: 0, benefits: 0, employer: 0, total: 0 };
    const c = compMap[emp.id] || { earnings: 0, benefits: 0, employer: 0 };
    groups[gKey].headcount += 1;
    groups[gKey].earnings  += c.earnings;
    groups[gKey].benefits  += c.benefits;
    groups[gKey].employer  += c.employer;
    groups[gKey].total     += c.earnings + c.benefits + c.employer;
  });

  const result = Object.values(groups).sort((a, b) => b.total - a.total);
  return returnFunction(res, 200, true, req.locale.success, result);
};

// ── Cost Centers ──────────────────────────────────────────────────────────────
const getCostCenters = async (req, res) => {
  const employees = await knex('employees').where({ status: 'active' }).select('id', 'fullName', 'department', 'costCenter', 'designation');
  const empIds = employees.map(e => e.id);

  const compensations = empIds.length
    ? await knex('employee_compensations').whereIn('employeeId', empIds).where({ isActive: true, category: 'earnings' })
    : [];

  const costMap = {};
  compensations.forEach(c => {
    costMap[c.employeeId] = (costMap[c.employeeId] || 0) + (Number(c.amount) || 0);
  });

  const centers = {};
  employees.forEach(emp => {
    const cc = emp.costCenter || 'Unassigned';
    if (!centers[cc]) centers[cc] = { name: cc, headcount: 0, totalCost: 0, departments: new Set(), employees: [] };
    centers[cc].headcount += 1;
    centers[cc].totalCost += costMap[emp.id] || 0;
    if (emp.department) centers[cc].departments.add(emp.department);
    centers[cc].employees.push({ _id: emp.id, fullName: emp.fullName, department: emp.department, jobTitle: emp.designation });
  });

  const result = Object.values(centers).map(c => ({
    ...c,
    departments: Array.from(c.departments),
    avgCost: c.headcount > 0 ? Math.round(c.totalCost / c.headcount) : 0,
  })).sort((a, b) => b.totalCost - a.totalCost);

  return returnFunction(res, 200, true, req.locale.success, result);
};

// ── Workforce History ─────────────────────────────────────────────────────────
const getWorkforceHistory = async (req, res) => {
  const limit  = parseInt(req.query.limit) || 50;
  const skip   = (parseInt(req.query.page) - 1 || 0) * limit;
  const type   = req.query.type; // 'hire' | 'termination' | 'resignation'

  const [hires, exits] = await Promise.all([
    knex('employees').whereNotNull('dateOfHire').select('id', 'fullName', 'department', 'designation', 'dateOfHire', 'staffNumber')
      .orderBy('dateOfHire', 'desc').limit(200),
    knex('employees').whereIn('status', ['terminated', 'resigned']).select('id', 'fullName', 'department', 'designation', 'terminationDate', 'updatedAt', 'staffNumber', 'status')
      .orderBy('updatedAt', 'desc').limit(200),
  ]);

  let events = [
    ...hires.map(e => ({
      type: 'hire',
      date: e.dateOfHire,
      employee: { _id: e.id, fullName: e.fullName, staffNumber: e.staffNumber },
      department: e.department,
      jobTitle: e.designation,
    })),
    ...exits.map(e => ({
      type: e.status === 'terminated' ? 'termination' : 'resignation',
      date: e.terminationDate || e.updatedAt,
      employee: { _id: e.id, fullName: e.fullName, staffNumber: e.staffNumber },
      department: e.department,
      jobTitle: e.designation,
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  if (type) events = events.filter(e => e.type === type);

  return returnFunction(res, 200, true, req.locale.success, events.slice(skip, skip + limit));
};

// ── Payroll Trends ────────────────────────────────────────────────────────────
const getTrends = async (req, res) => {
  const months = parseInt(req.query.months) || 12;

  const cycles = await knex('payroll_cycles').where({ status: 'closed' })
    .orderBy('periodStartDate', 'desc').limit(months)
    .select('id', 'name', 'periodMonth', 'periodYear', 'periodStartDate', 'status', 'totalGross', 'totalNet', 'totalDeductions', 'totalEmployerCost', 'employeeCount', 'closedAt');

  cycles.sort((a, b) => new Date(a.periodStartDate) - new Date(b.periodStartDate));

  const trend = cycles.map(c => ({
    cycleId:      c.id,
    name:         c.name,
    period:       { month: c.periodMonth, year: c.periodYear },
    grossPay:     Number(c.totalGross) || 0,
    netPay:       Number(c.totalNet) || 0,
    deductions:   Number(c.totalDeductions) || 0,
    employerCost: Number(c.totalEmployerCost) || 0,
    headcount:    c.employeeCount || 0,
  }));

  const avgGross    = trend.length ? trend.reduce((s, t) => s + t.grossPay, 0) / trend.length : 0;
  const avgNet      = trend.length ? trend.reduce((s, t) => s + t.netPay, 0) / trend.length : 0;
  const totalAnnual = trend.reduce((s, t) => s + t.grossPay, 0);

  return returnFunction(res, 200, true, req.locale.success, { trend, avgGross, avgNet, totalAnnual });
};

// ── Workspace Summary ─────────────────────────────────────────────────────────
const getWorkspaceSummary = async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    [{ count: totalHeadcount }],
    [{ count: newHiresThisMonth }],
    [{ count: exitsThisMonth }],
    recentClosedCycles,
  ] = await Promise.all([
    knex('employees').where({ status: 'active' }).count('* as count'),
    knex('employees').where('dateOfHire', '>=', startOfMonth).count('* as count'),
    knex('employees').whereIn('status', ['terminated', 'resigned']).where('updatedAt', '>=', startOfMonth).count('* as count'),
    // Two most recent closed cycles — for the current-vs-previous month-over-month comparison.
    knex('payroll_cycles').where({ status: 'closed' }).orderBy('closedAt', 'desc').limit(2)
      .select('name', 'totalGross'),
  ]);

  const [lastCycle, prevCycle] = recentClosedCycles;
  const currentGross  = Number(lastCycle?.totalGross) || 0;
  const previousGross = Number(prevCycle?.totalGross) || 0;
  const momChange     = previousGross > 0 ? ((currentGross - previousGross) / previousGross) * 100 : 0;

  return returnFunction(res, 200, true, req.locale.success, {
    totalHeadcount: Number(totalHeadcount),
    newHiresThisMonth: Number(newHiresThisMonth),
    exitsThisMonth: Number(exitsThisMonth),
    lastCycleName:    lastCycle?.name ?? null,
    currentGross,
    previousGross,
    momChangePct:     parseFloat(momChange.toFixed(1)),
  });
};

module.exports = { getWorkspaceSummary, getCompensationByGroup, getCostCenters, getWorkforceHistory, getTrends };
