// Postgres migration (Phase 9) — tasks/task_templates are Postgres now.
// employees are Postgres since Phase 1.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const { notifyEmployee } = require('../../functions/HR/notifyUser');

function calculateDueDate(referenceDate, dueOffset) {
  const ref = new Date(referenceDate);
  const { direction = 'after', days = 0 } = dueOffset || {};
  if (direction === 'before') ref.setDate(ref.getDate() - days);
  else if (direction === 'after') ref.setDate(ref.getDate() + days);
  // 'on' → same date
  return ref;
}

async function resolveAssignee(assignTo, employee) {
  const role = (assignTo || '').toLowerCase();
  if (role === 'employee') return { id: employee.id, name: employee.fullName };
  if (role === 'manager' && employee.managerId) {
    const mgr = await knex('employees').where({ id: String(employee.managerId) }).select('id', 'fullName').first();
    if (mgr) return { id: mgr.id, name: mgr.fullName };
  }
  // HR, IT, Finance, Legal → role-based (no concrete assignee yet)
  return { id: null, name: assignTo || 'HR' };
}

async function triggerTasksFromTemplate(templateId, employeeId, referenceDate) {
  const [template, employee] = await Promise.all([
    knex('task_templates').where({ id: String(templateId) }).first(),
    knex('employees').where({ id: String(employeeId) }).first(),
  ]);

  if (!template || !employee) return { created: 0, error: 'Not found' };

  const docs = [];
  for (const tplTask of (template.tasks || [])) {
    const dueDate  = calculateDueDate(referenceDate, tplTask.dueOffset);
    const assignee = await resolveAssignee(tplTask.assignTo, employee);

    docs.push({
      id: newId(),
      title:            tplTask.title,
      description:      tplTask.description || '',
      status:           'not_started',
      priority:         tplTask.priority || 'medium',
      type:             tplTask.type || 'action',

      assignedTo:       assignee.id,
      assignedToName:   assignee.id ? assignee.name : (tplTask.assignTo || 'HR'),
      assignedToRole:   tplTask.assignTo,  // 'hr' | 'it' | 'employee' | 'manager' | 'finance'
      assignedBy:       'System',
      department:       employee.department || '',

      module:           template.triggerEvent || 'general',
      linkedEmployeeId: employee.id,
      linkedEmployeeName: employee.fullName,

      templateId:       template.id,
      templateTaskId:   tplTask._id || null,
      sectionId:        tplTask.sectionId || null,

      dueDate:          dueDate.toISOString().split('T')[0],

      meetingAttendees: JSON.stringify([]),
      blockedByTaskIds: JSON.stringify([]),
      attachments:      JSON.stringify([]),
      tags:             JSON.stringify([]),

      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  if (!docs.length) return { created: 0 };

  const saved = await knex('tasks').insert(docs).returning('id');
  await knex('task_activity').insert(docs.map((d) => ({
    taskId: d.id, action: 'created', fromValue: null, toValue: null, performedByName: 'System', timestamp: d.createdAt,
  })));

  const notified = new Set();
  for (const doc of docs) {
    if (doc.assignedTo && !notified.has(String(doc.assignedTo))) {
      notified.add(String(doc.assignedTo));
      notifyEmployee(doc.assignedTo, {
        title: `New task: ${doc.title}`,
        body:  `From "${template.name}" · Due ${doc.dueDate}`,
        type:  'task',
      });
    }
  }

  return { created: docs.length };
}

module.exports = { triggerTasksFromTemplate, calculateDueDate };
