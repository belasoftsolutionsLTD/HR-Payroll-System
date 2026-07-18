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
//
// Non-loan pass-2 deductions are further split into two ordered sub-passes because a
// concept may declare `deductConceptCodesFromBase` (e.g. PAYE needing NSSF's amount
// already subtracted from its taxable base) — depth-1 only, enforced at write time in
// payrollConceptsFunctions.js, so this fixed two-sub-pass ordering is provably sufficient
// and a general dependency graph/topological sort is unnecessary:
//   2a — concepts with no dependency: evaluate normally, record resolvedByCode[code].
//   2b — concepts that reference other codes: sum the referenced amounts from
//        resolvedByCode (missing reference → warning, contributes 0, never throws),
//        subtract that sum (floored at 0) from the relevant context variable, then evaluate.
//
// Any resolved deduction whose concept has `statutoryKey` set is moved into a separate
// `statutoryItems` bucket instead of `deductionItemsPass2` — see resolveStatutoryLine in
// payrollCyclesFunctions.js, which prefers this over the legacy taxCalc.calc*() output
// when a concept claims that key. No concept has `statutoryKey` set until HR opts in, so
// `statutoryItems` is always `[]` and `deductionItemsPass2`/`deductionTotalPass2` are
// unchanged for every deployment that hasn't adopted this extension.
function resolveConceptPass2({ emp, individualComps, groupAssignments, conceptById, context, loanApplications }) {
  const all = assignmentsForEmployee(emp, individualComps, groupAssignments);

  const deductionItemsPass2 = [];
  const statutoryItems = [];
  const loanItems = [];
  const warnings = [];
  const resolvedByCode = {};
  const pass2Deductions = [];

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
    pass2Deductions.push({ a, concept });
  }

  const hasDependency = ({ concept }) =>
    Array.isArray(concept.deductConceptCodesFromBase) && concept.deductConceptCodesFromBase.length > 0;
  const sub2a = pass2Deductions.filter((x) => !hasDependency(x));
  const sub2b = pass2Deductions.filter(hasDependency);

  const recordResolved = ({ a, concept }, amount) => {
    const item = {
      conceptId: a.conceptId, conceptName: a.conceptName || concept.name, conceptCode: a.conceptCode || concept.code,
      subCategory: a.subCategory || concept.subCategory, amount, source: a.scope === 'group' ? 'concept_group' : 'concept',
    };
    if (concept.code) resolvedByCode[concept.code] = amount;
    if (concept.statutoryKey) {
      statutoryItems.push({ statutoryKey: concept.statutoryKey, conceptId: a.conceptId, conceptName: item.conceptName, amount });
    } else {
      deductionItemsPass2.push(item);
    }
  };

  for (const entry of sub2a) {
    const { a, concept } = entry;
    const { amount, warnings: w } = evaluateConceptAmount(concept, a, context);
    if (w.length) warnings.push(...w.map((msg) => `${concept.name} (${emp.fullName || emp._id}): ${msg}`));
    recordResolved(entry, amount);
  }

  for (const entry of sub2b) {
    const { a, concept } = entry;
    let baseDeduction = 0;
    for (const refCode of concept.deductConceptCodesFromBase) {
      if (Object.prototype.hasOwnProperty.call(resolvedByCode, refCode)) {
        baseDeduction += resolvedByCode[refCode];
      } else {
        warnings.push(`${concept.name} (${emp.fullName || emp._id}): referenced concept code "${refCode}" was not resolved this cycle — treated as 0`);
      }
    }
    const baseKey = concept.percentageOf || 'adjusted_gross';
    const adjustedContext = { ...context, [baseKey]: Math.max(0, (Number(context[baseKey]) || 0) - baseDeduction) };
    const { amount, warnings: w } = evaluateConceptAmount(concept, a, adjustedContext);
    if (w.length) warnings.push(...w.map((msg) => `${concept.name} (${emp.fullName || emp._id}): ${msg}`));
    recordResolved(entry, amount);
  }

  const deductionTotalPass2 = deductionItemsPass2.reduce((s, i) => s + i.amount, 0);
  const loanTotal = loanItems.reduce((s, i) => s + i.amount, 0);

  return { deductionItemsPass2, deductionTotalPass2, statutoryItems, loanItems, loanTotal, warnings };
}

module.exports = { resolveConceptPass1, resolveConceptPass2 };
