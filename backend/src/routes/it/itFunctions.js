// Postgres migration (Phase 9) — devices (+ device_assignment_history),
// software_apps (+ software_assignments), it_requests are Postgres now.
// employees/users have been Postgres since Phase 1.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { notifyHR, createInboxItem } = require('../inbox/inboxFunctions');

// ── DEVICES ───────────────────────────────────────────────────────────────────

const listDevices = async (req, res) => {
  let query = knex('devices');
  const isStaff = req.user?.role === 'staff';

  if (isStaff) {
    // Staff can only see their own assigned devices
    if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, { data: [], total: 0 });
    query = query.where({ assignedTo: String(req.user.employeeId) });
  } else {
    if (req.query.type)       query = query.where({ type: req.query.type });
    if (req.query.status)     query = query.where({ status: req.query.status });
    if (req.query.search)     query = query.whereILike('name', `%${req.query.search}%`);
    if (req.query.employeeId) query = query.where({ assignedTo: req.query.employeeId });
  }

  const { page, limit, skip } = getPagination(req.query);
  const [{ count: total }] = await query.clone().count('* as count');
  const devices = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const enriched = await Promise.all(devices.map(async (d) => {
    const emp = d.assignedTo ? await knex('employees').where({ id: d.assignedTo }).select('fullName', 'designation').first() : null;
    return { ...d, assignedEmployee: emp || null };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(total), page, limit));
};

const getDeviceSummary = async (req, res) => {
  const now = new Date();
  const [[{ count: total }], [{ count: assigned }], [{ count: unassigned }], [{ count: inRepair }], [{ count: needsAttention }]] = await Promise.all([
    knex('devices').count('* as count'),
    knex('devices').where({ status: 'assigned' }).count('* as count'),
    knex('devices').where({ status: 'unassigned' }).count('* as count'),
    knex('devices').where({ status: 'in_repair' }).count('* as count'),
    knex('devices').where((qb) => qb.where({ status: 'in_repair' }).orWhere('warrantyExpiry', '<', now)).count('* as count'),
  ]);
  return returnFunction(res, 200, true, req.locale.success, {
    total: Number(total), assigned: Number(assigned), unassigned: Number(unassigned),
    inRepair: Number(inRepair), needsAttention: Number(needsAttention),
  });
};

const getDevice = async (req, res) => {
  const device = await knex('devices').where({ id: req.params.id }).first();
  if (!device) return returnFunction(res, 404, false, req.locale.notFound);
  const emp = device.assignedTo ? await knex('employees').where({ id: device.assignedTo }).first() : null;
  return returnFunction(res, 200, true, req.locale.success, { ...device, assignedEmployee: emp || null });
};

// device_asset_tag counter — see migration file header: the original
// countDocuments-based numbering was global (not actually year-scoped despite
// the "IT-YYYY-" prefix); preserved faithfully via a single non-year-suffixed
// counters key, seeded from the real device count by the ETL.
const nextAssetTagSeq = async () => {
  const [row] = await knex('counters')
    .insert({ id: 'device_asset_tag', seq: 1 })
    .onConflict('id')
    .merge({ seq: knex.raw('"counters"."seq" + 1') })
    .returning('*');
  return row.seq;
};

const createDevice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'type', 'serialNumber', 'condition'])) return;

  // Auto-generate system asset tag if none provided: IT-YYYY-NNN
  let assetTag = req.body.assetTag || null;
  if (!assetTag) {
    const year = new Date().getFullYear();
    const seq = await nextAssetTagSeq();
    assetTag = `IT-${year}-${String(seq).padStart(3, '0')}`;
  }

  const doc = {
    id: newId(),
    name:           req.body.name,
    type:           req.body.type,
    brand:          req.body.brand || null,
    model:          req.body.model || null,
    serialNumber:   req.body.serialNumber,
    assetTag,
    purchaseDate:   req.body.purchaseDate ? new Date(req.body.purchaseDate) : null,
    purchasePrice:  req.body.purchasePrice ? Number(req.body.purchasePrice) : null,
    currency:       req.body.currency || 'KES',
    vendor:         req.body.vendor || null,
    warrantyExpiry: req.body.warrantyExpiry ? new Date(req.body.warrantyExpiry) : null,
    condition:      req.body.condition,
    status:         'unassigned',
    assignedTo:     null,
    assignedAt:     null,
    notes:          req.body.notes || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Optionally assign on creation
  let historyEntry = null;
  if (req.body.assignedTo) {
    doc.assignedTo = String(req.body.assignedTo);
    doc.assignedAt = new Date();
    doc.status = 'assigned';
    historyEntry = { deviceId: doc.id, employeeId: doc.assignedTo, assignedAt: doc.assignedAt, returnedAt: null, condition: doc.condition };
  }

  const [saved] = await knex('devices').insert(doc).returning('*');
  if (historyEntry) await knex('device_assignment_history').insert(historyEntry);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id });
};

const updateDevice = async (req, res) => {
  const device = await knex('devices').where({ id: req.params.id }).first();
  if (!device) return returnFunction(res, 404, false, req.locale.notFound);

  const update = { updatedAt: new Date() };
  ['name', 'type', 'brand', 'model', 'serialNumber', 'assetTag', 'condition', 'notes', 'vendor', 'currency'].forEach((f) => {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  });
  if (req.body.purchaseDate)   update.purchaseDate   = new Date(req.body.purchaseDate);
  if (req.body.purchasePrice)  update.purchasePrice  = Number(req.body.purchasePrice);
  if (req.body.warrantyExpiry) update.warrantyExpiry = new Date(req.body.warrantyExpiry);

  await knex('devices').where({ id: device.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteDevice = async (req, res) => {
  const device = await knex('devices').where({ id: req.params.id }).first();
  if (!device) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('device_assignment_history').where({ deviceId: device.id }).delete();
  await knex('devices').where({ id: device.id }).delete();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const assignDevice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId'])) return;
  const device = await knex('devices').where({ id: req.params.id }).first();
  if (!device) return returnFunction(res, 404, false, req.locale.notFound);
  if (device.status === 'assigned') return returnFunction(res, 400, false, 'Device is already assigned.');

  const empId = String(req.body.employeeId);
  const now = new Date();

  await knex('devices').where({ id: device.id }).update({ assignedTo: empId, assignedAt: now, status: 'assigned', updatedAt: now });
  await knex('device_assignment_history').insert({ deviceId: device.id, employeeId: empId, assignedAt: now, returnedAt: null, condition: device.condition });
  return returnFunction(res, 200, true, 'Device assigned.');
};

const unassignDevice = async (req, res) => {
  const device = await knex('devices').where({ id: req.params.id }).first();
  if (!device) return returnFunction(res, 404, false, req.locale.notFound);
  if (device.status !== 'assigned') return returnFunction(res, 400, false, 'Device is not currently assigned.');

  const now = new Date();
  await knex('devices').where({ id: device.id }).update({ assignedTo: null, assignedAt: null, status: 'unassigned', updatedAt: now });
  // Close the open history entry
  await knex('device_assignment_history').where({ deviceId: device.id }).whereNull('returnedAt').update({ returnedAt: now });
  return returnFunction(res, 200, true, 'Device unassigned.');
};

// ── SOFTWARE / APPS ───────────────────────────────────────────────────────────

const listSoftware = async (req, res) => {
  let query = knex('software_apps');
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.category) query = query.where({ category: req.query.category });
  const software = await query.orderBy('name', 'asc');
  return returnFunction(res, 200, true, req.locale.success, software);
};

const getSoftwareSummary = async (req, res) => {
  const apps = await knex('software_apps');
  const totalLicenses = apps.reduce((s, a) => s + (a.totalLicenses || 0), 0);
  const assignedLicenses = apps.reduce((s, a) => s + (a.assignedLicenses || 0), 0);
  const now = new Date();
  const soon = new Date(now); soon.setDate(now.getDate() + 30);
  const expiringSoon = apps.filter((a) => a.renewalDate && new Date(a.renewalDate) <= soon && new Date(a.renewalDate) >= now).length;
  const monthlyCost = apps.reduce((s, a) => {
    if (!a.costPerLicense) return s;
    const n = a.billingCycle === 'annual' ? (a.costPerLicense / 12) * (a.totalLicenses || 1) : a.costPerLicense * (a.totalLicenses || 1);
    return s + n;
  }, 0);
  return returnFunction(res, 200, true, req.locale.success, { totalLicenses, assignedLicenses, monthlyCost: Math.round(monthlyCost), expiringSoon });
};

const createSoftware = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'licenseType'])) return;
  const doc = {
    id: newId(),
    name:             req.body.name,
    category:         req.body.category || 'Other',
    vendor:           req.body.vendor || null,
    licenseType:      req.body.licenseType,
    totalLicenses:    req.body.totalLicenses ? Number(req.body.totalLicenses) : 0,
    assignedLicenses: 0,
    costPerLicense:   req.body.costPerLicense ? Number(req.body.costPerLicense) : 0,
    currency:         req.body.currency || 'KES',
    billingCycle:     req.body.billingCycle || 'monthly',
    renewalDate:      req.body.renewalDate ? new Date(req.body.renewalDate) : null,
    adminId:          req.body.adminId || null,
    loginUrl:         req.body.loginUrl || null,
    status:           'active',
    notes:            req.body.notes || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('software_apps').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id });
};

const updateSoftware = async (req, res) => {
  const app = await knex('software_apps').where({ id: req.params.id }).first();
  if (!app) return returnFunction(res, 404, false, req.locale.notFound);
  const update = { updatedAt: new Date() };
  ['name', 'category', 'vendor', 'licenseType', 'loginUrl', 'status', 'notes', 'currency', 'billingCycle'].forEach((f) => {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  });
  if (req.body.totalLicenses !== undefined) update.totalLicenses = Number(req.body.totalLicenses);
  if (req.body.costPerLicense !== undefined) update.costPerLicense = Number(req.body.costPerLicense);
  if (req.body.renewalDate) update.renewalDate = new Date(req.body.renewalDate);
  await knex('software_apps').where({ id: app.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteSoftware = async (req, res) => {
  await knex('software_assignments').where({ softwareId: req.params.id }).delete();
  await knex('software_apps').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const assignSoftware = async (req, res) => {
  const app = await knex('software_apps').where({ id: req.params.id }).first();
  if (!app) return returnFunction(res, 404, false, req.locale.notFound);
  const empId = String(req.params.employeeId);
  const existing = await knex('software_assignments').where({ softwareId: app.id, employeeId: empId }).first();
  if (existing) return returnFunction(res, 409, false, 'Employee already has access.');

  await knex('software_assignments').insert({ softwareId: app.id, employeeId: empId, assignedAt: new Date() });
  await knex('software_apps').where({ id: app.id }).increment('assignedLicenses', 1).update({ updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Access granted.');
};

const revokeSoftware = async (req, res) => {
  const empId = String(req.params.employeeId);
  const deleted = await knex('software_assignments').where({ softwareId: req.params.id, employeeId: empId }).delete();
  if (deleted) await knex('software_apps').where({ id: req.params.id }).decrement('assignedLicenses', 1).update({ updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Access revoked.');
};

// ── IT REQUESTS ───────────────────────────────────────────────────────────────

const listRequests = async (req, res) => {
  let query = knex('it_requests');
  if (req.user.role === 'staff') query = query.where({ requesterId: req.user.id });
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.type)   query = query.where({ type: req.query.type });

  const { page, limit, skip } = getPagination(req.query);
  const [{ count: total }] = await query.clone().count('* as count');
  const requests = await query.clone().orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const enriched = await Promise.all(requests.map(async (r) => {
    const [requester, assignee, device] = await Promise.all([
      r.employeeId ? knex('employees').where({ id: r.employeeId }).select('fullName').first().catch(() => null) : null,
      r.assignedTo ? knex('employees').where({ id: r.assignedTo }).select('fullName').first().catch(() => null) : null,
      r.deviceId ? knex('devices').where({ id: r.deviceId }).select('name', 'type', 'condition', 'status').first().catch(() => null) : null,
    ]);
    return {
      ...r,
      requesterName: requester?.fullName || 'Unknown',
      assigneeName:  assignee?.fullName  || null,
      device:        device || null,
    };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(total), page, limit));
};

const createRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['type', 'subject', 'description', 'priority'])) return;
  const doc = {
    id: newId(),
    requesterId:   req.user.id,
    employeeId:    req.user.employeeId ? String(req.user.employeeId) : null,
    type:          req.body.type,
    subject:       req.body.subject,
    description:   req.body.description,
    priority:      req.body.priority,
    status:        'open',
    assignedTo:    null,
    resolution:    null,
    resolvedAt:    null,
    // Repair-specific fields
    deviceId:      req.body.deviceId || null,
    deviceName:    req.body.deviceName || null,
    repairNotes:   null,
    createdAt:     new Date(),
    updatedAt:     new Date(),
  };
  const [saved] = await knex('it_requests').insert(doc).returning('*');

  // Notify all HR users so the request lands in their inbox
  notifyHR({
    type: 'it_request',
    subType: 'it_request_submitted',
    title: 'New IT Request',
    subtitle: `${doc.type.replace(/_/g, ' ')} — ${doc.subject}`,
    referenceId: saved.id,
    referenceModel: 'it_requests',
    priority: doc.priority,
    requiresAction: true,
    triggeredBy: req.user.id,
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { id: saved.id });
};

const updateRequest = async (req, res) => {
  const existing = await knex('it_requests').where({ id: req.params.id }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);

  const update = { updatedAt: new Date() };
  ['status', 'priority', 'resolution', 'type', 'subject', 'description', 'repairNotes'].forEach((f) => {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  });

  const isNewAssignment = req.body.assignedTo && String(req.body.assignedTo) !== String(existing.assignedTo);
  if (req.body.assignedTo) update.assignedTo = String(req.body.assignedTo);

  await knex('it_requests').where({ id: existing.id }).update(update);

  // When a repair request is assigned, mark the linked device as in_repair
  if (isNewAssignment && existing.type === 'repair' && existing.deviceId) {
    await knex('devices').where({ id: existing.deviceId }).update({ status: 'in_repair', updatedAt: new Date() });
  }

  // Notify the newly assigned person
  if (isNewAssignment) {
    const assignedUser = await knex('users').where({ employeeId: String(req.body.assignedTo) }).first();
    if (assignedUser) {
      createInboxItem({
        recipientId:    assignedUser.id,
        type:           'it_request',
        subType:        'it_request_assigned',
        title:          existing.type === 'repair' ? 'Repair Job Assigned to You' : 'IT Request Assigned to You',
        subtitle:       existing.deviceName ? `${existing.subject} — ${existing.deviceName}` : existing.subject,
        referenceId:    existing.id,
        referenceModel: 'it_requests',
        priority:       existing.priority,
        requiresAction: true,
        triggeredBy:    req.user.id,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const resolveRequest = async (req, res) => {
  const existing = await knex('it_requests').where({ id: req.params.id }).first();
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('it_requests').where({ id: existing.id }).update({
    status: 'resolved', resolution: req.body.resolution || '', resolvedAt: new Date(), updatedAt: new Date(),
  });
  // When a repair request resolves, restore the device to available with updated condition
  if (existing.type === 'repair' && existing.deviceId) {
    const newCondition = req.body.updatedCondition || 'good';
    await knex('devices').where({ id: existing.deviceId }).update({ status: 'unassigned', condition: newCondition, updatedAt: new Date() });
  }
  return returnFunction(res, 200, true, 'Request resolved.');
};

// ── Expiring Assets (warranty/license expiring within next N days) ────────────
// Fixed forward this phase — software_licenses was a dead/orphaned collection
// (only ever read, never written anywhere in the app, 0 rows always; see
// migration file header). The real per-app renewal date lives on software_apps.
const getExpiringAssets = async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const now  = new Date();
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const [expiringDevices, expiringSoftware] = await Promise.all([
    knex('devices').where('warrantyExpiry', '>=', now).where('warrantyExpiry', '<=', cutoff).whereNot({ status: 'retired' }).orderBy('warrantyExpiry', 'asc'),
    knex('software_apps').where('renewalDate', '>=', now).where('renewalDate', '<=', cutoff).orderBy('renewalDate', 'asc'),
  ]);

  const enrichedDevices = await Promise.all(expiringDevices.map(async (d) => {
    const emp = d.assignedTo ? await knex('employees').where({ id: d.assignedTo }).select('fullName').first() : null;
    const daysLeft = Math.ceil((new Date(d.warrantyExpiry) - now) / (1000 * 60 * 60 * 24));
    return { ...d, assignedEmployee: emp || null, daysLeft };
  }));

  const enrichedSoftware = expiringSoftware.map((s) => ({
    ...s,
    daysLeft: Math.ceil((new Date(s.renewalDate) - now) / (1000 * 60 * 60 * 24)),
  }));

  return returnFunction(res, 200, true, 'Expiring assets fetched', {
    devices:  enrichedDevices,
    software: enrichedSoftware,
    totalExpiring: enrichedDevices.length + enrichedSoftware.length,
  });
};

module.exports = {
  listDevices, getDeviceSummary, getDevice, createDevice, updateDevice, deleteDevice,
  assignDevice, unassignDevice,
  listSoftware, getSoftwareSummary, createSoftware, updateSoftware, deleteSoftware,
  assignSoftware, revokeSoftware,
  listRequests, createRequest, updateRequest, resolveRequest,
  getExpiringAssets,
};
