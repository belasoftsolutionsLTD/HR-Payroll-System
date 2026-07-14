const express = require('express');
const router = express.Router();
const multer = require('multer');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, ALL_ROLES } = require('../../constants/roles');
const {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, uploadTemplateResource,
  createRecord, listRecords, getRecord, updateRecordTask, addRecordTask, updateWelcome,
  getMyOnboarding, updateMyTask, uploadMyDocument, uploadRecordDocument, updateMeetTheTeam,
  listRecordDocuments, verifyDocument, getAnalytics,
} = require('./onboardingFunctions');

const hrOnly = allowRoles(HR_ROLES);
const allRoles = allowRoles(ALL_ROLES);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
    filename: (req, file, cb) => cb(null, `onboarding-doc-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const resourceUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
    filename: (req, file, cb) => cb(null, `template-resource-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Templates ──────────────────────────────────────────────────────────────────
router.post('/templates',        hrOnly, AsyncHandler(createTemplate));
router.get('/templates',         hrOnly, AsyncHandler(listTemplates));
router.post('/templates/upload-resource', hrOnly, resourceUpload.single('file'), AsyncHandler(uploadTemplateResource));
router.get('/templates/:id',     hrOnly, AsyncHandler(getTemplate));
router.patch('/templates/:id',   hrOnly, AsyncHandler(updateTemplate));
router.delete('/templates/:id',  hrOnly, AsyncHandler(deleteTemplate));

// ── Employee self-service (own record only) — declared before /records/:id
// so they never get swallowed by the wildcard param route ─────────────────────
router.get('/my',                       allRoles, AsyncHandler(getMyOnboarding));
router.patch('/my/task/:taskId',        allRoles, AsyncHandler(updateMyTask));
router.post('/my/document',             allRoles, upload.single('file'), AsyncHandler(uploadMyDocument));
router.patch('/my/meetTheTeam/:personId', allRoles, AsyncHandler(updateMeetTheTeam));

// ── Records — HR only ──────────────────────────────────────────────────────────
router.post('/records',                    hrOnly, AsyncHandler(createRecord));
router.get('/records',                     hrOnly, AsyncHandler(listRecords));
router.get('/records/:id',                 hrOnly, AsyncHandler(getRecord));
router.get('/records/:id/documents',       hrOnly, AsyncHandler(listRecordDocuments));
router.post('/records/:id/document',       hrOnly, upload.single('file'), AsyncHandler(uploadRecordDocument));
router.patch('/records/:id/task',          hrOnly, AsyncHandler(updateRecordTask));
router.post('/records/:id/task',           hrOnly, AsyncHandler(addRecordTask));
router.patch('/records/:id/welcome',       hrOnly, AsyncHandler(updateWelcome));
router.patch('/documents/:id/verify',      hrOnly, AsyncHandler(verifyDocument));

// ── Analytics ──────────────────────────────────────────────────────────────────
router.get('/analytics', hrOnly, AsyncHandler(getAnalytics));

module.exports = router;
