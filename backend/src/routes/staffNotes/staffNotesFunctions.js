const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 1) —
// staff_notes, employees, and users now all live in Postgres.
const { findOne, insertOne, deleteOne, knex } = require('../../functions/Database/pgDBFunctions');

const getStaffNotes = async (req, res) => {
  const notes = await knex('staff_notes')
    .where({ 'staff_notes.employeeId': req.params.employeeId })
    .leftJoin('users', 'staff_notes.createdBy', 'users.id')
    .orderBy('staff_notes.createdAt', 'desc')
    .select(
      'staff_notes.*',
      'users.name as createdByName',
      'users.role as createdByRole',
    );

  const withIds = notes.map((n) => ({
    ...n, _id: new ObjectId(n.id), employeeId: new ObjectId(n.employeeId), createdBy: n.createdBy ? new ObjectId(n.createdBy) : null,
  }));
  return returnFunction(res, 200, true, req.locale.success, withIds);
};

const createStaffNote = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeId', 'category', 'note'])) return;
  const categories = ['disciplinary_action','verbal_warning','written_warning','commendation','general_note'];
  if (!categories.includes(req.body.category)) return returnFunction(res, 400, false, 'Invalid category.');

  const doc = {
    employeeId: req.body.employeeId,
    category: req.body.category,
    note: req.body.note,
    createdBy: req.user.id,
    createdAt: new Date(),
  };
  const result = await insertOne('staff_notes', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const deleteStaffNote = async (req, res) => {
  await deleteOne('staff_notes', { id: req.params.id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

module.exports = { getStaffNotes, createStaffNote, deleteStaffNote };
