const { ObjectId } = require('mongodb');
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
  if (role === 'employee') return { id: employee._id, name: employee.fullName };
  if (role === 'manager' && employee.managerId) {
    try {
      const mgr = await global.dbo.collection('employees').findOne(
        { _id: new ObjectId(String(employee.managerId)) },
        { projection: { _id: 1, fullName: 1 } }
      );
      if (mgr) return { id: mgr._id, name: mgr.fullName };
    } catch { /* fall through */ }
  }
  // HR, IT, Finance, Legal → role-based (no concrete assignee yet)
  return { id: null, name: assignTo || 'HR' };
}

async function triggerTasksFromTemplate(templateId, employeeId, referenceDate) {
  const tplOid = typeof templateId === 'string' ? new ObjectId(templateId) : templateId;
  const empOid = typeof employeeId === 'string' ? new ObjectId(employeeId) : employeeId;

  const [template, employee] = await Promise.all([
    global.dbo.collection('task_templates').findOne({ _id: tplOid }),
    global.dbo.collection('employees').findOne({ _id: empOid }),
  ]);

  if (!template || !employee) return { created: 0, error: 'Not found' };

  const docs = [];
  for (const tplTask of (template.tasks || [])) {
    const dueDate  = calculateDueDate(referenceDate, tplTask.dueOffset);
    const assignee = await resolveAssignee(tplTask.assignTo, employee);

    docs.push({
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
      linkedEmployeeId: employee._id,
      linkedEmployeeName: employee.fullName,

      templateId:       template._id,
      templateTaskId:   tplTask._id || null,
      sectionId:        tplTask.sectionId || null,

      dueDate:          dueDate.toISOString().split('T')[0],

      subtasks:         [],
      blockedByTaskIds: [],
      attachments:      [],
      comments:         [],
      activity: [{
        action:          'created',
        from:            null,
        to:              null,
        performedByName: 'System',
        timestamp:       new Date(),
      }],
      tags: [],

      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  if (!docs.length) return { created: 0 };

  await global.dbo.collection('tasks').insertMany(docs);

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
