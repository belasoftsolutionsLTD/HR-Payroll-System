const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLegacyPass1, resolveLegacyPass2, matchesJobGroup } = require('../src/lib/payroll/resolveLegacyPayItems');

// ── Reference implementations — verbatim copies of the inline logic in
// payrollCyclesFunctions.js's lockCycleInternal, kept here as an independent oracle so
// this suite proves the extraction is byte-for-byte identical, not just "looks right". ──

function referenceMatchesJobGroup(def, emp) {
  return !def.jobGroupIds || def.jobGroupIds.length === 0 || def.jobGroupIds.map(String).includes(String(emp.jobGroupId));
}

function referencePass1(emp, jobGroupAllowanceDefs, jobGroupDeductionDefs) {
  const jgAllowanceItems = jobGroupAllowanceDefs.filter(d => referenceMatchesJobGroup(d, emp)).map(d => ({
    conceptId: null, conceptName: d.name, conceptCode: 'JG-ALW', subCategory: 'fixed_pay',
    amount: d.amount || 0, isTaxable: d.isTaxable !== false, source: 'job_group',
  }));
  const taxableJgAllowanceTotal    = jgAllowanceItems.filter(i => i.isTaxable).reduce((s, i) => s + i.amount, 0);
  const nonTaxableJgAllowanceTotal = jgAllowanceItems.filter(i => !i.isTaxable).reduce((s, i) => s + i.amount, 0);

  const jgDeductionDefsForEmp = jobGroupDeductionDefs.filter(d => referenceMatchesJobGroup(d, emp));
  const jgFixedDeductionItems = jgDeductionDefsForEmp.filter(d => d.type !== 'percentage').map(d => ({
    conceptId: null, conceptName: d.name, conceptCode: 'JG-DED', subCategory: 'other_withholding',
    amount: d.amount || 0, source: 'job_group',
  }));
  const jgFixedDeductionTotal = jgFixedDeductionItems.reduce((s, i) => s + i.amount, 0);

  return { jgAllowanceItems, taxableJgAllowanceTotal, nonTaxableJgAllowanceTotal, jgFixedDeductionItems, jgFixedDeductionTotal };
}

function referencePass2(emp, jobGroupDeductionDefs, adjustedGross, activeLoans) {
  const jgDeductionDefsForEmp = jobGroupDeductionDefs.filter(d => referenceMatchesJobGroup(d, emp));
  const jgPercentageDeductionItems = jgDeductionDefsForEmp.filter(d => d.type === 'percentage').map(d => ({
    conceptId: null, conceptName: d.name, conceptCode: 'JG-DED', subCategory: 'other_withholding',
    amount: Math.round(adjustedGross * (d.percentage || 0) / 100 * 100) / 100, source: 'job_group',
  }));
  const jgPercentageDeductionTotal = jgPercentageDeductionItems.reduce((s, i) => s + i.amount, 0);

  const loanDeductionItems = activeLoans.map((loan) => {
    const installmentApplied = Math.min(loan.monthlyInstallment, loan.balanceRemaining);
    return {
      conceptId: null, conceptName: loan.loanType || 'Staff Loan', conceptCode: 'LOAN', subCategory: 'other_withholding',
      amount: installmentApplied, source: 'loan', loanId: loan._id,
      balanceAfter: Math.round((loan.balanceRemaining - installmentApplied) * 100) / 100,
    };
  }).filter((i) => i.amount > 0);
  const loanDeductionTotal = loanDeductionItems.reduce((s, i) => s + i.amount, 0);

  return { jgPercentageDeductionItems, jgPercentageDeductionTotal, loanDeductionItems, loanDeductionTotal };
}

const emp = { _id: 'emp1', jobGroupId: 'jg1' };

test('matchesJobGroup matches the reference implementation', () => {
  assert.equal(matchesJobGroup({ jobGroupIds: [] }, emp), referenceMatchesJobGroup({ jobGroupIds: [] }, emp));
  assert.equal(matchesJobGroup({ jobGroupIds: ['jg1'] }, emp), referenceMatchesJobGroup({ jobGroupIds: ['jg1'] }, emp));
  assert.equal(matchesJobGroup({ jobGroupIds: ['jg2'] }, emp), referenceMatchesJobGroup({ jobGroupIds: ['jg2'] }, emp));
  assert.equal(matchesJobGroup({}, emp), referenceMatchesJobGroup({}, emp));
});

test('resolveLegacyPass1 matches the reference implementation exactly', () => {
  const jobGroupAllowanceDefs = [
    { name: 'Housing', amount: 8000, isTaxable: true, jobGroupIds: [] },
    { name: 'Medical', amount: 3000, isTaxable: false, jobGroupIds: ['jg1'] },
    { name: 'Other Grade Only', amount: 5000, isTaxable: true, jobGroupIds: ['jg2'] },
  ];
  const jobGroupDeductionDefs = [
    { name: 'Union Dues', amount: 500, type: 'fixed', jobGroupIds: [] },
    { name: 'Percent One', percentage: 3, type: 'percentage', jobGroupIds: [] },
  ];

  const result = resolveLegacyPass1({ emp, jobGroupAllowanceDefs, jobGroupDeductionDefs });
  const ref = referencePass1(emp, jobGroupAllowanceDefs, jobGroupDeductionDefs);
  assert.deepEqual(result, ref);
});

test('resolveLegacyPass2 matches the reference implementation exactly', async () => {
  const jobGroupDeductionDefs = [
    { name: 'Union Dues', amount: 500, type: 'fixed', jobGroupIds: [] },
    { name: 'Percent One', percentage: 3, type: 'percentage', jobGroupIds: [] },
  ];
  const activeLoans = [
    { _id: 'loan1', loanType: 'Staff Loan', monthlyInstallment: 5000, balanceRemaining: 3000 },
    { _id: 'loan2', loanType: 'Salary Advance', monthlyInstallment: 1000, balanceRemaining: 5000 },
  ];
  const adjustedGross = 62000;

  const result = await resolveLegacyPass2({
    emp, jobGroupDeductionDefs, adjustedGross,
    findStaffLoansForEmployee: async () => activeLoans,
  });
  const ref = referencePass2(emp, jobGroupDeductionDefs, adjustedGross, activeLoans);
  assert.deepEqual(result, ref);
});

test('resolveLegacyPass1: empty defs produce empty/zero results, matching reference', () => {
  const result = resolveLegacyPass1({ emp, jobGroupAllowanceDefs: [], jobGroupDeductionDefs: [] });
  const ref = referencePass1(emp, [], []);
  assert.deepEqual(result, ref);
});
