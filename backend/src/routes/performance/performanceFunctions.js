const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { notifyEmployee, notifyByRoles } = require('../../functions/HR/notifyUser');

const getEmployeePerformance = async (req, res) => {
  const records = await findMany('appraisal_records',
    { employeeId: new ObjectId(req.params.employeeId) },
    { sort: { createdAt: -1 } }
  );
  return returnFunction(res, 200, true, req.locale.success, records);
};

const VALID_PERIODS = ['Q1', 'Q2', 'Q3', 'Q4'];

const createAppraisal = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'reviewPeriod', 'rating'])) return;
  const rating = parseInt(req.body.rating);
  if (rating < 1 || rating > 5) return returnFunction(res, 400, false, 'Rating must be between 1 and 5.');

  // Enforce quarterly period — must be Q1/Q2/Q3/Q4 optionally followed by a year e.g. "Q1 2025"
  const periodBase = req.body.reviewPeriod?.trim().toUpperCase().split(' ')[0];
  if (!VALID_PERIODS.includes(periodBase)) {
    return returnFunction(res, 400, false, 'Review period must be Q1, Q2, Q3, or Q4 (optionally with a year, e.g. "Q1 2025").');
  }

  const doc = {
    employeeId: new ObjectId(req.body.employeeId),
    reviewPeriod: req.body.reviewPeriod,
    reviewerId: new ObjectId(req.user._id),
    goalsSet: req.body.goalsSet || [],
    goalsAchieved: req.body.goalsAchieved || [],
    rating,
    comments: req.body.comments || null,
    createdAt: new Date(),
  };
  const result = await insertOne('appraisal_records', doc);

  // Look up the employee to get their name for the notification body
  const employee = await findOne('employees', { _id: new ObjectId(req.body.employeeId) }, { projection: { fullName: 1 } });
  const empName = employee?.fullName ?? 'An employee';
  const ratingLabel = ['', 'Unsatisfactory', 'Needs Improvement', 'Meets Expectations', 'Exceeds Expectations', 'Outstanding'][doc.rating] ?? `${doc.rating}/5`;

  // Notify the appraised staff member
  notifyEmployee(req.body.employeeId, {
    title: 'New Appraisal Recorded',
    body: `Your appraisal for ${doc.reviewPeriod} has been submitted — ${ratingLabel}.`,
    type: 'general',
  });

  // Notify all HR managers and super admins
  notifyByRoles(['hr_manager', 'super_admin'], {
    title: 'Appraisal Submitted',
    body: `${req.user.name ?? 'Dept Head'} submitted an appraisal for ${empName} (${doc.reviewPeriod}) — ${ratingLabel}.`,
    type: 'general',
  });

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateAppraisal = async (req, res) => {
  const update = { ...req.body };
  delete update._id;
  if (update.rating) update.rating = parseInt(update.rating);
  await updateOne('appraisal_records', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const getPerformanceAlerts = async (req, res) => {
  const flagged = await global.dbo.collection('appraisal_records').aggregate([
    { $sort: { employeeId: 1, createdAt: -1 } },
    { $group: { _id: '$employeeId', ratings: { $push: '$rating' } } },
    { $addFields: { lastTwo: { $slice: ['$ratings', 2] } } },
    { $match: { $expr: { $and: [
      { $gte: [{ $size: '$lastTwo' }, 2] },
      { $lte: [{ $arrayElemAt: ['$lastTwo', 0] }, 2] },
      { $lte: [{ $arrayElemAt: ['$lastTwo', 1] }, 2] },
    ]}}},
  ]).toArray();

  const enriched = await Promise.all(flagged.map(async (f) => {
    const emp = await findOne('employees', { _id: f._id }, { projection: { fullName: 1, staffNumber: 1, department: 1, designation: 1 } });
    return { employee: emp, ratings: f.lastTwo };
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

module.exports = { getEmployeePerformance, createAppraisal, updateAppraisal, getPerformanceAlerts };
