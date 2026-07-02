const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, countDocuments } = require('../../functions/Database/commonDBFunctions');

// ── Compensation by Group ─────────────────────────────────────────────────────
const getCompensationByGroup = async (req, res) => {
  const groupBy = req.query.groupBy || 'department'; // department | location | costCenter

  const employees = await findMany('employees', { status: 'active' }, {
    projection: { _id: 1, fullName: 1, department: 1, location: 1, costCenter: 1 },
  });

  const empIds = employees.map(e => e._id);

  const compensations = await findMany('employee_compensations', {
    employeeId: { $in: empIds },
    isActive: true,
    category: { $in: ['earnings', 'benefits', 'employer_contributions'] },
  });

  const compMap = {};
  compensations.forEach(c => {
    const key = String(c.employeeId);
    if (!compMap[key]) compMap[key] = { earnings: 0, benefits: 0, employer: 0 };
    if (c.category === 'earnings') compMap[key].earnings += c.amount || 0;
    if (c.category === 'benefits') compMap[key].benefits += c.amount || 0;
    if (c.category === 'employer_contributions') compMap[key].employer += c.amount || 0;
  });

  const groups = {};
  employees.forEach(emp => {
    const gKey = emp[groupBy] || 'Unassigned';
    if (!groups[gKey]) groups[gKey] = { name: gKey, headcount: 0, earnings: 0, benefits: 0, employer: 0, total: 0 };
    const c = compMap[String(emp._id)] || { earnings: 0, benefits: 0, employer: 0 };
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
  const employees = await findMany('employees', { status: 'active' }, {
    projection: { _id: 1, fullName: 1, department: 1, costCenter: 1, jobTitle: 1 },
  });

  const empIds = employees.map(e => e._id);
  const compensations = await findMany('employee_compensations', {
    employeeId: { $in: empIds },
    isActive: true,
    category: 'earnings',
  });

  const costMap = {};
  compensations.forEach(c => {
    costMap[String(c.employeeId)] = (costMap[String(c.employeeId)] || 0) + (c.amount || 0);
  });

  const centers = {};
  employees.forEach(emp => {
    const cc = emp.costCenter || 'Unassigned';
    if (!centers[cc]) centers[cc] = { name: cc, headcount: 0, totalCost: 0, departments: new Set(), employees: [] };
    centers[cc].headcount += 1;
    centers[cc].totalCost += costMap[String(emp._id)] || 0;
    if (emp.department) centers[cc].departments.add(emp.department);
    centers[cc].employees.push({ _id: emp._id, fullName: emp.fullName, department: emp.department, jobTitle: emp.jobTitle });
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
    findMany('employees', {}, {
      projection: { _id: 1, fullName: 1, department: 1, designation: 1, dateOfHire: 1, staffNumber: 1 },
      sort: { dateOfHire: -1 },
      limit: 200,
    }),
    findMany('employees', { status: { $in: ['terminated', 'resigned'] } }, {
      projection: { _id: 1, fullName: 1, department: 1, designation: 1, exitDate: 1, updatedAt: 1, staffNumber: 1, status: 1 },
      sort: { updatedAt: -1 },
      limit: 200,
    }),
  ]);

  let events = [
    ...hires.filter(e => e.dateOfHire).map(e => ({
      type: 'hire',
      date: e.dateOfHire,
      employee: { _id: e._id, fullName: e.fullName, staffNumber: e.staffNumber },
      department: e.department,
      jobTitle: e.designation,
    })),
    ...exits.map(e => ({
      type: e.status === 'terminated' ? 'termination' : 'resignation',
      date: e.exitDate || e.updatedAt,
      employee: { _id: e._id, fullName: e.fullName, staffNumber: e.staffNumber },
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

  const cycles = await findMany('payroll_cycles', { status: 'closed' }, {
    sort: { 'period.startDate': -1 },
    limit: months,
    projection: {
      _id: 1, name: 1, period: 1, status: 1,
      totals: 1, headcountProcessed: 1, closedAt: 1,
    },
  });

  cycles.sort((a, b) => new Date(a.period?.startDate) - new Date(b.period?.startDate));

  const trend = cycles.map(c => ({
    cycleId:      c._id,
    name:         c.name,
    period:       c.period,
    grossPay:     c.totals?.totalGross    ?? 0,
    netPay:       c.totals?.totalNet      ?? 0,
    deductions:   c.totals?.totalDeductions ?? 0,
    employerCost: c.totals?.totalEmployerCost ?? 0,
    headcount:    c.headcountProcessed    ?? 0,
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
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0);

  const [
    totalHeadcount,
    newHiresThisMonth,
    exitsThisMonth,
    lastCycle,
    prevCycle,
  ] = await Promise.all([
    countDocuments('employees', { status: 'active' }),
    countDocuments('employees', { dateOfHire: { $gte: startOfMonth } }),
    countDocuments('employees', {
      status: { $in: ['terminated', 'resigned'] },
      updatedAt: { $gte: startOfMonth },
    }),
    // Most recent closed payroll cycle
    global.dbo.collection('payroll_cycles').findOne(
      { status: 'closed' },
      { sort: { closedAt: -1 }, projection: { totals: 1, headcountProcessed: 1, name: 1 } }
    ),
    // Second most recent closed payroll cycle (for MoM comparison)
    global.dbo.collection('payroll_cycles').find(
      { status: 'closed' }
    ).sort({ closedAt: -1 }).skip(1).limit(1).toArray(),
  ]);

  const currentGross  = lastCycle?.totals?.totalGross ?? 0;
  const previousGross = prevCycle[0]?.totals?.totalGross ?? 0;
  const momChange     = previousGross > 0 ? ((currentGross - previousGross) / previousGross) * 100 : 0;

  return returnFunction(res, 200, true, req.locale.success, {
    totalHeadcount,
    newHiresThisMonth,
    exitsThisMonth,
    lastCycleName:    lastCycle?.name ?? null,
    currentGross,
    previousGross,
    momChangePct:     parseFloat(momChange.toFixed(1)),
  });
};

module.exports = { getWorkspaceSummary, getCompensationByGroup, getCostCenters, getWorkforceHistory, getTrends };
