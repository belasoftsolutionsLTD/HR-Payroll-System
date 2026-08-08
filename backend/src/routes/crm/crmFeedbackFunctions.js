// Postgres migration (Phase 7) — crm_feedback/crm_contacts/crm_deals are Postgres now.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
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

  const contact = await knex('crm_contacts').where({ id: req.params.id }).first();
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  let dealId = null;
  if (req.body.dealId) {
    const deal = await knex('crm_deals').where({ id: req.body.dealId, contactId: contact.id }).first();
    if (!deal) return returnFunction(res, 400, false, 'Deal not found for this contact.');
    dealId = deal.id;
  }

  const doc = {
    id: newId(),
    contactId: contact.id,
    dealId,
    rating,
    comment: req.body.comment?.trim() || null,
    loggedBy: req.user.id,
    loggedByName: req.user.name,
    createdAt: new Date(),
  };
  const [saved] = await knex('crm_feedback').insert(doc).returning('*');

  // Same "system-generated timeline entry" mechanism deal-won/lost already uses, so
  // feedback shows up in the unified contact timeline without getContactTimeline having
  // to know about a third table beyond crm_activities/pos_sales — it just reads one
  // more logSystemActivity-authored row.
  await logSystemActivity({
    contactId: contact.id, dealId, type: 'feedback_logged',
    subject: `Feedback logged: ${rating}/5`, notes: doc.comment,
    performedBy: req.user.id, performedByName: req.user.name,
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const listFeedbackForContact = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const contact = await knex('crm_contacts').where({ id: req.params.id }).first();
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const feedback = await knex('crm_feedback').where({ contactId: contact.id }).orderBy('createdAt', 'desc');
  const avgRating = feedback.length ? Math.round((feedback.reduce((s, f) => s + f.rating, 0) / feedback.length) * 10) / 10 : null;
  return returnFunction(res, 200, true, req.locale.success, { feedback, avgRating, count: feedback.length });
};

module.exports = { createFeedback, listFeedbackForContact };
