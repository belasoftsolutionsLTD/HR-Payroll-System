// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 5) — trainingAssignmentRules, ruleExecutionLogs, certificates, reviews, users
// all now live in Postgres.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const { notifyUser } = require('../../functions/HR/notifyUser');
const { notifyManager } = require('../../routes/inbox/inboxFunctions');
const { createSingleCourseEnrollment, createLearningPathEnrollment } = require('./enrollmentHelpers');

// `user` here is a full `users` row — enrollments.employeeId is always a users.id
// (see trainingFunctions.js), so rule targeting matches against users.role/users.department.
// `extra.performanceScore`, when provided, is checked against triggerConditions.performanceScoreBelow
// — only the single-user event path (a review just got submitted) supplies this; the full
// org-wide runRule scan does its own score filtering via a real query instead.
const matchesConditions = (user, conditions = {}, extra = {}) => {
  if (conditions.roles?.length && !conditions.roles.includes(user.role)) return false;
  if (conditions.departments?.length && !conditions.departments.includes(user.department)) return false;
  if (conditions.performanceScoreBelow != null) {
    if (extra.performanceScore == null || extra.performanceScore >= conditions.performanceScoreBelow) return false;
  }
  return true;
};

const applyRuleToUser = async (rule, user) => {
  const dueDate = rule.action.dueDateOffsetDays != null ? new Date(Date.now() + rule.action.dueDateOffsetDays * 86400000) : null;
  let created = 0;

  for (const courseId of rule.action.enrollInCourseIds || []) {
    const result = await createSingleCourseEnrollment({
      employeeId: user.id, courseId: String(courseId), enrolledBy: rule.createdBy, enrollmentTrigger: rule.trigger, dueDate,
    });
    if (result.created) created += 1;
  }
  for (const pathId of rule.action.enrollInLearningPathIds || []) {
    const result = await createLearningPathEnrollment({
      employeeId: user.id, learningPathId: String(pathId), enrolledBy: rule.createdBy, enrollmentTrigger: rule.trigger, dueDate,
    });
    if (result.created) created += 1;
  }

  if (created > 0) {
    if (rule.action.notifyEmployee) {
      notifyUser(user.id, {
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
        referenceId: user.id, referenceModel: 'users',
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
    const expiringCerts = await knex('certificates').where('expiresAt', '>=', now).where('expiresAt', '<=', windowEnd);
    const employeeIds = [...new Set(expiringCerts.map((c) => c.employeeId))];
    candidateUsers = employeeIds.length ? await knex('users').whereIn('id', employeeIds) : [];
    candidateUsers = candidateUsers.filter((u) => matchesConditions(u, conditions));
  } else if (rule.trigger === 'onPerformanceScore' && conditions.performanceScoreBelow != null) {
    // Ported from a Mongo aggregation ($sort + $group + $first, latest submitted manager
    // review's overallRating per employee) to a plain JS reduction, same idiom used for
    // every other Mongo aggregate() ported in this migration — scoped to submitted manager
    // reviews since that's the official rating, not a self- or peer-review score.
    const managerReviews = await knex('reviews')
      .where({ reviewType: 'manager', status: 'submitted' }).whereNotNull('overallRating')
      .orderBy('submittedAt', 'desc');
    const latestByEmployee = new Map();
    for (const r of managerReviews) {
      if (!latestByEmployee.has(r.employeeId)) latestByEmployee.set(r.employeeId, r.overallRating);
    }
    const employeeIds = [...latestByEmployee.entries()]
      .filter(([, score]) => Number(score) < conditions.performanceScoreBelow)
      .map(([employeeId]) => employeeId);
    candidateUsers = employeeIds.length ? await knex('users').whereIn('employeeId', employeeIds) : [];
    candidateUsers = candidateUsers.filter((u) => matchesConditions(u, conditions));
  } else {
    let query = knex('users');
    if (conditions.roles?.length) query = query.whereIn('role', conditions.roles);
    if (conditions.departments?.length) query = query.whereIn('department', conditions.departments);
    candidateUsers = await query;
  }

  let created = 0;
  for (const user of candidateUsers) {
    created += await applyRuleToUser(rule, user);
  }

  await knex('rule_execution_logs').insert({ id: newId(), ruleId: rule.id, runAt: new Date(), matched: candidateUsers.length, created });
  return { matched: candidateUsers.length, created };
}

// Fired from a specific event (new account created, role/department changed) — only
// evaluates active rules of the matching trigger type against the ONE affected user,
// instead of re-scanning the whole org.
async function evaluateRulesForUser(trigger, user, extra = {}) {
  const rules = await knex('training_assignment_rules').where({ trigger, isActive: true });
  for (const rule of rules) {
    if (!matchesConditions(user, rule.triggerConditions, extra)) continue;
    const created = await applyRuleToUser(rule, user);
    await knex('rule_execution_logs').insert({ id: newId(), ruleId: rule.id, runAt: new Date(), matched: 1, created });
  }
}

// Daily cron hook: certificate-expiry rules are always re-checked; scheduled rules only
// fire once their recurrence interval has elapsed since their last logged run.
async function runDueScheduledAndExpiryRules() {
  const rules = await knex('training_assignment_rules').where({ isActive: true }).whereIn('trigger', ['onCertExpiry', 'scheduled']);
  for (const rule of rules) {
    if (rule.trigger === 'scheduled') {
      const recurrence = rule.triggerConditions?.scheduledRecurrence || 'monthly';
      const intervalDays = recurrence === 'custom'
        ? (Number(rule.triggerConditions?.customIntervalDays) || 30)
        : ({ monthly: 30, quarterly: 90, annual: 365 }[recurrence] || 30);
      const lastLog = await knex('rule_execution_logs').where({ ruleId: rule.id }).orderBy('runAt', 'desc').first();
      const dueSince = lastLog ? new Date(new Date(lastLog.runAt).getTime() + intervalDays * 86400000) : new Date(0);
      if (new Date() < dueSince) continue;
    }
    await runRule(rule).catch(() => {});
  }
}

module.exports = { runRule, evaluateRulesForUser, runDueScheduledAndExpiryRules };
