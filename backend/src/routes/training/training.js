const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listCourses, getCourse, createCourse, updateCourse, deleteCourse,
  enrollInCourse, assignCourseToEmployees, getMyTraining, updateProgress, getTeamTraining,
  startCourse, toggleObjective, downloadCertificate,
} = require('./trainingFunctions');

const ALL  = ['super_admin', 'hr_manager', 'department_head', 'staff'];
const HR   = ['super_admin', 'hr_manager'];
const MGMT = ['super_admin', 'hr_manager', 'department_head'];

router.get('/my',                    allowRoles(ALL),  AsyncHandler(getMyTraining));
router.get('/team',                  allowRoles(MGMT), AsyncHandler(getTeamTraining));
router.get('/courses',               allowRoles(ALL),  AsyncHandler(listCourses));
router.get('/courses/:id',           allowRoles(ALL),  AsyncHandler(getCourse));
router.post('/courses',              allowRoles(HR),   AsyncHandler(createCourse));
router.put('/courses/:id',           allowRoles(HR),   AsyncHandler(updateCourse));
router.delete('/courses/:id',        allowRoles(HR),   AsyncHandler(deleteCourse));
router.post('/courses/:id/enroll',        allowRoles(ALL),  AsyncHandler(enrollInCourse));
router.post('/courses/:id/start',         allowRoles(ALL),  AsyncHandler(startCourse));
router.post('/courses/:id/assign',        allowRoles(HR),   AsyncHandler(assignCourseToEmployees));
router.put('/enrollments/:id/progress',        allowRoles(ALL),  AsyncHandler(updateProgress));
router.patch('/enrollments/:id/objective',     allowRoles(ALL),  AsyncHandler(toggleObjective));
router.get('/enrollments/:id/certificate',     allowRoles(ALL),  AsyncHandler(downloadCertificate));

module.exports = router;
