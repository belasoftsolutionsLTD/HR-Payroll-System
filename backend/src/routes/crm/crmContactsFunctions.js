// Postgres migration (Phase 7) — crm_contacts/crm_companies/crm_deals are Postgres now.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { getCrmAccessLevel, getScopedAssigneeIds, canAccessAssignee } = require('../../lib/crm/crmAccess');

const listContacts = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scoped = await getScopedAssigneeIds(req.user, level);

  const { page, limit, skip } = getPagination(req.query);
  let query = knex('crm_contacts').whereNot({ isActive: false });
  if (scoped) query = query.whereIn('assignedTo', scoped);
  if (req.query.companyId) query = query.where({ companyId: req.query.companyId });
  if (req.query.tag) query = query.whereRaw('? = ANY("tags")', [req.query.tag]);
  if (req.query.search) {
    const q = `%${req.query.search.trim()}%`;
    query = query.where((qb) => qb.whereILike('firstName', q).orWhereILike('lastName', q).orWhereILike('email', q).orWhereILike('phone', q));
  }

  const [{ count }] = await query.clone().count('* as count');
  const contacts = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const companyIds = [...new Set(contacts.filter((c) => c.companyId).map((c) => c.companyId))];
  const companies = companyIds.length ? await knex('crm_companies').whereIn('id', companyIds).select('id', 'name') : [];
  const companyMap = Object.fromEntries(companies.map((c) => [c.id, c]));
  const enriched = contacts.map((c) => ({ ...c, company: c.companyId ? companyMap[c.companyId] || null : null }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getContact = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const contact = await knex('crm_contacts').where({ id: req.params.id }).first();
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const [company, deals] = await Promise.all([
    contact.companyId ? knex('crm_companies').where({ id: contact.companyId }).select('name').first() : null,
    knex('crm_deals').where({ contactId: contact.id }).orderBy('createdAt', 'desc'),
  ]);
  return returnFunction(res, 200, true, req.locale.success, { ...contact, company: company || null, deals });
};

const createContact = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['firstName'])) return;
  // Website/event sources are otherwise too vague to act on later ("website" alone
  // doesn't say which one) — require the specific detail at creation time instead of
  // leaving it to be filled in later (in practice, never).
  if (req.body.source === 'website' && !req.body.sourceWebsite?.trim()) {
    return returnFunction(res, 400, false, 'sourceWebsite is required when source is "website".');
  }
  if (req.body.source === 'event' && !req.body.sourceEventName?.trim()) {
    return returnFunction(res, 400, false, 'sourceEventName is required when source is "event".');
  }

  const doc = {
    id: newId(),
    firstName: req.body.firstName.trim(),
    lastName: req.body.lastName?.trim() || '',
    email: req.body.email?.trim() || '',
    phone: req.body.phone?.trim() || '',
    companyId: req.body.companyId || null,
    tags: Array.isArray(req.body.tags) ? req.body.tags.map(String) : [],
    // 'manual' only as a fallback for callers that omit source entirely (e.g. programmatic
    // creation) — the Add Contact form always sends a real value from the dropdown now:
    // 'website' | 'referral' | 'cold_outreach' | 'event' | 'social_media' | 'walk_in' | 'other'.
    // 'imported' | 'pos_sale' are set only by their own dedicated flows, never user-picked.
    source: req.body.source || 'manual',
    sourceWebsite: req.body.source === 'website' ? req.body.sourceWebsite.trim() : null,
    sourceEventName: req.body.source === 'event' ? req.body.sourceEventName.trim() : null,
    sourceEventVenue: req.body.source === 'event' ? (req.body.sourceEventVenue?.trim() || null) : null,
    sourceEventDate: req.body.source === 'event' && req.body.sourceEventDate ? new Date(req.body.sourceEventDate) : null,
    assignedTo: req.body.assignedTo || req.user.id,
    customFieldValues: JSON.stringify(req.body.customFieldValues && typeof req.body.customFieldValues === 'object' ? req.body.customFieldValues : {}),
    isActive: true,
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  // Only admin/manager may hand a new contact to someone other than themselves.
  if (doc.assignedTo !== req.user.id && level === 'staff') {
    return returnFunction(res, 403, false, 'You can only create contacts assigned to yourself.');
  }

  const [saved] = await knex('crm_contacts').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updateContact = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const contact = await knex('crm_contacts').where({ id: req.params.id }).first();
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const update = { updatedAt: new Date() };
  if (req.body.firstName !== undefined) update.firstName = req.body.firstName.trim();
  if (req.body.lastName !== undefined) update.lastName = req.body.lastName.trim();
  if (req.body.email !== undefined) update.email = req.body.email.trim();
  if (req.body.phone !== undefined) update.phone = req.body.phone.trim();
  if (req.body.companyId !== undefined) update.companyId = req.body.companyId || null;
  if (Array.isArray(req.body.tags)) update.tags = req.body.tags.map(String);
  if (req.body.source !== undefined) {
    if (req.body.source === 'website' && !req.body.sourceWebsite?.trim()) {
      return returnFunction(res, 400, false, 'sourceWebsite is required when source is "website".');
    }
    if (req.body.source === 'event' && !req.body.sourceEventName?.trim()) {
      return returnFunction(res, 400, false, 'sourceEventName is required when source is "event".');
    }
    update.source = req.body.source;
    update.sourceWebsite = req.body.source === 'website' ? req.body.sourceWebsite.trim() : null;
    update.sourceEventName = req.body.source === 'event' ? req.body.sourceEventName.trim() : null;
    update.sourceEventVenue = req.body.source === 'event' ? (req.body.sourceEventVenue?.trim() || null) : null;
    update.sourceEventDate = req.body.source === 'event' && req.body.sourceEventDate ? new Date(req.body.sourceEventDate) : null;
  }
  if (req.body.customFieldValues && typeof req.body.customFieldValues === 'object') update.customFieldValues = JSON.stringify(req.body.customFieldValues);
  if (req.body.assignedTo !== undefined) {
    if (level === 'staff') return returnFunction(res, 403, false, 'You cannot reassign contacts.');
    update.assignedTo = req.body.assignedTo;
  }

  await knex('crm_contacts').where({ id: contact.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteContact = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized.');
  await knex('crm_contacts').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = { listContacts, getContact, createContact, updateContact, deleteContact };
