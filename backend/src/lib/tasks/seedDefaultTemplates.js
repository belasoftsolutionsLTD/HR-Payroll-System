const { ObjectId } = require('mongodb');

const ONBOARDING_TEMPLATE = {
  name: 'Standard Employee Onboarding',
  description: 'Default onboarding checklist for all new employees',
  triggerEvent: 'new_hire',
  applyTo: { type: 'all', departments: [], roles: [], employmentTypes: [] },
  isActive: true,
  isDefault: true,
  sections: [
    { _id: new ObjectId(), name: 'Before Day 1', order: 0 },
    { _id: new ObjectId(), name: 'Day 1',        order: 1 },
    { _id: new ObjectId(), name: 'Week 1',       order: 2 },
    { _id: new ObjectId(), name: 'Month 1',      order: 3 },
  ],
  get tasks() {
    const s = this.sections;
    return [
      { _id: new ObjectId(), title: 'Send welcome email',            type: 'action',   assignTo: 'HR',       priority: 'high',   sectionId: s[0]._id, order: 0, dueOffset: { direction: 'before', days: 3 }, description: '' },
      { _id: new ObjectId(), title: 'Set up company email account',  type: 'action',   assignTo: 'IT',       priority: 'high',   sectionId: s[0]._id, order: 1, dueOffset: { direction: 'before', days: 2 }, description: '' },
      { _id: new ObjectId(), title: 'Assign laptop',                 type: 'equipment',assignTo: 'IT',       priority: 'high',   sectionId: s[0]._id, order: 2, dueOffset: { direction: 'before', days: 1 }, description: '' },
      { _id: new ObjectId(), title: 'Add to Slack workspace',        type: 'action',   assignTo: 'IT',       priority: 'medium', sectionId: s[0]._id, order: 3, dueOffset: { direction: 'before', days: 1 }, description: '' },
      { _id: new ObjectId(), title: 'Prepare workstation',           type: 'action',   assignTo: 'Manager',  priority: 'medium', sectionId: s[0]._id, order: 4, dueOffset: { direction: 'before', days: 1 }, description: '' },
      { _id: new ObjectId(), title: 'Send pre-boarding documents',   type: 'document', assignTo: 'HR',       priority: 'high',   sectionId: s[0]._id, order: 5, dueOffset: { direction: 'before', days: 5 }, description: '' },
      { _id: new ObjectId(), title: 'Sign employment contract',      type: 'document', assignTo: 'Employee', priority: 'high',   sectionId: s[1]._id, order: 0, dueOffset: { direction: 'on',     days: 0 }, description: '', documentAction: 'sign' },
      { _id: new ObjectId(), title: 'Sign NDA',                      type: 'document', assignTo: 'Employee', priority: 'high',   sectionId: s[1]._id, order: 1, dueOffset: { direction: 'on',     days: 0 }, description: '', documentAction: 'sign' },
      { _id: new ObjectId(), title: 'Complete bank details form',    type: 'form',     assignTo: 'Employee', priority: 'high',   sectionId: s[1]._id, order: 2, dueOffset: { direction: 'on',     days: 0 }, description: '' },
      { _id: new ObjectId(), title: 'Complete emergency contact form',type:'form',     assignTo: 'Employee', priority: 'medium', sectionId: s[1]._id, order: 3, dueOffset: { direction: 'on',     days: 0 }, description: '' },
      { _id: new ObjectId(), title: 'Meet with manager (1:1)',       type: 'meeting',  assignTo: 'Manager',  priority: 'high',   sectionId: s[1]._id, order: 4, dueOffset: { direction: 'on',     days: 0 }, description: '', meetingDuration: 60 },
      { _id: new ObjectId(), title: 'Office/workspace tour',         type: 'meeting',  assignTo: 'Manager',  priority: 'medium', sectionId: s[1]._id, order: 5, dueOffset: { direction: 'on',     days: 0 }, description: '' },
      { _id: new ObjectId(), title: 'Complete company policy review', type:'document', assignTo: 'Employee', priority: 'medium', sectionId: s[2]._id, order: 0, dueOffset: { direction: 'after',  days: 3 }, description: '', documentAction: 'acknowledge' },
      { _id: new ObjectId(), title: 'IT security training',          type: 'form',     assignTo: 'Employee', priority: 'high',   sectionId: s[2]._id, order: 1, dueOffset: { direction: 'after',  days: 4 }, description: '' },
      { _id: new ObjectId(), title: 'Meet with team members',        type: 'meeting',  assignTo: 'Manager',  priority: 'medium', sectionId: s[2]._id, order: 2, dueOffset: { direction: 'after',  days: 2 }, description: '' },
      { _id: new ObjectId(), title: 'Set up development environment', type:'equipment',assignTo: 'IT',       priority: 'medium', sectionId: s[2]._id, order: 3, dueOffset: { direction: 'after',  days: 2 }, description: '' },
      { _id: new ObjectId(), title: 'Set 30-day goals',              type: 'form',     assignTo: 'Employee', priority: 'medium', sectionId: s[3]._id, order: 0, dueOffset: { direction: 'after',  days: 5 }, description: '' },
      { _id: new ObjectId(), title: '30-day check-in meeting',       type: 'meeting',  assignTo: 'Manager',  priority: 'high',   sectionId: s[3]._id, order: 1, dueOffset: { direction: 'after',  days: 30}, description: '', meetingDuration: 60 },
      { _id: new ObjectId(), title: 'Complete probation mid-point review', type:'form',assignTo: 'HR',      priority: 'high',   sectionId: s[3]._id, order: 2, dueOffset: { direction: 'after',  days: 45}, description: '' },
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
    { _id: new ObjectId(), name: 'Before Last Day', order: 0 },
    { _id: new ObjectId(), name: 'Last Day',        order: 1 },
  ],
  get tasks() {
    const s = this.sections;
    return [
      { _id: new ObjectId(), title: 'Submit resignation acceptance letter', type: 'document', assignTo: 'HR',       priority: 'high',   sectionId: s[0]._id, order: 0, dueOffset: { direction: 'before', days: 14 }, description: '' },
      { _id: new ObjectId(), title: 'Knowledge transfer document',          type: 'document', assignTo: 'Employee', priority: 'high',   sectionId: s[0]._id, order: 1, dueOffset: { direction: 'before', days: 7  }, description: '' },
      { _id: new ObjectId(), title: 'Schedule handover meetings',           type: 'meeting',  assignTo: 'Manager',  priority: 'high',   sectionId: s[0]._id, order: 2, dueOffset: { direction: 'before', days: 5  }, description: '' },
      { _id: new ObjectId(), title: 'Return company devices',               type: 'equipment',assignTo: 'IT',       priority: 'high',   sectionId: s[0]._id, order: 3, dueOffset: { direction: 'before', days: 1  }, description: '', deviceAction: 'return' },
      { _id: new ObjectId(), title: 'Exit interview',                       type: 'meeting',  assignTo: 'HR',       priority: 'high',   sectionId: s[1]._id, order: 0, dueOffset: { direction: 'on',     days: 0  }, description: '', meetingDuration: 60 },
      { _id: new ObjectId(), title: 'Revoke email access',                  type: 'action',   assignTo: 'IT',       priority: 'high',   sectionId: s[1]._id, order: 1, dueOffset: { direction: 'on',     days: 0  }, description: '' },
      { _id: new ObjectId(), title: 'Revoke Slack/Teams access',            type: 'action',   assignTo: 'IT',       priority: 'high',   sectionId: s[1]._id, order: 2, dueOffset: { direction: 'on',     days: 0  }, description: '' },
      { _id: new ObjectId(), title: 'Revoke all software access',           type: 'action',   assignTo: 'IT',       priority: 'high',   sectionId: s[1]._id, order: 3, dueOffset: { direction: 'on',     days: 0  }, description: '' },
      { _id: new ObjectId(), title: 'Final payslip confirmed',              type: 'approval', assignTo: 'Finance',  priority: 'high',   sectionId: s[1]._id, order: 4, dueOffset: { direction: 'on',     days: 0  }, description: '' },
      { _id: new ObjectId(), title: 'Issue reference letter',               type: 'document', assignTo: 'HR',       priority: 'medium', sectionId: s[1]._id, order: 5, dueOffset: { direction: 'on',     days: 0  }, description: '' },
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
    { _id: new ObjectId(), name: 'Probation Review', order: 0 },
  ],
  get tasks() {
    const s = this.sections;
    return [
      { _id: new ObjectId(), title: 'Send probation review form to employee', type: 'form',    assignTo: 'HR',       priority: 'high', sectionId: s[0]._id, order: 0, dueOffset: { direction: 'before', days: 7 }, description: '' },
      { _id: new ObjectId(), title: 'Complete self-assessment',               type: 'form',    assignTo: 'Employee', priority: 'high', sectionId: s[0]._id, order: 1, dueOffset: { direction: 'before', days: 5 }, description: '' },
      { _id: new ObjectId(), title: 'Manager completes review form',          type: 'form',    assignTo: 'Manager',  priority: 'high', sectionId: s[0]._id, order: 2, dueOffset: { direction: 'before', days: 3 }, description: '' },
      { _id: new ObjectId(), title: 'Probation outcome meeting',              type: 'meeting', assignTo: 'Manager',  priority: 'high', sectionId: s[0]._id, order: 3, dueOffset: { direction: 'on',     days: 0 }, description: '', meetingDuration: 60 },
      { _id: new ObjectId(), title: 'Update contract status',                 type: 'action',  assignTo: 'HR',       priority: 'high', sectionId: s[0]._id, order: 4, dueOffset: { direction: 'after',  days: 1 }, description: 'Pass / extend / terminate based on outcome' },
    ];
  },
  usageCount: 0,
  createdBy: 'System',
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function seedDefaultTemplates() {
  if (!global.dbo) return;
  const col = global.dbo.collection('task_templates');

  for (const tpl of [ONBOARDING_TEMPLATE, OFFBOARDING_TEMPLATE, PROBATION_TEMPLATE]) {
    const exists = await col.findOne({ name: tpl.name, isDefault: true });
    if (!exists) {
      // Materialise getter before inserting
      const doc = { ...tpl, tasks: tpl.tasks };
      await col.insertOne(doc);
      console.log(`[Seed] Inserted default template: ${tpl.name}`);
    }
  }
}

module.exports = { seedDefaultTemplates };
