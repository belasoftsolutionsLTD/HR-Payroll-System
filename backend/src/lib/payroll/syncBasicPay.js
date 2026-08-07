// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md) —
// payroll_concepts, employee_compensations, and compensation_audit_logs all now live in
// Postgres (compensation_audit_logs since Phase 1, payroll_concepts/employee_compensations
// since Phase 2).
const { findOne, insertOne, updateOne } = require('../../functions/Database/pgDBFunctions');

const BASIC_PAY_CODE = 'BASIC';

async function ensureBasicPayConcept(actorUserId) {
  const existing = await findOne('payroll_concepts', { code: BASIC_PAY_CODE });
  if (existing) return existing;
  const doc = {
    name: 'Basic Pay', code: BASIC_PAY_CODE, category: 'earnings', subCategory: 'fixed_pay',
    type: 'fixed', currency: 'KES', isActive: true,
    createdBy: actorUserId ?? null, createdAt: new Date(), updatedAt: new Date(),
  };
  return insertOne('payroll_concepts', doc);
}

// Keeps the employee record's `grossPay` field (set on the Add/Edit Employee form) in
// sync with the actual "Basic Pay" employee_compensations line the payroll engine reads
// from — those two were previously disconnected: setting a salary on the employee form
// did nothing to payroll unless HR separately visited Payroll > Employee Compensations
// and added a matching item by hand. Silent divergence meant a new hire's real payroll
// gross pay was whatever job-group allowances happened to apply, often near-zero.
async function syncBasicPayCompensation(employeeId, grossPay, actorUserId, effectiveFrom) {
  const empId = String(employeeId);
  const existing = await findOne('employee_compensations', {
    employeeId: empId, conceptCode: BASIC_PAY_CODE, isActive: true,
  });

  // grossPay cleared/zeroed — deactivate any existing auto-synced Basic Pay line rather
  // than leaving a stale amount that no longer reflects the employee record.
  if (!grossPay || grossPay <= 0) {
    if (existing) {
      await updateOne('employee_compensations', { id: existing.id }, { isActive: false, updatedAt: new Date() });
      await insertOne('compensation_audit_logs', {
        employeeId: empId, compensationId: existing.id, conceptName: existing.conceptName, action: 'removed',
        changes: JSON.stringify([{ field: 'isActive', oldValue: true, newValue: false }]),
        performedBy: actorUserId ? String(actorUserId) : null, performedAt: new Date(),
      }).catch(() => {});
    }
    return;
  }

  if (existing) {
    if (Number(existing.amount) === Number(grossPay)) return;
    await updateOne('employee_compensations', { id: existing.id }, { amount: grossPay, updatedAt: new Date() });
    await insertOne('compensation_audit_logs', {
      employeeId: empId, compensationId: existing.id, conceptName: existing.conceptName, action: 'updated',
      changes: JSON.stringify([{ field: 'amount', oldValue: existing.amount, newValue: grossPay }]),
      performedBy: actorUserId ? String(actorUserId) : null, performedAt: new Date(),
    }).catch(() => {});
    return;
  }

  const concept = await ensureBasicPayConcept(actorUserId);
  const doc = {
    employeeId: empId,
    conceptId: concept.id, conceptName: concept.name, conceptCode: concept.code,
    category: concept.category, subCategory: concept.subCategory,
    amount: grossPay, currency: concept.currency || 'KES',
    effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
    effectiveTo: null, cycleId: null, isActive: true,
    addedBy: actorUserId ?? null, notes: 'Auto-synced from employee grossPay',
    createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await insertOne('employee_compensations', doc);
  await insertOne('compensation_audit_logs', {
    employeeId: empId, compensationId: result.id, conceptName: doc.conceptName, action: 'added',
    changes: JSON.stringify([{ field: 'amount', oldValue: null, newValue: grossPay }]),
    performedBy: actorUserId ? String(actorUserId) : null, performedAt: new Date(),
  }).catch(() => {});
}

module.exports = { syncBasicPayCompensation };
