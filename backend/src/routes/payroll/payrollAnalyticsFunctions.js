// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 2) —
// payroll_cycles/payroll_results/employees now live in Postgres.
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');

// Org-wide payroll analytics — HR admin only (never exposed to employee self-service).
// Sourced entirely from closed cycles' payroll_results, so numbers only reflect payroll
// that has actually been run and distributed, not in-progress drafts.
const getPayrollAnalytics = async (req, res) => {
  const closedCycles = await knex('payroll_cycles').where({ status: 'closed' }).orderBy('periodYear', 'asc').orderBy('periodMonth', 'asc');
  if (!closedCycles.length) {
    return returnFunction(res, 200, true, req.locale.success, {
      monthlyTrend: [], departmentBreakdown: [], topEarners: [], avgSalaryByDepartment: [],
    });
  }

  // ── Monthly trend (across all closed cycles ever run, summed per calendar month) ──
  const trendMap = {};
  for (const c of closedCycles) {
    const key = `${c.periodYear}-${String(c.periodMonth).padStart(2, '0')}`;
    if (!trendMap[key]) trendMap[key] = { month: c.periodMonth, year: c.periodYear, totalGross: 0, totalNet: 0 };
    trendMap[key].totalGross += Number(c.totalGross) || 0;
    trendMap[key].totalNet += Number(c.totalNet) || 0;
  }
  const monthlyTrend = Object.values(trendMap)
    .sort((a, b) => (a.year - b.year) || (a.month - b.month))
    .slice(-12);

  // ── Department breakdown / top earners / avg salary — snapshot of the most recent
  // calendar month that has closed cycle(s) ──
  const latest = closedCycles[closedCycles.length - 1];
  const latestMonthCycles = closedCycles.filter(c => c.periodMonth === latest.periodMonth && c.periodYear === latest.periodYear);
  const cycleIds = latestMonthCycles.map(c => c.id);
  const results = await knex('payroll_results').whereIn('cycleId', cycleIds);

  const employeeIds = [...new Set(results.map(r => r.employeeId))];
  const employees = employeeIds.length
    ? await knex('employees').whereIn('id', employeeIds).select('id', 'fullName', 'department', 'staffNumber')
    : [];
  const empMap = Object.fromEntries(employees.map(e => [e.id, e]));

  const byDept = {};
  for (const r of results) {
    const dept = empMap[r.employeeId]?.department || 'Unassigned';
    if (!byDept[dept]) byDept[dept] = { department: dept, totalGross: 0, totalNet: 0, employeeCount: 0 };
    byDept[dept].totalGross += Number(r.grossPay) || 0;
    byDept[dept].totalNet += Number(r.netPay) || 0;
    byDept[dept].employeeCount += 1;
  }
  const departmentBreakdown = Object.values(byDept).sort((a, b) => b.totalGross - a.totalGross);
  const avgSalaryByDepartment = departmentBreakdown.map((d) => ({
    department: d.department,
    avgGross: Math.round((d.totalGross / d.employeeCount) * 100) / 100,
  }));

  const topEarners = results
    .map((r) => ({
      employeeId: r.employeeId,
      fullName: empMap[r.employeeId]?.fullName || 'Unknown',
      department: empMap[r.employeeId]?.department || '—',
      staffNumber: empMap[r.employeeId]?.staffNumber || '—',
      netPay: Number(r.netPay) || 0,
    }))
    .sort((a, b) => b.netPay - a.netPay)
    .slice(0, 10);

  return returnFunction(res, 200, true, req.locale.success, {
    latestPeriod: { month: latest.periodMonth, year: latest.periodYear },
    monthlyTrend, departmentBreakdown, topEarners, avgSalaryByDepartment,
  });
};

module.exports = { getPayrollAnalytics };
