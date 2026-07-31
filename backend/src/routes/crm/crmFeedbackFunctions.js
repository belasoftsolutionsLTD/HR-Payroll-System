const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne } = require('../../functions/Database/commonDBFunctions');
const { getCrmAccessLevel, canAccessAssignee } = require('../../lib/crm/crmAccess');
const { logSystemActivity } = require('./crmActivitiesFunctions');

// Customer feedback tied to a contact (and optionally the deal it came out of) — the
// gap flagged directly: this module had activities and a unified timeline, but nothing
// captured "how did this go from the customer's side." Deliberately a plain 1-5 rating +
// comment, same minimal shape as an activity, not a survey-builder — that's a much
// bigger feature this doesn't try to be.
const createFeedback = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['rating'])) return;
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return returnFunction(res, 400, false, 'rating must be a whole number from 1 to 5.');

  const contact = await findOne('crm_contacts', { _id: new ObjectId(req.params.id) });
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  let dealId = null;
  if (req.body.dealId) {
    const deal = await findOne('crm_deals', { _id: new ObjectId(req.body.dealId), contactId: contact._id });
    if (!deal) return returnFunction(res, 400, false, 'Deal not found for this contact.');
    dealId = deal._id;
  }

  const doc = {
    contactId: contact._id,
    dealId,
    rating,
    comment: req.body.comment?.trim() || null,
    loggedBy: req.user._id,
    loggedByName: req.user.name,
    createdAt: new Date(),
  };
  const result = await insertOne('crm_feedback', doc);

  // Same "system-generated timeline entry" mechanism deal-won/lost already uses, so
  // feedback shows up in the unified contact timeline without getContactTimeline having
  // to know about a third collection beyond crm_activities/pos_sales — it just reads one
  // more logSystemActivity-authored row.
  await logSystemActivity({
    contactId: contact._id, dealId, type: 'feedback_logged',
    subject: `Feedback logged: ${rating}/5`, notes: doc.comment,
    performedBy: req.user._id, performedByName: req.user.name,
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const listFeedbackForContact = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const contact = await findOne('crm_contacts', { _id: new ObjectId(req.params.id) });
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const feedback = await findMany('crm_feedback', { contactId: contact._id }, { sort: { createdAt: -1 } });
  const avgRating = feedback.length ? Math.round((feedback.reduce((s, f) => s + f.rating, 0) / feedback.length) * 10) / 10 : null;
  return returnFunction(res, 200, true, req.locale.success, { feedback, avgRating, count: feedback.length });
};

module.exports = { createFeedback, listFeedbackForContact };
