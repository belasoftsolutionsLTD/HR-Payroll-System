const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyEmployee } = require('../../functions/HR/notifyUser');
const { logCompensationChange } = require('../payroll/payrollCompensationsFunctions');

// Welfare schemes are a thin, named layer over the existing Payroll Concepts engine —
// each scheme owns exactly one payroll_concept (category:'deductions', subCategory:'welfare')
// and "membership" is simply an active employee_compensations record against that concept.
// This means contributions are real payroll deductions from day one (evaluated by the same
// resolveConceptPass2/lockCycleInternal machinery every other deduction already goes
// through) instead of a parallel record-keeping feature that payroll never sees.

const CONTRIBUTION_TYPES = ['fixed', 'percentage'];

const createScheme = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'contributionAmount', 'contributionType'])) return;
  const { name, description, contributionAmount, contributionType, percentageOf } = req.body;

  if (!CONTRIBUTION_TYPES.includes(contributionType)) {
    return returnFunction(res, 400, false, `contributionType must be one of: ${CONTRIBUTION_TYPES.join(', ')}.`);
  }
  const amount = Number(contributionAmount);
  if (!(amount > 0)) return returnFunction(res, 400, false, 'contributionAmount must be greater than 0.');

  // Auto-generated code — HR names the scheme, not the underlying concept, so there's
  // no user-facing code field to collide on. `payroll_concepts.code` has no DB-level
  // unique index (only createConcept's own app-level findOne check, which this direct
  // insert bypasses), so explicitly check-and-retry here rather than trusting a
  // single random value to never collide.
  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `WELFARE_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    if (!(await findOne('payroll_concepts', { code: candidate }))) { code = candidate; break; }
  }
  if (!code) return returnFunction(res, 500, false, 'Could not generate a unique scheme code — please try again.');
  const conceptDoc = {
    name: `${name.trim()} Contribution`,
    code,
    category: 'deductions',
    subCategory: 'welfare',
    type: contributionType,
    defaultAmount: contributionType === 'fixed' ? amount : null,
    currency: 'KES',
    percentageOf: contributionType === 'percentage' ? (percentageOf || 'gross_salary') : null,
    percentageValue: contributionType === 'percentage' ? amount : null,
    formula: null, brackets: null, loanType: null,
    cap: null, flatCredit: null, deductConceptCodesFromBase: [], statutoryKey: null,
    isActive: true, isTaxable: false, isRecurring: true, appearsOnPayslip: true, alertIfUndefined: false,
    createdBy: req.user?._id ?? null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const conceptResult = await insertOne('payroll_concepts', conceptDoc);

  const schemeDoc = {
    name: name.trim(),
    description: description || '',
    conceptId: conceptResult.insertedId,
    contributionAmount: amount,
    contributionType,
    percentageOf: conceptDoc.percentageOf,
    isActive: true,
    createdBy: req.user?._id ?? null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('welfare_schemes', schemeDoc);

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, conceptId: conceptResult.insertedId });
};

const listSchemes = async (req, res) => {
  const schemes = await findMany('welfare_schemes', {}, { sort: { createdAt: -1 } });
  const enriched = await Promise.all(schemes.map(async (s) => {
    const memberCount = await countDocuments('employee_compensations', { conceptId: s.conceptId, isActive: true });
    return { ...s, memberCount };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getScheme = async (req, res) => {
  const scheme = await findOne('welfare_schemes', { _id: new ObjectId(req.params.id) });
  if (!scheme) return returnFunction(res, 404, false, req.locale.notFound);

  const memberComps = await findMany('employee_compensations', { conceptId: scheme.conceptId, isActive: true }, {});
  const employeeIds = memberComps.map((c) => c.employeeId);
  const employees = employeeIds.length
    ? await findMany('employees', { _id: { $in: employeeIds } }, { projection: { fullName: 1, staffNumber: 1, department: 1 } })
    : [];
  const empById = Object.fromEntries(employees.map((e) => [String(e._id), e]));

  const members = memberComps.map((c) => ({
    compensationId: c._id,
    employeeId: c.employeeId,
    employee: empById[String(c.employeeId)] || null,
    amount: c.amount,
    effectiveFrom: c.effectiveFrom,
  }));

  return returnFunction(res, 200, true, req.locale.success, { ...scheme, members });
};

const updateScheme = async (req, res) => {
  const scheme = await findOne('welfare_schemes', { _id: new ObjectId(req.params.id) });
  if (!scheme) return returnFunction(res, 404, false, req.locale.notFound);

  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.description !== undefined) update.description = req.body.description;
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);

  await updateOne('welfare_schemes', { _id: scheme._id }, { $set: update });

  // Deactivating the scheme deactivates its underlying concept too, so it stops being
  // evaluated in payroll (existing members degrade to a harmless "concept not found"
  // warning rather than continuing to be silently deducted for a scheme HR closed).
  if (update.isActive === false) {
    await updateOne('payroll_concepts', { _id: scheme.conceptId }, { $set: { isActive: false, updatedAt: new Date() } });
  } else if (update.isActive === true) {
    await updateOne('payroll_concepts', { _id: scheme.conceptId }, { $set: { isActive: true, updatedAt: new Date() } });
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const addMember = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId'])) return;
  const scheme = await findOne('welfare_schemes', { _id: new ObjectId(req.params.id) });
  if (!scheme) return returnFunction(res, 404, false, req.locale.notFound);
  if (!scheme.isActive) return returnFunction(res, 400, false, 'This scheme is no longer active.');

  const employee = await findOne('employees', { _id: new ObjectId(req.body.employeeId) }, { projection: { fullName: 1 } });
  if (!employee) return returnFunction(res, 404, false, 'Employee not found.');

  const existing = await findOne('employee_compensations', {
    employeeId: employee._id, conceptId: scheme.conceptId, isActive: true,
  });
  if (existing) return returnFunction(res, 409, false, `${employee.fullName} is already a member of this scheme.`);

  const concept = await findOne('payroll_concepts', { _id: scheme.conceptId }, { projection: { name: 1, code: 1, category: 1, subCategory: 1 } });
  const now = new Date();
  const doc = {
    employeeId: employee._id,
    conceptId: scheme.conceptId,
    conceptName: concept.name,
    conceptCode: concept.code,
    category: concept.category,
    subCategory: concept.subCategory,
    // Percentage-type schemes apply the concept's own percentageValue uniformly — the
    // assignment's `amount` is only meaningful (and only evaluated) for fixed-type concepts.
    amount: scheme.contributionType === 'fixed' ? Number(req.body.amount ?? scheme.contributionAmount) : 0,
    currency: 'KES',
    effectiveFrom: now, effectiveTo: null, cycleId: null, isActive: true,
    addedBy: req.user?._id ?? null, notes: null,
    createdAt: now, updatedAt: now,
  };
  const result = await insertOne('employee_compensations', doc);
  logCompensationChange(doc.employeeId, result.insertedId, doc.conceptName, 'added',
    [{ field: 'amount', oldValue: null, newValue: doc.amount }], req.user?._id);

  notifyEmployee(employee._id, {
    title: 'Welfare Scheme Enrollment',
    body: `You have been enrolled in the "${scheme.name}" welfare scheme.`,
    type: 'general',
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const removeMember = async (req, res) => {
  const scheme = await findOne('welfare_schemes', { _id: new ObjectId(req.params.id) });
  if (!scheme) return returnFunction(res, 404, false, req.locale.notFound);

  const compensation = await findOne('employee_compensations', {
    employeeId: new ObjectId(req.params.employeeId), conceptId: scheme.conceptId, isActive: true,
  });
  if (!compensation) return returnFunction(res, 404, false, 'This employee is not an active member of this scheme.');

  await updateOne('employee_compensations', { _id: compensation._id }, { $set: { isActive: false, updatedAt: new Date() } });
  logCompensationChange(compensation.employeeId, compensation._id, compensation.conceptName, 'removed',
    [{ field: 'isActive', oldValue: true, newValue: false }], req.user?._id);

  notifyEmployee(compensation.employeeId, {
    title: 'Welfare Scheme Membership Ended',
    body: `Your membership in the "${scheme.name}" welfare scheme has ended.`,
    type: 'general',
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Member removed from scheme.');
};

// Staff self-service — an employee's own active welfare memberships.
const getMyWelfare = async (req, res) => {
  if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const comps = await findMany('employee_compensations', {
    employeeId: new ObjectId(req.user.employeeId), category: 'deductions', subCategory: 'welfare', isActive: true,
  }, {});
  if (!comps.length) return returnFunction(res, 200, true, req.locale.success, []);

  const conceptIds = comps.map((c) => c.conceptId);
  const schemes = await findMany('welfare_schemes', { conceptId: { $in: conceptIds } }, {});
  const schemeByConceptId = Object.fromEntries(schemes.map((s) => [String(s.conceptId), s]));

  const enriched = comps.map((c) => {
    const scheme = schemeByConceptId[String(c.conceptId)];
    return {
      schemeId: scheme?._id || null,
      schemeName: scheme?.name || c.conceptName,
      description: scheme?.description || '',
      contributionType: scheme?.contributionType || null,
      amount: scheme?.contributionType === 'percentage' ? scheme.contributionAmount : c.amount,
      effectiveFrom: c.effectiveFrom,
    };
  });
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

module.exports = {
  createScheme, listSchemes, getScheme, updateScheme, addMember, removeMember, getMyWelfare,
};
