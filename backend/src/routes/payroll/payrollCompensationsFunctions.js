const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');

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

module.exports = { getEmployeeCompensations, listEmployeeCompensationSummaries, addCompensation, updateCompensation, removeCompensation, getCompensationAuditLog };
