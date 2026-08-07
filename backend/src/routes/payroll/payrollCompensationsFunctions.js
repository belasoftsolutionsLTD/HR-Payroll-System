const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 2) —
// employee_compensations, payroll_concepts, employees, users, compensation_audit_logs all
// now live in Postgres.
const { findOne, findMany, insertOne, updateOne, countDocuments, knex } = require('../../functions/Database/pgDBFunctions');
const { VALID_EMPLOYMENT_TYPES } = require('../../lib/payroll/conceptTargeting');

// Immutable log of every change to an employee's compensation — amount, effective dates,
// active/inactive (added/removed), viewable by HR on the employee's payroll profile.
const logCompensationChange = (employeeId, compensationId, conceptName, action, changes, userId) =>
  insertOne('compensation_audit_logs', {
    employeeId, compensationId, conceptName, action, changes: JSON.stringify(changes),
    performedBy: userId ?? null,
    performedAt: new Date(),
  }).catch(() => {});

// List compensations for one employee
const getEmployeeCompensations = async (req, res) => {
  const { employeeId } = req.params;
  const data = await findMany('employee_compensations', { employeeId, isActive: true },
    { orderBy: [{ column: 'category' }, { column: 'createdAt' }] });
  // Enrich with concept details
  const enriched = await Promise.all(data.map(async comp => {
    const concept = await findOne('payroll_concepts', { id: comp.conceptId });
    const conceptSlim = concept ? { name: concept.name, code: concept.code, category: concept.category, subCategory: concept.subCategory, type: concept.type, currency: concept.currency } : null;
    return { ...comp, concept: conceptSlim };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// All employees with compensation summary (for the employees tab)
const listEmployeeCompensationSummaries = async (req, res) => {
  const employees = await knex('employees').where({ status: 'active' })
    .select('id', 'fullName', 'staffNumber', 'department', 'designation').orderBy('fullName', 'asc');
  const summaries = await Promise.all(employees.map(async emp => {
    const comps = await findMany('employee_compensations', { employeeId: emp.id, isActive: true });
    const totalEarnings     = comps.filter(c => c.category === 'earnings').reduce((s, c) => s + Number(c.amount || 0), 0);
    const totalDeductions   = comps.filter(c => c.category === 'deductions').reduce((s, c) => s + Number(c.amount || 0), 0);
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
    findOne('employees', { id: employeeId }),
    findOne('payroll_concepts', { id: conceptId }),
  ]);
  if (!emp)     return returnFunction(res, 404, false, 'Employee not found.');
  if (!concept) return returnFunction(res, 404, false, 'Concept not found.');

  const doc = {
    employeeId,
    conceptId,
    conceptName:  concept.name,
    conceptCode:  concept.code,
    category:     concept.category,
    subCategory:  concept.subCategory,
    amount:       Number(amount),
    currency:     currency || 'KES',
    effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
    effectiveTo:   effectiveTo   ? new Date(effectiveTo)   : null,
    cycleId:       cycleId       || null,
    isActive:      true,
    addedBy:       req.user?.id ?? null,
    notes:         notes || null,
    createdAt:     new Date(),
    updatedAt:     new Date(),
  };
  const result = await insertOne('employee_compensations', doc);
  logCompensationChange(doc.employeeId, result.id, doc.conceptName, 'added',
    [{ field: 'amount', oldValue: null, newValue: doc.amount }], req.user?.id);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
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

  const concept = await findOne('payroll_concepts', { id: conceptId });
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
    conceptId: concept.id, conceptName: concept.name, conceptCode: concept.code,
    category: concept.category, subCategory: concept.subCategory,
    currency: currency || 'KES',
    effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : now,
    effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
    cycleId: null, isActive: true,
    addedBy: req.user?.id ?? null,
    notes: notes || null,
    createdAt: now, updatedAt: now,
  };

  const hasPrincipal = principal !== undefined && principal !== null && principal !== '';

  if (targetType === 'employee' || targetType === 'employees') {
    const employeeIds = Array.isArray(target.employeeIds) ? target.employeeIds : [];
    if (employeeIds.length === 0) {
      return returnFunction(res, 400, false, 'Select at least one employee.');
    }

    const employees = await knex('employees').whereIn('id', employeeIds).select('id');
    if (employees.length !== employeeIds.length) {
      return returnFunction(res, 404, false, 'One or more employees were not found.');
    }

    const insertedIds = [];
    for (const empId of employeeIds) {
      const doc = {
        ...baseFields,
        scope: 'individual',
        employeeId: empId,
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
      insertedIds.push(result.id);
      logCompensationChange(doc.employeeId, result.id, doc.conceptName, 'added',
        [{ field: 'amount', oldValue: null, newValue: doc.amount }], req.user?.id);
    }
    return returnFunction(res, 201, true, req.locale.createdSuccessfully, { insertedIds });
  }

  // 'all' | 'department' | 'jobGroup' — a single shared assignment record, no running
  // balance possible (a loan needs one specific person's balance, not a group's). Gated
  // on the concept's own subCategory, not just whether a principal was supplied here —
  // a loan-type concept assigned group-wide with no balance would otherwise resolve as
  // an ordinary flat deduction (resolveConceptPayItems.js's pass 1), silently bypassing
  // every loan safeguard (balance tracking, loanStatus, auto-completion).
  if (hasPrincipal || concept.subCategory === 'loans') {
    return returnFunction(res, 400, false, 'A loan must target a specific employee, not a group — loans are always tied to one person\'s balance.');
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
    appliesTo = { type: 'jobGroup', jobGroupIds: target.jobGroupIds };
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
    appliesTo: JSON.stringify(appliesTo),
    amount: Number(amount) || 0,
  };
  const result = await insertOne('employee_compensations', doc);
  logCompensationChange(null, result.id, doc.conceptName, 'added',
    [{ field: 'amount', oldValue: null, newValue: doc.amount }], req.user?.id);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

// Update compensation item
const updateCompensation = async (req, res) => {
  const { id } = req.params;
  const existing = await findOne('employee_compensations', { id });
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

  await updateOne('employee_compensations', { id }, update);
  if (changes.length) {
    logCompensationChange(existing.employeeId, existing.id, existing.conceptName, 'updated', changes, req.user?.id);
  }
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Remove compensation item
const removeCompensation = async (req, res) => {
  const existing = await findOne('employee_compensations', { id: req.params.id });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('employee_compensations', { id: req.params.id }, { isActive: false, updatedAt: new Date() });
  logCompensationChange(existing.employeeId, existing.id, existing.conceptName, 'removed',
    [{ field: 'isActive', oldValue: true, newValue: false }], req.user?.id);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// Audit log for one employee's compensation history — viewable by HR on the employee's payroll profile
const getCompensationAuditLog = async (req, res) => {
  const logs = await findMany('compensation_audit_logs', { employeeId: req.params.employeeId }, { orderBy: { column: 'performedAt', order: 'desc' } });
  const userIds = [...new Set(logs.filter((l) => l.performedBy).map((l) => l.performedBy))];
  const users = userIds.length ? await knex('users').whereIn('id', userIds).select('id', 'name') : [];
  const userMap = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const enriched = logs.map((l) => ({ ...l, performedByName: l.performedBy ? (userMap[l.performedBy] || 'Unknown') : 'System' }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

module.exports = {
  getEmployeeCompensations, listEmployeeCompensationSummaries, addCompensation,
  assignConcept, updateCompensation, removeCompensation, getCompensationAuditLog,
  logCompensationChange,
};
