const express = require('express');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listAwardTypes, createAwardType, updateAwardType, deleteAwardType,
  listEmployeeAwards, grantAward, bulkGrantAward, revokeAward,
  searchEmployeesForAward, getAwardStats, getUpcomingAwards, advanceAwardSchedule,
  listValues, createValue, updateValue, deleteValue, reorderValues,
  listKudos, createKudos, deleteKudos, reactToKudos, addKudosComment,
  getLeaderboard, getMyRank,
  listPrograms, createProgram, getProgram, updateProgram,
  nominateForProgram, listNominations, selectWinner,
  getRecognitionSettings, updateRecognitionSettings,
  searchColleagues,
} = require('./awardFunctions');

const HR   = ['super_admin', 'hr_manager'];
const MGMT = ['super_admin', 'hr_manager', 'department_head'];
const ALL  = ['super_admin', 'hr_manager', 'department_head', 'staff'];

// ── Named specific routes BEFORE generic /:id catch-alls ─────────────────────

// Award types (templates)
router.get('/awards/types',                        allowRoles(HR),  AsyncHandler(listAwardTypes));
router.post('/awards/types',                       allowRoles(HR),  AsyncHandler(createAwardType));
router.put('/awards/types/:id',                    allowRoles(HR),  AsyncHandler(updateAwardType));
router.delete('/awards/types/:id',                 allowRoles(HR),  AsyncHandler(deleteAwardType));
router.post('/awards/types/:id/advance-schedule',  allowRoles(HR),  AsyncHandler(advanceAwardSchedule));

// Employee awards (formal) — specific named routes before /:id
router.get('/awards/employees/search',             allowRoles(HR),  AsyncHandler(searchEmployeesForAward));
router.get('/awards/stats',                        allowRoles(HR),  AsyncHandler(getAwardStats));
router.get('/awards/upcoming',                     allowRoles(HR),  AsyncHandler(getUpcomingAwards));
router.post('/awards/bulk',                        allowRoles(HR),  AsyncHandler(bulkGrantAward));
router.get('/awards',                              allowRoles(HR),  AsyncHandler(listEmployeeAwards));
router.post('/awards',                             allowRoles(HR),  AsyncHandler(grantAward));
router.delete('/awards/:id',                       allowRoles(HR),  AsyncHandler(revokeAward));

// ── COMPANY VALUES ────────────────────────────────────────────────────────────
router.get('/recognition/values',                  allowRoles(ALL), AsyncHandler(listValues));
router.post('/recognition/values',                 allowRoles(HR),  AsyncHandler(createValue));
router.put('/recognition/values/reorder',          allowRoles(HR),  AsyncHandler(reorderValues));
router.put('/recognition/values/:id',              allowRoles(HR),  AsyncHandler(updateValue));
router.delete('/recognition/values/:id',           allowRoles(HR),  AsyncHandler(deleteValue));

// ── COLLEAGUES SEARCH (for kudos recipient picker — all roles) ────────────────
router.get('/recognition/employees',               allowRoles(ALL), AsyncHandler(searchColleagues));

// ── KUDOS ─────────────────────────────────────────────────────────────────────
router.get('/recognition/kudos',                   allowRoles(ALL), AsyncHandler(listKudos));
router.post('/recognition/kudos',                  allowRoles(ALL), AsyncHandler(createKudos));
router.post('/recognition/kudos/:id/react',        allowRoles(ALL), AsyncHandler(reactToKudos));
router.post('/recognition/kudos/:id/comment',      allowRoles(ALL), AsyncHandler(addKudosComment));
router.delete('/recognition/kudos/:id',            allowRoles(ALL), AsyncHandler(deleteKudos));

// ── LEADERBOARD ───────────────────────────────────────────────────────────────
router.get('/recognition/leaderboard',             allowRoles(ALL), AsyncHandler(getLeaderboard));
router.get('/recognition/leaderboard/my-rank',     allowRoles(ALL), AsyncHandler(getMyRank));

// ── AWARD PROGRAMS ────────────────────────────────────────────────────────────
router.get('/recognition/programs',                allowRoles(ALL),  AsyncHandler(listPrograms));
router.post('/recognition/programs',               allowRoles(HR),   AsyncHandler(createProgram));
router.get('/recognition/programs/:id',            allowRoles(ALL),  AsyncHandler(getProgram));
router.put('/recognition/programs/:id',            allowRoles(HR),   AsyncHandler(updateProgram));
router.get('/recognition/programs/:id/nominations',allowRoles(MGMT), AsyncHandler(listNominations));
router.post('/recognition/programs/:id/nominate',  allowRoles(ALL),  AsyncHandler(nominateForProgram));
router.post('/recognition/programs/:id/winner',    allowRoles(HR),   AsyncHandler(selectWinner));

// ── SETTINGS ──────────────────────────────────────────────────────────────────
router.get('/recognition/settings',                allowRoles(HR),  AsyncHandler(getRecognitionSettings));
router.put('/recognition/settings',                allowRoles(HR),  AsyncHandler(updateRecognitionSettings));

module.exports = router;
