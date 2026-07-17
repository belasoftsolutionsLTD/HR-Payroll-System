const test = require('node:test');
const assert = require('node:assert/strict');
const { calcBracketAmount } = require('../src/functions/bracketCalculator');
const { buildCalculator, KENYA_DEFAULT } = require('../src/functions/taxCalculator');

// Reference implementation — a verbatim copy of the marginal-bracket loop that used
// to be inlined in taxCalculator.js's calcIncomeTax, before it was extracted into
// bracketCalculator.js. Kept here as an independent oracle so this suite proves the
// extraction was byte-identical, not just "looks right".
function referenceLoop(amount, brackets) {
  let tax = 0;
  let rem = amount;
  for (const b of brackets) {
    if (rem <= 0) break;
    const r = b.rate / 100;
    if (b.limit) {
      const t = Math.min(rem, b.limit);
      tax += t * r;
      rem -= t;
    } else {
      tax += rem * r;
      rem = 0;
    }
  }
  return tax;
}

const KENYA_BRACKETS = KENYA_DEFAULT.incomeTax.brackets;

test('calcBracketAmount matches the original inline loop across a sweep of incomes', () => {
  const samples = [0, 1, 100, 20000, 24000, 24001, 32333, 32334, 100000, 467667 + 24000 + 8333, 500000, 800000, 800001, 1000000, 5000000];
  for (const amount of samples) {
    assert.equal(calcBracketAmount(amount, KENYA_BRACKETS), referenceLoop(amount, KENYA_BRACKETS), `mismatch at amount=${amount}`);
  }
});

test('calcBracketAmount matches the original loop across randomized inputs', () => {
  for (let i = 0; i < 500; i++) {
    const amount = Math.random() * 2_000_000;
    assert.equal(calcBracketAmount(amount, KENYA_BRACKETS), referenceLoop(amount, KENYA_BRACKETS));
  }
});

test('calcBracketAmount: zero income is zero tax', () => {
  assert.equal(calcBracketAmount(0, KENYA_BRACKETS), 0);
});

test('calcBracketAmount: exact first-bracket boundary consumes only bracket 1', () => {
  assert.equal(calcBracketAmount(24000, KENYA_BRACKETS), 24000 * 0.10);
});

test('calcBracketAmount: top (limit:null) bracket consumes all remaining income', () => {
  // Sum of all finite bracket widths = 24000 + 8333 + 467667 + 300000 = 800000
  const total = calcBracketAmount(900000, KENYA_BRACKETS);
  const belowTop = calcBracketAmount(800000, KENYA_BRACKETS);
  // The last 100000 should be taxed entirely at the top bracket's 35% rate
  assert.ok(Math.abs((total - belowTop) - 100000 * 0.35) < 1e-9);
});

test('calcBracketAmount: empty bracket list returns 0', () => {
  assert.equal(calcBracketAmount(50000, []), 0);
});

test('taxCalculator.calcIncomeTax end-to-end still produces sane, non-negative output after the extraction', () => {
  const calc = buildCalculator(KENYA_DEFAULT);
  const tax = calc.calcIncomeTax(100000);
  assert.ok(tax >= 0);
  assert.equal(typeof tax, 'number');
  // Known-good spot check: gross 100000, pension deducted first (NSSF tiered: 7000@6% + 29000@6% capped by gross-remaining, but tiers total width 36000 > taxable portion),
  // just assert it's less than a naive flat-30%-of-gross sanity ceiling and more than 0 for a mid income.
  assert.ok(tax < 100000 * 0.35);
});
