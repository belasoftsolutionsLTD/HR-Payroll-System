const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, insertOne } = require('../../functions/Database/commonDBFunctions');

const getStaffNotes = async (req, res) => {
  const notes = await findMany('staff_notes',
    { employeeId: new ObjectId(req.params.employeeId) },
    { sort: { createdAt: -1 } }
  );
  return returnFunction(res, 200, true, req.locale.success, notes);
};

const createStaffNote = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'category', 'note'])) return;
  const categories = ['disciplinary_action','verbal_warning','written_warning','commendation','general_note'];
  if (!categories.includes(req.body.category)) return returnFunction(res, 400, false, 'Invalid category.');

  const doc = {
    employeeId: new ObjectId(req.body.employeeId),
    category: req.body.category,
    note: req.body.note,
    createdBy: new ObjectId(req.user._id),
    createdAt: new Date(),
  };
  const result = await insertOne('staff_notes', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const deleteStaffNote = async (req, res) => {
  await global.dbo.collection('staff_notes').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

module.exports = { getStaffNotes, createStaffNote, deleteStaffNote };
