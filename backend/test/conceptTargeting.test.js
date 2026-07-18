const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesGroupAssignment, VALID_EMPLOYMENT_TYPES } = require('../src/lib/payroll/conceptTargeting');

test('matchesGroupAssignment: type "all" matches every employee', () => {
  const assignment = { appliesTo: { type: 'all' } };
  assert.equal(matchesGroupAssignment(assignment, { department: 'Sales', jobGroupId: 'x' }), true);
  assert.equal(matchesGroupAssignment(assignment, {}), true);
});

test('matchesGroupAssignment: type "department" matches only listed departments', () => {
  const assignment = { appliesTo: { type: 'department', departments: ['Sales', 'Finance'] } };
  assert.equal(matchesGroupAssignment(assignment, { department: 'Sales' }), true);
  assert.equal(matchesGroupAssignment(assignment, { department: 'Engineering' }), false);
  assert.equal(matchesGroupAssignment(assignment, {}), false);
});

test('matchesGroupAssignment: type "jobGroup" matches only listed job groups, comparing as strings', () => {
  const assignment = { appliesTo: { type: 'jobGroup', jobGroupIds: ['abc123', 'def456'] } };
  assert.equal(matchesGroupAssignment(assignment, { jobGroupId: 'abc123' }), true);
  assert.equal(matchesGroupAssignment(assignment, { jobGroupId: { toString: () => 'def456' } }), true);
  assert.equal(matchesGroupAssignment(assignment, { jobGroupId: 'zzz999' }), false);
  assert.equal(matchesGroupAssignment(assignment, {}), false);
});

test('matchesGroupAssignment: missing/malformed appliesTo never throws, returns false', () => {
  assert.equal(matchesGroupAssignment({}, { department: 'Sales' }), false);
  assert.equal(matchesGroupAssignment({ appliesTo: {} }, { department: 'Sales' }), false);
  assert.equal(matchesGroupAssignment(null, { department: 'Sales' }), false);
  assert.equal(matchesGroupAssignment({ appliesTo: { type: 'department' } }, { department: 'Sales' }), false);
});

test('matchesGroupAssignment: unknown type is false, not a throw', () => {
  assert.equal(matchesGroupAssignment({ appliesTo: { type: 'nonsense' } }, {}), false);
});

// ── employmentType targeting (contractor withholding-tax extension) ────────────

test('VALID_EMPLOYMENT_TYPES matches the employees.employmentType enum used across the app', () => {
  assert.deepEqual(VALID_EMPLOYMENT_TYPES, ['permanent', 'contract', 'partTime', 'intern']);
});

test('matchesGroupAssignment: type "employmentType" matches only listed employment types', () => {
  const assignment = { appliesTo: { type: 'employmentType', employmentTypes: ['contract'] } };
  assert.equal(matchesGroupAssignment(assignment, { employmentType: 'contract' }), true);
  assert.equal(matchesGroupAssignment(assignment, { employmentType: 'permanent' }), false);
  assert.equal(matchesGroupAssignment(assignment, {}), false);
});

test('matchesGroupAssignment: excludeEmploymentTypes filters out matching employees regardless of type', () => {
  const allExceptContract = { appliesTo: { type: 'all', excludeEmploymentTypes: ['contract'] } };
  assert.equal(matchesGroupAssignment(allExceptContract, { employmentType: 'permanent' }), true);
  assert.equal(matchesGroupAssignment(allExceptContract, { employmentType: 'contract' }), false);

  const deptExceptIntern = { appliesTo: { type: 'department', departments: ['Sales'], excludeEmploymentTypes: ['intern'] } };
  assert.equal(matchesGroupAssignment(deptExceptIntern, { department: 'Sales', employmentType: 'permanent' }), true);
  assert.equal(matchesGroupAssignment(deptExceptIntern, { department: 'Sales', employmentType: 'intern' }), false);
});

test('matchesGroupAssignment: excludeEmploymentTypes absent (every assignment before this extension) changes nothing — regression', () => {
  const assignment = { appliesTo: { type: 'all' } };
  assert.equal(matchesGroupAssignment(assignment, { employmentType: 'contract' }), true);
  assert.equal(matchesGroupAssignment(assignment, {}), true);
});
