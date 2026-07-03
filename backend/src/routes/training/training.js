const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const router   = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listCourses, getCourse, createCourse, updateCourse, deleteCourse,
  enrollInCourse, assignCourseToEmployees, getMyTraining, updateProgress, getTeamTraining,
  startCourse, toggleObjective, downloadCertificate,
  addMaterial, removeMaterial, saveMaterialProgress,
} = require('./trainingFunctions');

const ALL  = ['super_admin', 'hr_manager', 'department_head', 'staff'];
const HR   = ['super_admin', 'hr_manager'];
const MGMT = ['super_admin', 'hr_manager', 'department_head'];

// ── Multer for material uploads ───────────────────────────────────────────────

const trainingUploadDir = path.join(
  process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', '..', '..', 'uploads'),
  'training'
);
if (!fs.existsSync(trainingUploadDir)) fs.mkdirSync(trainingUploadDir, { recursive: true });

const materialStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, trainingUploadDir),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const materialUpload = multer({
  storage: materialStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB for videos
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ── Course routes ─────────────────────────────────────────────────────────────

router.get('/my',                allowRoles(ALL),  AsyncHandler(getMyTraining));
router.get('/team',              allowRoles(MGMT), AsyncHandler(getTeamTraining));
router.get('/courses',           allowRoles(ALL),  AsyncHandler(listCourses));
router.get('/courses/:id',       allowRoles(ALL),  AsyncHandler(getCourse));
router.post('/courses',          allowRoles(HR),   AsyncHandler(createCourse));
router.put('/courses/:id',       allowRoles(HR),   AsyncHandler(updateCourse));
router.delete('/courses/:id',    allowRoles(HR),   AsyncHandler(deleteCourse));

// ── Enrollment routes ─────────────────────────────────────────────────────────

router.post('/courses/:id/enroll',   allowRoles(ALL),  AsyncHandler(enrollInCourse));
router.post('/courses/:id/start',    allowRoles(ALL),  AsyncHandler(startCourse));
router.post('/courses/:id/assign',   allowRoles(HR),   AsyncHandler(assignCourseToEmployees));

router.put('/enrollments/:id/progress',          allowRoles(ALL), AsyncHandler(updateProgress));
router.patch('/enrollments/:id/objective',       allowRoles(ALL), AsyncHandler(toggleObjective));
router.get('/enrollments/:id/certificate',       allowRoles(ALL), AsyncHandler(downloadCertificate));
router.put('/enrollments/:id/material-progress', allowRoles(ALL), AsyncHandler(saveMaterialProgress));

// ── Material management (HR only) ─────────────────────────────────────────────

router.post(
  '/courses/:id/materials',
  allowRoles(HR),
  materialUpload.single('file'),
  AsyncHandler(addMaterial)
);
router.delete(
  '/courses/:id/materials/:materialId',
  allowRoles(HR),
  AsyncHandler(removeMaterial)
);

module.exports = router;
