const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');

const VALID_CATEGORIES = ['earnings', 'deductions', 'benefits', 'employer_contributions'];
const VALID_TYPES      = ['fixed', 'variable', 'percentage', 'formula'];

const SUB_CATEGORY_MAP = {
  earnings:                ['fixed_pay', 'variable_pay', 'benefits_in_kind', 'bonus'],
  deductions:              ['tax', 'social_security', 'other_withholding'],
  benefits:                ['meals_transport', 'health', 'childcare', 'training', 'wellness'],
  employer_contributions:  ['employer_contribution'],
};

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
          percentageOf, percentageValue, formula, isTaxable, isRecurring,
          appearsOnPayslip, alertIfUndefined } = req.body;

  if (!VALID_CATEGORIES.includes(category)) {
    return returnFunction(res, 400, false, 'Invalid category.');
  }
  if (!VALID_TYPES.includes(type)) {
    return returnFunction(res, 400, false, 'Invalid type.');
  }
  if (!SUB_CATEGORY_MAP[category]?.includes(subCategory)) {
    return returnFunction(res, 400, false, 'Sub-category does not match the selected category.');
  }

  // Check unique code
  const existing = await findOne('payroll_concepts', { code: code.toUpperCase() });
  if (existing) return returnFunction(res, 409, false, `Concept code "${code.toUpperCase()}" already exists.`);

  const doc = {
    name:             name.trim(),
    code:             code.toUpperCase().trim(),
    category,
    subCategory,
    type,
    defaultAmount:    defaultAmount     ? Number(defaultAmount)     : null,
    currency:         currency          || 'KES',
    percentageOf:     percentageOf      || null,
    percentageValue:  percentageValue   ? Number(percentageValue)   : null,
    formula:          formula           || null,
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
          percentageOf, percentageValue, formula, isTaxable, isRecurring,
          appearsOnPayslip, alertIfUndefined, isActive } = req.body;

  if (code && code.toUpperCase() !== existing.code) {
    const dupe = await findOne('payroll_concepts', { code: code.toUpperCase(), _id: { $ne: new ObjectId(id) } });
    if (dupe) return returnFunction(res, 409, false, `Concept code "${code.toUpperCase()}" is already in use.`);
  }

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

module.exports = { listConcepts, createConcept, updateConcept, deleteConcept, getConcept };
