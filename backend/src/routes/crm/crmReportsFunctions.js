const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findOne, findMany } = require('../../functions/Database/commonDBFunctions');
const { getCrmAccessLevel, getScopedAssigneeIds } = require('../../lib/crm/crmAccess');

const buildAssigneeFilter = async (req, level) => {
  const filter = {};
  if (req.query.assignedTo) {
    filter.assignedTo = new ObjectId(req.query.assignedTo);
  } else {
    const scoped = await getScopedAssigneeIds(req.user, level);
    if (scoped) filter.assignedTo = { $in: scoped };
  }
  return filter;
};

// Pipeline value by stage, win rate, average deal size, average time-to-close — the
// core Pipedrive-style pipeline health report.
const getPipelineReport = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!req.query.pipelineId) return returnFunction(res, 400, false, 'pipelineId is required.');

  const pipeline = await findOne('crm_pipelines', { _id: new ObjectId(req.query.pipelineId) });
  if (!pipeline) return returnFunction(res, 404, false, 'Pipeline not found.');

  const filter = { ...(await buildAssigneeFilter(req, level)), pipelineId: pipeline._id };
  const deals = await findMany('crm_deals', filter, {});

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

  const filter = {};
  const scoped = await getScopedAssigneeIds(req.user, level);
  if (scoped) filter.performedBy = { $in: scoped };
  if (req.query.startDate || req.query.endDate) {
    filter.createdAt = {};
    if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
  }

  const activities = await findMany('crm_activities', filter, {});
  const byStaff = {};
  for (const a of activities) {
    const key = String(a.performedBy);
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

  const contactFilter = await buildAssigneeFilter(req, level);
  const contacts = await findMany('crm_contacts', { ...contactFilter, isActive: { $ne: false } }, { projection: { source: 1 } });
  const contactIds = contacts.map((c) => c._id);
  const deals = contactIds.length ? await findMany('crm_deals', { contactId: { $in: contactIds } }, { projection: { contactId: 1, status: 1, value: 1 } }) : [];

  const dealsByContact = {};
  for (const d of deals) {
    const key = String(d.contactId);
    (dealsByContact[key] ??= []).push(d);
  }

  const bySource = {};
  for (const c of contacts) {
    const key = c.source || 'other';
    bySource[key] ??= { source: key, contactCount: 0, wonContactCount: 0, wonValue: 0 };
    bySource[key].contactCount += 1;
    const cDeals = dealsByContact[String(c._id)] || [];
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

  const filter = {};
  const scoped = await getScopedAssigneeIds(req.user, level);
  if (scoped) filter.loggedBy = { $in: scoped };

  const feedback = await findMany('crm_feedback', filter, {});
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

  const filter = await buildAssigneeFilter(req, level);
  if (req.query.pipelineId) filter.pipelineId = new ObjectId(req.query.pipelineId);
  if (req.query.status) filter.status = req.query.status;

  const deals = await findMany('crm_deals', filter, { sort: { createdAt: -1 } });
  const contactIds = [...new Set(deals.map((d) => String(d.contactId)))].map((id) => new ObjectId(id));
  const contacts = await findMany('crm_contacts', { _id: { $in: contactIds } }, { projection: { firstName: 1, lastName: 1 } });
  const contactMap = Object.fromEntries(contacts.map((c) => [String(c._id), c]));

  const header = 'Title,Contact,Value,Currency,Status,ExpectedCloseDate,CreatedAt,WonAt,LostAt';
  const rows = deals.map((d) => {
    const contact = contactMap[String(d.contactId)];
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
