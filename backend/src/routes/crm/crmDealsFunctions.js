// Postgres migration (Phase 7) — crm_deals/crm_contacts/crm_pipelines are Postgres now.
// pos_sales was already fixed in Phase 6 (kept as-is below).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { getCrmAccessLevel, getScopedAssigneeIds, canAccessAssignee } = require('../../lib/crm/crmAccess');
const { logSystemActivity } = require('./crmActivitiesFunctions');

const enrichDeals = async (deals) => {
  if (!deals.length) return [];
  const contactIds = [...new Set(deals.map((d) => d.contactId))];
  const contacts = await knex('crm_contacts').whereIn('id', contactIds).select('id', 'firstName', 'lastName');
  const contactMap = Object.fromEntries(contacts.map((c) => [c.id, c]));
  return deals.map((d) => ({ ...d, contact: contactMap[d.contactId] || null }));
};

const listDeals = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scoped = await getScopedAssigneeIds(req.user, level);

  const { page, skip } = getPagination(req.query);
  // The pipeline board wants every open deal at once for client-side column grouping,
  // not a small page — a business realistically has dozens to low-hundreds of open
  // deals, not thousands, so one generous cap stands in for real pagination here.
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 500);
  let query = knex('crm_deals').where({ status: req.query.status || 'open' });
  if (scoped) query = query.whereIn('assignedTo', scoped);
  if (req.query.pipelineId) query = query.where({ pipelineId: req.query.pipelineId });
  if (req.query.contactId) query = query.where({ contactId: req.query.contactId });

  const [{ count }] = await query.clone().count('* as count');
  const deals = await query.clone().orderBy('updatedAt', 'desc').limit(limit).offset(skip);
  const enriched = await enrichDeals(deals);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const deal = await knex('crm_deals').where({ id: req.params.id }).first();
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const [contact, pipeline] = await Promise.all([
    knex('crm_contacts').where({ id: deal.contactId }).select('firstName', 'lastName', 'companyId').first(),
    knex('crm_pipelines').where({ id: deal.pipelineId }).first(),
  ]);
  return returnFunction(res, 200, true, req.locale.success, { ...deal, contact: contact || null, pipeline: pipeline || null });
};

const createDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['title', 'contactId', 'pipelineId'])) return;

  const [contact, pipeline] = await Promise.all([
    knex('crm_contacts').where({ id: req.body.contactId }).first(),
    knex('crm_pipelines').where({ id: req.body.pipelineId }).first(),
  ]);
  if (!contact) return returnFunction(res, 404, false, 'Contact not found.');
  if (!pipeline) return returnFunction(res, 404, false, 'Pipeline not found.');
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized for this contact.');

  const stageId = req.body.stageId || pipeline.stages[0]?.id;
  if (!pipeline.stages.some((s) => s.id === stageId)) return returnFunction(res, 400, false, 'stageId does not belong to this pipeline.');

  const assignedTo = req.body.assignedTo || req.user.id;
  if (level === 'staff' && assignedTo !== req.user.id) {
    return returnFunction(res, 403, false, 'You can only create deals assigned to yourself.');
  }

  const doc = {
    id: newId(),
    title: req.body.title.trim(),
    contactId: contact.id,
    companyId: contact.companyId || null,
    pipelineId: pipeline.id,
    stageId,
    value: Number(req.body.value) || 0,
    currency: req.body.currency || 'KES',
    expectedCloseDate: req.body.expectedCloseDate ? new Date(req.body.expectedCloseDate) : null,
    nextAction: req.body.nextAction?.description
      ? JSON.stringify({ description: req.body.nextAction.description.trim(), dueDate: req.body.nextAction.dueDate ? new Date(req.body.nextAction.dueDate) : null })
      : null,
    assignedTo,
    status: 'open',
    wonAt: null, lostAt: null, confirmedSaleId: null,
    customFieldValues: JSON.stringify(req.body.customFieldValues && typeof req.body.customFieldValues === 'object' ? req.body.customFieldValues : {}),
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('crm_deals').insert(doc).returning('*');

  await logSystemActivity({
    contactId: contact.id, dealId: saved.id, type: 'deal_created',
    subject: `Deal "${saved.title}" created`, performedBy: req.user.id, performedByName: req.user.name,
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const deal = await knex('crm_deals').where({ id: req.params.id }).first();
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const update = { updatedAt: new Date() };
  if (req.body.title !== undefined) update.title = req.body.title.trim();
  if (req.body.value !== undefined) update.value = Number(req.body.value) || 0;
  if (req.body.currency !== undefined) update.currency = req.body.currency;
  if (req.body.expectedCloseDate !== undefined) update.expectedCloseDate = req.body.expectedCloseDate ? new Date(req.body.expectedCloseDate) : null;
  if (req.body.nextAction !== undefined) {
    update.nextAction = req.body.nextAction?.description
      ? JSON.stringify({ description: req.body.nextAction.description.trim(), dueDate: req.body.nextAction.dueDate ? new Date(req.body.nextAction.dueDate) : null })
      : null;
  }
  if (req.body.customFieldValues && typeof req.body.customFieldValues === 'object') update.customFieldValues = JSON.stringify(req.body.customFieldValues);

  await knex('crm_deals').where({ id: deal.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// The drag-and-drop pipeline board's core action — moving a deal card between columns.
// Every move is logged as a timeline event on the linked contact, per the module spec.
const moveDealStage = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['stageId'])) return;

  const deal = await knex('crm_deals').where({ id: req.params.id }).first();
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');
  if (deal.status !== 'open') return returnFunction(res, 400, false, 'This deal is already closed.');

  const pipeline = await knex('crm_pipelines').where({ id: deal.pipelineId }).first();
  const fromStage = pipeline?.stages.find((s) => s.id === deal.stageId);
  const toStage = pipeline?.stages.find((s) => s.id === req.body.stageId);
  if (!toStage) return returnFunction(res, 400, false, 'stageId does not belong to this deal\'s pipeline.');

  await knex('crm_deals').where({ id: deal.id }).update({ stageId: toStage.id, updatedAt: new Date() });
  await logSystemActivity({
    contactId: deal.contactId, dealId: deal.id, type: 'stage_change',
    subject: `Deal "${deal.title}" moved from ${fromStage?.name ?? '—'} to ${toStage.name}`,
    performedBy: req.user.id, performedByName: req.user.name,
  });

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Optional close-the-loop confirmation against a real POS sale — manual link only
// (the staff member picks the sale, never an automatic amount/date guess). Reading
// pos_sales here is read-only; nothing in CRM ever writes to POS.
const winDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const deal = await knex('crm_deals').where({ id: req.params.id }).first();
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');
  if (deal.status !== 'open') return returnFunction(res, 400, false, 'This deal is already closed.');

  let confirmedSaleId = null;
  if (req.body.confirmedSaleId) {
    const sale = await knex('pos_sales').where({ id: req.body.confirmedSaleId }).first();
    if (!sale) return returnFunction(res, 404, false, 'Sale not found.');
    if (String(sale.contactId) !== String(deal.contactId)) return returnFunction(res, 400, false, 'That sale is not linked to this deal\'s contact.');
    confirmedSaleId = sale.id;
  }

  const pipeline = await knex('crm_pipelines').where({ id: deal.pipelineId }).first();
  const wonStage = pipeline?.stages.find((s) => s.isWon);

  await knex('crm_deals').where({ id: deal.id }).update({
    status: 'won', wonAt: new Date(), confirmedSaleId, stageId: wonStage?.id || deal.stageId, updatedAt: new Date(),
  });
  await logSystemActivity({
    contactId: deal.contactId, dealId: deal.id, type: 'deal_won',
    subject: `Deal "${deal.title}" won${confirmedSaleId ? ' — confirmed against a POS sale' : ''}`,
    performedBy: req.user.id, performedByName: req.user.name,
  });

  return returnFunction(res, 200, true, 'Deal marked as won.');
};

const loseDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const deal = await knex('crm_deals').where({ id: req.params.id }).first();
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');
  if (deal.status !== 'open') return returnFunction(res, 400, false, 'This deal is already closed.');

  const pipeline = await knex('crm_pipelines').where({ id: deal.pipelineId }).first();
  const lostStage = pipeline?.stages.find((s) => s.isLost);

  await knex('crm_deals').where({ id: deal.id }).update({
    status: 'lost', lostAt: new Date(), lostReason: req.body.reason || null, stageId: lostStage?.id || deal.stageId, updatedAt: new Date(),
  });
  await logSystemActivity({
    contactId: deal.contactId, dealId: deal.id, type: 'deal_lost',
    subject: `Deal "${deal.title}" lost${req.body.reason ? `: ${req.body.reason}` : ''}`,
    performedBy: req.user.id, performedByName: req.user.name,
  });

  return returnFunction(res, 200, true, 'Deal marked as lost.');
};

const reassignDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized to reassign deals.');
  if (!validateRequiredFields(req, res, ['assignedTo'])) return;

  const deal = await knex('crm_deals').where({ id: req.params.id }).first();
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  await knex('crm_deals').where({ id: deal.id }).update({ assignedTo: req.body.assignedTo, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

module.exports = { listDeals, getDeal, createDeal, updateDeal, moveDealStage, winDeal, loseDeal, reassignDeal };
