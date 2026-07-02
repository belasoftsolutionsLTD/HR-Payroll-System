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

    // ── training ─────────────────────────────────────────────────────────────
    idx('training_enrollments', { userId: 1 }),
    idx('training_enrollments', { courseId: 1 }),
    idx('training_enrollments', { userId: 1, courseId: 1 }, { unique: true }),
    idx('training_enrollments', { status: 1 }),

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

    // ── clock_entries ────────────────────────────────────────────────────────
    idx('clock_entries', { employeeId: 1 }),
    idx('clock_entries', { date: 1 }),
    idx('clock_entries', { employeeId: 1, date: 1 }),
    idx('clock_entries', { status: 1 }),

    // ── attendance_records ───────────────────────────────────────────────────
    idx('attendance_records', { employeeId: 1, date: 1 }),
    idx('attendance_records', { department: 1, date: 1 }),

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

    // ── payroll_summaries ────────────────────────────────────────────────────
    idx('payroll_summaries', { employeeId: 1 }),
    idx('payroll_summaries', { month: 1, year: 1 }),
    idx('payroll_summaries', { employeeId: 1, month: 1, year: 1 }, { unique: true }),

    // ── payroll_cycles ───────────────────────────────────────────────────────
    idx('payroll_cycles', { status: 1 }),
    idx('payroll_cycles', { month: 1, year: 1 }),

    // ── recruitment_applications ─────────────────────────────────────────────
    idx('recruitment_applications', { positionId: 1 }),
    idx('recruitment_applications', { stage: 1 }),
    idx('recruitment_applications', { email: 1 }),
    idx('recruitment_applications', { positionId: 1, stage: 1 }),

    // ── recruitment_positions ────────────────────────────────────────────────
    idx('recruitment_positions', { status: 1 }),
    idx('recruitment_positions', { department: 1 }),

    // ── expenses ─────────────────────────────────────────────────────────────
    idx('expenses', { submittedBy: 1 }),
    idx('expenses', { status: 1 }),
    idx('expenses', { submittedBy: 1, status: 1 }),

    // ── performance_reviews ──────────────────────────────────────────────────
    idx('performance_reviews', { employeeId: 1 }),
    idx('performance_reviews', { cycleId: 1 }),
    idx('performance_reviews', { status: 1 }),

    // ── goals ────────────────────────────────────────────────────────────────
    idx('goals', { employeeId: 1 }),
    idx('goals', { cycleId: 1 },             { sparse: true }),
    idx('goals', { status: 1 }),

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
  ]);
}

module.exports = { initIndexes };
