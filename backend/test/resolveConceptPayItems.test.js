const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConceptPass1, resolveConceptPass2 } = require('../src/lib/payroll/resolveConceptPayItems');

const emp = { _id: 'emp1', fullName: 'Jane Wanjiku', department: 'IT', jobGroupId: 'jg1' };
const CONTEXT = { basic_salary: 50000, gross_salary: 60000, adjusted_gross: 62000, hours_worked: 160 };

function concept(overrides) {
  return { _id: 'concept-default', name: 'Test Concept', code: 'TEST', type: 'fixed', isTaxable: true, ...overrides };
}

test('pass1: earnings fixed concept resolves with the assignment amount and taxable flag', () => {
  const c = concept({ _id: 'c1', category: 'earnings', type: 'fixed', isTaxable: true });
  const conceptById = { c1: c };
  const individualComps = [{ conceptId: 'c1', category: 'earnings', amount: 15000 }];

  const result = resolveConceptPass1({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT });
  assert.equal(result.earningsItems.length, 1);
  assert.equal(result.earningsItems[0].amount, 15000);
  assert.equal(result.earningsItems[0].isTaxable, true);
  assert.equal(result.taxableEarningsTotal, 15000);
  assert.equal(result.nonTaxableEarningsTotal, 0);
});

test('pass1: earnings percentage concept (of basic_salary) is evaluated, not read from stored amount', () => {
  const c = concept({ _id: 'c2', category: 'earnings', type: 'percentage', percentageOf: 'basic_salary', percentageValue: 10 });
  const conceptById = { c2: c };
  const individualComps = [{ conceptId: 'c2', category: 'earnings', amount: 0 }]; // stored amount irrelevant for percentage type

  const result = resolveConceptPass1({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT });
  assert.equal(result.earningsItems[0].amount, 5000); // 10% of 50000
});

test('pass1: non-taxable earnings are tracked separately from taxable', () => {
  const c = concept({ _id: 'c3', category: 'earnings', type: 'fixed', isTaxable: false });
  const conceptById = { c3: c };
  const individualComps = [{ conceptId: 'c3', category: 'earnings', amount: 2000 }];

  const result = resolveConceptPass1({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT });
  assert.equal(result.taxableEarningsTotal, 0);
  assert.equal(result.nonTaxableEarningsTotal, 2000);
});

test('pass1: deduction fixed-type resolves in pass 1', () => {
  const c = concept({ _id: 'c4', category: 'deductions', type: 'fixed' });
  const conceptById = { c4: c };
  const individualComps = [{ conceptId: 'c4', category: 'deductions', amount: 1000 }];

  const result = resolveConceptPass1({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT });
  assert.equal(result.deductionItemsPass1.length, 1);
  assert.equal(result.deductionTotalPass1, 1000);
});

test('pass1: deduction percentage/formula/bracket types are deferred to pass 2, not resolved here', () => {
  const conceptById = {
    p: concept({ _id: 'p', category: 'deductions', type: 'percentage', percentageOf: 'gross_salary', percentageValue: 5 }),
    f: concept({ _id: 'f', category: 'deductions', type: 'formula', formula: 'gross_salary * 0.02' }),
    b: concept({ _id: 'b', category: 'deductions', type: 'bracket', percentageOf: 'adjusted_gross', brackets: [{ limit: null, rate: 10 }] }),
  };
  const individualComps = [
    { conceptId: 'p', category: 'deductions', amount: 999 },
    { conceptId: 'f', category: 'deductions', amount: 999 },
    { conceptId: 'b', category: 'deductions', amount: 999 },
  ];
  const result = resolveConceptPass1({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT });
  assert.equal(result.deductionItemsPass1.length, 0);
});

test('pass1: loan-like assignment (deductions + balanceRemaining set) is skipped entirely, even if type is fixed', () => {
  const c = concept({ _id: 'loan1', category: 'deductions', subCategory: 'loans', type: 'fixed' });
  const conceptById = { loan1: c };
  const individualComps = [{ conceptId: 'loan1', category: 'deductions', amount: 5000, balanceRemaining: 20000, isActive: true, loanStatus: 'active' }];

  const result = resolveConceptPass1({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT });
  assert.equal(result.deductionItemsPass1.length, 0);
});

test('pass1: benefits and employer_contributions resolve independently', () => {
  const conceptById = {
    ben: concept({ _id: 'ben', category: 'benefits', type: 'fixed' }),
    ec: concept({ _id: 'ec', category: 'employer_contributions', type: 'fixed' }),
  };
  const individualComps = [
    { conceptId: 'ben', category: 'benefits', amount: 300 },
    { conceptId: 'ec', category: 'employer_contributions', amount: 400 },
  ];
  const result = resolveConceptPass1({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT });
  assert.equal(result.benefitsItems.length, 1);
  assert.equal(result.benefitsItems[0].amount, 300);
  assert.equal(result.employerContributionItems.length, 1);
  assert.equal(result.employerContributionTotal, 400);
});

test('pass1: group assignment matching (all/department/jobGroup) is applied per employee', () => {
  const c = concept({ _id: 'g1', category: 'deductions', type: 'fixed' });
  const conceptById = { g1: c };
  const groupAssignments = [
    { conceptId: 'g1', category: 'deductions', amount: 100, scope: 'group', appliesTo: { type: 'all' } },
    { conceptId: 'g1', category: 'deductions', amount: 200, scope: 'group', appliesTo: { type: 'department', departments: ['IT'] } },
    { conceptId: 'g1', category: 'deductions', amount: 300, scope: 'group', appliesTo: { type: 'department', departments: ['Finance'] } }, // doesn't match emp's IT
    { conceptId: 'g1', category: 'deductions', amount: 400, scope: 'group', appliesTo: { type: 'jobGroup', jobGroupIds: ['jg1'] } },
  ];
  const result = resolveConceptPass1({ emp, individualComps: [], groupAssignments, conceptById, context: CONTEXT });
  assert.equal(result.deductionItemsPass1.length, 3); // all, IT department, jg1 job group — not Finance
  assert.equal(result.deductionTotalPass1, 100 + 200 + 400);
});

test('pass1: orphaned assignment (concept missing from conceptById) is skipped, never throws', () => {
  const individualComps = [{ conceptId: 'ghost', category: 'earnings', amount: 999 }];
  assert.doesNotThrow(() => {
    const result = resolveConceptPass1({ emp, individualComps, groupAssignments: [], conceptById: {}, context: CONTEXT });
    assert.equal(result.earningsItems.length, 0);
  });
});

// ── Pass 2 ───────────────────────────────────────────────────────────────────

test('pass2: deduction percentage-type resolves against adjusted_gross context', () => {
  const c = concept({ _id: 'p2', category: 'deductions', type: 'percentage', percentageOf: 'adjusted_gross', percentageValue: 5 });
  const conceptById = { p2: c };
  const individualComps = [{ conceptId: 'p2', category: 'deductions', amount: 0 }];
  const loanApplications = [];

  const result = resolveConceptPass2({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT, loanApplications });
  assert.equal(result.deductionItemsPass2.length, 1);
  assert.equal(result.deductionItemsPass2[0].amount, 3100); // 5% of 62000
  assert.equal(loanApplications.length, 0);
});

test('pass2: fixed-type deductions are NOT re-resolved here (already handled in pass 1)', () => {
  const c = concept({ _id: 'fx', category: 'deductions', type: 'fixed' });
  const conceptById = { fx: c };
  const individualComps = [{ conceptId: 'fx', category: 'deductions', amount: 500 }];
  const result = resolveConceptPass2({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT, loanApplications: [] });
  assert.equal(result.deductionItemsPass2.length, 0);
});

test('pass2: loan installment is capped at the remaining balance, never overshoots', () => {
  const c = concept({ _id: 'loan2', category: 'deductions', subCategory: 'loans', type: 'fixed' });
  const conceptById = { loan2: c };
  const individualComps = [{ _id: 'assign1', conceptId: 'loan2', category: 'deductions', amount: 5000, balanceRemaining: 3000, isActive: true, loanStatus: 'active' }];
  const loanApplications = [];

  const result = resolveConceptPass2({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT, loanApplications });
  assert.equal(result.loanItems.length, 1);
  assert.equal(result.loanItems[0].amount, 3000); // capped, not 5000
  assert.equal(result.loanItems[0].balanceAfter, 0);
  assert.equal(loanApplications.length, 1);
  assert.equal(loanApplications[0].assignmentId, 'assign1');
  assert.equal(loanApplications[0].installmentApplied, 3000);
});

test('pass2: loan with a fully-paid balance (0) is skipped, not re-deducted', () => {
  const c = concept({ _id: 'loan3', category: 'deductions', subCategory: 'loans', type: 'fixed' });
  const conceptById = { loan3: c };
  const individualComps = [{ conceptId: 'loan3', category: 'deductions', amount: 5000, balanceRemaining: 0, isActive: false, loanStatus: 'completed' }];

  const result = resolveConceptPass2({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT, loanApplications: [] });
  assert.equal(result.loanItems.length, 0);
});

test('pass2: inactive/cancelled loan is skipped even with a positive balanceRemaining', () => {
  const c = concept({ _id: 'loan4', category: 'deductions', subCategory: 'loans', type: 'fixed' });
  const conceptById = { loan4: c };
  const individualComps = [{ conceptId: 'loan4', category: 'deductions', amount: 5000, balanceRemaining: 10000, isActive: true, loanStatus: 'cancelled' }];

  const result = resolveConceptPass2({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT, loanApplications: [] });
  assert.equal(result.loanItems.length, 0);
});

test('pass2: percentage-type loan is evaluated against context, then capped at balance', () => {
  const c = concept({ _id: 'loan5', category: 'deductions', subCategory: 'loans', type: 'percentage', percentageOf: 'adjusted_gross', percentageValue: 50 });
  const conceptById = { loan5: c };
  // 50% of 62000 = 31000, but only 10000 remains owed
  const individualComps = [{ _id: 'assign2', conceptId: 'loan5', category: 'deductions', amount: 0, balanceRemaining: 10000, isActive: true, loanStatus: 'active' }];
  const loanApplications = [];

  const result = resolveConceptPass2({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT, loanApplications });
  assert.equal(result.loanItems[0].amount, 10000);
  assert.equal(loanApplications[0].installmentApplied, 10000);
});

test('pass2: totals sum correctly across multiple items', () => {
  const conceptById = {
    p: concept({ _id: 'p', category: 'deductions', type: 'percentage', percentageOf: 'gross_salary', percentageValue: 10 }),
    loan: concept({ _id: 'loan', category: 'deductions', subCategory: 'loans', type: 'fixed' }),
  };
  const individualComps = [
    { conceptId: 'p', category: 'deductions', amount: 0 },
    { _id: 'a1', conceptId: 'loan', category: 'deductions', amount: 1000, balanceRemaining: 5000, isActive: true, loanStatus: 'active' },
  ];
  const result = resolveConceptPass2({ emp, individualComps, groupAssignments: [], conceptById, context: CONTEXT, loanApplications: [] });
  assert.equal(result.deductionTotalPass2, 6000); // 10% of 60000
  assert.equal(result.loanTotal, 1000);
});
