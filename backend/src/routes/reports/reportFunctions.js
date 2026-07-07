const returnFunction = require('../../functions/returnFunction');
const { findOne } = require('../../functions/Database/commonDBFunctions');

function toMins(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ── Overview (headline stats across all modules) ──────────────────────────────
const getOverviewReport = async (req, res) => {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  const m     = String(month).padStart(2, '0');

  const [
    totalEmployees, activeEmployees,
    monthAttendance, allAppraisals,
    openPositions, totalApplicants,
    pendingLeave, onboardingTasks,
    monthCycles,
  ] = await Promise.all([
    global.dbo.collection('employees').countDocuments({}),
    global.dbo.collection('employees').countDocuments({ status: { $in: ['active', 'on_leave'] } }),
    global.dbo.collection('attendance_records').find({ date: { $gte: `${year}-${m}-01`, $lte: `${year}-${m}-31` } }).toArray(),
    global.dbo.collection('appraisal_records').find({}).toArray(),
    global.dbo.collection('job_positions').countDocuments({ status: 'open' }),
    global.dbo.collection('applicants').countDocuments({}),
    global.dbo.collection('leave_requests').countDocuments({ status: 'pending' }),
    global.dbo.collection('onboarding_tasks').find({}).toArray(),
    // Multiple cycles can share a month now (weekly/biweekly frequencies, off-cycle runs)
    global.dbo.collection('payroll_cycles').find({ 'period.month': month, 'period.year': year }).toArray(),
  ]);
  const cycleIds = monthCycles.map((c) => c._id);
  const monthPayroll = cycleIds.length
    ? await global.dbo.collection('payroll_results').find({ cycleId: { $in: cycleIds } }).toArray()
    : [];

  const presentCount   = monthAttendance.filter(r => ['present','remote','late'].includes(r.status)).length;
  const attendanceRate = monthAttendance.length > 0 ? Math.round((presentCount / monthAttendance.length) * 100) : 0;

  const clocked   = monthAttendance.filter(r => r.checkInTime && r.checkOutTime);
  const totalMins = clocked.reduce((s, r) => { const d = toMins(r.checkOutTime) - toMins(r.checkInTime); return s + (d > 0 ? d : 0); }, 0);
  const avgHoursPerDay = clocked.length > 0 ? parseFloat((totalMins / clocked.length / 60).toFixed(1)) : 0;

  const scored       = allAppraisals.filter(r => r.rating != null);
  const avgRating    = scored.length > 0 ? parseFloat((scored.reduce((s, r) => s + r.rating, 0) / scored.length).toFixed(1)) : 0;

  const onboardingComplete = onboardingTasks.filter(t => t.status === 'completed').length;
  const onboardingTotal    = onboardingTasks.length;

  const totalGross = monthPayroll.reduce((s, p) => s + (p.grossPay || 0), 0);
  const totalNet   = monthPayroll.reduce((s, p) => s + (p.netPay   || 0), 0);

  return returnFunction(res, 200, true, 'OK', {
    month, year,
    employees:     { total: totalEmployees, active: activeEmployees },
    attendance:    { rate: attendanceRate, avgHoursPerDay },
    appraisals:    { avgRating, total: allAppraisals.length },
    recruitment:   { openPositions, totalApplicants },
    leave:         { pendingRequests: pendingLeave },
    onboarding:    { completed: onboardingComplete, total: onboardingTotal },
    payroll:       { totalGross, totalNet, headcount: monthPayroll.length },
  });
};

// ── Attendance ────────────────────────────────────────────────────────────────
const getAttendanceReport = async (req, res) => {
  const now   = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year  = parseInt(req.query.year)  || now.getFullYear();
  const m     = String(month).padStart(2, '0');

  const records = await global.dbo.collection('attendance_records')
    .find({ date: { $gte: `${year}-${m}-01`, $lte: `${year}-${m}-31` } }).toArray();

  const grouped = {};
  for (const r of records) {
    const k = String(r.employeeId);
    if (!grouped[k]) grouped[k] = { employeeId: r.employeeId, records: [] };
    grouped[k].records.push(r);
  }

  const employees = await Promise.all(Object.values(grouped).map(async (g) => {
    const emp = await findOne('employees', { _id: g.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    let present = 0, absent = 0, late = 0, halfDay = 0, totalMins = 0;
    for (const r of g.records) {
      if (r.status === 'present' || r.status === 'remote') present++;
      else if (r.status === 'absent') absent++;
      else if (r.status === 'late') { late++; present++; }
      else if (r.status === 'half_day') halfDay++;
      if (r.checkInTime && r.checkOutTime) {
        const diff = toMins(r.checkOutTime) - toMins(r.checkInTime);
        if (diff > 0) totalMins += diff;
      }
    }
    const totalHours = parseFloat((totalMins / 60).toFixed(1));
    const avgHours   = present > 0 ? parseFloat((totalHours / present).toFixed(1)) : 0;
    return { employeeName: emp?.fullName || 'Unknown', staffNumber: emp?.staffNumber || '—', department: emp?.department || '—', present, absent, late, halfDay, totalHours, avgHours };
  }));

  employees.sort((a, b) => a.department.localeCompare(b.department) || a.employeeName.localeCompare(b.employeeName));
  return returnFunction(res, 200, true, 'OK', { month, year, employees });
};

// ── Payroll ───────────────────────────────────────────────────────────────────
const getPayrollReport = async (req, res) => {
  const now   = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year  = parseInt(req.query.year)  || now.getFullYear();

  const cycles  = await global.dbo.collection('payroll_cycles').find({ 'period.month': month, 'period.year': year }).toArray();
  const cycleIds = cycles.map((c) => c._id);
  const results = cycleIds.length ? await global.dbo.collection('payroll_results').find({ cycleId: { $in: cycleIds } }).toArray() : [];

  const employees = await Promise.all(results.map(async (s) => {
    const emp = await findOne('employees', { _id: s.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    return {
      employeeName: emp?.fullName || 'Unknown',
      staffNumber:  emp?.staffNumber || '—',
      department:   emp?.department  || '—',
      grossPay:     s.grossPay  || 0,
      netPay:       s.netPay    || 0,
      paye:         s.statutoryDeductions?.paye || 0,
      sha:          s.statutoryDeductions?.sha  || 0,
      nssf:         s.statutoryDeductions?.nssf || 0,
      paymentStatus: s.status === 'paid' ? 'paid' : 'pending',
      paidAt:       s.status === 'paid' ? s.updatedAt : null,
    };
  }));

  employees.sort((a, b) => a.department.localeCompare(b.department) || a.employeeName.localeCompare(b.employeeName));

  // Department totals
  const byDept = {};
  for (const e of employees) {
    if (!byDept[e.department]) byDept[e.department] = { gross: 0, net: 0, count: 0 };
    byDept[e.department].gross += e.grossPay;
    byDept[e.department].net   += e.netPay;
    byDept[e.department].count++;
  }

  return returnFunction(res, 200, true, 'OK', {
    month, year, employees,
    totals: {
      gross: employees.reduce((s, e) => s + e.grossPay, 0),
      net:   employees.reduce((s, e) => s + e.netPay,   0),
      paye:  employees.reduce((s, e) => s + e.paye,     0),
      headcount: employees.length,
    },
    byDepartment: byDept,
  });
};

// ── Leave ─────────────────────────────────────────────────────────────────────
const getLeaveReport = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();

  const [requests, balances] = await Promise.all([
    global.dbo.collection('leave_requests').find({
      createdAt: { $gte: new Date(`${year}-01-01`), $lte: new Date(`${year}-12-31T23:59:59`) }
    }).toArray(),
    global.dbo.collection('leave_balances').find({ year }).toArray(),
  ]);

  // Aggregate leave usage by type
  const byType = {};
  for (const r of requests) {
    if (!byType[r.leaveType]) byType[r.leaveType] = { total: 0, approved: 0, pending: 0, rejected: 0, days: 0 };
    byType[r.leaveType].total++;
    byType[r.leaveType][r.status] = (byType[r.leaveType][r.status] || 0) + 1;
    if (r.status === 'approved') byType[r.leaveType].days += r.numberOfDays || 0;
  }

  // Per-employee leave summary
  const empMap = {};
  for (const r of requests) {
    const k = String(r.employeeId);
    if (!empMap[k]) empMap[k] = { employeeId: r.employeeId, requests: [] };
    empMap[k].requests.push(r);
  }

  const employees = await Promise.all(Object.values(empMap).map(async (g) => {
    const emp = await findOne('employees', { _id: g.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    const bal = balances.find(b => String(b.employeeId) === String(g.employeeId));
    return {
      employeeName:   emp?.fullName || 'Unknown',
      staffNumber:    emp?.staffNumber || '—',
      department:     emp?.department  || '—',
      totalRequests:  g.requests.length,
      approved:       g.requests.filter(r => r.status === 'approved').length,
      pending:        g.requests.filter(r => r.status === 'pending').length,
      totalDaysTaken: g.requests.filter(r => r.status === 'approved').reduce((s, r) => s + (r.numberOfDays || 0), 0),
      annualRemaining: bal?.balances?.annual?.remaining ?? null,
      sickRemaining:   bal?.balances?.sick?.remaining   ?? null,
    };
  }));

  employees.sort((a, b) => a.department.localeCompare(b.department) || a.employeeName.localeCompare(b.employeeName));

  // Enrich individual requests with employee names for the detail view
  const empCache = {};
  const enrichedRequests = await Promise.all(requests.map(async (r) => {
    const k = String(r.employeeId);
    if (!empCache[k]) {
      empCache[k] = await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    }
    const emp = empCache[k];
    return {
      _id:          String(r._id),
      employeeName: emp?.fullName    || 'Unknown',
      staffNumber:  emp?.staffNumber || '—',
      department:   emp?.department  || '—',
      leaveType:    r.leaveType,
      startDate:    r.startDate,
      endDate:      r.endDate,
      numberOfDays: r.numberOfDays || 0,
      status:       r.status,
      reason:       r.reason || '',
      createdAt:    r.createdAt,
    };
  }));
  enrichedRequests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return returnFunction(res, 200, true, 'OK', { year, byType, employees, requests: enrichedRequests });
};

// ── Recruitment ───────────────────────────────────────────────────────────────
const getRecruitmentReport = async (req, res) => {
  const [positions, applicants] = await Promise.all([
    global.dbo.collection('job_positions').find({}).toArray(),
    global.dbo.collection('applicants').find({}).toArray(),
  ]);

  // By stage
  const byStage = {};
  for (const a of applicants) {
    const s = a.stage || 'applied';
    byStage[s] = (byStage[s] || 0) + 1;
  }

  // By position
  const byPosition = await Promise.all(positions.map(async (p) => {
    const apps = applicants.filter(a => String(a.positionApplied) === String(p._id));
    return {
      jobTitle:      p.jobTitle,
      department:    p.department,
      status:        p.status,
      openings:      p.numberOfOpenings || 0,
      filled:        p.filledCount || 0,
      applications:  apps.length,
      shortlisted:   apps.filter(a => ['shortlisted','interview_scheduled','offered'].includes(a.stage)).length,
      hired:         apps.filter(a => a.stage === 'hired').length,
    };
  }));

  byPosition.sort((a, b) => a.department.localeCompare(b.department));
  return returnFunction(res, 200, true, 'OK', {
    summary: {
      totalPositions: positions.length,
      openPositions:  positions.filter(p => p.status === 'open').length,
      filledPositions: positions.filter(p => p.status === 'filled').length,
      totalApplicants: applicants.length,
    },
    byStage,
    byPosition,
  });
};

// ── Onboarding ────────────────────────────────────────────────────────────────
const getOnboardingReport = async (req, res) => {
  const tasks = await global.dbo.collection('onboarding_tasks').find({}).toArray();

  const empMap = {};
  for (const t of tasks) {
    const k = String(t.employeeId);
    if (!empMap[k]) empMap[k] = { employeeId: t.employeeId, tasks: [] };
    empMap[k].tasks.push(t);
  }

  const employees = await Promise.all(Object.values(empMap).map(async (g) => {
    const emp = await findOne('employees', { _id: g.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1, createdAt: 1 } });
    const completed = g.tasks.filter(t => t.status === 'completed').length;
    const total     = g.tasks.length;
    const overdue   = g.tasks.filter(t => t.status !== 'completed' && t.dueDate && new Date(t.dueDate) < new Date()).length;
    return {
      employeeName: emp?.fullName || 'Unknown',
      staffNumber:  emp?.staffNumber || '—',
      department:   emp?.department  || '—',
      completed, total, overdue,
      pct: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }));

  employees.sort((a, b) => a.pct - b.pct);
  return returnFunction(res, 200, true, 'OK', employees);
};

// ── Performance ───────────────────────────────────────────────────────────────
const getPerformanceReport = async (req, res) => {
  const appraisals = await global.dbo.collection('appraisal_records').find({}).sort({ createdAt: -1 }).toArray();

  const empMap = {};
  for (const a of appraisals) {
    const k = String(a.employeeId);
    if (!empMap[k]) empMap[k] = { employeeId: a.employeeId, records: [] };
    empMap[k].records.push(a);
  }

  const employees = await Promise.all(Object.values(empMap).map(async (g) => {
    const emp = await findOne('employees', { _id: g.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    const scored   = g.records.filter(r => r.rating != null);
    const avgScore = scored.length > 0 ? parseFloat((scored.reduce((s, r) => s + r.rating, 0) / scored.length).toFixed(1)) : null;
    const latest   = g.records[0];
    return {
      employeeName: emp?.fullName || 'Unknown',
      staffNumber:  emp?.staffNumber || '—',
      department:   emp?.department  || '—',
      reviewCount:  g.records.length,
      avgScore,
      latestScore:  latest?.rating ?? null,
      latestReview: latest?.createdAt ?? null,
      reviewPeriod: latest?.reviewPeriod ?? null,
    };
  }));

  employees.sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
  return returnFunction(res, 200, true, 'OK', employees);
};

// ── Expense Claims ────────────────────────────────────────────────────────────
const getExpenseClaimsReport = async (req, res) => {
  const now   = new Date();
  const year  = parseInt(req.query.year)  || now.getFullYear();
  const month = parseInt(req.query.month) || null;

  const filter = {};
  if (month) {
    const m = String(month).padStart(2, '0');
    filter.date = { $gte: new Date(`${year}-${m}-01`), $lte: new Date(`${year}-${m}-31`) };
  } else {
    filter.date = { $gte: new Date(`${year}-01-01`), $lte: new Date(`${year}-12-31T23:59:59`) };
  }

  const claims = await global.dbo.collection('expense_claims').find(filter).toArray();

  const byStatus   = {};
  const byCategory = {};
  const empMap     = {};

  for (const c of claims) {
    const s   = c.status   || 'submitted';
    const cat = c.category || c.type || 'other';

    if (!byStatus[s])     byStatus[s]   = { count: 0, amount: 0 };
    if (!byCategory[cat]) byCategory[cat] = { count: 0, amount: 0 };
    byStatus[s].count++;   byStatus[s].amount   += c.amount || 0;
    byCategory[cat].count++; byCategory[cat].amount += c.amount || 0;

    const ek = String(c.employeeId);
    if (!empMap[ek]) empMap[ek] = { employeeId: c.employeeId, claims: [] };
    empMap[ek].claims.push(c);
  }

  const employees = await Promise.all(Object.values(empMap).map(async (g) => {
    const emp = await findOne('employees', { _id: g.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    const approved = g.claims.filter(c => c.status === 'approved');
    return {
      employeeName:   emp?.fullName    || 'Unknown',
      staffNumber:    emp?.staffNumber || '—',
      department:     emp?.department  || '—',
      totalClaims:    g.claims.length,
      approvedCount:  approved.length,
      pendingCount:   g.claims.filter(c => c.status === 'submitted').length,
      rejectedCount:  g.claims.filter(c => c.status === 'rejected').length,
      totalApproved:  approved.reduce((s, c) => s + (c.amount || 0), 0),
      totalSubmitted: g.claims.reduce((s, c) => s + (c.amount || 0), 0),
      violations:     g.claims.filter(c => c.isPolicyViolation).length,
    };
  }));
  employees.sort((a, b) => b.totalSubmitted - a.totalSubmitted);

  return returnFunction(res, 200, true, 'OK', {
    year, month,
    summary: {
      total: claims.length,
      totalAmount:    claims.reduce((s, c) => s + (c.amount || 0), 0),
      approvedAmount: claims.filter(c => c.status === 'approved').reduce((s, c) => s + (c.amount || 0), 0),
      violations:     claims.filter(c => c.isPolicyViolation).length,
      byStatus,
    },
    byCategory,
    employees,
  });
};

// ── Awards / Recognition ──────────────────────────────────────────────────────
const getAwardsReport = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();

  const awards = await global.dbo.collection('employee_awards').find({ year }).toArray();

  const byType = {};
  const byDept = {};
  const byEmp  = {};

  for (const a of awards) {
    const t = a.awardTypeName || 'Other';
    const d = a.department    || 'Unknown';
    byType[t] = (byType[t] || 0) + 1;
    byDept[d] = (byDept[d] || 0) + 1;

    const ek = String(a.employeeId);
    if (!byEmp[ek]) byEmp[ek] = { employeeName: a.employeeName, staffNumber: a.staffNumber || '—', department: d, count: 0, awards: [] };
    byEmp[ek].count++;
    byEmp[ek].awards.push(t);
  }

  const employees = Object.values(byEmp).sort((a, b) => b.count - a.count);

  return returnFunction(res, 200, true, 'OK', {
    year,
    summary: { total: awards.length, uniqueRecipients: employees.length },
    byType,
    byDepartment: byDept,
    employees,
  });
};

// ── IT Assets ─────────────────────────────────────────────────────────────────
const getITAssetsReport = async (req, res) => {
  const [devices, software] = await Promise.all([
    global.dbo.collection('devices').find({}).toArray(),
    global.dbo.collection('software_apps').find({}).toArray(),
  ]);

  const byCategory = {};
  const byStatus   = {};

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
      assigneeName = empCache[k]?.fullName   || 'Unknown';
      assigneeDept = empCache[k]?.department || '—';
    }
    return {
      name:              d.name,
      type:              d.type || 'Other',
      brand:             d.brand || '—',
      serialNumber:      d.serialNumber || '—',
      status:            d.status || 'unassigned',
      condition:         d.condition || '—',
      assigneeName,
      assigneeDepartment: assigneeDept,
      purchaseDate:      d.purchaseDate || null,
      purchasePrice:     d.purchasePrice || null,
      warrantyExpiry:    d.warrantyExpiry || null,
    };
  }));

  const softwareList = software.map(a => ({
    name:             a.name,
    category:         a.category || 'Other',
    vendor:           a.vendor || '—',
    licenseType:      a.licenseType || '—',
    totalLicenses:    a.totalLicenses || 0,
    assignedLicenses: a.assignedLicenses || 0,
    costPerLicense:   a.costPerLicense || 0,
    billingCycle:     a.billingCycle || '—',
    renewalDate:      a.renewalDate || null,
    status:           a.status || 'active',
  }));

  return returnFunction(res, 200, true, 'OK', {
    devices: {
      total:     devices.length,
      assigned:  devices.filter(d => d.assignedTo).length,
      unassigned: devices.filter(d => !d.assignedTo).length,
      byCategory, byStatus,
      list: deviceList,
    },
    software: {
      totalApps:       software.length,
      totalLicenses:   software.reduce((s, a) => s + (a.totalLicenses || 0), 0),
      usedLicenses:    software.reduce((s, a) => s + (a.assignedLicenses || 0), 0),
      list: softwareList,
    },
  });
};

// ── Spending (company-level expenses) ─────────────────────────────────────────
const getSpendingReport = async (req, res) => {
  const now   = new Date();
  const year  = parseInt(req.query.year)  || now.getFullYear();
  const month = parseInt(req.query.month) || null;

  const filter = {};
  if (month) {
    const m = String(month).padStart(2, '0');
    filter.date = { $gte: `${year}-${m}-01`, $lte: `${year}-${m}-31` };
  } else {
    filter.date = { $gte: `${year}-01-01`, $lte: `${year}-12-31` };
  }

  const expenses = await global.dbo.collection('expenses').find(filter).sort({ date: -1 }).toArray();

  const byCategory = {};
  for (const e of expenses) {
    const cat = e.category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = { count: 0, amount: 0 };
    byCategory[cat].count++;
    byCategory[cat].amount += e.amount || 0;
  }

  return returnFunction(res, 200, true, 'OK', {
    year, month,
    summary: {
      total:       expenses.length,
      totalAmount: expenses.reduce((s, e) => s + (e.amount || 0), 0),
      byCategory,
    },
    expenses: expenses.map(e => ({
      _id:           String(e._id),
      description:   e.description,
      category:      e.category || 'Other',
      amount:        e.amount || 0,
      currency:      e.currency || 'KES',
      date:          e.date,
      vendor:        e.vendor || '—',
      paymentMethod: e.paymentMethod || '—',
      recordedBy:    e.recordedBy || '—',
    })),
  });
};

// ── CSV Exports ───────────────────────────────────────────────────────────────

const exportAttendanceCSV = async (req, res) => {
  const now   = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year  = parseInt(req.query.year)  || now.getFullYear();
  const m     = String(month).padStart(2, '0');

  const records = await global.dbo.collection('attendance_records')
    .find({ date: { $gte: `${year}-${m}-01`, $lte: `${year}-${m}-31` } }).toArray();

  const grouped = {};
  for (const r of records) {
    const k = String(r.employeeId);
    if (!grouped[k]) grouped[k] = { employeeId: r.employeeId, records: [] };
    grouped[k].records.push(r);
  }

  const rows = await Promise.all(Object.values(grouped).map(async g => {
    const emp = await findOne('employees', { _id: g.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    let present = 0, absent = 0, late = 0, totalMins = 0;
    for (const r of g.records) {
      if (['present', 'remote', 'late'].includes(r.status)) present++;
      if (r.status === 'absent') absent++;
      if (r.status === 'late') late++;
      if (r.checkInTime && r.checkOutTime) {
        const diff = toMins(r.checkOutTime) - toMins(r.checkInTime);
        if (diff > 0) totalMins += diff;
      }
    }
    return [
      emp?.staffNumber ?? '', `"${(emp?.fullName ?? '').replace(/"/g, '')}"`,
      emp?.department ?? '', present, absent, late,
      parseFloat((totalMins / 60).toFixed(1)),
    ].join(',');
  }));

  const csv = ['StaffNo,Name,Department,Present,Absent,Late,TotalHours', ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${year}-${m}.csv"`);
  return res.send(csv);
};

const exportLeaveCSV = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();

  const requests = await global.dbo.collection('leave_requests')
    .find({ createdAt: { $gte: new Date(`${year}-01-01`), $lte: new Date(`${year}-12-31T23:59:59`) } })
    .sort({ createdAt: -1 }).toArray();

  const rows = await Promise.all(requests.map(async r => {
    const emp = await findOne('employees', { _id: r.employeeId }, { projection: { fullName: 1, staffNumber: 1, department: 1 } });
    return [
      emp?.staffNumber ?? '', `"${(emp?.fullName ?? '').replace(/"/g, '')}"`,
      emp?.department ?? '', r.leaveType, r.startDate, r.endDate,
      r.numberOfDays, r.status,
    ].join(',');
  }));

  const csv = ['StaffNo,Name,Department,LeaveType,StartDate,EndDate,Days,Status', ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leave-${year}.csv"`);
  return res.send(csv);
};

module.exports = {
  getOverviewReport, getAttendanceReport, getPayrollReport, getLeaveReport,
  getRecruitmentReport, getOnboardingReport, getPerformanceReport,
  getExpenseClaimsReport, getAwardsReport, getITAssetsReport, getSpendingReport,
  exportAttendanceCSV, exportLeaveCSV,
};
