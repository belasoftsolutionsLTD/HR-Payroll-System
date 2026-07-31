const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { getCrmAccessLevel, getScopedAssigneeIds, canAccessAssignee } = require('../../lib/crm/crmAccess');

const listContacts = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const scoped = await getScopedAssigneeIds(req.user, level);

  const { page, limit, skip } = getPagination(req.query);
  const filter = { isActive: { $ne: false } };
  if (scoped) filter.assignedTo = { $in: scoped };
  if (req.query.companyId) filter.companyId = new ObjectId(req.query.companyId);
  if (req.query.tag) filter.tags = req.query.tag;
  if (req.query.search) {
    const q = req.query.search.trim();
    filter.$or = [
      { firstName: { $regex: q, $options: 'i' } },
      { lastName: { $regex: q, $options: 'i' } },
      { email: { $regex: q, $options: 'i' } },
      { phone: { $regex: q, $options: 'i' } },
    ];
  }

  const [total, contacts] = await Promise.all([
    countDocuments('crm_contacts', filter),
    findMany('crm_contacts', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const companyIds = [...new Set(contacts.filter((c) => c.companyId).map((c) => String(c.companyId)))].map((id) => new ObjectId(id));
  const companies = companyIds.length ? await findMany('crm_companies', { _id: { $in: companyIds } }, { projection: { name: 1 } }) : [];
  const companyMap = Object.fromEntries(companies.map((c) => [String(c._id), c]));
  const enriched = contacts.map((c) => ({ ...c, company: c.companyId ? companyMap[String(c.companyId)] || null : null }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getContact = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const contact = await findOne('crm_contacts', { _id: new ObjectId(req.params.id) });
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const [company, deals] = await Promise.all([
    contact.companyId ? findOne('crm_companies', { _id: contact.companyId }, { projection: { name: 1 } }) : null,
    findMany('crm_deals', { contactId: contact._id }, { sort: { createdAt: -1 } }),
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
    firstName: req.body.firstName.trim(),
    lastName: req.body.lastName?.trim() || '',
    email: req.body.email?.trim() || '',
    phone: req.body.phone?.trim() || '',
    companyId: req.body.companyId ? new ObjectId(req.body.companyId) : null,
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
    assignedTo: req.body.assignedTo ? new ObjectId(req.body.assignedTo) : req.user._id,
    customFieldValues: req.body.customFieldValues && typeof req.body.customFieldValues === 'object' ? req.body.customFieldValues : {},
    isActive: true,
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  // Only admin/manager may hand a new contact to someone other than themselves.
  if (String(doc.assignedTo) !== String(req.user._id) && level === 'staff') {
    return returnFunction(res, 403, false, 'You can only create contacts assigned to yourself.');
  }

  const result = await insertOne('crm_contacts', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateContact = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const contact = await findOne('crm_contacts', { _id: new ObjectId(req.params.id) });
  if (!contact) return returnFunction(res, 404, false, req.locale.notFound);
  if (!(await canAccessAssignee(req.user, level, contact.assignedTo))) return returnFunction(res, 403, false, 'Not authorized.');

  const update = { updatedAt: new Date() };
  if (req.body.firstName !== undefined) update.firstName = req.body.firstName.trim();
  if (req.body.lastName !== undefined) update.lastName = req.body.lastName.trim();
  if (req.body.email !== undefined) update.email = req.body.email.trim();
  if (req.body.phone !== undefined) update.phone = req.body.phone.trim();
  if (req.body.companyId !== undefined) update.companyId = req.body.companyId ? new ObjectId(req.body.companyId) : null;
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
  if (req.body.customFieldValues && typeof req.body.customFieldValues === 'object') update.customFieldValues = req.body.customFieldValues;
  if (req.body.assignedTo !== undefined) {
    if (level === 'staff') return returnFunction(res, 403, false, 'You cannot reassign contacts.');
    update.assignedTo = new ObjectId(req.body.assignedTo);
  }

  await updateOne('crm_contacts', { _id: contact._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteContact = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin' && level !== 'manager') return returnFunction(res, 403, false, 'Not authorized.');
  await updateOne('crm_contacts', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = { listContacts, getContact, createContact, updateContact, deleteContact };
