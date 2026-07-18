const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateFormula, evaluateConceptAmount } = require('../src/functions/payrollConceptEvaluator');

const CTX = { basic_salary: 50000, gross_salary: 60000, adjusted_gross: 62000, hours_worked: 160 };

// ── evaluateFormula: parsing/precedence/edge cases ──────────────────────────

test('evaluateFormula: simple literal', () => {
  assert.equal(evaluateFormula('5', {}), 5);
});

test('evaluateFormula: basic arithmetic', () => {
  assert.equal(evaluateFormula('2 + 3', {}), 5);
  assert.equal(evaluateFormula('10 - 4', {}), 6);
  assert.equal(evaluateFormula('3 * 4', {}), 12);
  assert.equal(evaluateFormula('10 / 4', {}), 2.5);
});

test('evaluateFormula: multiplication/division bind tighter than addition/subtraction', () => {
  assert.equal(evaluateFormula('2 + 3 * 4', {}), 14);
  assert.equal(evaluateFormula('2 * 3 + 4', {}), 10);
  assert.equal(evaluateFormula('20 - 10 / 5', {}), 18);
});

test('evaluateFormula: parentheses override precedence', () => {
  assert.equal(evaluateFormula('(2 + 3) * 4', {}), 20);
  assert.equal(evaluateFormula('2 * (3 + 4)', {}), 14);
  assert.equal(evaluateFormula('((1 + 2) * (3 + 4))', {}), 21);
});

test('evaluateFormula: unary minus and chained unary operators', () => {
  assert.equal(evaluateFormula('-5', {}), -5);
  assert.equal(evaluateFormula('-5 + 10', {}), 5);
  assert.equal(evaluateFormula('--5', {}), 5);
  assert.equal(evaluateFormula('-(2 + 3)', {}), -5);
  assert.equal(evaluateFormula('+5', {}), 5);
});

test('evaluateFormula: resolves all four allowed variables', () => {
  assert.equal(evaluateFormula('basic_salary', CTX), 50000);
  assert.equal(evaluateFormula('gross_salary', CTX), 60000);
  assert.equal(evaluateFormula('adjusted_gross', CTX), 62000);
  assert.equal(evaluateFormula('hours_worked', CTX), 160);
});

test('evaluateFormula: realistic formula — half of basic salary plus a per-hour rate', () => {
  const result = evaluateFormula('basic_salary / 2 + hours_worked * 50', CTX);
  assert.equal(result, 50000 / 2 + 160 * 50);
});

test('evaluateFormula: unknown variable resolves to 0 with a warning, does not throw', () => {
  const warnings = [];
  const result = evaluateFormula('unknown_var + 5', {}, warnings);
  assert.equal(result, 5);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unknown variable "unknown_var"/);
});

test('evaluateFormula: division by zero resolves to 0 for that term with a warning, does not throw', () => {
  const warnings = [];
  const result = evaluateFormula('10 / 0', {}, warnings);
  assert.equal(result, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Division by zero/);
});

test('evaluateFormula: missing context value for a known variable resolves to 0', () => {
  assert.equal(evaluateFormula('basic_salary', {}), 0);
});

test('evaluateFormula: malformed input throws (caller is responsible for catching)', () => {
  assert.throws(() => evaluateFormula('2 +', {}));
  assert.throws(() => evaluateFormula('(2 + 3', {}));
  assert.throws(() => evaluateFormula('2 3', {}));
  assert.throws(() => evaluateFormula('', {}));
  assert.throws(() => evaluateFormula('2 $ 3', {}));
});

test('evaluateFormula: never uses eval or Function constructor (source scan)', () => {
  const src = require('fs').readFileSync(__dirname + '/../src/functions/payrollConceptEvaluator.js', 'utf8');
  assert.doesNotMatch(src, /\beval\s*\(/);
  assert.doesNotMatch(src, /new\s+Function\s*\(/);
});

// ── evaluateConceptAmount: per-type resolution, never throws ────────────────

test('evaluateConceptAmount: fixed type returns the assignment amount', () => {
  const { amount, warnings } = evaluateConceptAmount({ type: 'fixed' }, { amount: 5000 }, CTX);
  assert.equal(amount, 5000);
  assert.equal(warnings.length, 0);
});

test('evaluateConceptAmount: variable type returns the assignment amount', () => {
  const { amount } = evaluateConceptAmount({ type: 'variable' }, { amount: 1234.5 }, CTX);
  assert.equal(amount, 1234.5);
});

test('evaluateConceptAmount: fixed/variable with missing amount defaults to 0', () => {
  const { amount } = evaluateConceptAmount({ type: 'fixed' }, {}, CTX);
  assert.equal(amount, 0);
});

test('evaluateConceptAmount: percentage of gross_salary', () => {
  const { amount, warnings } = evaluateConceptAmount(
    { type: 'percentage', percentageOf: 'gross_salary', percentageValue: 10 }, {}, CTX
  );
  assert.equal(amount, 6000);
  assert.equal(warnings.length, 0);
});

test('evaluateConceptAmount: percentage referencing an unavailable base is 0 with a warning', () => {
  const { amount, warnings } = evaluateConceptAmount(
    { type: 'percentage', percentageOf: 'not_a_real_field', percentageValue: 10 }, {}, CTX
  );
  assert.equal(amount, 0);
  assert.equal(warnings.length, 1);
});

test('evaluateConceptAmount: formula type evaluates and floors negative results to 0', () => {
  const { amount } = evaluateConceptAmount(
    { type: 'formula', formula: 'basic_salary - gross_salary' }, {}, CTX
  );
  assert.equal(amount, 0); // 50000 - 60000 = -10000, clamped to 0
});

test('evaluateConceptAmount: formula type with no formula string is 0 with a warning', () => {
  const { amount, warnings } = evaluateConceptAmount({ type: 'formula', formula: '' }, {}, CTX);
  assert.equal(amount, 0);
  assert.equal(warnings.length, 1);
});

test('evaluateConceptAmount: malformed formula degrades to 0 with a warning, never throws', () => {
  const { amount, warnings } = evaluateConceptAmount(
    { type: 'formula', formula: '2 +' }, {}, CTX
  );
  assert.equal(amount, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Evaluation error/);
});

test('evaluateConceptAmount: bracket type applies the bracket table to the given base', () => {
  const { amount, warnings } = evaluateConceptAmount(
    { type: 'bracket', percentageOf: 'adjusted_gross', brackets: [{ limit: 30000, rate: 10 }, { limit: null, rate: 20 }] },
    {}, CTX
  );
  // 62000 adjusted_gross: 30000@10% + 32000@20% = 3000 + 6400 = 9400
  assert.equal(amount, 9400);
  assert.equal(warnings.length, 0);
});

test('evaluateConceptAmount: bracket type defaults its base to adjusted_gross when percentageOf is unset', () => {
  const { amount } = evaluateConceptAmount(
    { type: 'bracket', brackets: [{ limit: null, rate: 10 }] }, {}, CTX
  );
  assert.equal(amount, 6200); // 10% of adjusted_gross (62000)
});

test('evaluateConceptAmount: unknown type is 0 with a warning, never throws', () => {
  const { amount, warnings } = evaluateConceptAmount({ type: 'not_a_type' }, {}, CTX);
  assert.equal(amount, 0);
  assert.equal(warnings.length, 1);
});

test('evaluateConceptAmount: null/undefined concept never throws', () => {
  assert.doesNotThrow(() => evaluateConceptAmount(null, {}, CTX));
  assert.doesNotThrow(() => evaluateConceptAmount(undefined, {}, CTX));
});

// ── evaluateConceptAmount: cap / flatCredit (statutory concepts extension) ──

test('cap: percentage type clamps the raw amount before rounding', () => {
  const { amount } = evaluateConceptAmount(
    { type: 'percentage', percentageOf: 'gross_salary', percentageValue: 10, cap: 4000 }, {}, CTX
  );
  assert.equal(amount, 4000); // uncapped would be 6000
});

test('cap: percentage type is a no-op when the raw amount is under the cap', () => {
  const { amount } = evaluateConceptAmount(
    { type: 'percentage', percentageOf: 'gross_salary', percentageValue: 10, cap: 9000 }, {}, CTX
  );
  assert.equal(amount, 6000);
});

test('cap: bracket type clamps the raw amount before rounding', () => {
  const { amount } = evaluateConceptAmount(
    { type: 'bracket', percentageOf: 'adjusted_gross', brackets: [{ limit: null, rate: 10 }], cap: 5000 }, {}, CTX
  );
  assert.equal(amount, 5000); // uncapped would be 6200
});

test('flatCredit: percentage type subtracts after the raw amount is computed', () => {
  const { amount } = evaluateConceptAmount(
    { type: 'percentage', percentageOf: 'gross_salary', percentageValue: 10, flatCredit: 1500 }, {}, CTX
  );
  assert.equal(amount, 4500); // 6000 - 1500
});

test('flatCredit: floors at zero rather than going negative', () => {
  const { amount } = evaluateConceptAmount(
    { type: 'percentage', percentageOf: 'gross_salary', percentageValue: 10, flatCredit: 999999 }, {}, CTX
  );
  assert.equal(amount, 0);
});

test('flatCredit: formula type applies after the negative-floor step', () => {
  const { amount } = evaluateConceptAmount(
    { type: 'formula', formula: 'basic_salary / 10', flatCredit: 1000 }, {}, CTX
  );
  assert.equal(amount, 4000); // 50000/10=5000, minus 1000 credit
});

test('cap and flatCredit combined: cap is applied first, then credit subtracted', () => {
  const { amount } = evaluateConceptAmount(
    { type: 'percentage', percentageOf: 'gross_salary', percentageValue: 10, cap: 4000, flatCredit: 1000 }, {}, CTX
  );
  // raw 6000 -> capped to 4000 -> minus 1000 credit = 3000.
  // If credit were applied before cap it would also be 3000 here by coincidence,
  // so this case alone doesn't pin the order — the next test does.
  assert.equal(amount, 3000);
});

test('cap and flatCredit combined: order is provably cap-then-credit, not credit-then-cap', () => {
  // raw = 6000. cap-then-credit: min(6000,5500)=5500, 5500-1000=4500.
  // credit-then-cap would be: 6000-1000=5000, min(5000,5500)=5000 (different answer).
  const { amount } = evaluateConceptAmount(
    { type: 'percentage', percentageOf: 'gross_salary', percentageValue: 10, cap: 5500, flatCredit: 1000 }, {}, CTX
  );
  assert.equal(amount, 4500);
});

test('cap/flatCredit absent (every concept before this extension): behavior is byte-identical to before', () => {
  const withoutFields = evaluateConceptAmount(
    { type: 'percentage', percentageOf: 'gross_salary', percentageValue: 10 }, {}, CTX
  );
  const withNullFields = evaluateConceptAmount(
    { type: 'percentage', percentageOf: 'gross_salary', percentageValue: 10, cap: null, flatCredit: null }, {}, CTX
  );
  assert.equal(withoutFields.amount, 6000);
  assert.equal(withNullFields.amount, 6000);
});
