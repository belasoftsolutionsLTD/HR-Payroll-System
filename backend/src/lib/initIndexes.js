// Creates indexes on all major collections for production performance.
// Called once on startup after DB connection is established.

async function initIndexes() {
  const db = global.dbo;
  if (!db) return;

  const idx = (col, spec, opts = {}) =>
    db.collection(col).createIndex(spec, { background: true, ...opts }).catch(() => {});

  await Promise.all([
    // ── employees ────────────────────────────────────────────────────────────
    idx('employees', { email: 1 },           { unique: true, sparse: true }),
    idx('employees', { staffNumber: 1 },     { unique: true, sparse: true }),
    idx('employees', { department: 1 }),
    idx('employees', { status: 1 }),
    idx('employees', { managerId: 1 }),
    idx('employees', { fullName: 'text' }),

    // ── job_history ──────────────────────────────────────────────────────────
    idx('job_history', { employeeId: 1, effectiveDate: -1 }),

    // ── users ────────────────────────────────────────────────────────────────
    idx('users', { email: 1 },                    { unique: true }),
    idx('users', { employeeId: 1 },               { sparse: true }),
    idx('users', { refreshTokenHash: 1 },         { sparse: true }),
    idx('users', { passwordResetToken: 1 },       { sparse: true }),

    // ── audit_logs ───────────────────────────────────────────────────────────
    idx('audit_logs', { userId: 1 }),
    idx('audit_logs', { timestamp: -1 }),
    idx('audit_logs', { path: 1, timestamp: -1 }),

    // ── expense_claims ───────────────────────────────────────────────────────
    idx('expense_claims', { employeeId: 1, status: 1 }),
    idx('expense_claims', { status: 1 }),
    idx('expense_claims', { payrollCycleId: 1 }, { sparse: true }),
    idx('expense_claims', { department: 1 }),
    idx('expense_claims', { policyId: 1 }),

    // ── expense_policies / procurement_policies ─────────────────────────────
    idx('expense_policies', { isActive: 1, isDefault: 1 }),
    idx('procurement_policies', { isActive: 1, isDefault: 1 }),

    // ── Spend Management: Procurement ────────────────────────────────────────
    idx('purchase_requests', { employeeId: 1, status: 1 }),
    idx('purchase_requests', { department: 1 }),
    idx('purchase_requests', { status: 1 }),
    idx('vendors', { status: 1 }),
    idx('vendors', { category: 1 }),
    idx('purchase_orders', { requisitionId: 1 }),
    idx('purchase_orders', { vendorId: 1 }),
    idx('purchase_orders', { departmentId: 1 }),
    idx('purchase_orders', { status: 1 }),
    idx('purchase_orders', { poNumber: 1 }, { unique: true }),
    idx('goods_receipts', { purchaseOrderId: 1 }),
    idx('vendor_invoices', { purchaseOrderId: 1 }),
    idx('vendor_invoices', { vendorId: 1 }),
    idx('vendor_invoices', { status: 1 }),

    // ── training / LMS ───────────────────────────────────────────────────────
    idx('courses', { status: 1 }),
    idx('courses', { category: 1 }),
    idx('courses', { isMandatory: 1 }),
    idx('courseModules', { courseId: 1, order: 1 }),
    idx('trainingSessions', { courseId: 1, scheduledAt: 1 }),
    idx('trainingSessions', { attendeeIds: 1 }),
    idx('quizzes', { moduleId: 1 }),
    idx('quizzes', { courseId: 1 }),
    idx('learningPaths', { status: 1 }),
    idx('enrollments', { employeeId: 1 }),
    idx('enrollments', { courseId: 1 }),
    idx('enrollments', { learningPathId: 1 }),
    idx('enrollments', { status: 1 }),
    idx('enrollments', { employeeId: 1, courseId: 1 }, { unique: true, partialFilterExpression: { courseId: { $exists: true } } }),
    idx('certificates', { employeeId: 1 }),
    idx('certificates', { courseId: 1 }),
    idx('certificates', { certificateNumber: 1 }, { unique: true }),
    idx('externalCertificates', { employeeId: 1 }),
    idx('externalCertificates', { status: 1 }),
    idx('trainingAssignmentRules', { isActive: 1, trigger: 1 }),
    idx('trainingFeedback', { courseId: 1 }),
    idx('ruleExecutionLogs', { ruleId: 1, runAt: -1 }),

    // ── onboarding_tasks ─────────────────────────────────────────────────────
    idx('onboarding_tasks', { employeeId: 1 }),
    idx('onboarding_tasks', { status: 1, dueDate: 1 }),

    // ── devices ──────────────────────────────────────────────────────────────
    idx('devices', { assignedTo: 1 }, { sparse: true }),
    idx('devices', { warrantyExpiry: 1 }, { sparse: true }),

    // ── payroll_results ───────────────────────────────────────────────────────
    idx('payroll_results', { cycleId: 1 }),
    idx('payroll_results', { employeeId: 1 }),
    idx('payroll_results', { cycleId: 1, status: 1 }),

    // ── leave_requests ───────────────────────────────────────────────────────
    idx('leave_requests', { employeeId: 1 }),
    idx('leave_requests', { status: 1 }),
    idx('leave_requests', { startDate: 1, endDate: 1 }),
    idx('leave_requests', { employeeId: 1, status: 1 }),

    // ── leave_balances ───────────────────────────────────────────────────────
    idx('leave_balances', { employeeId: 1, year: 1 }),
    idx('leave_balances', { employeeId: 1, leaveTypeId: 1, year: 1 }),

    // ── leave_types / leave_accrual_policies / public_holidays / leave_blackouts / leave_audit_log ──
    idx('leave_types', { code: 1 }),
    idx('leave_types', { isActive: 1 }),
    idx('leave_accrual_policies', { leaveTypeId: 1 }),
    idx('leave_accrual_policies', { isActive: 1 }),
    idx('public_holidays', { date: 1 }),
    idx('leave_blackouts', { startDate: 1, endDate: 1 }),
    idx('leave_audit_log', { leaveRequestId: 1 }),
    idx('leave_audit_log', { employeeId: 1 }),

    // ── attendance_records ───────────────────────────────────────────────────
    idx('attendance_records', { employeeId: 1, date: 1 }),
    idx('attendance_records', { date: 1, status: 1 }),

    // ── shifts / shift_applications ──────────────────────────────────────────
    idx('shifts', { employeeId: 1, date: 1 }),
    idx('shifts', { date: 1, isOpen: 1 }),
    idx('shift_applications', { shiftId: 1, employeeId: 1 }),
    idx('shift_applications', { employeeId: 1 }),

    // ── timesheets ────────────────────────────────────────────────────────────
    idx('timesheets', { employeeId: 1, weekStart: 1 }),
    idx('timesheets', { status: 1, payrollRunId: 1 }),

    // ── work_schedules / employeeShiftAssignments ────────────────────────────
    idx('employeeShiftAssignments', { employeeId: 1, effectiveFrom: 1 }),

    // ── tasks ────────────────────────────────────────────────────────────────
    idx('tasks', { assignedTo: 1 }),
    idx('tasks', { status: 1 }),
    idx('tasks', { dueDate: 1 }),
    idx('tasks', { assignedTo: 1, status: 1 }),
    idx('tasks', { linkedEmployeeId: 1 }),
    idx('tasks', { department: 1 }),
    idx('tasks', { module: 1 }),
    idx('tasks', { templateId: 1 },          { sparse: true }),

    // ── task_templates ───────────────────────────────────────────────────────
    idx('task_templates', { triggerEvent: 1 }),
    idx('task_templates', { isActive: 1 }),

    // ── inbox_items ──────────────────────────────────────────────────────────
    idx('inbox_items', { recipientId: 1 }),
    idx('inbox_items', { status: 1 }),
    idx('inbox_items', { recipientId: 1, status: 1 }),
    idx('inbox_items', { createdAt: -1 }),

    // ── notifications ────────────────────────────────────────────────────────
    idx('notifications', { recipientId: 1 }),
    idx('notifications', { isRead: 1 }),
    idx('notifications', { recipientId: 1, isRead: 1 }),
    idx('notifications', { createdAt: -1 }),

    // ── payroll_cycles ───────────────────────────────────────────────────────
    // Not unique: multiple cycles can share a calendar month once weekly/biweekly pay
    // frequencies and off-cycle runs are in play (see payrollCyclesFunctions.js createCycle,
    // which enforces the real non-overlap rule at the app level instead).
    idx('payroll_cycles', { status: 1 }),
    idx('payroll_cycles', { 'period.month': 1, 'period.year': 1 }),
    idx('payroll_cycles', { payFrequency: 1 }),
    idx('payroll_cycles', { runType: 1 }),

    // ── staff_loans ──────────────────────────────────────────────────────────
    idx('staff_loans', { employeeId: 1, status: 1 }),

    // ── payslips ─────────────────────────────────────────────────────────────
    idx('payslips', { employeeId: 1 }),
    idx('payslips', { cycleId: 1 }),

    // ── employee_compensations ───────────────────────────────────────────────
    idx('employee_compensations', { employeeId: 1, isActive: 1 }),
    idx('employee_compensations', { conceptId: 1 }),
    idx('employee_compensations', { scope: 1, isActive: 1 }),

    // ── compensation_audit_logs ──────────────────────────────────────────────
    idx('compensation_audit_logs', { employeeId: 1, performedAt: -1 }),

    // ── payroll_concepts ─────────────────────────────────────────────────────
    idx('payroll_concepts', { category: 1 }),
    idx('payroll_concepts', { alertIfUndefined: 1, isActive: 1 }),

    // ── jobRequisitions ───────────────────────────────────────────────────────
    idx('jobRequisitions', { status: 1 }),
    idx('jobRequisitions', { department: 1 }),
    idx('jobRequisitions', { hiringManagerId: 1 }),

    // ── applications ─────────────────────────────────────────────────────────
    idx('applications', { requisitionId: 1 }),
    idx('applications', { candidateId: 1 }),
    idx('applications', { requisitionId: 1, currentStageId: 1 }),
    idx('applications', { status: 1 }),

    // ── scorecards ───────────────────────────────────────────────────────────
    idx('scorecards', { applicationId: 1 }),
    idx('scorecards', { applicationId: 1, stageId: 1, interviewerId: 1 }, { unique: true }),

    // ── candidates ───────────────────────────────────────────────────────────
    idx('candidates', { email: 1 }, { unique: true }),
    idx('candidates', { tags: 1 }),
    idx('candidates', { isPassiveTalent: 1 }),
    idx('candidates', { source: 1 }),

    // ── nurtureCampaigns ─────────────────────────────────────────────────────
    idx('nurtureCampaigns', { status: 1 }),
    idx('nurtureCampaigns', { targetTags: 1 }),

    // ── emailTemplates ───────────────────────────────────────────────────────
    idx('emailTemplates', { trigger: 1 }),

    // ── expenses ─────────────────────────────────────────────────────────────
    idx('expenses', { submittedBy: 1 }),
    idx('expenses', { status: 1 }),
    idx('expenses', { submittedBy: 1, status: 1 }),

    // ── reviews ──────────────────────────────────────────────────────────────
    // Was indexed under the wrong collection name ('performance_reviews') — the actual
    // collection reads/writes go to 'reviews' (performanceFunctions.js), so these indexes
    // never applied to any real query.
    idx('reviews', { employeeId: 1 }),
    idx('reviews', { cycleId: 1 }),
    idx('reviews', { status: 1 }),

    // ── review_cycles ────────────────────────────────────────────────────────
    idx('review_cycles', { status: 1 }),
    idx('review_cycles', { 'participants.employeeId': 1 }),

    // ── review_templates ─────────────────────────────────────────────────────
    idx('review_templates', { isActive: 1 }),

    // ── oneOnOnes ────────────────────────────────────────────────────────────
    idx('oneOnOnes', { managerId: 1 }),
    idx('oneOnOnes', { employeeId: 1 }),
    idx('oneOnOnes', { scheduledAt: -1 }),

    // ── performanceImprovementPlans ──────────────────────────────────────────
    idx('performanceImprovementPlans', { employeeId: 1 }),
    idx('performanceImprovementPlans', { managerId: 1 }),
    idx('performanceImprovementPlans', { status: 1 }),

    // ── goals ────────────────────────────────────────────────────────────────
    idx('goals', { employeeId: 1 }),
    idx('goals', { cycleId: 1 },             { sparse: true }),
    idx('goals', { status: 1 }),
    idx('goals', { department: 1 },          { sparse: true }),

    // ── awards ───────────────────────────────────────────────────────────────
    idx('awards', { recipientId: 1 }),
    idx('awards', { grantedBy: 1 }),
    idx('awards', { type: 1 }),
    idx('awards', { createdAt: -1 }),

    // ── announcements ────────────────────────────────────────────────────────
    idx('announcements', { createdAt: -1 }),
    idx('announcements', { isPublished: 1 }),

    // ── messages ────────────────────────────────────────────────────────────
    idx('messages', { participants: 1 }),
    idx('messages', { createdAt: -1 }),

    // ── customReports (Reports module) ──────────────────────────────────────
    idx('customReports', { createdBy: 1 }),
    idx('customReports', { 'schedule.nextRunAt': 1 }, { sparse: true }),
  ]);
}

module.exports = { initIndexes };
