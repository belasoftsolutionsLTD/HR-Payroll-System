const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, insertOne, updateOne, deleteOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { notifyHR, createInboxItem } = require('../inbox/inboxFunctions');

// ── DEVICES ───────────────────────────────────────────────────────────────────

const listDevices = async (req, res) => {
  const filter = {};
  const isStaff = req.user?.role === 'staff';

  if (isStaff) {
    // Staff can only see their own assigned devices
    if (!req.user?.employeeId) return returnFunction(res, 200, true, req.locale.success, { data: [], total: 0 });
    filter.assignedTo = new ObjectId(req.user.employeeId);
  } else {
    if (req.query.type)       filter.type   = req.query.type;
    if (req.query.status)     filter.status = req.query.status;
    if (req.query.search)     filter.name   = { $regex: req.query.search, $options: 'i' };
    if (req.query.employeeId) filter.assignedTo = new ObjectId(req.query.employeeId);
  }

  const { page, limit, skip } = getPagination(req.query);
  const [total, devices] = await Promise.all([
    countDocuments('devices', filter),
    findMany('devices', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const enriched = await Promise.all(devices.map(async d => {
    const emp = d.assignedTo ? await findOne('employees', { _id: d.assignedTo }, { projection: { fullName: 1, designation: 1 } }) : null;
    return { ...d, assignedEmployee: emp || null };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getDeviceSummary = async (req, res) => {
  const now = new Date();
  const [total, assigned, unassigned, inRepair] = await Promise.all([
    countDocuments('devices', {}),
    countDocuments('devices', { status: 'assigned' }),
    countDocuments('devices', { status: 'unassigned' }),
    countDocuments('devices', { status: 'in_repair' }),
  ]);
  const needsAttention = await countDocuments('devices', {
    $or: [
      { status: 'in_repair' },
      { warrantyExpiry: { $lt: now } },
    ],
  });
  return returnFunction(res, 200, true, req.locale.success, { total, assigned, unassigned, inRepair, needsAttention });
};

const getDevice = async (req, res) => {
  const device = await findOne('devices', { _id: new ObjectId(req.params.id) });
  if (!device) return returnFunction(res, 404, false, req.locale.notFound);
  const emp = device.assignedTo ? await findOne('employees', { _id: device.assignedTo }) : null;
  return returnFunction(res, 200, true, req.locale.success, { ...device, assignedEmployee: emp || null });
};

const createDevice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'type', 'serialNumber', 'condition'])) return;
  const doc = {
    name:           req.body.name,
    type:           req.body.type,
    brand:          req.body.brand || null,
    model:          req.body.model || null,
    serialNumber:   req.body.serialNumber,
    assetTag:       req.body.assetTag || null,
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
    assignmentHistory: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Optionally assign on creation
  if (req.body.assignedTo) {
    doc.assignedTo = new ObjectId(req.body.assignedTo);
    doc.assignedAt = new Date();
    doc.status = 'assigned';
    doc.assignmentHistory.push({ employeeId: doc.assignedTo, assignedAt: doc.assignedAt, returnedAt: null, condition: doc.condition });
  }

  const result = await insertOne('devices', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateDevice = async (req, res) => {
  const device = await findOne('devices', { _id: new ObjectId(req.params.id) });
  if (!device) return returnFunction(res, 404, false, req.locale.notFound);

  const update = { updatedAt: new Date() };
  ['name', 'type', 'brand', 'model', 'serialNumber', 'assetTag', 'condition', 'notes', 'vendor', 'currency'].forEach(f => {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  });
  if (req.body.purchaseDate)   update.purchaseDate   = new Date(req.body.purchaseDate);
  if (req.body.purchasePrice)  update.purchasePrice  = Number(req.body.purchasePrice);
  if (req.body.warrantyExpiry) update.warrantyExpiry = new Date(req.body.warrantyExpiry);

  await updateOne('devices', { _id: device._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteDevice = async (req, res) => {
  const device = await findOne('devices', { _id: new ObjectId(req.params.id) });
  if (!device) return returnFunction(res, 404, false, req.locale.notFound);
  await global.dbo.collection('devices').deleteOne({ _id: device._id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const assignDevice = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId'])) return;
  const device = await findOne('devices', { _id: new ObjectId(req.params.id) });
  if (!device) return returnFunction(res, 404, false, req.locale.notFound);
  if (device.status === 'assigned') return returnFunction(res, 400, false, 'Device is already assigned.');

  const empId = new ObjectId(req.body.employeeId);
  const now = new Date();

  await updateOne('devices', { _id: device._id }, {
    $set: { assignedTo: empId, assignedAt: now, status: 'assigned', updatedAt: now },
    $push: { assignmentHistory: { employeeId: empId, assignedAt: now, returnedAt: null, condition: device.condition } },
  });
  return returnFunction(res, 200, true, 'Device assigned.');
};

const unassignDevice = async (req, res) => {
  const device = await findOne('devices', { _id: new ObjectId(req.params.id) });
  if (!device) return returnFunction(res, 404, false, req.locale.notFound);
  if (device.status !== 'assigned') return returnFunction(res, 400, false, 'Device is not currently assigned.');

  const now = new Date();
  await global.dbo.collection('devices').updateOne(
    { _id: device._id },
    { $set: { assignedTo: null, assignedAt: null, status: 'unassigned', updatedAt: now } }
  );
  // Close the open history entry
  await global.dbo.collection('devices').updateOne(
    { _id: device._id, 'assignmentHistory.returnedAt': null },
    { $set: { 'assignmentHistory.$.returnedAt': now } }
  );
  return returnFunction(res, 200, true, 'Device unassigned.');
};

// ── SOFTWARE / APPS ───────────────────────────────────────────────────────────

const listSoftware = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  const software = await findMany('software_apps', filter, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, software);
};

const getSoftwareSummary = async (req, res) => {
  const apps = await findMany('software_apps', {});
  const totalLicenses = apps.reduce((s, a) => s + (a.totalLicenses || 0), 0);
  const assignedLicenses = apps.reduce((s, a) => s + (a.assignedLicenses || 0), 0);
  const now = new Date();
  const soon = new Date(now); soon.setDate(now.getDate() + 30);
  const expiringSoon = apps.filter(a => a.renewalDate && new Date(a.renewalDate) <= soon && new Date(a.renewalDate) >= now).length;
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
    adminId:          req.body.adminId ? new ObjectId(req.body.adminId) : null,
    loginUrl:         req.body.loginUrl || null,
    status:           'active',
    assignedEmployeeIds: [],
    notes:            req.body.notes || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('software_apps', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateSoftware = async (req, res) => {
  const app = await findOne('software_apps', { _id: new ObjectId(req.params.id) });
  if (!app) return returnFunction(res, 404, false, req.locale.notFound);
  const update = { updatedAt: new Date() };
  ['name', 'category', 'vendor', 'licenseType', 'loginUrl', 'status', 'notes', 'currency', 'billingCycle'].forEach(f => {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  });
  if (req.body.totalLicenses !== undefined) update.totalLicenses = Number(req.body.totalLicenses);
  if (req.body.costPerLicense !== undefined) update.costPerLicense = Number(req.body.costPerLicense);
  if (req.body.renewalDate) update.renewalDate = new Date(req.body.renewalDate);
  await updateOne('software_apps', { _id: app._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteSoftware = async (req, res) => {
  await global.dbo.collection('software_apps').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const assignSoftware = async (req, res) => {
  const app = await findOne('software_apps', { _id: new ObjectId(req.params.id) });
  if (!app) return returnFunction(res, 404, false, req.locale.notFound);
  const empId = new ObjectId(req.params.employeeId);
  if (app.assignedEmployeeIds?.some(id => id.toString() === empId.toString())) {
    return returnFunction(res, 409, false, 'Employee already has access.');
  }
  await updateOne('software_apps', { _id: app._id }, {
    $addToSet: { assignedEmployeeIds: empId },
    $inc: { assignedLicenses: 1 },
    $set: { updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Access granted.');
};

const revokeSoftware = async (req, res) => {
  const empId = new ObjectId(req.params.employeeId);
  await updateOne('software_apps', { _id: new ObjectId(req.params.id) }, {
    $pull: { assignedEmployeeIds: empId },
    $inc: { assignedLicenses: -1 },
    $set: { updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Access revoked.');
};

// ── IT REQUESTS ───────────────────────────────────────────────────────────────

const listRequests = async (req, res) => {
  const filter = {};
  if (req.user.role === 'staff') filter.requesterId = req.user._id;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type)   filter.type   = req.query.type;

  const { page, limit, skip } = getPagination(req.query);
  const [total, requests] = await Promise.all([
    countDocuments('it_requests', filter),
    findMany('it_requests', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const enriched = await Promise.all(requests.map(async r => {
    const [requester, assignee, device] = await Promise.all([
      r.employeeId
        ? findOne('employees', { _id: new ObjectId(String(r.employeeId)) }, { projection: { fullName: 1 } }).catch(() => null)
        : null,
      r.assignedTo
        ? findOne('employees', { _id: new ObjectId(String(r.assignedTo)) }, { projection: { fullName: 1 } }).catch(() => null)
        : null,
      r.deviceId
        ? findOne('devices', { _id: r.deviceId }, { projection: { name: 1, type: 1, condition: 1, status: 1 } }).catch(() => null)
        : null,
    ]);
    return {
      ...r,
      requesterName: requester?.fullName || 'Unknown',
      assigneeName:  assignee?.fullName  || null,
      device:        device || null,
    };
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const createRequest = async (req, res) => {
  if (!validateRequiredFields(req, res, ['type', 'subject', 'description', 'priority'])) return;
  const doc = {
    requesterId:   req.user._id,
    employeeId:    req.user.employeeId ? new ObjectId(String(req.user.employeeId)) : null,
    type:          req.body.type,
    subject:       req.body.subject,
    description:   req.body.description,
    priority:      req.body.priority,
    status:        'open',
    assignedTo:    null,
    resolution:    null,
    resolvedAt:    null,
    // Repair-specific fields
    deviceId:      req.body.deviceId ? new ObjectId(req.body.deviceId) : null,
    deviceName:    req.body.deviceName || null,
    repairNotes:   null,
    createdAt:     new Date(),
    updatedAt:     new Date(),
  };
  const result = await insertOne('it_requests', doc);

  // Notify all HR users so the request lands in their inbox
  notifyHR({
    type: 'it_request',
    subType: 'it_request_submitted',
    title: 'New IT Request',
    subtitle: `${doc.type.replace(/_/g, ' ')} — ${doc.subject}`,
    referenceId: result.insertedId,
    referenceModel: 'it_requests',
    priority: doc.priority,
    requiresAction: true,
    triggeredBy: req.user._id,
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateRequest = async (req, res) => {
  const req_ = await findOne('it_requests', { _id: new ObjectId(req.params.id) });
  if (!req_) return returnFunction(res, 404, false, req.locale.notFound);

  const update = { updatedAt: new Date() };
  ['status', 'priority', 'resolution', 'type', 'subject', 'description', 'repairNotes'].forEach(f => {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  });

  const isNewAssignment = req.body.assignedTo && String(req.body.assignedTo) !== String(req_?.assignedTo);
  if (req.body.assignedTo) update.assignedTo = new ObjectId(req.body.assignedTo);

  await updateOne('it_requests', { _id: req_._id }, { $set: update });

  // When a repair request is assigned, mark the linked device as in_repair
  if (isNewAssignment && req_.type === 'repair' && req_.deviceId) {
    await global.dbo.collection('devices').updateOne(
      { _id: req_.deviceId },
      { $set: { status: 'in_repair', updatedAt: new Date() } }
    );
  }

  // Notify the newly assigned person
  if (isNewAssignment) {
    const assignedUser = await findOne('users', { employeeId: new ObjectId(req.body.assignedTo) });
    if (assignedUser) {
      createInboxItem({
        recipientId:    assignedUser._id,
        type:           'it_request',
        subType:        'it_request_assigned',
        title:          req_.type === 'repair' ? 'Repair Job Assigned to You' : 'IT Request Assigned to You',
        subtitle:       req_.deviceName ? `${req_.subject} — ${req_.deviceName}` : req_.subject,
        referenceId:    req_._id,
        referenceModel: 'it_requests',
        priority:       req_.priority,
        requiresAction: true,
        triggeredBy:    req.user._id,
      }).catch(() => {});
    }
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const resolveRequest = async (req, res) => {
  const req_ = await findOne('it_requests', { _id: new ObjectId(req.params.id) });
  if (!req_) return returnFunction(res, 404, false, req.locale.notFound);
  await updateOne('it_requests', { _id: req_._id }, {
    $set: { status: 'resolved', resolution: req.body.resolution || '', resolvedAt: new Date(), updatedAt: new Date() },
  });
  // When a repair request resolves, restore the device to available with updated condition
  if (req_.type === 'repair' && req_.deviceId) {
    const newCondition = req.body.updatedCondition || 'good';
    await global.dbo.collection('devices').updateOne(
      { _id: req_.deviceId },
      { $set: { status: 'unassigned', condition: newCondition, updatedAt: new Date() } }
    );
  }
  return returnFunction(res, 200, true, 'Request resolved.');
};

// ── Expiring Assets (warranty expiring within next N days) ────────────────────
const getExpiringAssets = async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const now  = new Date();
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const [expiringDevices, expiringSoftware] = await Promise.all([
    findMany('devices', {
      warrantyExpiry: { $gte: now, $lte: cutoff },
      status: { $ne: 'retired' },
    }, { sort: { warrantyExpiry: 1 } }),
    findMany('software_licenses', {
      licenseExpiry: { $gte: now, $lte: cutoff },
    }, { sort: { licenseExpiry: 1 } }),
  ]);

  const enrichedDevices = await Promise.all(expiringDevices.map(async d => {
    const emp = d.assignedTo ? await findOne('employees', { _id: d.assignedTo }, { projection: { fullName: 1 } }) : null;
    const daysLeft = Math.ceil((new Date(d.warrantyExpiry) - now) / (1000 * 60 * 60 * 24));
    return { ...d, assignedEmployee: emp || null, daysLeft };
  }));

  const enrichedSoftware = expiringSoftware.map(s => ({
    ...s,
    daysLeft: Math.ceil((new Date(s.licenseExpiry) - now) / (1000 * 60 * 60 * 24)),
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
