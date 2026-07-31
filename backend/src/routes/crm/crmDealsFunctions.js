const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { getCrmAccessLevel, getScopedAssigneeIds, canAccessAssignee } = require('../../lib/crm/crmAccess');
const { logSystemActivity } = require('./crmActivitiesFunctions');

const enrichDeals = async (deals) => {
  if (!deals.length) return [];
  const contactIds = [...new Set(deals.map((d) => String(d.contactId)))].map((id) => new ObjectId(id));
  const contacts = await findMany('crm_contacts', { _id: { $in: contactIds } }, { projection: { firstName: 1, lastName: 1 } });
  const contactMap = Object.fromEntries(contacts.map((c) => [String(c._id), c]));
  return deals.map((d) => ({ ...d, contact: contactMap[String(d.contactId)] || null }));
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
  const filter = {};
  if (scoped) filter.assignedTo = { $in: scoped };
  if (req.query.pipelineId) filter.pipelineId = new ObjectId(req.query.pipelineId);
  filter.status = req.query.status || 'open';
  if (req.query.contactId) filter.contactId = new ObjectId(req.query.contactId);

  const [total, deals] = await Promise.all([
    countDocuments('crm_deals', filter),
    findMany('crm_deals', filter, { skip, limit, sort: { updatedAt: -1 } }),
  ]);
  const enriched = await enrichDeals(deals);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const deal = await findOne('crm_deals', { _id: new ObjectId(req.params.id) });
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const [contact, pipeline] = await Promise.all([
    findOne('crm_contacts', { _id: deal.contactId }, { projection: { firstName: 1, lastName: 1, companyId: 1 } }),
    findOne('crm_pipelines', { _id: deal.pipelineId }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, { ...deal, contact: contact || null, pipeline: pipeline || null });
};

const createDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['title', 'contactId', 'pipelineId'])) return;

  const [contact, pipeline] = await Promise.all([
    findOne('crm_contacts', { _id: new ObjectId(req.body.contactId) }),
    findOne('crm_pipelines', { _id: new ObjectId(req.body.pipelineId) }),
  ]);
  if (!contact) return returnFunction(res, 404, false, 'Contact not found.');
  if (!pipeline) return returnFunction(res, 404, false, 'Pipeline not found.');
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized for this contact.');

  const stageId = req.body.stageId || pipeline.stages[0]?.id;
  if (!pipeline.stages.some((s) => s.id === stageId)) return returnFunction(res, 400, false, 'stageId does not belong to this pipeline.');

  const assignedTo = req.body.assignedTo ? new ObjectId(req.body.assignedTo) : req.user._id;
  if (level === 'staff' && String(assignedTo) !== String(req.user._id)) {
    return returnFunction(res, 403, false, 'You can only create deals assigned to yourself.');
  }

  const doc = {
    title: req.body.title.trim(),
    contactId: contact._id,
    companyId: contact.companyId || null,
    pipelineId: pipeline._id,
    stageId,
    value: Number(req.body.value) || 0,
    currency: req.body.currency || 'KES',
    expectedCloseDate: req.body.expectedCloseDate ? new Date(req.body.expectedCloseDate) : null,
    nextAction: req.body.nextAction?.description ? { description: req.body.nextAction.description.trim(), dueDate: req.body.nextAction.dueDate ? new Date(req.body.nextAction.dueDate) : null } : null,
    assignedTo,
    status: 'open',
    wonAt: null, lostAt: null, confirmedSaleId: null,
    customFieldValues: req.body.customFieldValues && typeof req.body.customFieldValues === 'object' ? req.body.customFieldValues : {},
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('crm_deals', doc);

  await logSystemActivity({
    contactId: contact._id, dealId: result.insertedId, type: 'deal_created',
    subject: `Deal "${doc.title}" created`, performedBy: req.user._id, performedByName: req.user.name,
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const deal = await findOne('crm_deals', { _id: new ObjectId(req.params.id) });
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const update = { updatedAt: new Date() };
  if (req.body.title !== undefined) update.title = req.body.title.trim();
  if (req.body.value !== undefined) update.value = Number(req.body.value) || 0;
  if (req.body.currency !== undefined) update.currency = req.body.currency;
  if (req.body.expectedCloseDate !== undefined) update.expectedCloseDate = req.body.expectedCloseDate ? new Date(req.body.expectedCloseDate) : null;
  if (req.body.nextAction !== undefined) {
    update.nextAction = req.body.nextAction?.description
      ? { description: req.body.nextAction.description.trim(), dueDate: req.body.nextAction.dueDate ? new Date(req.body.nextAction.dueDate) : null }
      : null;
  }
  if (req.body.customFieldValues && typeof req.body.customFieldValues === 'object') update.customFieldValues = req.body.customFieldValues;

  await updateOne('crm_deals', { _id: deal._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// The drag-and-drop pipeline board's core action — moving a deal card between columns.
// Every move is logged as a timeline event on the linked contact, per the module spec.
const moveDealStage = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['stageId'])) return;

  const deal = await findOne('crm_deals', { _id: new ObjectId(req.params.id) });
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');
  if (deal.status !== 'open') return returnFunction(res, 400, false, 'This deal is already closed.');

  const pipeline = await findOne('crm_pipelines', { _id: deal.pipelineId });
  const fromStage = pipeline?.stages.find((s) => s.id === deal.stageId);
  const toStage = pipeline?.stages.find((s) => s.id === req.body.stageId);
  if (!toStage) return returnFunction(res, 400, false, 'stageId does not belong to this deal\'s pipeline.');

  await updateOne('crm_deals', { _id: deal._id }, { $set: { stageId: toStage.id, updatedAt: new Date() } });
  await logSystemActivity({
    contactId: deal.contactId, dealId: deal._id, type: 'stage_change',
    subject: `Deal "${deal.title}" moved from ${fromStage?.name ?? '—'} to ${toStage.name}`,
    performedBy: req.user._id, performedByName: req.user.name,
  });

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Optional close-the-loop confirmation against a real POS sale — manual link only
// (the staff member picks the sale, never an automatic amount/date guess). Reading
// pos_sales here is read-only; nothing in CRM ever writes to POS.
const winDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const deal = await findOne('crm_deals', { _id: new ObjectId(req.params.id) });
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');
  if (deal.status !== 'open') return returnFunction(res, 400, false, 'This deal is already closed.');

  let confirmedSaleId = null;
  if (req.body.confirmedSaleId) {
    const sale = await findOne('pos_sales', { _id: new ObjectId(req.body.confirmedSaleId) });
    if (!sale) return returnFunction(res, 404, false, 'Sale not found.');
    if (String(sale.contactId) !== String(deal.contactId)) return returnFunction(res, 400, false, 'That sale is not linked to this deal\'s contact.');
    confirmedSaleId = sale._id;
  }

  const pipeline = await findOne('crm_pipelines', { _id: deal.pipelineId });
  const wonStage = pipeline?.stages.find((s) => s.isWon);

  await updateOne('crm_deals', { _id: deal._id }, {
    $set: { status: 'won', wonAt: new Date(), confirmedSaleId, stageId: wonStage?.id || deal.stageId, updatedAt: new Date() },
  });
  await logSystemActivity({
    contactId: deal.contactId, dealId: deal._id, type: 'deal_won',
    subject: `Deal "${deal.title}" won${confirmedSaleId ? ' — confirmed against a POS sale' : ''}`,
    performedBy: req.user._id, performedByName: req.user.name,
  });

  return returnFunction(res, 200, true, 'Deal marked as won.');
};

const loseDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const deal = await findOne('crm_deals', { _id: new ObjectId(req.params.id) });
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');
  if (deal.status !== 'open') return returnFunction(res, 400, false, 'This deal is already closed.');

  const pipeline = await findOne('crm_pipelines', { _id: deal.pipelineId });
  const lostStage = pipeline?.stages.find((s) => s.isLost);

  await updateOne('crm_deals', { _id: deal._id }, {
    $set: { status: 'lost', lostAt: new Date(), lostReason: req.body.reason || null, stageId: lostStage?.id || deal.stageId, updatedAt: new Date() },
  });
  await logSystemActivity({
    contactId: deal.contactId, dealId: deal._id, type: 'deal_lost',
    subject: `Deal "${deal.title}" lost${req.body.reason ? `: ${req.body.reason}` : ''}`,
    performedBy: req.user._id, performedByName: req.user.name,
  });

  return returnFunction(res, 200, true, 'Deal marked as lost.');
};

const reassignDeal = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized to reassign deals.');
  if (!validateRequiredFields(req, res, ['assignedTo'])) return;

  const deal = await findOne('crm_deals', { _id: new ObjectId(req.params.id) });
  if (!deal) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, deal.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  await updateOne('crm_deals', { _id: deal._id }, { $set: { assignedTo: new ObjectId(req.body.assignedTo), updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

module.exports = { listDeals, getDeal, createDeal, updateDeal, moveDealStage, winDeal, loseDeal, reassignDeal };
