const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findOne, findMany } = require('../../functions/Database/commonDBFunctions');
// pos_sales is Postgres now (Phase 6) — found while sweeping CRM; crm_contacts stays
// Mongo, CRM's own phase (7).
const { knex } = require('../../functions/Database/pgDBFunctions');
const { getCrmAccessLevel, canAccessAssignee } = require('../../lib/crm/crmAccess');

// A focused list of one contact's real POS purchases — used by the "confirm this deal
// against an actual sale" picker on the Won action. Read-only against pos_sales; the
// fuller getContactTimeline (crmActivitiesFunctions) merges these into the whole feed,
// this is just the sales on their own for that specific picker use case.
const getContactSales = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const contact = await findOne('crm_contacts', { _id: new ObjectId(req.params.id) });
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const sales = await knex('pos_sales').where({ contactId: String(contact._id) }).whereNot({ status: 'failed' }).orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, sales);
};

module.exports = { getContactSales };
