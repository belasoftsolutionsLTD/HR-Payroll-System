// Postgres migration (Phase 9) — task_templates is Postgres now.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');

const ONBOARDING_TEMPLATE = {
  name: 'Standard Employee Onboarding',
  description: 'Default onboarding checklist for all new employees',
  triggerEvent: 'new_hire',
  applyTo: { type: 'all', departments: [], roles: [], employmentTypes: [] },
  isActive: true,
  isDefault: true,
  sections: [
    { _id: newId(), name: 'Before Day 1', order: 0 },
    { _id: newId(), name: 'Day 1',        order: 1 },
    { _id: newId(), name: 'Week 1',       order: 2 },
    { _id: newId(), name: 'Month 1',      order: 3 },
  ],
  get tasks() {
    const s = this.sections;
    return [
      { _id: newId(), title: 'Send welcome email',            type: 'action',   assignTo: 'HR',       priority: 'high',   sectionId: s[0]._id, order: 0, dueOffset: { direction: 'before', days: 3 }, description: '' },
      { _id: newId(), title: 'Set up company email account',  type: 'action',   assignTo: 'IT',       priority: 'high',   sectionId: s[0]._id, order: 1, dueOffset: { direction: 'before', days: 2 }, description: '' },
      { _id: newId(), title: 'Assign laptop',                 type: 'equipment',assignTo: 'IT',       priority: 'high',   sectionId: s[0]._id, order: 2, dueOffset: { direction: 'before', days: 1 }, description: '' },
      { _id: newId(), title: 'Add to Slack workspace',        type: 'action',   assignTo: 'IT',       priority: 'medium', sectionId: s[0]._id, order: 3, dueOffset: { direction: 'before', days: 1 }, description: '' },
      { _id: newId(), title: 'Prepare workstation',           type: 'action',   assignTo: 'Manager',  priority: 'medium', sectionId: s[0]._id, order: 4, dueOffset: { direction: 'before', days: 1 }, description: '' },
      { _id: newId(), title: 'Send pre-boarding documents',   type: 'document', assignTo: 'HR',       priority: 'high',   sectionId: s[0]._id, order: 5, dueOffset: { direction: 'before', days: 5 }, description: '' },
      { _id: newId(), title: 'Sign employment contract',      type: 'document', assignTo: 'Employee', priority: 'high',   sectionId: s[1]._id, order: 0, dueOffset: { direction: 'on',     days: 0 }, description: '', documentAction: 'sign' },
      { _id: newId(), title: 'Sign NDA',                      type: 'document', assignTo: 'Employee', priority: 'high',   sectionId: s[1]._id, order: 1, dueOffset: { direction: 'on',     days: 0 }, description: '', documentAction: 'sign' },
      { _id: newId(), title: 'Complete bank details form',    type: 'form',     assignTo: 'Employee', priority: 'high',   sectionId: s[1]._id, order: 2, dueOffset: { direction: 'on',     days: 0 }, description: '' },
      { _id: newId(), title: 'Complete emergency contact form',type:'form',     assignTo: 'Employee', priority: 'medium', sectionId: s[1]._id, order: 3, dueOffset: { direction: 'on',     days: 0 }, description: '' },
      { _id: newId(), title: 'Meet with manager (1:1)',       type: 'meeting',  assignTo: 'Manager',  priority: 'high',   sectionId: s[1]._id, order: 4, dueOffset: { direction: 'on',     days: 0 }, description: '', meetingDuration: 60 },
      { _id: newId(), title: 'Office/workspace tour',         type: 'meeting',  assignTo: 'Manager',  priority: 'medium', sectionId: s[1]._id, order: 5, dueOffset: { direction: 'on',     days: 0 }, description: '' },
      { _id: newId(), title: 'Complete company policy review', type:'document', assignTo: 'Employee', priority: 'medium', sectionId: s[2]._id, order: 0, dueOffset: { direction: 'after',  days: 3 }, description: '', documentAction: 'acknowledge' },
      { _id: newId(), title: 'IT security training',          type: 'form',     assignTo: 'Employee', priority: 'high',   sectionId: s[2]._id, order: 1, dueOffset: { direction: 'after',  days: 4 }, description: '' },
      { _id: newId(), title: 'Meet with team members',        type: 'meeting',  assignTo: 'Manager',  priority: 'medium', sectionId: s[2]._id, order: 2, dueOffset: { direction: 'after',  days: 2 }, description: '' },
      { _id: newId(), title: 'Set up development environment', type:'equipment',assignTo: 'IT',       priority: 'medium', sectionId: s[2]._id, order: 3, dueOffset: { direction: 'after',  days: 2 }, description: '' },
      { _id: newId(), title: 'Set 30-day goals',              type: 'form',     assignTo: 'Employee', priority: 'medium', sectionId: s[3]._id, order: 0, dueOffset: { direction: 'after',  days: 5 }, description: '' },
      { _id: newId(), title: '30-day check-in meeting',       type: 'meeting',  assignTo: 'Manager',  priority: 'high',   sectionId: s[3]._id, order: 1, dueOffset: { direction: 'after',  days: 30}, description: '', meetingDuration: 60 },
      { _id: newId(), title: 'Complete probation mid-point review', type:'form',assignTo: 'HR',      priority: 'high',   sectionId: s[3]._id, order: 2, dueOffset: { direction: 'after',  days: 45}, description: '' },
    ];
  },
  usageCount: 0,
  createdBy: 'System',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const OFFBOARDING_TEMPLATE = {
  name: 'Employee Exit Checklist',
  description: 'Standard offboarding process for departing employees',
  triggerEvent: 'offboarding',
  applyTo: { type: 'all', departments: [], roles: [], employmentTypes: [] },
  isActive: true,
  isDefault: true,
  sections: [
    { _id: newId(), name: 'Before Last Day', order: 0 },
    { _id: newId(), name: 'Last Day',        order: 1 },
  ],
  get tasks() {
    const s = this.sections;
    return [
      { _id: newId(), title: 'Submit resignation acceptance letter', type: 'document', assignTo: 'HR',       priority: 'high',   sectionId: s[0]._id, order: 0, dueOffset: { direction: 'before', days: 14 }, description: '' },
      { _id: newId(), title: 'Knowledge transfer document',          type: 'document', assignTo: 'Employee', priority: 'high',   sectionId: s[0]._id, order: 1, dueOffset: { direction: 'before', days: 7  }, description: '' },
      { _id: newId(), title: 'Schedule handover meetings',           type: 'meeting',  assignTo: 'Manager',  priority: 'high',   sectionId: s[0]._id, order: 2, dueOffset: { direction: 'before', days: 5  }, description: '' },
      { _id: newId(), title: 'Return company devices',               type: 'equipment',assignTo: 'IT',       priority: 'high',   sectionId: s[0]._id, order: 3, dueOffset: { direction: 'before', days: 1  }, description: '', deviceAction: 'return' },
      { _id: newId(), title: 'Exit interview',                       type: 'meeting',  assignTo: 'HR',       priority: 'high',   sectionId: s[1]._id, order: 0, dueOffset: { direction: 'on',     days: 0  }, description: '', meetingDuration: 60 },
      { _id: newId(), title: 'Revoke email access',                  type: 'action',   assignTo: 'IT',       priority: 'high',   sectionId: s[1]._id, order: 1, dueOffset: { direction: 'on',     days: 0  }, description: '' },
      { _id: newId(), title: 'Revoke Slack/Teams access',            type: 'action',   assignTo: 'IT',       priority: 'high',   sectionId: s[1]._id, order: 2, dueOffset: { direction: 'on',     days: 0  }, description: '' },
      { _id: newId(), title: 'Revoke all software access',           type: 'action',   assignTo: 'IT',       priority: 'high',   sectionId: s[1]._id, order: 3, dueOffset: { direction: 'on',     days: 0  }, description: '' },
      { _id: newId(), title: 'Final payslip confirmed',              type: 'approval', assignTo: 'Finance',  priority: 'high',   sectionId: s[1]._id, order: 4, dueOffset: { direction: 'on',     days: 0  }, description: '' },
      { _id: newId(), title: 'Issue reference letter',               type: 'document', assignTo: 'HR',       priority: 'medium', sectionId: s[1]._id, order: 5, dueOffset: { direction: 'on',     days: 0  }, description: '' },
    ];
  },
  usageCount: 0,
  createdBy: 'System',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PROBATION_TEMPLATE = {
  name: 'Probation Review',
  description: 'Tasks to complete when an employee reaches their probation end date',
  triggerEvent: 'probation_end',
  applyTo: { type: 'all', departments: [], roles: [], employmentTypes: [] },
  isActive: true,
  isDefault: true,
  sections: [
    { _id: newId(), name: 'Probation Review', order: 0 },
  ],
  get tasks() {
    const s = this.sections;
    return [
      { _id: newId(), title: 'Send probation review form to employee', type: 'form',    assignTo: 'HR',       priority: 'high', sectionId: s[0]._id, order: 0, dueOffset: { direction: 'before', days: 7 }, description: '' },
      { _id: newId(), title: 'Complete self-assessment',               type: 'form',    assignTo: 'Employee', priority: 'high', sectionId: s[0]._id, order: 1, dueOffset: { direction: 'before', days: 5 }, description: '' },
      { _id: newId(), title: 'Manager completes review form',          type: 'form',    assignTo: 'Manager',  priority: 'high', sectionId: s[0]._id, order: 2, dueOffset: { direction: 'before', days: 3 }, description: '' },
      { _id: newId(), title: 'Probation outcome meeting',              type: 'meeting', assignTo: 'Manager',  priority: 'high', sectionId: s[0]._id, order: 3, dueOffset: { direction: 'on',     days: 0 }, description: '', meetingDuration: 60 },
      { _id: newId(), title: 'Update contract status',                 type: 'action',  assignTo: 'HR',       priority: 'high', sectionId: s[0]._id, order: 4, dueOffset: { direction: 'after',  days: 1 }, description: 'Pass / extend / terminate based on outcome' },
    ];
  },
  usageCount: 0,
  createdBy: 'System',
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function seedDefaultTemplates() {
  for (const tpl of [ONBOARDING_TEMPLATE, OFFBOARDING_TEMPLATE, PROBATION_TEMPLATE]) {
    const exists = await knex('task_templates').where({ name: tpl.name, isDefault: true }).first();
    if (!exists) {
      const materializedTasks = tpl.tasks; // materialize getter before inserting
      await knex('task_templates').insert({
        id: newId(), name: tpl.name, description: tpl.description, triggerEvent: tpl.triggerEvent,
        applyTo: JSON.stringify(tpl.applyTo), isActive: tpl.isActive, isDefault: tpl.isDefault,
        sections: JSON.stringify(tpl.sections), tasks: JSON.stringify(materializedTasks),
        usageCount: tpl.usageCount, createdBy: tpl.createdBy, createdAt: tpl.createdAt, updatedAt: tpl.updatedAt,
      });
      console.log(`[Seed] Inserted default template: ${tpl.name}`);
    }
  }
}

module.exports = { seedDefaultTemplates };
