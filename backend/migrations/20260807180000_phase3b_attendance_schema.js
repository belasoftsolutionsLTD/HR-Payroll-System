// Phase 3b of the Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md):
// Attendance — the second half of "Leave + Attendance, the shared time domain."
// attendance_records, timesheets, shifts (+ its task-checklist/notes/applications
// sub-features), attendance_settings, work_schedules, employeeShiftAssignments.
//
// Same conventions as Phases 1-3a: ids stay as unchanged Mongo ObjectId-hex TEXT
// primary keys, camelCase columns, nullability generous until checked against real
// data, attribution-only fields (markedBy/approvedBy/createdBy/assignedBy/resolvedBy)
// get no FK constraint by default (matching the now-repeated real-orphan finding in
// every phase so far) — added back only for columns confirmed clean via a live check.

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  await knex.schema.createTable('attendance_records', (t) => {
    t.text('id').primary();
    // No ON DELETE CASCADE / no FK enforcement gap either way — real data confirmed
    // 2/14 employeeId values already point at since-deleted employees, matching every
    // other phase's "don't invent a stricter guarantee than Mongo ever had" finding.
    t.text('employeeId').notNullable();
    t.text('date').notNullable(); // 'YYYY-MM-DD' string, matching the original exactly
    t.text('status');
    t.text('checkInTime'); // 'HH:MM' string
    t.text('checkOutTime');
    t.timestamp('checkInAt', { useTz: true });
    t.timestamp('checkOutAt', { useTz: true });
    t.decimal('checkInLat', 10, 6);
    t.decimal('checkInLng', 10, 6);
    t.decimal('checkOutLat', 10, 6);
    t.decimal('checkOutLng', 10, 6);
    t.text('checkInLocation');
    t.text('checkOutLocation');
    t.text('location'); // 'office' | 'remote' | 'field' | 'client site'
    t.text('mode'); // 'onsite' | 'remote' — geofence result at clock-in
    t.boolean('selfMarked').defaultTo(false);
    t.boolean('isManualEntry').defaultTo(false);
    t.text('markedBy');
    t.text('notes');
    t.integer('totalWorkMinutes');
    t.integer('totalBreakMinutes');
    t.integer('regularMinutes');
    t.integer('overtimeMinutes');
    t.decimal('overtimeHours', 10, 2);
    t.jsonb('overtimeBreakdown'); // {weekdayDayMins, weekdayNightMins, weekendDayMins, weekendNightMins}
    t.text('payCategory');
    t.boolean('lateMarked').defaultTo(false);
    t.boolean('missedClockOutNotified').defaultTo(false);
    t.boolean('autoMarked').defaultTo(false);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    // Every write path (markAttendance, clockIn, clockOut, bulkImportAttendance) upserts
    // by (employeeId, date) — a real, enforced guarantee, unlike the loose passthrough
    // collections elsewhere.
    t.unique(['employeeId', 'date']);
    t.index('date');
    t.index('status');
  });

  // breakStart/breakEnd are real row-level operations (insert one row; find-and-update
  // the one open row), not a whole-array replace — a child table matches that better
  // than JSONB here, unlike leave_requests.approvalChain in Phase 3a.
  await knex.schema.createTable('attendance_breaks', (t) => {
    t.increments('id');
    t.text('attendanceRecordId').notNullable().references('id').inTable('attendance_records').onDelete('CASCADE');
    t.timestamp('startTime', { useTz: true }).notNullable();
    t.timestamp('endTime', { useTz: true });
    t.integer('duration'); // minutes, set once endTime is set

    t.index('attendanceRecordId');
  });

  await knex.schema.createTable('work_schedules', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.specificType('workDays', 'text[]');
    t.text('startTime');
    t.text('endTime');
    t.integer('breakMinutes');
    t.integer('weeklyHours');
    t.integer('gracePeriod');
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('shift_task_templates', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.specificType('tasks', 'text[]');
    t.boolean('isActive').defaultTo(true);
    t.text('createdBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });

  await knex.schema.createTable('shifts', (t) => {
    t.text('id').primary();
    // Nullable — open-marketplace shifts have no assigned employee yet.
    t.text('employeeId').references('id').inTable('employees');
    t.text('date').notNullable();
    t.text('shiftType');
    t.text('startTime');
    t.text('endTime');
    t.integer('breakMinutes');
    t.text('location');
    t.text('address');
    t.decimal('addressLat', 10, 6);
    t.decimal('addressLng', 10, 6);
    t.text('notes');
    t.text('taskTemplateId').references('id').inTable('shift_task_templates');
    // Two different field names for the same "who scheduled this" concept in the
    // original — createShift writes assignedBy, bulkCreateShifts writes createdBy.
    // Preserved as-is (both columns) rather than silently consolidated.
    t.text('assignedBy');
    t.text('createdBy');
    t.boolean('isOpen').defaultTo(false);
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index(['employeeId', 'date']);
    t.index('date');
    t.index('isOpen');
  });

  await knex.schema.createTable('shift_tasks', (t) => {
    t.text('id').primary();
    t.text('shiftId').notNullable().references('id').inTable('shifts').onDelete('CASCADE');
    t.text('title');
    t.integer('order');
    t.boolean('completed').defaultTo(false);
    t.timestamp('completedAt', { useTz: true });
    t.text('completedBy');
    t.timestamp('createdAt', { useTz: true });

    t.index('shiftId');
  });

  await knex.schema.createTable('shift_notes', (t) => {
    t.text('id').primary();
    t.text('shiftId').notNullable().references('id').inTable('shifts').onDelete('CASCADE');
    t.text('employeeId').references('id').inTable('employees');
    t.text('authorName');
    t.text('type'); // 'progress' | 'incident'
    t.text('text');
    t.timestamp('createdAt', { useTz: true });

    t.index('shiftId');
  });

  await knex.schema.createTable('shift_applications', (t) => {
    t.text('id').primary();
    t.text('shiftId').notNullable().references('id').inTable('shifts').onDelete('CASCADE');
    t.text('employeeId').references('id').inTable('employees');
    t.text('employeeName');
    t.text('status').defaultTo('pending');
    t.text('note');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('resolvedAt', { useTz: true });
    t.text('resolvedBy');

    t.index('shiftId');
    t.index('employeeId');
  });

  await knex.schema.createTable('employeeShiftAssignments', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees');
    t.text('scheduleId').notNullable().references('id').inTable('work_schedules');
    t.timestamp('effectiveFrom', { useTz: true }).notNullable();
    t.timestamp('effectiveTo', { useTz: true });
    t.text('assignedBy');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.index(['employeeId', 'effectiveFrom']);
  });

  await knex.schema.createTable('timesheets', (t) => {
    t.text('id').primary();
    t.text('employeeId').notNullable().references('id').inTable('employees');
    t.timestamp('weekStart', { useTz: true }).notNullable();
    t.timestamp('weekEnd', { useTz: true });
    // entries[] — a small (7 days/week), fixed-shape array always fully replaced
    // together on every save (buildTimesheetEntries re-derives all 7 days from
    // attendance/shift data each time), same reasoning as leave_requests.approvalChain
    // in Phase 3a — not a real per-row entity like payroll_results' line items.
    t.jsonb('entries');
    t.integer('totalMinutes');
    t.integer('totalRegularMinutes');
    t.integer('overtimeMinutes');
    t.jsonb('overtimeBreakdown');
    t.integer('totalBreakMinutes');
    t.text('status').defaultTo('draft');
    t.timestamp('submittedAt', { useTz: true });
    t.text('approvedBy');
    t.timestamp('approvedAt', { useTz: true });
    t.text('rejectionReason');
    t.text('payrollRunId'); // no FK — payroll_cycles' own id, cross-checked in app code only
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });

    t.unique(['employeeId', 'weekStart']);
    t.index('status');
  });

  // Singleton settings blob — saveSettings is a `{...req.body}` passthrough with no
  // fixed field whitelist (same shape as Phase 1's branches/departments), and real data
  // shows a wider, more loosely-defined field set than the handful this file's code
  // actually reads back (autoClockOutEnabled/Time, breakTracking, clockInMethods[],
  // geofencingEnabled, gracePeriodMinutes, maxBreakMinutes, selfMarkEnabled, its own
  // officeLatitude/Longitude/RadiusMeters that clockIn doesn't actually read from here —
  // it reads company_settings' copies instead, apparently a legacy duplicate). A JSONB
  // catch-all avoids silently dropping a field HR's settings UI sends that this
  // migration's author didn't happen to enumerate.
  await knex.schema.createTable('attendance_settings', (t) => {
    t.text('id').primary(); // always 'singleton' — see pgDBFunctions usage in the handler
    t.jsonb('data');
    t.timestamp('createdAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true });
  });
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('attendance_settings');
  await knex.schema.dropTableIfExists('timesheets');
  await knex.schema.dropTableIfExists('employeeShiftAssignments');
  await knex.schema.dropTableIfExists('shift_applications');
  await knex.schema.dropTableIfExists('shift_notes');
  await knex.schema.dropTableIfExists('shift_tasks');
  await knex.schema.dropTableIfExists('shifts');
  await knex.schema.dropTableIfExists('shift_task_templates');
  await knex.schema.dropTableIfExists('work_schedules');
  await knex.schema.dropTableIfExists('attendance_breaks');
  await knex.schema.dropTableIfExists('attendance_records');
};
