const { findMany } = require('../../functions/Database/commonDBFunctions');
const returnFunction = require('../../functions/returnFunction');

// Org-wide payroll analytics — HR admin only (never exposed to employee self-service).
// Sourced entirely from closed cycles' payroll_results, so numbers only reflect payroll
// that has actually been run and distributed, not in-progress drafts.
const getPayrollAnalytics = async (req, res) => {
  const closedCycles = await findMany('payroll_cycles', { status: 'closed' }, { sort: { 'period.year': 1, 'period.month': 1 } });
  if (!closedCycles.length) {
    return returnFunction(res, 200, true, req.locale.success, {
      monthlyTrend: [], departmentBreakdown: [], topEarners: [], avgSalaryByDepartment: [],
    });
  }

  // ── Monthly trend (across all closed cycles ever run, summed per calendar month) ──
  const trendMap = {};
  for (const c of closedCycles) {
    const key = `${c.period.year}-${String(c.period.month).padStart(2, '0')}`;
    if (!trendMap[key]) trendMap[key] = { month: c.period.month, year: c.period.year, totalGross: 0, totalNet: 0 };
    trendMap[key].totalGross += c.totalGross || 0;
    trendMap[key].totalNet += c.totalNet || 0;
  }
  const monthlyTrend = Object.values(trendMap)
    .sort((a, b) => (a.year - b.year) || (a.month - b.month))
    .slice(-12);

  // ── Department breakdown / top earners / avg salary — snapshot of the most recent
  // calendar month that has closed cycle(s) ──
  const latest = closedCycles[closedCycles.length - 1];
  const latestMonthCycles = closedCycles.filter(c => c.period.month === latest.period.month && c.period.year === latest.period.year);
  const cycleIds = latestMonthCycles.map(c => c._id);
  const results = await findMany('payroll_results', { cycleId: { $in: cycleIds } }, {});

  const employeeIds = [...new Set(results.map(r => String(r.employeeId)))].map((id) => results.find(r => String(r.employeeId) === id).employeeId);
  const employees = employeeIds.length
    ? await findMany('employees', { _id: { $in: employeeIds } }, { projection: { fullName: 1, department: 1, staffNumber: 1 } })
    : [];
  const empMap = Object.fromEntries(employees.map(e => [String(e._id), e]));

  const byDept = {};
  for (const r of results) {
    const dept = empMap[String(r.employeeId)]?.department || 'Unassigned';
    if (!byDept[dept]) byDept[dept] = { department: dept, totalGross: 0, totalNet: 0, employeeCount: 0 };
    byDept[dept].totalGross += r.grossPay || 0;
    byDept[dept].totalNet += r.netPay || 0;
    byDept[dept].employeeCount += 1;
  }
  const departmentBreakdown = Object.values(byDept).sort((a, b) => b.totalGross - a.totalGross);
  const avgSalaryByDepartment = departmentBreakdown.map((d) => ({
    department: d.department,
    avgGross: Math.round((d.totalGross / d.employeeCount) * 100) / 100,
  }));

  const topEarners = results
    .map((r) => ({
      employeeId: String(r.employeeId),
      fullName: empMap[String(r.employeeId)]?.fullName || 'Unknown',
      department: empMap[String(r.employeeId)]?.department || '—',
      staffNumber: empMap[String(r.employeeId)]?.staffNumber || '—',
      netPay: r.netPay || 0,
    }))
    .sort((a, b) => b.netPay - a.netPay)
    .slice(0, 10);

  return returnFunction(res, 200, true, req.locale.success, {
    latestPeriod: { month: latest.period.month, year: latest.period.year },
    monthlyTrend, departmentBreakdown, topEarners, avgSalaryByDepartment,
  });
};

module.exports = { getPayrollAnalytics };
