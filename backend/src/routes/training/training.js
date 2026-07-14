const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  createCourse, listCourses, getCourse, updateCourse, publishCourse, archiveCourse, addCourseAuthor,
  listCatalog, getCatalogCourse, getModuleQuizForLearner,
  addModule, updateModule, deleteModule,
  createQuiz, updateQuiz,
  createLearningPath, listLearningPaths, getLearningPath, updateLearningPath, archiveLearningPath,
  assignTraining, listEnrollments, waiveEnrollment,
  getMyEnrollments, updateMyProgress, submitQuizAttempt, submitCourseFeedback, getMyLearningPaths,
  generateMyCertificate, getMyCertificates,
  uploadExternalCertificate, getMyExternalCertificates, listExternalCertificates, verifyExternalCertificate,
  createRule, listRules, updateRule, runRuleNow,
  getTrainingOverview, getComplianceReport, getCourseAnalytics, getEmployeeTrainingRecord, getLeaderboard,
  sendComplianceReminder,
  uploadTrainingFile,
  createSession, listCourseSessions, updateSession, deleteSession,
  registerForSession, unregisterFromSession, markSessionAttendance, getMySessions,
} = require('./trainingFunctions');

const { SUPER_ADMIN, HR_MANAGER, ALL_ROLES } = require('../../constants/roles');
const HR = [SUPER_ADMIN, HR_MANAGER];

// ── Multer for module content uploads (documents/videos) ─────────────────────
const trainingUploadDir = path.join(
  process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', '..', '..', 'uploads'),
  'training'
);
if (!fs.existsSync(trainingUploadDir)) fs.mkdirSync(trainingUploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, trainingUploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ── Courses (HR admin only) ────────────────────────────────────────────────────
router.post('/courses',              allowRoles(HR), AsyncHandler(createCourse));
router.get('/courses',               allowRoles(HR), AsyncHandler(listCourses));
router.get('/courses/:id',           allowRoles(HR), AsyncHandler(getCourse));
router.patch('/courses/:id',         allowRoles(HR), AsyncHandler(updateCourse));
router.post('/courses/:id/publish',  allowRoles(HR), AsyncHandler(publishCourse));
router.delete('/courses/:id',        allowRoles(HR), AsyncHandler(archiveCourse));
router.post('/courses/:id/authors',  allowRoles(HR), AsyncHandler(addCourseAuthor));

// ── Module content uploads (HR admin only) ────────────────────────────────────
router.post('/upload', allowRoles(HR), upload.single('file'), AsyncHandler(uploadTrainingFile));

// ── Live / Instructor-led Sessions (HR admin manages, all roles register) ─────
router.post('/courses/:id/sessions',      allowRoles(HR), AsyncHandler(createSession));
router.get('/courses/:id/sessions',       allowRoles(ALL_ROLES), AsyncHandler(listCourseSessions));
router.patch('/sessions/:id',             allowRoles(HR), AsyncHandler(updateSession));
router.delete('/sessions/:id',            allowRoles(HR), AsyncHandler(deleteSession));
router.patch('/sessions/:id/attendance',  allowRoles(HR), AsyncHandler(markSessionAttendance));
router.post('/sessions/:id/register',     allowRoles(ALL_ROLES), AsyncHandler(registerForSession));
router.delete('/sessions/:id/register',   allowRoles(ALL_ROLES), AsyncHandler(unregisterFromSession));
router.get('/my/sessions',                allowRoles(ALL_ROLES), AsyncHandler(getMySessions));

// ── Modules / Quizzes (HR admin only) ─────────────────────────────────────────
router.post('/courses/:id/modules',  allowRoles(HR), AsyncHandler(addModule));
router.patch('/modules/:id',         allowRoles(HR), AsyncHandler(updateModule));
router.delete('/modules/:id',        allowRoles(HR), AsyncHandler(deleteModule));
router.post('/modules/:id/quiz',     allowRoles(HR), AsyncHandler(createQuiz));
router.patch('/quizzes/:id',         allowRoles(HR), AsyncHandler(updateQuiz));

// ── Learning Paths (HR admin only) ────────────────────────────────────────────
router.post('/learning-paths',           allowRoles(HR), AsyncHandler(createLearningPath));
router.get('/learning-paths',            allowRoles(HR), AsyncHandler(listLearningPaths));
router.get('/learning-paths/:id',        allowRoles(HR), AsyncHandler(getLearningPath));
router.patch('/learning-paths/:id',      allowRoles(HR), AsyncHandler(updateLearningPath));
router.delete('/learning-paths/:id',     allowRoles(HR), AsyncHandler(archiveLearningPath));

// ── Enrollments (HR admin only) ───────────────────────────────────────────────
router.post('/enrollments',             allowRoles(HR), AsyncHandler(assignTraining));
router.get('/enrollments',              allowRoles(HR), AsyncHandler(listEnrollments));
router.patch('/enrollments/:id/waive',  allowRoles(HR), AsyncHandler(waiveEnrollment));

// ── Employee — own data only ──────────────────────────────────────────────────
router.get('/my/enrollments',                    allowRoles(ALL_ROLES), AsyncHandler(getMyEnrollments));
router.patch('/my/enrollments/:id/progress',     allowRoles(ALL_ROLES), AsyncHandler(updateMyProgress));
router.post('/my/enrollments/:id/quiz-attempt',  allowRoles(ALL_ROLES), AsyncHandler(submitQuizAttempt));
router.post('/my/enrollments/:id/feedback',      allowRoles(ALL_ROLES), AsyncHandler(submitCourseFeedback));
router.get('/my/learning-paths',                  allowRoles(ALL_ROLES), AsyncHandler(getMyLearningPaths));
router.get('/my/certificates',                             allowRoles(ALL_ROLES), AsyncHandler(getMyCertificates));
router.post('/my/certificates/generate/:enrollmentId',     allowRoles(ALL_ROLES), AsyncHandler(generateMyCertificate));
router.post('/my/external-certificates',  allowRoles(ALL_ROLES), AsyncHandler(uploadExternalCertificate));
router.get('/my/external-certificates',   allowRoles(ALL_ROLES), AsyncHandler(getMyExternalCertificates));

// ── External Certificates (HR admin only) ─────────────────────────────────────
router.get('/external-certificates',              allowRoles(HR), AsyncHandler(listExternalCertificates));
router.patch('/external-certificates/:id/verify',  allowRoles(HR), AsyncHandler(verifyExternalCertificate));

// ── Assignment Rules (HR admin only) ──────────────────────────────────────────
router.post('/rules',          allowRoles(HR), AsyncHandler(createRule));
router.get('/rules',           allowRoles(HR), AsyncHandler(listRules));
router.patch('/rules/:id',     allowRoles(HR), AsyncHandler(updateRule));
router.post('/rules/:id/run',  allowRoles(HR), AsyncHandler(runRuleNow));

// ── Analytics (HR admin only) ─────────────────────────────────────────────────
router.get('/analytics/overview',        allowRoles(HR), AsyncHandler(getTrainingOverview));
router.get('/analytics/compliance',      allowRoles(HR), AsyncHandler(getComplianceReport));
router.get('/analytics/course/:id',      allowRoles(HR), AsyncHandler(getCourseAnalytics));
router.get('/analytics/employee/:id',    allowRoles(HR), AsyncHandler(getEmployeeTrainingRecord));
router.get('/analytics/leaderboard',     allowRoles(HR), AsyncHandler(getLeaderboard));
router.post('/analytics/compliance/remind', allowRoles(HR), AsyncHandler(sendComplianceReminder));

// ── Catalog (employee — own data, published only) ────────────────────────────
router.get('/catalog',      allowRoles(ALL_ROLES), AsyncHandler(listCatalog));
router.get('/catalog/:id',  allowRoles(ALL_ROLES), AsyncHandler(getCatalogCourse));
router.get('/my/modules/:moduleId/quiz', allowRoles(ALL_ROLES), AsyncHandler(getModuleQuizForLearner));

module.exports = router;
module.exports.upload = upload;
