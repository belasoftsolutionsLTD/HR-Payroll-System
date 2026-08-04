// Registry of every trigger sendTemplatedEmail() is called with across the codebase —
// the single source of truth the Settings > Email Templates UI reads to know what's
// editable, and what each one's default (fallback) subject/body and tokens are. Each
// call site still carries its own fallbackSubject/fallbackHtml (so nothing breaks if a
// trigger is ever removed from here), but keeping the human-facing copy here too means
// admins can preview/reset a template without hunting through route files.
const EMAIL_TRIGGERS = [
  {
    id: 'leaveRequestSubmitted',
    label: 'Leave Request Submitted',
    description: 'Sent to the employee confirming their leave request was submitted',
    module: 'Leave',
    tokens: ['employeeName', 'leaveType', 'totalDays', 'startDate', 'endDate'],
    defaultSubject: 'Your leave request has been submitted',
    defaultBody: '<p>Dear {{employeeName}},</p><p>Your {{leaveType}} request for {{totalDays}} day(s), from {{startDate}} to {{endDate}}, has been submitted and is pending approval.</p>',
  },
  {
    id: 'leaveRequestAwaitingApproval',
    label: 'Leave Request Awaiting Your Approval',
    description: 'Sent to an approver when a leave request needs their action',
    module: 'Leave',
    tokens: ['approverName', 'employeeName', 'leaveType', 'totalDays', 'startDate', 'endDate', 'reviewUrl'],
    defaultSubject: 'Leave request awaiting your approval — {{employeeName}}',
    defaultBody: '<p>Dear {{approverName}},</p><p>{{employeeName}} has requested {{leaveType}} for {{totalDays}} day(s), from {{startDate}} to {{endDate}}.</p><p><a href="{{reviewUrl}}">Review this request</a></p>',
  },
  {
    id: 'leaveRequestApproved',
    label: 'Leave Request Approved',
    description: "Sent to the employee when their leave request is approved",
    module: 'Leave',
    tokens: ['employeeName', 'leaveType', 'totalDays', 'startDate', 'endDate'],
    defaultSubject: 'Your leave request has been approved',
    defaultBody: '<p>Dear {{employeeName}},</p><p>Your {{leaveType}} request for {{totalDays}} day(s), from {{startDate}} to {{endDate}}, has been approved.</p>',
  },
  {
    id: 'leaveRequestRejected',
    label: 'Leave Request Rejected',
    description: "Sent to the employee when their leave request is rejected",
    module: 'Leave',
    tokens: ['employeeName', 'leaveType', 'rejectionReason'],
    defaultSubject: 'Your leave request was not approved',
    defaultBody: '<p>Dear {{employeeName}},</p><p>Your {{leaveType}} request was not approved.</p><p>Reason: {{rejectionReason}}</p>',
  },
  {
    id: 'applicationReceived',
    label: 'Job Application Received',
    description: 'Sent to a candidate confirming their application was received',
    module: 'Recruitment',
    tokens: ['candidateName', 'jobTitle', 'companyName'],
    defaultSubject: 'We received your application for {{jobTitle}}',
    defaultBody: '<p>Dear {{candidateName}},</p><p>Thank you for applying to {{jobTitle}} at {{companyName}}. Our team will review your application and be in touch soon.</p><p>Regards,<br/>{{companyName}}</p>',
  },
  {
    id: 'rejection',
    label: 'Application Rejected',
    description: 'Sent to a candidate whose application was not progressed',
    module: 'Recruitment',
    tokens: ['candidateName', 'companyName'],
    defaultSubject: 'Application Update',
    defaultBody: '<p>Dear {{candidateName}},</p><p>Thank you for your interest. After careful consideration, we are unable to proceed with your application at this time.</p><p>Regards,<br/>{{companyName}}</p>',
  },
  {
    id: 'offerExtended',
    label: 'Offer Extended',
    description: 'Sent to a candidate with their offer details',
    module: 'Recruitment',
    tokens: ['candidateName', 'companyName', 'offerUrl'],
    defaultSubject: 'Offer of Employment',
    defaultBody: '<p>Dear {{candidateName}},</p><p>We are pleased to extend you an offer. Please review and respond here: <a href="{{offerUrl}}">{{offerUrl}}</a></p><p>Regards,<br/>{{companyName}}</p>',
  },
  {
    id: 'interviewScheduled',
    label: 'Interview Scheduled',
    description: 'Sent to a candidate when an interview is scheduled',
    module: 'Recruitment',
    tokens: ['candidateName', 'jobTitle'],
    defaultSubject: 'Interview Scheduled — {{jobTitle}}',
    defaultBody: '<p>Dear {{candidateName}},</p><p>Your interview has been scheduled. Details to follow.</p>',
  },
  {
    id: 'interviewReminder',
    label: 'Interview Reminder',
    description: 'Sent to a candidate ahead of a scheduled interview',
    module: 'Recruitment',
    tokens: ['candidateName'],
    defaultSubject: 'Reminder: Upcoming Interview',
    defaultBody: '<p>Dear {{candidateName}},</p><p>This is a reminder of your upcoming interview.</p>',
  },
  {
    id: 'payslipGenerated',
    label: 'Payslip Generated',
    description: "Sent to an employee when their payslip is generated",
    module: 'Payroll',
    tokens: ['employeeName', 'period'],
    defaultSubject: 'Your Payslip — {{period}}',
    defaultBody: '<p>Dear {{employeeName}},</p><p>Your payslip for {{period}} is ready.</p>',
  },
  {
    id: 'appraisalSubmitted',
    label: 'Appraisal Submitted',
    description: 'Sent to an employee when a performance appraisal is recorded for them',
    module: 'Performance',
    tokens: ['employeeName', 'period', 'rating'],
    defaultSubject: 'Your Appraisal — {{period}}',
    defaultBody: '<p>Dear {{employeeName}},</p><p>An appraisal has been recorded for {{period}}. Rating: {{rating}}.</p>',
  },

  // ── Onboarding / Offboarding ────────────────────────────────────────────────
  {
    id: 'onboardingCompensationSetup', label: 'Compensation Set Up', description: "Sent to a new hire when HR sets up their pay", module: 'Onboarding',
    tokens: ['employeeName'], defaultSubject: 'Your compensation has been set up',
    defaultBody: '<p>Dear {{employeeName}},</p><p>Your salary and payment details have been set up by HR as part of your onboarding.</p>',
  },
  {
    id: 'offboardingFinalPayRequired', label: 'Final Pay Required', description: 'Sent to HR when a terminated employee needs their final pay processed', module: 'Offboarding',
    tokens: ['employeeName', 'lastWorkingDay'], defaultSubject: 'Final pay required — {{employeeName}}',
    defaultBody: '<p>{{employeeName}}\'s final pay needs to be processed (last working day {{lastWorkingDay}}). Create an off-cycle payroll run from the Payroll module.</p>',
  },
  {
    id: 'offboardingNotStarted', label: 'Offboarding Not Started', description: 'Sent to HR when an employee is terminated with no offboarding record', module: 'Offboarding',
    tokens: ['employeeName'], defaultSubject: 'Offboarding not started — {{employeeName}}',
    defaultBody: '<p>{{employeeName}} was marked terminated but has no offboarding record. Start one from the Offboarding module.</p>',
  },

  // ── Employees ────────────────────────────────────────────────────────────────
  {
    id: 'employeeProfileUpdated', label: 'Profile Updated by HR', description: "Sent to an employee when HR edits their profile", module: 'Employees',
    tokens: ['employeeName', 'fields', 'plural'], defaultSubject: 'Your profile has been updated',
    defaultBody: '<p>Dear {{employeeName}},</p><p>Your {{fields}} {{plural}} been updated by HR. Contact HR if you have any questions.</p>',
  },
  {
    id: 'employeeSelfServiceProfileUpdated', label: 'Employee Self-Service Profile Update', description: 'Sent to HR when an employee edits their own sensitive profile fields', module: 'Employees',
    tokens: ['employeeName', 'fields'], defaultSubject: 'Employee Updated Their Profile',
    defaultBody: '<p>{{employeeName}} updated: {{fields}}.</p>',
  },

  // ── Attendance ───────────────────────────────────────────────────────────────
  {
    id: 'shiftApplicationResolved', label: 'Shift Application Resolved', description: 'Sent to an employee when their shift application is approved or rejected', module: 'Attendance',
    tokens: ['employeeName', 'status'], defaultSubject: 'Shift application {{status}}',
    defaultBody: '<p>Dear {{employeeName}},</p><p>Your shift application was {{status}}.</p>',
  },
  {
    id: 'missingClockOut', label: 'Missing Clock-Out', description: 'Sent to an employee who clocked in but never clocked out', module: 'Attendance',
    tokens: [], defaultSubject: 'Missing clock-out',
    defaultBody: '<p>You clocked in earlier today but never clocked out. Please update your attendance.</p>',
  },

  // ── Welfare ──────────────────────────────────────────────────────────────────
  {
    id: 'welfareMembershipChanged', label: 'Welfare Membership Changed', description: 'Sent to an employee when they are enrolled in or removed from a welfare scheme', module: 'Welfare',
    tokens: ['employeeName', 'schemeName', 'action'], defaultSubject: 'Welfare scheme update — {{schemeName}}',
    defaultBody: '<p>Dear {{employeeName}},</p><p>You have been {{action}} the "{{schemeName}}" welfare scheme.</p>',
  },

  // ── Awards ───────────────────────────────────────────────────────────────────
  {
    id: 'awardGranted', label: 'Award Granted', description: 'Sent to an employee when they receive an award', module: 'Awards',
    tokens: ['employeeName', 'awardName', 'notes'], defaultSubject: 'Congratulations — you received "{{awardName}}"!',
    defaultBody: '<p>Dear {{employeeName}},</p><p>Congratulations! You\'ve been awarded "{{awardName}}".</p>',
  },

  // ── Announcements / Communication ───────────────────────────────────────────
  {
    id: 'announcementPublished', label: 'Announcement Published', description: 'Sent to the targeted audience when HR publishes an announcement', module: 'Announcements',
    tokens: ['title', 'body'], defaultSubject: '📢 {{title}}',
    defaultBody: '<p>{{body}}</p>',
  },
  {
    id: 'trustReportSubmitted', label: 'Anonymous Trust Report Submitted', description: 'Sent to HR when a confidential trust report is filed', module: 'Communication',
    tokens: ['category', 'trackingCode'], defaultSubject: '🔒 New anonymous trust report',
    defaultBody: '<p>Category: {{category}}. Use tracking code {{trackingCode}} to reference it.</p>',
  },

  // ── Tasks ────────────────────────────────────────────────────────────────────
  {
    id: 'taskAssigned', label: 'Task Assigned', description: 'Sent to an employee when a new task is assigned to them', module: 'Tasks',
    tokens: ['employeeName', 'taskTitle', 'dueInfo', 'priority'], defaultSubject: 'New task: {{taskTitle}}',
    defaultBody: '<p>Dear {{employeeName}},</p><p>You\'ve been assigned a new task: "{{taskTitle}}". {{dueInfo}}{{priority}} priority.</p>',
  },
  {
    id: 'taskApprovalNeeded', label: 'Task Awaiting Approval', description: 'Sent to an approver when a completed task needs their sign-off', module: 'Tasks',
    tokens: ['taskTitle', 'assigneeName'], defaultSubject: 'Task awaiting your approval — {{taskTitle}}',
    defaultBody: '<p>"{{taskTitle}}" was marked complete by {{assigneeName}} and needs your sign-off.</p>',
  },
  {
    id: 'taskDueTomorrow', label: 'Task Due Tomorrow', description: 'Reminder sent to an employee the day before a task is due', module: 'Tasks',
    tokens: ['taskTitle', 'dueDate'], defaultSubject: 'Due tomorrow: "{{taskTitle}}"',
    defaultBody: '<p>Make sure to complete this task by {{dueDate}}.</p>',
  },

  // ── Training ─────────────────────────────────────────────────────────────────
  {
    id: 'trainingCourseAssigned', label: 'Course Assigned', description: 'Sent to an employee when they are enrolled in a course', module: 'Training',
    tokens: ['employeeName', 'courseTitle'], defaultSubject: 'New training assigned',
    defaultBody: '<p>Dear {{employeeName}},</p><p>You have been assigned a new course: "{{courseTitle}}".</p>',
  },
  {
    id: 'trainingPathAssigned', label: 'Learning Path Assigned', description: 'Sent to an employee when they are enrolled in a learning path', module: 'Training',
    tokens: ['employeeName', 'pathName'], defaultSubject: 'New learning path assigned',
    defaultBody: '<p>Dear {{employeeName}},</p><p>You have been enrolled in "{{pathName}}".</p>',
  },
  {
    id: 'trainingCertificateEarned', label: 'Certificate Earned', description: 'Sent to an employee when they complete a course and earn a certificate', module: 'Training',
    tokens: ['courseTitle'], defaultSubject: 'Certificate Earned',
    defaultBody: '<p>Congratulations! You\'ve earned a certificate for completing "{{courseTitle}}".</p>',
  },
  {
    id: 'trainingCertificateReviewed', label: 'External Certificate Reviewed', description: 'Sent to an employee when HR verifies or rejects their uploaded certificate', module: 'Training',
    tokens: ['certName', 'status'], defaultSubject: 'External Certificate {{status}}',
    defaultBody: '<p>Your certificate "{{certName}}" was {{status}}.</p>',
  },
  {
    id: 'trainingReminder', label: 'Training Reminder', description: 'Ad-hoc or overdue-training reminder sent to an employee', module: 'Training',
    tokens: ['message'], defaultSubject: 'Training Reminder',
    defaultBody: '<p>{{message}}</p>',
  },
  {
    id: 'trainingOverdue', label: 'Training Overdue', description: 'Sent to an employee when an enrollment becomes overdue', module: 'Training',
    tokens: ['courseTitle'], defaultSubject: 'Training Overdue',
    defaultBody: '<p>"{{courseTitle}}" was due and is now overdue — please complete it.</p>',
  },
  {
    id: 'certificationExpiring', label: 'Certification Expiring Soon', description: "Sent to an employee ahead of a professional certification's expiry", module: 'Training',
    tokens: ['certName', 'expiryDate'], defaultSubject: 'Certification Expiring Soon',
    defaultBody: '<p>Your "{{certName}}" certification expires on {{expiryDate}} — renew it soon.</p>',
  },

  // ── Performance ──────────────────────────────────────────────────────────────
  {
    id: 'appraisalDecision', label: 'Appraisal Decision', description: 'Sent to an employee when HR approves or rejects their appraisal', module: 'Performance',
    tokens: ['reviewPeriod', 'decision', 'comment'], defaultSubject: 'Appraisal {{decision}}',
    defaultBody: '<p>Your appraisal for {{reviewPeriod}} was {{decision}} by HR.</p>',
  },
  {
    id: 'appraisalDecisionReviewer', label: 'Appraisal Decision (Reviewer copy)', description: 'Sent to the reviewer/dept head when HR decides on an appraisal they submitted', module: 'Performance',
    tokens: ['empName', 'reviewPeriod', 'decision', 'comment'], defaultSubject: 'Appraisal {{decision}}',
    defaultBody: '<p>Your submitted appraisal for {{empName}} ({{reviewPeriod}}) was {{decision}} by HR.</p>',
  },
  {
    id: 'reviewCycleLaunched', label: 'Review Cycle Launched', description: 'Sent to all staff when a new performance review cycle opens', module: 'Performance',
    tokens: ['cycleName'], defaultSubject: 'Review Cycle Launched: {{cycleName}}',
    defaultBody: '<p>A new performance review cycle, "{{cycleName}}", has started. Please complete your self-review.</p>',
  },
  {
    id: 'performanceRecommendation', label: 'Promotion/PIP Recommended', description: 'Sent to HR when a manager recommends a promotion or PIP', module: 'Performance',
    tokens: ['managerName', 'recommendationLabel', 'employeeName'], defaultSubject: 'Promotion/PIP Recommended',
    defaultBody: '<p>{{managerName}} recommended {{recommendationLabel}} for {{employeeName}}.</p>',
  },
  {
    id: 'feedbackReceived', label: 'Feedback Received', description: 'Sent to an employee when they receive peer/manager feedback', module: 'Performance',
    tokens: ['fromLabel', 'feedbackType'], defaultSubject: 'You received new feedback',
    defaultBody: '<p>{{fromLabel}} gave you {{feedbackType}} feedback.</p>',
  },
  {
    id: 'oneOnOneScheduled', label: '1-on-1 Scheduled', description: 'Sent to an employee when a 1-on-1 meeting is scheduled with them', module: 'Performance',
    tokens: ['scheduledDate'], defaultSubject: '1-on-1 Scheduled',
    defaultBody: '<p>A 1-on-1 meeting has been scheduled for {{scheduledDate}}.</p>',
  },
  {
    id: 'pipStarted', label: 'PIP Started', description: 'Sent to an employee when a performance improvement plan is created for them', module: 'Performance',
    tokens: [], defaultSubject: 'Performance Improvement Plan Started',
    defaultBody: '<p>A performance improvement plan has been created for you. Please speak with your manager.</p>',
  },
  {
    id: 'pipClosed', label: 'PIP Closed', description: 'Sent to an employee when their performance improvement plan is closed', module: 'Performance',
    tokens: ['outcomeLabel'], defaultSubject: 'Performance Improvement Plan Closed',
    defaultBody: '<p>Your performance improvement plan has been closed. Outcome: {{outcomeLabel}}.</p>',
  },

  // ── Inventory ────────────────────────────────────────────────────────────────
  {
    id: 'inventoryTransferApproved', label: 'Stock Transfer Approved', description: 'Sent to the requester when their stock transfer is approved', module: 'Inventory',
    tokens: [], defaultSubject: 'Transfer approved',
    defaultBody: '<p>Your stock transfer request was approved and is ready to be received.</p>',
  },
  {
    id: 'inventoryTransferRejected', label: 'Stock Transfer Rejected', description: 'Sent to the requester when their stock transfer is rejected', module: 'Inventory',
    tokens: ['reason'], defaultSubject: 'Transfer rejected',
    defaultBody: '<p>Your stock transfer request was rejected. Reason: {{reason}}</p>',
  },
  {
    id: 'inventoryTransferReceived', label: 'Stock Transfer Received', description: 'Sent to the requester when their stock transfer is marked received', module: 'Inventory',
    tokens: [], defaultSubject: 'Transfer received',
    defaultBody: '<p>Your stock transfer has arrived and been received.</p>',
  },
  {
    id: 'inventoryLowStockAlert', label: 'Low Stock Alert', description: 'Sent to HR/admin when an item drops to or below its reorder point', module: 'Inventory',
    tokens: ['itemName', 'sku', 'locationName', 'quantity', 'unitOfMeasure', 'reorderPoint'], defaultSubject: 'Low stock alert',
    defaultBody: '<p>{{itemName}} ({{sku}}) at {{locationName}} is at {{quantity}} {{unitOfMeasure}}, at/below its reorder point of {{reorderPoint}}.</p>',
  },

  // ── Config / Me / Recruitment (internal) ────────────────────────────────────
  {
    id: 'scheduledEventCreated', label: 'Scheduled Event Created', description: 'Sent to affected staff when a team-building or training event is scheduled', module: 'Config',
    tokens: ['typeLabel', 'eventTitle', 'bodyText'], defaultSubject: '{{typeLabel}}: {{eventTitle}}',
    defaultBody: '<p>{{bodyText}}</p>',
  },
  {
    id: 'internalApplicationReceived', label: 'Internal Application Received', description: 'Sent to HR when an employee applies to an internal job posting', module: 'Recruitment',
    tokens: ['employeeName', 'jobTitle'], defaultSubject: 'New Internal Application Received',
    defaultBody: '<p>{{employeeName}} applied for {{jobTitle}}.</p>',
  },
  {
    id: 'careersApplicationReceived', label: 'Careers Site Application Received', description: 'Sent to HR when a candidate applies via the public careers site', module: 'Recruitment',
    tokens: ['candidateName', 'jobTitle'], defaultSubject: 'New Application Received',
    defaultBody: '<p>{{candidateName}} applied for {{jobTitle}} via the careers site.</p>',
  },
];

const getTriggerCatalog = () => EMAIL_TRIGGERS;
const getTriggerDefinition = (id) => EMAIL_TRIGGERS.find((t) => t.id === id) || null;

module.exports = { EMAIL_TRIGGERS, getTriggerCatalog, getTriggerDefinition };
