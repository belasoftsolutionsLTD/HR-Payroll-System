// Postgres migration (Phase 7) — crm_pipelines/crm_deals/crm_contacts/crm_activities/
// crm_feedback are all Postgres now.
const { knex } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { getCrmAccessLevel, getScopedAssigneeIds } = require('../../lib/crm/crmAccess');

const resolveAssigneeIds = async (req, level) => {
  if (req.query.assignedTo) return [req.query.assignedTo];
  return getScopedAssigneeIds(req.user, level); // array, or null = unrestricted
};

// Pipeline value by stage, win rate, average deal size, average time-to-close — the
// core Pipedrive-style pipeline health report.
const getPipelineReport = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!req.query.pipelineId) return returnFunction(res, 400, false, 'pipelineId is required.');

  const pipeline = await knex('crm_pipelines').where({ id: req.query.pipelineId }).first();
  if (!pipeline) return returnFunction(res, 404, false, 'Pipeline not found.');

  let query = knex('crm_deals').where({ pipelineId: pipeline.id });
  const assigneeIds = await resolveAssigneeIds(req, level);
  if (assigneeIds) query = query.whereIn('assignedTo', assigneeIds);
  const deals = await query;

  const openDeals = deals.filter((d) => d.status === 'open');
  const wonDeals = deals.filter((d) => d.status === 'won');
  const lostDeals = deals.filter((d) => d.status === 'lost');
  const closedCount = wonDeals.length + lostDeals.length;

  const byStage = pipeline.stages.map((stage) => {
    const stageDeals = openDeals.filter((d) => d.stageId === stage.id);
    return { stageId: stage.id, stageName: stage.name, dealCount: stageDeals.length, value: stageDeals.reduce((s, d) => s + (d.value || 0), 0) };
  });

  const avgDealSize = wonDeals.length ? wonDeals.reduce((s, d) => s + (d.value || 0), 0) / wonDeals.length : 0;
  const avgTimeToCloseDays = wonDeals.length
    ? wonDeals.reduce((s, d) => s + (new Date(d.wonAt) - new Date(d.createdAt)) / 86400000, 0) / wonDeals.length
    : 0;

  return returnFunction(res, 200, true, req.locale.success, {
    byStage,
    openValue: openDeals.reduce((s, d) => s + (d.value || 0), 0),
    openCount: openDeals.length,
    winRate: closedCount ? Math.round((wonDeals.length / closedCount) * 1000) / 10 : 0,
    avgDealSize: Math.round(avgDealSize * 100) / 100,
    avgTimeToCloseDays: Math.round(avgTimeToCloseDays * 10) / 10,
    wonCount: wonDeals.length,
    lostCount: lostDeals.length,
  });
};

// Per-staff activity — calls made (and other logged activity types) and tasks completed,
// for whatever scope the requester can see.
const getActivityReport = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  let query = knex('crm_activities');
  const scoped = await getScopedAssigneeIds(req.user, level);
  if (scoped) query = query.whereIn('performedBy', scoped);
  if (req.query.startDate) query = query.where('createdAt', '>=', new Date(req.query.startDate));
  if (req.query.endDate) query = query.where('createdAt', '<=', new Date(req.query.endDate));

  const activities = await query;
  const byStaff = {};
  for (const a of activities) {
    const key = a.performedBy;
    byStaff[key] ??= { staffId: a.performedBy, staffName: a.performedByName, calls: 0, emails: 0, meetings: 0, notes: 0, tasksCompleted: 0 };
    if (a.type === 'call') byStaff[key].calls++;
    else if (a.type === 'email') byStaff[key].emails++;
    else if (a.type === 'meeting') byStaff[key].meetings++;
    else if (a.type === 'note') byStaff[key].notes++;
    else if (a.type === 'task' && a.completed) byStaff[key].tasksCompleted++;
  }

  return returnFunction(res, 200, true, req.locale.success, Object.values(byStaff));
};

// Contacts already capture a `source` at creation but nothing ever reported on it — this
// closes that gap: per source, how many contacts came in, how many turned into a won
// deal, and what that was worth. Conversion rate is "contacts from this source that have
// at least one won deal" over total contacts from that source, not deals-per-contact.
const getSourceEffectivenessReport = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  let contactQuery = knex('crm_contacts').whereNot({ isActive: false });
  const assigneeIds = await resolveAssigneeIds(req, level);
  if (assigneeIds) contactQuery = contactQuery.whereIn('assignedTo', assigneeIds);
  const contacts = await contactQuery.select('id', 'source');
  const contactIds = contacts.map((c) => c.id);
  const deals = contactIds.length ? await knex('crm_deals').whereIn('contactId', contactIds).select('contactId', 'status', 'value') : [];

  const dealsByContact = {};
  for (const d of deals) {
    (dealsByContact[d.contactId] ??= []).push(d);
  }

  const bySource = {};
  for (const c of contacts) {
    const key = c.source || 'other';
    bySource[key] ??= { source: key, contactCount: 0, wonContactCount: 0, wonValue: 0 };
    bySource[key].contactCount += 1;
    const cDeals = dealsByContact[c.id] || [];
    const wonDeals = cDeals.filter((d) => d.status === 'won');
    if (wonDeals.length) {
      bySource[key].wonContactCount += 1;
      bySource[key].wonValue += wonDeals.reduce((s, d) => s + (d.value || 0), 0);
    }
  }

  const result = Object.values(bySource)
    .map((s) => ({ ...s, conversionRate: s.contactCount ? Math.round((s.wonContactCount / s.contactCount) * 1000) / 10 : 0 }))
    .sort((a, b) => b.contactCount - a.contactCount);

  return returnFunction(res, 200, true, req.locale.success, result);
};

// Aggregate feedback stats for the Reports tab — average rating and a 1-5 distribution,
// scoped the same way activity reporting is (by who logged it, since that's the rep
// whose customer relationship the feedback reflects).
const getFeedbackSummary = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  let query = knex('crm_feedback');
  const scoped = await getScopedAssigneeIds(req.user, level);
  if (scoped) query = query.whereIn('loggedBy', scoped);

  const feedback = await query;
  const avgRating = feedback.length ? Math.round((feedback.reduce((s, f) => s + f.rating, 0) / feedback.length) * 10) / 10 : 0;
  const distribution = [1, 2, 3, 4, 5].map((rating) => ({ rating, count: feedback.filter((f) => f.rating === rating).length }));

  return returnFunction(res, 200, true, req.locale.success, { count: feedback.length, avgRating, distribution });
};

const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportDealsCSV = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');

  let query = knex('crm_deals');
  const assigneeIds = await resolveAssigneeIds(req, level);
  if (assigneeIds) query = query.whereIn('assignedTo', assigneeIds);
  if (req.query.pipelineId) query = query.where({ pipelineId: req.query.pipelineId });
  if (req.query.status) query = query.where({ status: req.query.status });

  const deals = await query.orderBy('createdAt', 'desc');
  const contactIds = [...new Set(deals.map((d) => d.contactId))];
  const contacts = await knex('crm_contacts').whereIn('id', contactIds).select('id', 'firstName', 'lastName');
  const contactMap = Object.fromEntries(contacts.map((c) => [c.id, c]));

  const header = 'Title,Contact,Value,Currency,Status,ExpectedCloseDate,CreatedAt,WonAt,LostAt';
  const rows = deals.map((d) => {
    const contact = contactMap[d.contactId];
    return [
      d.title, contact ? `${contact.firstName} ${contact.lastName}`.trim() : '', d.value, d.currency, d.status,
      d.expectedCloseDate ? new Date(d.expectedCloseDate).toISOString().split('T')[0] : '',
      d.createdAt.toISOString(), d.wonAt ? new Date(d.wonAt).toISOString() : '', d.lostAt ? new Date(d.lostAt).toISOString() : '',
    ].map(csvEscape).join(',');
  });
  const csv = [header, ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="crm-deals.csv"');
  return res.send(csv);
};

module.exports = { getPipelineReport, getActivityReport, exportDealsCSV, getSourceEffectivenessReport, getFeedbackSummary };
