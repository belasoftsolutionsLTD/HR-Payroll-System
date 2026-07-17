const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');

const VALID_CATEGORIES = ['earnings', 'deductions', 'benefits', 'employer_contributions'];
const VALID_TYPES      = ['fixed', 'variable', 'percentage', 'formula', 'bracket'];

const SUB_CATEGORY_MAP = {
  earnings:                ['fixed_pay', 'variable_pay', 'benefits_in_kind', 'bonus', 'allowance'],
  deductions:              ['tax', 'social_security', 'other_withholding', 'loans'],
  benefits:                ['meals_transport', 'health', 'childcare', 'training', 'wellness'],
  employer_contributions:  ['employer_contribution'],
};

// Earnings can't be a percentage/formula/bracket of the very gross pay they contribute
// to — gross is built FROM earnings, so referencing it back would be circular. Only
// deductions/benefits/employer_contributions (resolved after gross is known) may.
const FORBIDDEN_EARNINGS_VARS = ['gross_salary', 'adjusted_gross'];

function violatesEarningsCircularity(category, type, percentageOf, formula) {
  if (category !== 'earnings') return false;
  if (type === 'percentage') {
    return !!percentageOf && FORBIDDEN_EARNINGS_VARS.includes(percentageOf);
  }
  if (type === 'bracket') {
    // evaluateConceptAmount defaults an unset base to 'adjusted_gross' for bracket
    // types, so an unset base is itself the circular case here.
    return FORBIDDEN_EARNINGS_VARS.includes(percentageOf || 'adjusted_gross');
  }
  if (type === 'formula' && formula) {
    return FORBIDDEN_EARNINGS_VARS.some(v => formula.includes(v));
  }
  return false;
}

const STATUTORY_KEYS = ['paye', 'nssf', 'sha', 'ahl'];

// Validates the statutory-tax extension fields (cap, flatCredit, deductConceptCodesFromBase,
// statutoryKey) — added so PAYE/NSSF/SHA/AHL-style concepts can be authored for real,
// evaluated deductions rather than living only in the separate tax_config system. This
// needs DB reads (to check referenced-concept state), so it's a shared async helper called
// by both createConcept/updateConcept against the MERGED (existing+patch) field set — a
// partial update is validated against the concept's true resulting shape, not just the diff.
//
// deductConceptCodesFromBase is deliberately depth-1 only: a concept may reference other
// concepts' already-computed amounts (e.g. PAYE referencing NSSF), but a referenced concept
// may not itself have a dependency, and a concept that's already depended-upon can't
// retroactively gain one — this rules out chains/cycles by construction rather than needing
// a topological-sort engine, since in practice only one such relationship exists (income tax
// base excluding mandatory pension/social-security contributions).
async function validateStatutoryFields({ ownCode, category, type, cap, flatCredit, deductConceptCodesFromBase, statutoryKey, excludeId }) {
  if (cap != null && !['percentage', 'bracket'].includes(type)) {
    return 'A cap can only be set on percentage or bracket concepts.';
  }
  if (cap != null && Number(cap) < 0) {
    return 'Cap must be zero or greater.';
  }
  if (flatCredit != null && !['percentage', 'bracket', 'formula'].includes(type)) {
    return 'A flat credit can only be set on percentage, bracket, or formula concepts.';
  }
  if (flatCredit != null && Number(flatCredit) < 0) {
    return 'Flat credit must be zero or greater.';
  }

  const codes = Array.isArray(deductConceptCodesFromBase) ? deductConceptCodesFromBase.filter(Boolean).map(String) : [];
  if (codes.length > 0) {
    if (category !== 'deductions' || !['percentage', 'bracket'].includes(type)) {
      return 'Base-amount deductions can only be set on percentage or bracket deduction concepts.';
    }
    for (const refCode of codes) {
      const upperCode = refCode.toUpperCase();
      if (upperCode === ownCode) return 'A concept cannot reference itself in its base-amount deductions.';
      const ref = await findOne('payroll_concepts', { code: upperCode, isActive: true });
      if (!ref) return `Referenced concept code "${upperCode}" was not found or is inactive.`;
      if (ref.category !== 'deductions') return `Referenced concept "${upperCode}" must be a deductions-category concept.`;
      if (Array.isArray(ref.deductConceptCodesFromBase) && ref.deductConceptCodesFromBase.length > 0) {
        return `"${upperCode}" already has its own base-amount deductions — chaining more than one level deep isn't supported.`;
      }
    }

    // Reverse guard — some OTHER active concept may already depend on THIS concept's code;
    // if so, this concept can't take on a dependency of its own (would create a 2-level chain).
    if (ownCode) {
      const dependents = await findMany('payroll_concepts', {
        isActive: true,
        deductConceptCodesFromBase: ownCode,
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      });
      if (dependents.length > 0) {
        return `"${dependents[0].name}" already depends on this concept's amount — chaining more than one level deep isn't supported.`;
      }
    }
  }

  if (statutoryKey) {
    if (category !== 'deductions') return 'A statutory key can only be set on a deductions-category concept.';
    if (!STATUTORY_KEYS.includes(statutoryKey)) return 'Invalid statutory key.';
    const dupe = await findOne('payroll_concepts', {
      statutoryKey, isActive: true,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (dupe) return `"${dupe.name}" is already set as the ${statutoryKey.toUpperCase()} concept — only one concept may hold this key.`;
  }

  return null;
}

// ── List Concepts ─────────────────────────────────────────────────────────────

const listConcepts = async (req, res) => {
  const filter = {};
  if (req.query.category) filter.category    = req.query.category;
  if (req.query.isActive !== undefined) filter.isActive = req.query.isActive !== 'false';

  const { page, limit, skip } = getPagination(req.query);
  const [total, data] = await Promise.all([
    countDocuments('payroll_concepts', filter),
    findMany('payroll_concepts', filter, { skip, limit, sort: { category: 1, createdAt: -1 } }),
  ]);

  // Enrich with employee count using employee_compensations
  const enriched = await Promise.all(data.map(async concept => {
    const empCount = await countDocuments('employee_compensations', {
      conceptId: concept._id,
      isActive:  true,
    });
    return { ...concept, employeeCount: empCount };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

// ── Create Concept ────────────────────────────────────────────────────────────

const createConcept = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'code', 'category', 'subCategory', 'type'])) return;

  const { name, code, category, subCategory, type, defaultAmount, currency,
          percentageOf, percentageValue, formula, brackets, loanType,
          cap, flatCredit, deductConceptCodesFromBase, statutoryKey,
          isTaxable, isRecurring, appearsOnPayslip, alertIfUndefined } = req.body;

  if (!VALID_CATEGORIES.includes(category)) {
    return returnFunction(res, 400, false, 'Invalid category.');
  }
  if (!VALID_TYPES.includes(type)) {
    return returnFunction(res, 400, false, 'Invalid type.');
  }
  if (!SUB_CATEGORY_MAP[category]?.includes(subCategory)) {
    return returnFunction(res, 400, false, 'Sub-category does not match the selected category.');
  }
  if (type === 'bracket' && subCategory === 'loans') {
    return returnFunction(res, 400, false, 'A loan cannot use the bracket calculation type — choose fixed, percentage, or formula.');
  }
  if (violatesEarningsCircularity(category, type, percentageOf, formula)) {
    return returnFunction(res, 400, false, 'An earnings concept cannot be calculated as a percentage/formula/bracket of gross or adjusted gross pay — gross pay is built from earnings, so this would be circular. Use basic_salary or hours_worked instead.');
  }

  // Check unique code
  const upperCode = code.toUpperCase();
  const existing = await findOne('payroll_concepts', { code: upperCode });
  if (existing) return returnFunction(res, 409, false, `Concept code "${upperCode}" already exists.`);

  const statutoryError = await validateStatutoryFields({
    ownCode: upperCode, category, type, cap, flatCredit, deductConceptCodesFromBase, statutoryKey,
  });
  if (statutoryError) return returnFunction(res, 400, false, statutoryError);

  const doc = {
    name:             name.trim(),
    code:             upperCode.trim(),
    category,
    subCategory,
    type,
    defaultAmount:    defaultAmount     ? Number(defaultAmount)     : null,
    currency:         currency          || 'KES',
    percentageOf:     percentageOf      || null,
    percentageValue:  percentageValue   ? Number(percentageValue)   : null,
    formula:          formula           || null,
    brackets:         type === 'bracket' && Array.isArray(brackets)
      ? brackets.map(b => ({ limit: b.limit != null && b.limit !== '' ? Number(b.limit) : null, rate: Number(b.rate) || 0 }))
      : null,
    loanType:         subCategory === 'loans' ? (loanType || null) : null,
    cap:              cap != null && cap !== '' ? Number(cap) : null,
    flatCredit:       flatCredit != null && flatCredit !== '' ? Number(flatCredit) : null,
    deductConceptCodesFromBase: Array.isArray(deductConceptCodesFromBase)
      ? deductConceptCodesFromBase.filter(Boolean).map((c) => String(c).toUpperCase())
      : [],
    statutoryKey:     statutoryKey || null,
    isActive:         true,
    isTaxable:        Boolean(isTaxable),
    isRecurring:      Boolean(isRecurring),
    appearsOnPayslip: appearsOnPayslip !== false,
    alertIfUndefined: Boolean(alertIfUndefined),
    createdBy:        req.user?._id ?? null,
    createdAt:        new Date(),
    updatedAt:        new Date(),
  };

  const result = await insertOne('payroll_concepts', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// ── Update Concept ────────────────────────────────────────────────────────────

const updateConcept = async (req, res) => {
  const { id } = req.params;
  const existing = await findOne('payroll_concepts', { _id: new ObjectId(id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);

  const { name, code, category, subCategory, type, defaultAmount, currency,
          percentageOf, percentageValue, formula, brackets, loanType,
          cap, flatCredit, deductConceptCodesFromBase, statutoryKey,
          isTaxable, isRecurring, appearsOnPayslip, alertIfUndefined, isActive } = req.body;

  if (code && code.toUpperCase() !== existing.code) {
    const dupe = await findOne('payroll_concepts', { code: code.toUpperCase(), _id: { $ne: new ObjectId(id) } });
    if (dupe) return returnFunction(res, 409, false, `Concept code "${code.toUpperCase()}" is already in use.`);
  }

  // Validate against the MERGED result (existing doc + this patch), not just the
  // incoming fields in isolation — a patch that only changes `category` still needs
  // to be checked against whatever `type`/`subCategory` the concept already has.
  const merged = {
    category:     category     !== undefined ? category     : existing.category,
    subCategory:  subCategory  !== undefined ? subCategory  : existing.subCategory,
    type:         type         !== undefined ? type         : existing.type,
    percentageOf: percentageOf !== undefined ? percentageOf : existing.percentageOf,
    formula:      formula      !== undefined ? formula      : existing.formula,
    code:         code         !== undefined ? code.toUpperCase() : existing.code,
    cap:                        cap                        !== undefined ? cap                        : existing.cap,
    flatCredit:                 flatCredit                 !== undefined ? flatCredit                 : existing.flatCredit,
    deductConceptCodesFromBase: deductConceptCodesFromBase !== undefined ? deductConceptCodesFromBase : existing.deductConceptCodesFromBase,
    statutoryKey:               statutoryKey               !== undefined ? statutoryKey               : existing.statutoryKey,
  };
  if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
    return returnFunction(res, 400, false, 'Invalid category.');
  }
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    return returnFunction(res, 400, false, 'Invalid type.');
  }
  if ((category !== undefined || subCategory !== undefined) && !SUB_CATEGORY_MAP[merged.category]?.includes(merged.subCategory)) {
    return returnFunction(res, 400, false, 'Sub-category does not match the selected category.');
  }
  if (merged.type === 'bracket' && merged.subCategory === 'loans') {
    return returnFunction(res, 400, false, 'A loan cannot use the bracket calculation type — choose fixed, percentage, or formula.');
  }
  if (violatesEarningsCircularity(merged.category, merged.type, merged.percentageOf, merged.formula)) {
    return returnFunction(res, 400, false, 'An earnings concept cannot be calculated as a percentage/formula/bracket of gross or adjusted gross pay — gross pay is built from earnings, so this would be circular. Use basic_salary or hours_worked instead.');
  }

  const statutoryError = await validateStatutoryFields({
    ownCode: merged.code, category: merged.category, type: merged.type,
    cap: merged.cap, flatCredit: merged.flatCredit,
    deductConceptCodesFromBase: merged.deductConceptCodesFromBase, statutoryKey: merged.statutoryKey,
    excludeId: new ObjectId(id),
  });
  if (statutoryError) return returnFunction(res, 400, false, statutoryError);

  const update = { updatedAt: new Date() };
  if (name             !== undefined) update.name             = name.trim();
  if (code             !== undefined) update.code             = code.toUpperCase().trim();
  if (category         !== undefined) update.category         = category;
  if (subCategory      !== undefined) update.subCategory      = subCategory;
  if (type             !== undefined) update.type             = type;
  if (defaultAmount    !== undefined) update.defaultAmount    = defaultAmount ? Number(defaultAmount) : null;
  if (currency         !== undefined) update.currency         = currency;
  if (percentageOf     !== undefined) update.percentageOf     = percentageOf;
  if (percentageValue  !== undefined) update.percentageValue  = percentageValue ? Number(percentageValue) : null;
  if (formula          !== undefined) update.formula          = formula;
  if (brackets         !== undefined) update.brackets         = Array.isArray(brackets)
    ? brackets.map(b => ({ limit: b.limit != null && b.limit !== '' ? Number(b.limit) : null, rate: Number(b.rate) || 0 }))
    : null;
  if (loanType         !== undefined) update.loanType         = loanType || null;
  if (cap              !== undefined) update.cap              = cap != null && cap !== '' ? Number(cap) : null;
  if (flatCredit       !== undefined) update.flatCredit       = flatCredit != null && flatCredit !== '' ? Number(flatCredit) : null;
  if (deductConceptCodesFromBase !== undefined) update.deductConceptCodesFromBase = Array.isArray(deductConceptCodesFromBase)
    ? deductConceptCodesFromBase.filter(Boolean).map((c) => String(c).toUpperCase())
    : [];
  if (statutoryKey     !== undefined) update.statutoryKey     = statutoryKey || null;
  if (isTaxable        !== undefined) update.isTaxable        = Boolean(isTaxable);
  if (isRecurring      !== undefined) update.isRecurring      = Boolean(isRecurring);
  if (appearsOnPayslip !== undefined) update.appearsOnPayslip = Boolean(appearsOnPayslip);
  if (alertIfUndefined !== undefined) update.alertIfUndefined = Boolean(alertIfUndefined);
  if (isActive         !== undefined) update.isActive         = Boolean(isActive);

  await updateOne('payroll_concepts', { _id: new ObjectId(id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Delete / Deactivate Concept ───────────────────────────────────────────────

const deleteConcept = async (req, res) => {
  const { id } = req.params;
  const existing = await findOne('payroll_concepts', { _id: new ObjectId(id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);

  // Soft-delete: deactivate instead of hard-deleting (compensations reference this)
  await updateOne('payroll_concepts', { _id: new ObjectId(id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Get Single Concept ────────────────────────────────────────────────────────

const getConcept = async (req, res) => {
  const concept = await findOne('payroll_concepts', { _id: new ObjectId(req.params.id) });
  if (!concept) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, concept);
};

module.exports = {
  listConcepts, createConcept, updateConcept, deleteConcept, getConcept,
  violatesEarningsCircularity, validateStatutoryFields, VALID_TYPES, SUB_CATEGORY_MAP, STATUTORY_KEYS,
};
