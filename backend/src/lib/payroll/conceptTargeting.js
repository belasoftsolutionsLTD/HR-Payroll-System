// Matches a group-scope `employee_compensations` assignment (a concept assigned to
// "everyone" / "a department" / "a job group" / "all contractors" rather than one
// specific employee — see employee_compensations.scope:'group') against an employee.

const VALID_EMPLOYMENT_TYPES = ['permanent', 'contract', 'partTime', 'intern'];

// assignment: an employee_compensations doc with scope:'group', appliesTo: {
//   type: 'all'|'department'|'jobGroup'|'employmentType',
//   departments?, jobGroupIds?, employmentTypes?,
//   excludeEmploymentTypes?: string[],  // orthogonal post-filter, any type
// }
// employee:   an employees doc — department is a plain string field, jobGroupId an
//             ObjectId, employmentType one of VALID_EMPLOYMENT_TYPES
function matchesGroupAssignment(assignment, employee) {
  const appliesTo = assignment?.appliesTo;
  if (!appliesTo) return false;

  // Applies regardless of targeting type — e.g. an "all employees" statutory assignment
  // (NSSF/SHA/AHL/PAYE) that should still exclude contractors, who are subject to
  // withholding tax instead of the full employee statutory suite.
  if (Array.isArray(appliesTo.excludeEmploymentTypes)
    && appliesTo.excludeEmploymentTypes.includes(employee?.employmentType)) {
    return false;
  }

  switch (appliesTo.type) {
    case 'all':
      return true;
    case 'department':
      return Array.isArray(appliesTo.departments) && appliesTo.departments.includes(employee?.department);
    case 'jobGroup':
      return Array.isArray(appliesTo.jobGroupIds)
        && appliesTo.jobGroupIds.map(String).includes(String(employee?.jobGroupId));
    case 'employmentType':
      return Array.isArray(appliesTo.employmentTypes)
        && appliesTo.employmentTypes.includes(employee?.employmentType);
    default:
      return false;
  }
}

module.exports = { matchesGroupAssignment, VALID_EMPLOYMENT_TYPES };
