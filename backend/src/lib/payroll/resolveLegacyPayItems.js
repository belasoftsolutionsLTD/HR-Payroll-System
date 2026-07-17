// A faithful extraction of the legacy job-group Allowances/Deductions + staff_loans
// resolution logic that lives inline in lockCycleInternal (payrollCyclesFunctions.js).
// This is NOT wired into the live lock path — lockCycleInternal's own inline legacy
// code is untouched and remains the system of record when the unified engine is off.
// This module exists solely so the preview-concepts-engine endpoint can compute a
// legacy-equivalent result to diff against the new engine, without duplicating (and
// risking drift in) hand-copied logic inside the route handler itself.
//
// See test/resolveLegacyPayItems.test.js for a byte-for-byte comparison against the
// exact inline logic this was extracted from.

function matchesJobGroup(def, emp) {
  return !def.jobGroupIds || def.jobGroupIds.length === 0 || def.jobGroupIds.map(String).includes(String(emp.jobGroupId));
}

// ── Pass 1 — job-group allowances (taxable/non-taxable split) + fixed job-group deductions ──
function resolveLegacyPass1({ emp, jobGroupAllowanceDefs, jobGroupDeductionDefs }) {
  const jgAllowanceItems = jobGroupAllowanceDefs.filter((d) => matchesJobGroup(d, emp)).map((d) => ({
    conceptId: null, conceptName: d.name, conceptCode: 'JG-ALW', subCategory: 'fixed_pay',
    amount: d.amount || 0, isTaxable: d.isTaxable !== false, source: 'job_group',
  }));
  const taxableJgAllowanceTotal    = jgAllowanceItems.filter((i) => i.isTaxable).reduce((s, i) => s + i.amount, 0);
  const nonTaxableJgAllowanceTotal = jgAllowanceItems.filter((i) => !i.isTaxable).reduce((s, i) => s + i.amount, 0);

  const jgDeductionDefsForEmp = jobGroupDeductionDefs.filter((d) => matchesJobGroup(d, emp));
  const jgFixedDeductionItems = jgDeductionDefsForEmp.filter((d) => d.type !== 'percentage').map((d) => ({
    conceptId: null, conceptName: d.name, conceptCode: 'JG-DED', subCategory: 'other_withholding',
    amount: d.amount || 0, source: 'job_group',
  }));
  const jgFixedDeductionTotal = jgFixedDeductionItems.reduce((s, i) => s + i.amount, 0);

  return { jgAllowanceItems, taxableJgAllowanceTotal, nonTaxableJgAllowanceTotal, jgFixedDeductionItems, jgFixedDeductionTotal };
}

// ── Pass 2 — percentage job-group deductions (need adjustedGross) + staff_loans (async, DB read) ──
async function resolveLegacyPass2({ emp, jobGroupDeductionDefs, adjustedGross, findStaffLoansForEmployee }) {
  const jgDeductionDefsForEmp = jobGroupDeductionDefs.filter((d) => matchesJobGroup(d, emp));
  const jgPercentageDeductionItems = jgDeductionDefsForEmp.filter((d) => d.type === 'percentage').map((d) => ({
    conceptId: null, conceptName: d.name, conceptCode: 'JG-DED', subCategory: 'other_withholding',
    amount: Math.round(adjustedGross * (d.percentage || 0) / 100 * 100) / 100, source: 'job_group',
  }));
  const jgPercentageDeductionTotal = jgPercentageDeductionItems.reduce((s, i) => s + i.amount, 0);

  const activeLoans = await findStaffLoansForEmployee(emp._id);
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

module.exports = { resolveLegacyPass1, resolveLegacyPass2, matchesJobGroup };
