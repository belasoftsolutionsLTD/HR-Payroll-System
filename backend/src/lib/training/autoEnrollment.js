const { ObjectId } = require('mongodb');
const { findMany, insertOne } = require('../../functions/Database/commonDBFunctions');
const { notifyUser } = require('../../functions/HR/notifyUser');
const { notifyManager } = require('../../routes/inbox/inboxFunctions');
const { createSingleCourseEnrollment, createLearningPathEnrollment } = require('./enrollmentHelpers');

// `user` here is a full `users` document — enrollments.employeeId is always a users._id
// (see trainingFunctions.js), so rule targeting matches against users.role/users.department.
const matchesConditions = (user, conditions = {}) => {
  if (conditions.roles?.length && !conditions.roles.includes(user.role)) return false;
  if (conditions.departments?.length && !conditions.departments.includes(user.department)) return false;
  return true;
};

const applyRuleToUser = async (rule, user) => {
  const dueDate = rule.action.dueDateOffsetDays != null ? new Date(Date.now() + rule.action.dueDateOffsetDays * 86400000) : null;
  let created = 0;

  for (const courseId of rule.action.enrollInCourseIds || []) {
    const result = await createSingleCourseEnrollment({
      employeeId: user._id, courseId: new ObjectId(courseId), enrolledBy: rule.createdBy, enrollmentTrigger: rule.trigger, dueDate,
    });
    if (result.created) created += 1;
  }
  for (const pathId of rule.action.enrollInLearningPathIds || []) {
    const result = await createLearningPathEnrollment({
      employeeId: user._id, learningPathId: new ObjectId(pathId), enrolledBy: rule.createdBy, enrollmentTrigger: rule.trigger, dueDate,
    });
    if (result.created) created += 1;
  }

  if (created > 0) {
    if (rule.action.notifyEmployee) {
      notifyUser(user._id, {
        title: 'Training Assigned',
        body: `You've been automatically enrolled in new training via the "${rule.name}" rule.`,
        type: 'training',
      }).catch(() => {});
    }
    if (rule.action.notifyManager && user.employeeId) {
      notifyManager(user.employeeId, {
        type: 'training', subType: 'auto_enrolled',
        title: 'Team Member Auto-Enrolled',
        subtitle: `${user.name} was automatically enrolled in training via the "${rule.name}" rule.`,
        referenceId: user._id, referenceModel: 'users',
        requiresAction: false, triggeredBy: null,
      }).catch(() => {});
    }
  }

  return created;
};

// Full org-wide run — used by "Run Now" in the Rules UI and by the daily cron for
// onCertExpiry/scheduled rules.
async function runRule(rule) {
  const conditions = rule.triggerConditions || {};
  let candidateUsers = [];

  if (rule.trigger === 'onCertExpiry' && conditions.daysBeforeCertExpiry != null) {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + conditions.daysBeforeCertExpiry * 86400000);
    const expiringCerts = await findMany('certificates', { expiresAt: { $gte: now, $lte: windowEnd } });
    const employeeIds = [...new Set(expiringCerts.map((c) => String(c.employeeId)))].map((id) => new ObjectId(id));
    candidateUsers = employeeIds.length ? await findMany('users', { _id: { $in: employeeIds } }) : [];
    candidateUsers = candidateUsers.filter((u) => matchesConditions(u, conditions));
  } else if (rule.trigger === 'onPerformanceScore' && conditions.performanceScoreBelow != null) {
    // Best-effort join against performance_reviews — skipped gracefully if that collection/shape differs.
    const lowScorers = await global.dbo.collection('performance_reviews').aggregate([
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$employeeId', latestScore: { $first: '$overallRating' } } },
      { $match: { latestScore: { $lt: conditions.performanceScoreBelow } } },
    ]).toArray().catch(() => []);
    const employeeIds = lowScorers.map((r) => r._id);
    candidateUsers = employeeIds.length ? await findMany('users', { employeeId: { $in: employeeIds } }) : [];
    candidateUsers = candidateUsers.filter((u) => matchesConditions(u, conditions));
  } else {
    const filter = {};
    if (conditions.roles?.length) filter.role = { $in: conditions.roles };
    if (conditions.departments?.length) filter.department = { $in: conditions.departments };
    candidateUsers = await findMany('users', filter);
  }

  let created = 0;
  for (const user of candidateUsers) {
    created += await applyRuleToUser(rule, user);
  }

  await insertOne('ruleExecutionLogs', { ruleId: rule._id, runAt: new Date(), matched: candidateUsers.length, created });
  return { matched: candidateUsers.length, created };
}

// Fired from a specific event (new account created, role/department changed) — only
// evaluates active rules of the matching trigger type against the ONE affected user,
// instead of re-scanning the whole org.
async function evaluateRulesForUser(trigger, user) {
  const rules = await findMany('trainingAssignmentRules', { trigger, isActive: true });
  for (const rule of rules) {
    if (!matchesConditions(user, rule.triggerConditions)) continue;
    const created = await applyRuleToUser(rule, user);
    await insertOne('ruleExecutionLogs', { ruleId: rule._id, runAt: new Date(), matched: 1, created });
  }
}

// Daily cron hook: certificate-expiry rules are always re-checked; scheduled rules only
// fire once their recurrence interval has elapsed since their last logged run.
async function runDueScheduledAndExpiryRules() {
  const rules = await findMany('trainingAssignmentRules', { isActive: true, trigger: { $in: ['onCertExpiry', 'scheduled'] } });
  for (const rule of rules) {
    if (rule.trigger === 'scheduled') {
      const recurrence = rule.triggerConditions?.scheduledRecurrence || 'monthly';
      const intervalDays = { monthly: 30, quarterly: 90, annual: 365 }[recurrence] || 30;
      const lastLogs = await findMany('ruleExecutionLogs', { ruleId: rule._id }, { sort: { runAt: -1 }, limit: 1 });
      const dueSince = lastLogs.length ? new Date(lastLogs[0].runAt.getTime() + intervalDays * 86400000) : new Date(0);
      if (new Date() < dueSince) continue;
    }
    await runRule(rule).catch(() => {});
  }
}

module.exports = { runRule, evaluateRulesForUser, runDueScheduledAndExpiryRules };
