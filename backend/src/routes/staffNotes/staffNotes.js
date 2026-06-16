const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { getStaffNotes, createStaffNote, deleteStaffNote } = require('./staffNotesFunctions');

const SUPER_ADMIN = 'super_admin';
const HR_MANAGER = 'hr_manager';

router.get('/:employeeId', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(getStaffNotes));
router.post('/', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(createStaffNote));
router.delete('/:id', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(deleteStaffNote));

module.exports = router;
