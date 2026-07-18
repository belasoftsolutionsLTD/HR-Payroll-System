// The required go/no-go gate for the PAYE/NSSF/SHA/AHL-as-Concepts extension: builds the
// four Kenya-default statutory lines as real payroll_concepts (matching taxCalculator.js's
// KENYA_DEFAULT exactly) and asserts the Concepts-path output is byte-for-byte identical, to
// the cent, to buildCalculator(KENYA_DEFAULT)'s real output — across boundary values and a
// randomized sweep. Must stay green before any org is allowed to flip a statutoryKey on in
// production; previewConceptsEngine's per-cycle diff check is the runtime version of this
// same guarantee (see resolveStatutoryLine in payrollCyclesFunctions.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConceptPass2 } = require('../src/lib/payroll/resolveConceptPayItems');
const { buildCalculator, KENYA_DEFAULT } = require('../src/functions/taxCalculator');

const taxCalc = buildCalculator(KENYA_DEFAULT);

// Mirrors KENYA_DEFAULT.statutoryDeductions[pension].tiers exactly — a bracket concept with
// no null-limit catch-all reproduces calcStatutory's tiered_cap semantics precisely (income
// beyond the tier widths is simply never taxed further), so no explicit `cap` field is needed.
const NSSF = {
  _id: 'nssf', code: 'NSSF', name: 'NSSF', category: 'deductions', type: 'bracket',
  percentageOf: 'adjusted_gross',
  brackets: [{ limit: 7000, rate: 6 }, { limit: 29000, rate: 6 }],
  statutoryKey: 'nssf',
};
// Mirrors KENYA_DEFAULT.statutoryDeductions[health] (flat_rate, cap: null).
const SHA = {
  _id: 'sha', code: 'SHA', name: 'SHA', category: 'deductions', type: 'percentage',
  percentageOf: 'adjusted_gross', percentageValue: 2.75,
  statutoryKey: 'sha',
};
// Mirrors KENYA_DEFAULT.statutoryDeductions[housing_levy] (flat_rate, cap: null).
const AHL = {
  _id: 'ahl', code: 'AHL', name: 'Affordable Housing Levy', category: 'deductions', type: 'percentage',
  percentageOf: 'adjusted_gross', percentageValue: 1.5,
  statutoryKey: 'ahl',
};
// Mirrors KENYA_DEFAULT.incomeTax exactly: deductPensionFirst -> deductConceptCodesFromBase:
// ['NSSF'] (subtracts NSSF's already-resolved, already-rounded amount from adjusted_gross
// before bracket evaluation, same as calcIncomeTax's `gross - calcPension(gross)`);
// personalRelief -> flatCredit, subtracted after the bracket calc and floored at zero.
const PAYE = {
  _id: 'paye', code: 'PAYE', name: 'PAYE', category: 'deductions', type: 'bracket',
  percentageOf: 'adjusted_gross',
  brackets: [
    { limit: 24000,  rate: 10   },
    { limit: 8333,   rate: 25   },
    { limit: 467667, rate: 30   },
    { limit: 300000, rate: 32.5 },
    { limit: null,   rate: 35   },
  ],
  deductConceptCodesFromBase: ['NSSF'],
  flatCredit: 2400,
  statutoryKey: 'paye',
};

const conceptById = { nssf: NSSF, sha: SHA, ahl: AHL, paye: PAYE };
const individualComps = [
  { conceptId: 'nssf', category: 'deductions', amount: 0 },
  { conceptId: 'sha',  category: 'deductions', amount: 0 },
  { conceptId: 'ahl',  category: 'deductions', amount: 0 },
  { conceptId: 'paye', category: 'deductions', amount: 0 },
];
const emp = { _id: 'parity-emp', fullName: 'Parity Test Employee' };

function runConceptsEngine(adjustedGross) {
  const context = { basic_salary: adjustedGross, gross_salary: adjustedGross, adjusted_gross: adjustedGross, hours_worked: 0 };
  const result = resolveConceptPass2({ emp, individualComps, groupAssignments: [], conceptById, context, loanApplications: [] });
  assert.equal(result.warnings.length, 0, `unexpected warnings at gross=${adjustedGross}: ${result.warnings.join('; ')}`);
  return Object.fromEntries(result.statutoryItems.map((i) => [i.statutoryKey, i.amount]));
}

function assertParity(adjustedGross) {
  const concepts = runConceptsEngine(adjustedGross);
  assert.equal(concepts.nssf, taxCalc.calcPension(adjustedGross), `NSSF mismatch at gross=${adjustedGross}`);
  assert.equal(concepts.sha,  taxCalc.calcHealth(adjustedGross),  `SHA mismatch at gross=${adjustedGross}`);
  assert.equal(concepts.ahl,  taxCalc.calcHousingLevy(adjustedGross), `AHL mismatch at gross=${adjustedGross}`);
  assert.equal(concepts.paye, taxCalc.calcIncomeTax(adjustedGross), `PAYE mismatch at gross=${adjustedGross}`);
}

// ── Boundary sweep — every bracket/tier edge for all four lines, plus 0 and a few round numbers ──
const BOUNDARY_VALUES = [
  0, 1, 100,
  6999, 7000, 7001,             // NSSF tier 1 edge
  35999, 36000, 36001,          // NSSF tier 2 edge (6% of 7000 + 6% of 29000 = full width)
  23999, 24000, 24001,          // PAYE bracket 1 edge
  32332, 32333, 32334,          // PAYE bracket 2 edge (24000 + 8333)
  100000, 250000,
  499999, 500000, 500001,       // PAYE bracket 3 edge (24000 + 8333 + 467667)
  799999, 800000, 800001,       // PAYE bracket 4 edge (500000 + 300000)
  1000000, 2000000, 5000000,
];

for (const gross of BOUNDARY_VALUES) {
  test(`statutory parity at adjusted_gross=${gross} (boundary)`, () => {
    assertParity(gross);
  });
}

// ── Randomized sweep — deterministic seed so failures are reproducible ──
test('statutory parity holds across a randomized sweep of adjusted_gross values', () => {
  let seed = 42;
  const nextRandom = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 300; i++) {
    const gross = Math.round(nextRandom() * 3000000 * 100) / 100; // up to 3,000,000, cent precision
    assertParity(gross);
  }
});

test('sanity: taxCalc itself produces non-trivial output at a mid-range salary (guards against a vacuously-passing 0=0 test)', () => {
  const concepts = runConceptsEngine(100000);
  assert.ok(concepts.nssf > 0);
  assert.ok(concepts.sha > 0);
  assert.ok(concepts.ahl > 0);
  assert.ok(concepts.paye > 0);
});
