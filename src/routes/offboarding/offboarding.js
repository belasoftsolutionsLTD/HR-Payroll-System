const express = require('express');
const router = express.Router();
const multer = require('multer');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, ALL_ROLES } = require('../../constants/roles');
const {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
  createRecord, listRecords, getRecord, updateRecordTask, addRecordTask, updateAsset, updateAccess, updateRehire,
  generateDocument, triggerFinalPay, completeRecord, getAnalytics,
  getMyOffboarding, updateMyTask, uploadMyDocument, uploadRecordDocument, submitExitInterview, getMyDocuments,
  listRecordDocuments, verifyDocument,
} = require('./offboardingFunctions');

const hrOnly = allowRoles(HR_ROLES);
const allRoles = allowRoles(ALL_ROLES);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
    filename: (req, file, cb) => cb(null, `offboarding-doc-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Templates ──────────────────────────────────────────────────────────────────
router.post('/templates',        hrOnly, AsyncHandler(createTemplate));
router.get('/templates',         hrOnly, AsyncHandler(listTemplates));
router.get('/templates/:id',     hrOnly, AsyncHandler(getTemplate));
router.patch('/templates/:id',   hrOnly, AsyncHandler(updateTemplate));
router.delete('/templates/:id',  hrOnly, AsyncHandler(deleteTemplate));

// ── Employee self-service (own record only) — declared before /records/:id ────
router.get('/my',                allRoles, AsyncHandler(getMyOffboarding));
router.patch('/my/task/:taskId', allRoles, AsyncHandler(updateMyTask));
router.post('/my/document',      allRoles, upload.single('file'), AsyncHandler(uploadMyDocument));
router.post('/my/exit-interview',allRoles, AsyncHandler(submitExitInterview));
router.get('/my/documents',      allRoles, AsyncHandler(getMyDocuments));

// ── Records — HR only ──────────────────────────────────────────────────────────
router.post('/records',                       hrOnly, AsyncHandler(createRecord));
router.get('/records',                        hrOnly, AsyncHandler(listRecords));
router.get('/records/:id',                    hrOnly, AsyncHandler(getRecord));
router.patch('/records/:id/task',             hrOnly, AsyncHandler(updateRecordTask));
router.post('/records/:id/task',              hrOnly, AsyncHandler(addRecordTask));
router.get('/records/:id/documents',          hrOnly, AsyncHandler(listRecordDocuments));
router.post('/records/:id/document',          hrOnly, upload.single('file'), AsyncHandler(uploadRecordDocument));
router.patch('/documents/:id/verify',         hrOnly, AsyncHandler(verifyDocument));
router.patch('/records/:id/asset/:assetId',   hrOnly, AsyncHandler(updateAsset));
router.patch('/records/:id/access/:accessId', hrOnly, AsyncHandler(updateAccess));
router.patch('/records/:id/rehire',           hrOnly, AsyncHandler(updateRehire));
router.post('/records/:id/generate-document', hrOnly, AsyncHandler(generateDocument));
router.post('/records/:id/trigger-final-pay', hrOnly, AsyncHandler(triggerFinalPay));
router.patch('/records/:id/complete',         hrOnly, AsyncHandler(completeRecord));

// ── Analytics ──────────────────────────────────────────────────────────────────
router.get('/analytics', hrOnly, AsyncHandler(getAnalytics));

module.exports = router;
