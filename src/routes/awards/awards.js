const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listAwardTypes, createAwardType, updateAwardType, deleteAwardType,
  listEmployeeAwards, grantAward, bulkGrantAward, revokeAward,
  searchEmployeesForAward, getAwardStats, getUpcomingAwards, advanceAwardSchedule,
} = require('./awardFunctions');

const HR = ['super_admin', 'hr_manager'];

// Award types (templates)
router.get('/awards/types',          allowRoles(HR), AsyncHandler(listAwardTypes));
router.post('/awards/types',         allowRoles(HR), AsyncHandler(createAwardType));
router.put('/awards/types/:id',      allowRoles(HR), AsyncHandler(updateAwardType));
router.delete('/awards/types/:id',   allowRoles(HR), AsyncHandler(deleteAwardType));

// Employee awards
router.get('/awards',                allowRoles(HR), AsyncHandler(listEmployeeAwards));
router.post('/awards',               allowRoles(HR), AsyncHandler(grantAward));
router.post('/awards/bulk',          allowRoles(HR), AsyncHandler(bulkGrantAward));
router.delete('/awards/:id',         allowRoles(HR), AsyncHandler(revokeAward));

// Employee search for bulk award UI
router.get('/awards/employees/search', allowRoles(HR), AsyncHandler(searchEmployeesForAward));

// Stats + scheduling
router.get('/awards/stats',                        allowRoles(HR), AsyncHandler(getAwardStats));
router.get('/awards/upcoming',                     allowRoles(HR), AsyncHandler(getUpcomingAwards));
router.post('/awards/types/:id/advance-schedule',  allowRoles(HR), AsyncHandler(advanceAwardSchedule));

module.exports = router;
