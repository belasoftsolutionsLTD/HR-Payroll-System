const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { VALID_EMPLOYMENT_TYPES } = require('../../lib/payroll/conceptTargeting');

// Immutable log of every change to an employee's compensation — amount, effective dates,
// active/inactive (added/removed), viewable by HR on the employee's payroll profile.
const logCompensationChange = (employeeId, compensationId, conceptName, action, changes, userId) =>
  insertOne('compensation_audit_logs', {
    employeeId, compensationId, conceptName, action, changes,
    performedBy: userId ?? null,
    performedAt: new Date(),
  }).catch(() => {});

// List compensations for one employee
const getEmployeeCompensations = async (req, res) => {
  const { employeeId } = req.params;
  const filter = { employeeId: new ObjectId(employeeId), isActive: true };
  const data = await findMany('employee_compensations', filter, { sort: { category: 1, createdAt: 1 } });
  // Enrich with concept details
  const enriched = await Promise.all(data.map(async comp => {
    const concept = await findOne('payroll_concepts', { _id: comp.conceptId }, { projection: { name: 1, code: 1, category: 1, subCategory: 1, type: 1, currency: 1 } });
    return { ...comp, concept: concept ?? null };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// All employees with compensation summary (for the employees tab)
const listEmployeeCompensationSummaries = async (req, res) => {
  const employees = await findMany('employees', { status: 'active' }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1 }, sort: { fullName: 1 } });
  const summaries = await Promise.all(employees.map(async emp => {
    const comps = await findMany('employee_compensations', { employeeId: emp._id, isActive: true }, {});
    const totalEarnings     = comps.filter(c => c.category === 'earnings').reduce((s, c) => s + (c.amount || 0), 0);
    const totalDeductions   = comps.filter(c => c.category === 'deductions').reduce((s, c) => s + (c.amount || 0), 0);
    const basicComp         = comps.find(c => c.conceptCode === 'BASIC' || c.subCategory === 'fixed_pay');
    return {
      ...emp,
      basicSalary:     basicComp?.amount ?? 0,
      totalEarnings,
      totalDeductions,
      netEstimate:     totalEarnings - totalDeductions,
      compensationCount: comps.length,
      lastUpdated:     comps.reduce((latest, c) => c.updatedAt > latest ? c.updatedAt : latest, new Date(0)),
    };
  }));
  return returnFunction(res, 200, true, req.locale.success, summaries);
};

// Add compensation item to employee
const addCompensation = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'conceptId', 'amount'])) return;
  const { employeeId, conceptId, amount, currency, effectiveFrom, effectiveTo, cycleId, notes } = req.body;

  const [emp, concept] = await Promise.all([
    findOne('employees',         { _id: new ObjectId(employeeId) }, { projection: { fullName: 1 } }),
    findOne('payroll_concepts',  { _id: new ObjectId(conceptId)  }, { projection: { name: 1, code: 1, category: 1, subCategory: 1 } }),
  ]);
  if (!emp)     return returnFunction(res, 404, false, 'Employee not found.');
  if (!concept) return returnFunction(res, 404, false, 'Concept not found.');

  const doc = {
    employeeId:   new ObjectId(employeeId),
    conceptId:    new ObjectId(conceptId),
    conceptName:  concept.name,
    conceptCode:  concept.code,
    category:     concept.category,
    subCategory:  concept.subCategory,
    amount:       Number(amount),
    currency:     currency || 'KES',
    effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
    effectiveTo:   effectiveTo   ? new Date(effectiveTo)   : null,
    cycleId:       cycleId       ? new ObjectId(cycleId)   : null,
    isActive:      true,
    addedBy:       req.user?._id ?? null,
    notes:         notes || null,
    createdAt:     new Date(),
    updatedAt:     new Date(),
  };
  const result = await insertOne('employee_compensations', doc);
  logCompensationChange(doc.employeeId, result.insertedId, doc.conceptName, 'added',
    [{ field: 'amount', oldValue: null, newValue: doc.amount }], req.user?._id);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// Assign a concept to one employee, several employees, or a whole department/job-group/
// everyone at once — a generalization of addCompensation that also supports the
// group-scope (scope:'group', appliesTo) shape from employee_compensations. The
// existing single-employee `addCompensation`/`POST /payroll/compensations` path is
// left completely untouched (it already works and is in daily use) — this is purely
// additive, reached only through the new `POST /payroll/concepts/:id/assign` route.
const assignConcept = async (req, res) => {
  if (!validateRequiredFields(req, res, ['conceptId', 'target'])) return;
  const { conceptId, target, amount, currency, effectiveFrom, effectiveTo, notes, principal, openingBalance } = req.body;

  const concept = await findOne('payroll_concepts', { _id: new ObjectId(conceptId) }, { projection: { name: 1, code: 1, category: 1, subCategory: 1 } });
  if (!concept) return returnFunction(res, 404, false, 'Concept not found.');

  const targetType = target?.type;
  if (!['employee', 'employees', 'all', 'department', 'jobGroup', 'employmentType'].includes(targetType)) {
    return returnFunction(res, 400, false, 'Invalid target type.');
  }

  const excludeEmploymentTypes = Array.isArray(target?.excludeEmploymentTypes)
    ? target.excludeEmploymentTypes.filter((t) => VALID_EMPLOYMENT_TYPES.includes(t))
    : undefined;
  if (target?.excludeEmploymentTypes && !excludeEmploymentTypes?.length) {
    return returnFunction(res, 400, false, `excludeEmploymentTypes must contain valid employment types: ${VALID_EMPLOYMENT_TYPES.join(', ')}.`);
  }

  const now = new Date();
  const baseFields = {
    conceptId: concept._id, conceptName: concept.name, conceptCode: concept.code,
    category: concept.category, subCategory: concept.subCategory,
    currency: currency || 'KES',
    effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : now,
    effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
    cycleId: null, isActive: true,
    addedBy: req.user?._id ?? null,
    notes: notes || null,
    createdAt: now, updatedAt: now,
  };

  const hasPrincipal = principal !== undefined && principal !== null && principal !== '';

  if (targetType === 'employee' || targetType === 'employees') {
    const employeeIds = Array.isArray(target.employeeIds) ? target.employeeIds : [];
    if (employeeIds.length === 0) {
      return returnFunction(res, 400, false, 'Select at least one employee.');
    }

    const employees = await findMany('employees', { _id: { $in: employeeIds.map((id) => new ObjectId(id)) } }, { projection: { fullName: 1 } });
    if (employees.length !== employeeIds.length) {
      return returnFunction(res, 404, false, 'One or more employees were not found.');
    }

    const insertedIds = [];
    for (const empId of employeeIds) {
      const doc = {
        ...baseFields,
        scope: 'individual',
        employeeId: new ObjectId(empId),
        amount: Number(amount) || 0,
      };
      if (hasPrincipal) {
        const principalNum = Number(principal);
        const openingNum = (openingBalance !== undefined && openingBalance !== null && openingBalance !== '')
          ? Number(openingBalance) : principalNum;
        doc.principal = principalNum;
        doc.openingBalance = openingNum;
        doc.balanceRemaining = openingNum;
        doc.totalRepaid = 0;
        doc.loanStatus = 'active';
      }
      const result = await insertOne('employee_compensations', doc);
      insertedIds.push(result.insertedId);
      logCompensationChange(doc.employeeId, result.insertedId, doc.conceptName, 'added',
        [{ field: 'amount', oldValue: null, newValue: doc.amount }], req.user?._id);
    }
    return returnFunction(res, 201, true, req.locale.createdSuccessfully, { insertedIds });
  }

  // 'all' | 'department' | 'jobGroup' — a single shared assignment record, no running
  // balance possible (a loan needs one specific person's balance, not a group's).
  if (hasPrincipal) {
    return returnFunction(res, 400, false, 'A loan-like assignment (with a principal) must target a specific employee, not a group.');
  }

  let appliesTo;
  if (targetType === 'all') {
    appliesTo = { type: 'all' };
  } else if (targetType === 'department') {
    if (!Array.isArray(target.departments) || target.departments.length === 0) {
      return returnFunction(res, 400, false, 'Select at least one department.');
    }
    appliesTo = { type: 'department', departments: target.departments };
  } else if (targetType === 'jobGroup') {
    if (!Array.isArray(target.jobGroupIds) || target.jobGroupIds.length === 0) {
      return returnFunction(res, 400, false, 'Select at least one job group.');
    }
    appliesTo = { type: 'jobGroup', jobGroupIds: target.jobGroupIds.map((id) => new ObjectId(id)) };
  } else {
    const employmentTypes = Array.isArray(target.employmentTypes)
      ? target.employmentTypes.filter((t) => VALID_EMPLOYMENT_TYPES.includes(t))
      : [];
    if (employmentTypes.length === 0) {
      return returnFunction(res, 400, false, `Select at least one valid employment type: ${VALID_EMPLOYMENT_TYPES.join(', ')}.`);
    }
    appliesTo = { type: 'employmentType', employmentTypes };
  }
  if (excludeEmploymentTypes?.length) appliesTo.excludeEmploymentTypes = excludeEmploymentTypes;

  const doc = {
    ...baseFields,
    scope: 'group',
    employeeId: null,
    appliesTo,
    amount: Number(amount) || 0,
  };
  const result = await insertOne('employee_compensations', doc);
  logCompensationChange(null, result.insertedId, doc.conceptName, 'added',
    [{ field: 'amount', oldValue: null, newValue: doc.amount }], req.user?._id);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

// Update compensation item
const updateCompensation = async (req, res) => {
  const { id } = req.params;
  const existing = await findOne('employee_compensations', { _id: new ObjectId(id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  const { amount, currency, effectiveFrom, effectiveTo, notes, isActive } = req.body;
  const update = { updatedAt: new Date() };
  if (amount       !== undefined) update.amount       = Number(amount);
  if (currency     !== undefined) update.currency     = currency;
  if (effectiveFrom!== undefined) update.effectiveFrom= new Date(effectiveFrom);
  if (effectiveTo  !== undefined) update.effectiveTo  = effectiveTo ? new Date(effectiveTo) : null;
  if (notes        !== undefined) update.notes        = notes;
  if (isActive     !== undefined) update.isActive     = Boolean(isActive);

  const changes = Object.keys(update)
    .filter((f) => f !== 'updatedAt')
    .map((field) => ({ field, oldValue: existing[field] ?? null, newValue: update[field] }))
    .filter((c) => String(c.oldValue) !== String(c.newValue));

  await updateOne('employee_compensations', { _id: new ObjectId(id) }, { $set: update });
  if (changes.length) {
    logCompensationChange(existing.employeeId, existing._id, existing.conceptName, 'updated', changes, req.user?._id);
  }
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Remove compensation item
const removeCompensation = async (req, res) => {
  const existing = await findOne('employee_compensations', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('employee_compensations', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  logCompensationChange(existing.employeeId, existing._id, existing.conceptName, 'removed',
    [{ field: 'isActive', oldValue: true, newValue: false }], req.user?._id);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// Audit log for one employee's compensation history — viewable by HR on the employee's payroll profile
const getCompensationAuditLog = async (req, res) => {
  const logs = await findMany('compensation_audit_logs', { employeeId: new ObjectId(req.params.employeeId) }, { sort: { performedAt: -1 } });
  const userIds = [...new Set(logs.filter((l) => l.performedBy).map((l) => String(l.performedBy)))].map((id) => new ObjectId(id));
  const users = userIds.length ? await findMany('users', { _id: { $in: userIds } }, { projection: { name: 1 } }) : [];
  const userMap = Object.fromEntries(users.map((u) => [String(u._id), u.name]));
  const enriched = logs.map((l) => ({ ...l, performedByName: l.performedBy ? (userMap[String(l.performedBy)] || 'Unknown') : 'System' }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

module.exports = {
  getEmployeeCompensations, listEmployeeCompensationSummaries, addCompensation,
  assignConcept, updateCompensation, removeCompensation, getCompensationAuditLog,
  logCompensationChange,
};
