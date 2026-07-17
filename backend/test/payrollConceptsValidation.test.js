const test = require('node:test');
const assert = require('node:assert/strict');
const { violatesEarningsCircularity, validateStatutoryFields, VALID_TYPES, SUB_CATEGORY_MAP, STATUTORY_KEYS } = require('../src/routes/payroll/payrollConceptsFunctions');

test('schema: bracket and loans sub-category exist', () => {
  assert.ok(VALID_TYPES.includes('bracket'));
  assert.ok(SUB_CATEGORY_MAP.deductions.includes('loans'));
  assert.ok(SUB_CATEGORY_MAP.earnings.includes('allowance'));
});

test('circularity: earnings + percentage of gross_salary is rejected', () => {
  assert.equal(violatesEarningsCircularity('earnings', 'percentage', 'gross_salary', null), true);
});

test('circularity: earnings + percentage of adjusted_gross is rejected', () => {
  assert.equal(violatesEarningsCircularity('earnings', 'percentage', 'adjusted_gross', null), true);
});

test('circularity: earnings + percentage of basic_salary is allowed', () => {
  assert.equal(violatesEarningsCircularity('earnings', 'percentage', 'basic_salary', null), false);
});

test('circularity: earnings + percentage with no base set is allowed (resolves to 0, not circular)', () => {
  assert.equal(violatesEarningsCircularity('earnings', 'percentage', null, null), false);
});

test('circularity: earnings + bracket with no base set defaults to adjusted_gross and IS rejected', () => {
  assert.equal(violatesEarningsCircularity('earnings', 'bracket', null, null), true);
});

test('circularity: earnings + bracket explicitly based on hours_worked is allowed', () => {
  assert.equal(violatesEarningsCircularity('earnings', 'bracket', 'hours_worked', null), false);
});

test('circularity: earnings + formula referencing gross_salary is rejected', () => {
  assert.equal(violatesEarningsCircularity('earnings', 'formula', null, 'basic_salary + gross_salary * 0.1'), true);
});

test('circularity: earnings + formula referencing only basic_salary/hours_worked is allowed', () => {
  assert.equal(violatesEarningsCircularity('earnings', 'formula', null, 'basic_salary / 2 + hours_worked * 50'), false);
});

test('circularity: deductions category may freely reference gross_salary/adjusted_gross', () => {
  assert.equal(violatesEarningsCircularity('deductions', 'percentage', 'gross_salary', null), false);
  assert.equal(violatesEarningsCircularity('deductions', 'bracket', null, null), false);
  assert.equal(violatesEarningsCircularity('deductions', 'formula', null, 'adjusted_gross * 0.05'), false);
});

test('circularity: benefits/employer_contributions may also freely reference gross', () => {
  assert.equal(violatesEarningsCircularity('benefits', 'percentage', 'adjusted_gross', null), false);
  assert.equal(violatesEarningsCircularity('employer_contributions', 'bracket', 'gross_salary', null), false);
});

test('circularity: fixed/variable types are never circular regardless of category', () => {
  assert.equal(violatesEarningsCircularity('earnings', 'fixed', 'gross_salary', null), false);
  assert.equal(violatesEarningsCircularity('earnings', 'variable', null, null), false);
});

// ── Statutory extension fields (cap / flatCredit / deductConceptCodesFromBase / statutoryKey) ──
// Only the pure, DB-free rejection paths (type-gating, which return before any findOne/findMany
// call) are covered here — the DB-dependent paths (referenced-code existence, depth-1 chaining,
// statutoryKey uniqueness) are covered by a live smoke test against a real cycle, matching this
// codebase's established pattern for anything that needs global.dbo (see the Concepts unification
// work earlier this session — no mocking convention exists here, so DB-touching logic is verified
// live rather than retrofitting a mock).

test('schema: statutory keys are exported and violatesEarningsCircularity is unaffected by the new fields', () => {
  assert.deepEqual(STATUTORY_KEYS, ['paye', 'nssf', 'sha', 'ahl']);
  // The new fields (cap/flatCredit/deductConceptCodesFromBase/statutoryKey) are never inspected
  // by violatesEarningsCircularity — its signature and logic are untouched by this extension.
  assert.equal(violatesEarningsCircularity('earnings', 'percentage', 'basic_salary', null), false);
  assert.equal(violatesEarningsCircularity('earnings', 'percentage', 'gross_salary', null), true);
});

test('validateStatutoryFields: cap rejected on fixed/variable/formula types', async () => {
  assert.match(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'fixed', cap: 100 }), /cap can only be set/i);
  assert.match(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'variable', cap: 100 }), /cap can only be set/i);
  assert.match(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'formula', cap: 100 }), /cap can only be set/i);
});

test('validateStatutoryFields: cap allowed on percentage/bracket, rejects negative', async () => {
  assert.equal(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'percentage', cap: 100 }), null);
  assert.equal(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'bracket', cap: 0 }), null);
  assert.match(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'percentage', cap: -5 }), /zero or greater/i);
});

test('validateStatutoryFields: flatCredit rejected on fixed/variable, allowed on percentage/bracket/formula', async () => {
  assert.match(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'fixed', flatCredit: 2400 }), /flat credit can only be set/i);
  assert.equal(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'percentage', flatCredit: 2400 }), null);
  assert.equal(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'bracket', flatCredit: 2400 }), null);
  assert.equal(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'formula', flatCredit: 2400 }), null);
  assert.match(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'percentage', flatCredit: -1 }), /zero or greater/i);
});

test('validateStatutoryFields: deductConceptCodesFromBase rejected outside deductions category or fixed/variable/formula type', async () => {
  assert.match(await validateStatutoryFields({ ownCode: 'X', category: 'earnings', type: 'percentage', deductConceptCodesFromBase: ['NSSF'] }), /base-amount deductions can only be set/i);
  assert.match(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'fixed', deductConceptCodesFromBase: ['NSSF'] }), /base-amount deductions can only be set/i);
});

test('validateStatutoryFields: self-reference in deductConceptCodesFromBase is rejected before any DB lookup', async () => {
  assert.match(await validateStatutoryFields({ ownCode: 'PAYE', category: 'deductions', type: 'bracket', deductConceptCodesFromBase: ['PAYE'] }), /cannot reference itself/i);
});

test('validateStatutoryFields: statutoryKey rejected outside deductions category or with an invalid value, before any DB lookup', async () => {
  assert.match(await validateStatutoryFields({ ownCode: 'X', category: 'earnings', type: 'fixed', statutoryKey: 'paye' }), /statutory key can only be set/i);
  assert.match(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'fixed', statutoryKey: 'not_a_real_key' }), /invalid statutory key/i);
});

test('validateStatutoryFields: no error when none of the statutory fields are set (every existing concept today)', async () => {
  assert.equal(await validateStatutoryFields({ ownCode: 'X', category: 'earnings', type: 'fixed' }), null);
  assert.equal(await validateStatutoryFields({ ownCode: 'X', category: 'deductions', type: 'percentage', percentageOf: 'gross_salary' }), null);
});
