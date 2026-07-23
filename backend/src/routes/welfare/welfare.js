const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES } = require('../../constants/roles');
const {
  createScheme, listSchemes, getScheme, updateScheme, addMember, removeMember,
} = require('./welfareFunctions');

const hrOnly = allowRoles(HR_ROLES);

router.post('/schemes',                        hrOnly, AsyncHandler(createScheme));
router.get('/schemes',                          hrOnly, AsyncHandler(listSchemes));
router.get('/schemes/:id',                      hrOnly, AsyncHandler(getScheme));
router.patch('/schemes/:id',                    hrOnly, AsyncHandler(updateScheme));
router.post('/schemes/:id/members',             hrOnly, AsyncHandler(addMember));
router.delete('/schemes/:id/members/:employeeId', hrOnly, AsyncHandler(removeMember));

module.exports = router;
