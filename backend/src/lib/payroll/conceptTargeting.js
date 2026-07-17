// Generalizes the job-group-only matching that job-group-scoped Allowances/Deductions
// used to have (`matchesJobGroup` in payrollCyclesFunctions.js) to also handle 'all'
// and 'department' targeting, for group-scope `employee_compensations` assignments
// (concepts assigned to "everyone" / "a department" / "a job group" rather than one
// specific employee — see employee_compensations.scope:'group').

// assignment: an employee_compensations doc with scope:'group',
//             appliesTo: { type: 'all'|'department'|'jobGroup', departments?, jobGroupIds? }
// employee:   an employees doc — department is a plain string field, jobGroupId an ObjectId
function matchesGroupAssignment(assignment, employee) {
  const appliesTo = assignment?.appliesTo;
  if (!appliesTo) return false;

  switch (appliesTo.type) {
    case 'all':
      return true;
    case 'department':
      return Array.isArray(appliesTo.departments) && appliesTo.departments.includes(employee?.department);
    case 'jobGroup':
      return Array.isArray(appliesTo.jobGroupIds)
        && appliesTo.jobGroupIds.map(String).includes(String(employee?.jobGroupId));
    default:
      return false;
  }
}

module.exports = { matchesGroupAssignment };
