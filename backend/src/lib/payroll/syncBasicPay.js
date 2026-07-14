const { ObjectId } = require('mongodb');
const { findOne, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');

const BASIC_PAY_CODE = 'BASIC';

async function ensureBasicPayConcept(actorUserId) {
  const existing = await findOne('payroll_concepts', { code: BASIC_PAY_CODE });
  if (existing) return existing;
  const doc = {
    name: 'Basic Pay', code: BASIC_PAY_CODE, category: 'earnings', subCategory: 'fixed_pay',
    type: 'fixed', currency: 'KES', isActive: true,
    createdBy: actorUserId ?? null, createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('payroll_concepts', doc);
  return { _id: result.insertedId, ...doc };
}

// Keeps the employee record's `grossPay` field (set on the Add/Edit Employee form) in
// sync with the actual "Basic Pay" employee_compensations line the payroll engine reads
// from — those two were previously disconnected: setting a salary on the employee form
// did nothing to payroll unless HR separately visited Payroll > Employee Compensations
// and added a matching item by hand. Silent divergence meant a new hire's real payroll
// gross pay was whatever job-group allowances happened to apply, often near-zero.
async function syncBasicPayCompensation(employeeId, grossPay, actorUserId, effectiveFrom) {
  const empObjectId = typeof employeeId === 'string' ? new ObjectId(employeeId) : employeeId;
  const existing = await findOne('employee_compensations', {
    employeeId: empObjectId, conceptCode: BASIC_PAY_CODE, isActive: true,
  });

  // grossPay cleared/zeroed — deactivate any existing auto-synced Basic Pay line rather
  // than leaving a stale amount that no longer reflects the employee record.
  if (!grossPay || grossPay <= 0) {
    if (existing) {
      await updateOne('employee_compensations', { _id: existing._id }, { $set: { isActive: false, updatedAt: new Date() } });
      await insertOne('compensation_audit_logs', {
        employeeId: empObjectId, compensationId: existing._id, conceptName: existing.conceptName, action: 'removed',
        changes: [{ field: 'isActive', oldValue: true, newValue: false }],
        performedBy: actorUserId ?? null, performedAt: new Date(),
      }).catch(() => {});
    }
    return;
  }

  if (existing) {
    if (existing.amount === grossPay) return;
    await updateOne('employee_compensations', { _id: existing._id }, { $set: { amount: grossPay, updatedAt: new Date() } });
    await insertOne('compensation_audit_logs', {
      employeeId: empObjectId, compensationId: existing._id, conceptName: existing.conceptName, action: 'updated',
      changes: [{ field: 'amount', oldValue: existing.amount, newValue: grossPay }],
      performedBy: actorUserId ?? null, performedAt: new Date(),
    }).catch(() => {});
    return;
  }

  const concept = await ensureBasicPayConcept(actorUserId);
  const doc = {
    employeeId: empObjectId,
    conceptId: concept._id, conceptName: concept.name, conceptCode: concept.code,
    category: concept.category, subCategory: concept.subCategory,
    amount: grossPay, currency: concept.currency || 'KES',
    effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
    effectiveTo: null, cycleId: null, isActive: true,
    addedBy: actorUserId ?? null, notes: 'Auto-synced from employee grossPay',
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('employee_compensations', doc);
  await insertOne('compensation_audit_logs', {
    employeeId: empObjectId, compensationId: result.insertedId, conceptName: doc.conceptName, action: 'added',
    changes: [{ field: 'amount', oldValue: null, newValue: grossPay }],
    performedBy: actorUserId ?? null, performedAt: new Date(),
  }).catch(() => {});
}

module.exports = { syncBasicPayCompensation };
