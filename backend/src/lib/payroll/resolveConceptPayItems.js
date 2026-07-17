const { evaluateConceptAmount } = require('../../functions/payrollConceptEvaluator');
const { matchesGroupAssignment } = require('./conceptTargeting');

// The unified-Concepts replacement for the legacy job-group Allowances/Deductions +
// staff_loans resolution in lockCycleInternal. Two passes, same reason the legacy code
// has two passes: a deduction/benefit/employer_contribution concept may be a percentage/
// formula/bracket of adjusted gross pay, which isn't known until AFTER overtime is
// calculated — so anything that might need it is deferred to pass 2. Earnings concepts
// never need adjusted gross (payrollConceptsFunctions.js's circularity rule guarantees
// this at concept-creation time), so they always resolve in pass 1.
//
// Returns the same item shapes lockCycleInternal already builds its payslip/exception
// checks around ({conceptId, conceptName, conceptCode, subCategory, amount, ...}), so
// the calling code doesn't need to know which engine produced them.

const PASS2_TYPES = new Set(['percentage', 'formula', 'bracket']);

function assignmentsForEmployee(emp, individualComps, groupAssignments) {
  const individual = individualComps; // already scoped to this employee by the DB query
  const group = groupAssignments.filter((a) => matchesGroupAssignment(a, emp));
  return [...individual, ...group];
}

function isLoanLike(assignment) {
  return assignment.balanceRemaining !== undefined && assignment.balanceRemaining !== null;
}

// ── Pass 1 — earnings (always) + fixed/variable deductions/benefits/employer_contributions ──
function resolveConceptPass1({ emp, individualComps, groupAssignments, conceptById, context }) {
  const all = assignmentsForEmployee(emp, individualComps, groupAssignments);

  const earningsItems = [];
  const deductionItemsPass1 = [];
  const benefitsItems = [];
  const employerContributionItems = [];
  const warnings = [];

  for (const a of all) {
    const concept = conceptById[String(a.conceptId)];
    if (!concept) continue; // orphaned assignment (concept deactivated/deleted) — skip, not an evaluation error
    if (a.category === 'deductions' && isLoanLike(a)) continue; // loans always resolve in pass 2

    const isPass2Deduction = a.category !== 'earnings' && PASS2_TYPES.has(concept.type);
    if (isPass2Deduction) continue;

    const { amount, warnings: w } = evaluateConceptAmount(concept, a, context);
    if (w.length) warnings.push(...w.map((msg) => `${concept.name} (${emp.fullName || emp._id}): ${msg}`));

    const item = {
      conceptId: a.conceptId, conceptName: a.conceptName || concept.name, conceptCode: a.conceptCode || concept.code,
      subCategory: a.subCategory || concept.subCategory, amount, source: a.scope === 'group' ? 'concept_group' : 'concept',
    };

    if (a.category === 'earnings') {
      item.isTaxable = concept.isTaxable !== false;
      earningsItems.push(item);
    } else if (a.category === 'deductions') {
      deductionItemsPass1.push(item);
    } else if (a.category === 'benefits') {
      benefitsItems.push(item);
    } else if (a.category === 'employer_contributions') {
      employerContributionItems.push(item);
    }
  }

  const taxableEarningsTotal    = earningsItems.filter((i) => i.isTaxable).reduce((s, i) => s + i.amount, 0);
  const nonTaxableEarningsTotal = earningsItems.filter((i) => !i.isTaxable).reduce((s, i) => s + i.amount, 0);
  const deductionTotalPass1     = deductionItemsPass1.reduce((s, i) => s + i.amount, 0);
  const employerContributionTotal = employerContributionItems.reduce((s, i) => s + i.amount, 0);

  return {
    earningsItems, taxableEarningsTotal, nonTaxableEarningsTotal,
    deductionItemsPass1, deductionTotalPass1,
    benefitsItems, employerContributionItems, employerContributionTotal,
    warnings,
  };
}

// ── Pass 2 — deductions needing adjustedGross + loans (evaluated, capped at remaining balance) ──
function resolveConceptPass2({ emp, individualComps, groupAssignments, conceptById, context, loanApplications }) {
  const all = assignmentsForEmployee(emp, individualComps, groupAssignments);

  const deductionItemsPass2 = [];
  const loanItems = [];
  const warnings = [];

  for (const a of all) {
    if (a.category !== 'deductions') continue;
    const concept = conceptById[String(a.conceptId)];
    if (!concept) continue;

    if (isLoanLike(a)) {
      if (!a.isActive || a.loanStatus !== 'active' || a.balanceRemaining <= 0) continue;
      const { amount: evaluated, warnings: w } = evaluateConceptAmount(concept, a, context);
      if (w.length) warnings.push(...w.map((msg) => `${concept.name} (${emp.fullName || emp._id}): ${msg}`));
      const installmentApplied = Math.min(evaluated, a.balanceRemaining);
      if (installmentApplied <= 0) continue;
      loanApplications.push({ assignmentId: a._id, installmentApplied });
      loanItems.push({
        conceptId: a.conceptId, conceptName: a.conceptName || concept.name, conceptCode: a.conceptCode || concept.code,
        subCategory: a.subCategory || concept.subCategory, amount: installmentApplied, source: 'concept_loan',
        loanAssignmentId: a._id, balanceAfter: Math.round((a.balanceRemaining - installmentApplied) * 100) / 100,
      });
      continue;
    }

    if (!PASS2_TYPES.has(concept.type)) continue; // already resolved in pass 1

    const { amount, warnings: w } = evaluateConceptAmount(concept, a, context);
    if (w.length) warnings.push(...w.map((msg) => `${concept.name} (${emp.fullName || emp._id}): ${msg}`));
    deductionItemsPass2.push({
      conceptId: a.conceptId, conceptName: a.conceptName || concept.name, conceptCode: a.conceptCode || concept.code,
      subCategory: a.subCategory || concept.subCategory, amount, source: a.scope === 'group' ? 'concept_group' : 'concept',
    });
  }

  const deductionTotalPass2 = deductionItemsPass2.reduce((s, i) => s + i.amount, 0);
  const loanTotal = loanItems.reduce((s, i) => s + i.amount, 0);

  return { deductionItemsPass2, deductionTotalPass2, loanItems, loanTotal, warnings };
}

module.exports = { resolveConceptPass1, resolveConceptPass2 };
