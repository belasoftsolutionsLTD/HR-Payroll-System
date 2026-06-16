const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');

// ── Award Types (templates) ───────────────────────────────────────────────────

const listAwardTypes = async (req, res) => {
  const types = await findMany('award_types', {}, { sort: { name: 1 } });
  return returnFunction(res, 200, true, 'OK', types);
};

const createAwardType = async (req, res) => {
  const { name, description, category, repeatInterval, nextDueDate } = req.body;
  if (!name) return returnFunction(res, 400, false, 'Award name is required.');
  const existing = await findOne('award_types', { name: { $regex: `^${name}$`, $options: 'i' } });
  if (existing) return returnFunction(res, 409, false, 'An award type with this name already exists.');
  const result = await insertOne('award_types', {
    name, description: description || '', category: category || 'general',
    repeatInterval: repeatInterval || 'none',
    nextDueDate: nextDueDate ? new Date(nextDueDate) : null,
    createdAt: new Date(),
  });
  return returnFunction(res, 201, true, 'Award type created.', { _id: result.insertedId });
};

const updateAwardType = async (req, res) => {
  const { name, description, category, repeatInterval, nextDueDate } = req.body;
  await global.dbo.collection('award_types').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { name, description, category, repeatInterval: repeatInterval || 'none', nextDueDate: nextDueDate ? new Date(nextDueDate) : null, updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Award type updated.');
};

const deleteAwardType = async (req, res) => {
  await global.dbo.collection('award_types').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, 'Award type deleted.');
};

// ── Employee Awards ───────────────────────────────────────────────────────────

const listEmployeeAwards = async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const skip  = (page - 1) * limit;

  const filter = {};
  if (req.query.awardTypeId) filter.awardTypeId = new ObjectId(req.query.awardTypeId);
  if (req.query.year)        filter.year = parseInt(req.query.year);
  if (req.query.search) {
    filter.employeeName = { $regex: req.query.search, $options: 'i' };
  }

  const [total, awards] = await Promise.all([
    countDocuments('employee_awards', filter),
    global.dbo.collection('employee_awards').find(filter)
      .sort({ awardedAt: -1 }).skip(skip).limit(limit).toArray(),
  ]);

  // Populate award type names
  const typeIds = [...new Set(awards.map(a => String(a.awardTypeId)).filter(Boolean))];
  const types   = await findMany('award_types', { _id: { $in: typeIds.map(id => new ObjectId(id)) } });
  const typeMap  = Object.fromEntries(types.map(t => [String(t._id), t.name]));

  const enriched = awards.map(a => ({ ...a, awardTypeName: typeMap[String(a.awardTypeId)] || 'Unknown' }));
  return returnFunction(res, 200, true, 'OK', { data: enriched, total, page, limit });
};

// Single award
const grantAward = async (req, res) => {
  const { employeeId, awardTypeId, notes, year } = req.body;
  if (!employeeId || !awardTypeId) return returnFunction(res, 400, false, 'employeeId and awardTypeId are required.');

  const [emp, awardType] = await Promise.all([
    findOne('employees', { _id: new ObjectId(employeeId) }),
    findOne('award_types', { _id: new ObjectId(awardTypeId) }),
  ]);
  if (!emp)       return returnFunction(res, 404, false, 'Employee not found.');
  if (!awardType) return returnFunction(res, 404, false, 'Award type not found.');

  const doc = {
    employeeId:   new ObjectId(employeeId),
    employeeName: emp.fullName,
    staffNumber:  emp.staffNumber || null,
    department:   emp.department  || null,
    awardTypeId:  new ObjectId(awardTypeId),
    awardTypeName: awardType.name,
    notes:        notes || '',
    year:         year || new Date().getFullYear(),
    awardedBy:    req.user?.name || 'HR',
    awardedAt:    new Date(),
  };
  const result = await insertOne('employee_awards', doc);
  return returnFunction(res, 201, true, 'Award granted.', { _id: result.insertedId });
};

// Bulk award — grant the same award to multiple employees at once
const bulkGrantAward = async (req, res) => {
  const { employeeIds, awardTypeId, notes, year } = req.body;
  if (!Array.isArray(employeeIds) || !employeeIds.length) return returnFunction(res, 400, false, 'employeeIds array is required.');
  if (!awardTypeId) return returnFunction(res, 400, false, 'awardTypeId is required.');

  const awardType = await findOne('award_types', { _id: new ObjectId(awardTypeId) });
  if (!awardType) return returnFunction(res, 404, false, 'Award type not found.');

  const employees = await global.dbo.collection('employees')
    .find({ _id: { $in: employeeIds.map(id => new ObjectId(id)) } })
    .project({ _id: 1, fullName: 1, staffNumber: 1, department: 1 })
    .toArray();

  if (!employees.length) return returnFunction(res, 404, false, 'No valid employees found.');

  const awardYear = year || new Date().getFullYear();
  const docs = employees.map(emp => ({
    employeeId:   emp._id,
    employeeName: emp.fullName,
    staffNumber:  emp.staffNumber || null,
    department:   emp.department  || null,
    awardTypeId:  new ObjectId(awardTypeId),
    awardTypeName: awardType.name,
    notes:        notes || '',
    year:         awardYear,
    awardedBy:    req.user?.name || 'HR',
    awardedAt:    new Date(),
  }));

  await global.dbo.collection('employee_awards').insertMany(docs);
  return returnFunction(res, 201, true, `Award granted to ${docs.length} employee(s).`, { count: docs.length });
};

const revokeAward = async (req, res) => {
  await global.dbo.collection('employee_awards').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, 'Award revoked.');
};

// Employee search helper used by the bulk award UI
const searchEmployeesForAward = async (req, res) => {
  const q    = req.query.q || '';
  const dept = req.query.department || '';
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  const skip  = (page - 1) * limit;

  const filter = { status: { $in: ['active', 'on_leave'] } };
  if (q)    filter.$or = [
    { fullName:    { $regex: q, $options: 'i' } },
    { staffNumber: { $regex: q, $options: 'i' } },
  ];
  if (dept) filter.department = dept;

  const [total, employees] = await Promise.all([
    countDocuments('employees', filter),
    global.dbo.collection('employees')
      .find(filter)
      .project({ _id: 1, fullName: 1, staffNumber: 1, department: 1, designation: 1 })
      .sort({ fullName: 1 })
      .skip(skip).limit(limit)
      .toArray(),
  ]);
  return returnFunction(res, 200, true, 'OK', { data: employees, total, page, limit });
};

// Awards by type + by department + top employees for chart/insight cards
const getAwardStats = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const all  = await global.dbo.collection('employee_awards').find({ year }).toArray();

  const byType = {};
  const byDept = {};
  const byEmp  = {};

  for (const a of all) {
    byType[a.awardTypeName] = (byType[a.awardTypeName] || 0) + 1;
    if (a.department) byDept[a.department] = (byDept[a.department] || 0) + 1;
    const ek = String(a.employeeId);
    if (!byEmp[ek]) byEmp[ek] = { employeeName: a.employeeName, staffNumber: a.staffNumber, department: a.department, count: 0 };
    byEmp[ek].count++;
  }

  const topEmployees = Object.values(byEmp).sort((a, b) => b.count - a.count).slice(0, 5);

  return returnFunction(res, 200, true, 'OK', {
    year, total: all.length,
    byType: Object.entries(byType).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    byDepartment: Object.entries(byDept).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    topEmployees,
  });
};

// Award types that are scheduled (repeatInterval !== 'none') and due within 60 days
const getUpcomingAwards = async (req, res) => {
  const types = await findMany('award_types', { repeatInterval: { $nin: ['none', null] }, nextDueDate: { $ne: null } });
  const now   = new Date();
  const horizon = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  const upcoming = types
    .map(t => ({ ...t, daysUntilDue: Math.ceil((new Date(t.nextDueDate) - now) / (1000 * 60 * 60 * 24)) }))
    .filter(t => new Date(t.nextDueDate) <= horizon)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);

  return returnFunction(res, 200, true, 'OK', upcoming);
};

// After granting a scheduled award, advance the nextDueDate by one interval
const advanceAwardSchedule = async (req, res) => {
  const type = await findOne('award_types', { _id: new ObjectId(req.params.id) });
  if (!type) return returnFunction(res, 404, false, 'Award type not found.');

  const base = type.nextDueDate ? new Date(type.nextDueDate) : new Date();
  let next = new Date(base);
  if (type.repeatInterval === 'monthly')   next.setMonth(next.getMonth() + 1);
  else if (type.repeatInterval === 'quarterly') next.setMonth(next.getMonth() + 3);
  else if (type.repeatInterval === 'annually')  next.setFullYear(next.getFullYear() + 1);

  await global.dbo.collection('award_types').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { nextDueDate: next, updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Schedule advanced.', { nextDueDate: next });
};

module.exports = {
  listAwardTypes, createAwardType, updateAwardType, deleteAwardType,
  listEmployeeAwards, grantAward, bulkGrantAward, revokeAward,
  searchEmployeesForAward, getAwardStats, getUpcomingAwards, advanceAwardSchedule,
};
