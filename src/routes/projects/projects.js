const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, MGMT_ROLES, ALL_ROLES } = require('../../constants/roles');
const {
  listProjects, createProject, getProject, updateProject, completeProject, deleteProject,
  addMembers, removeMember,
  listSubtasks, createSubtask, updateSubtask, deleteSubtask,
  assignSubtaskEmployees, submitSubtaskReport,
  listNotes, createNote, deleteNote,
  getMessages, sendMessage,
} = require('./projectsFunctions');

const hrOnly   = allowRoles(HR_ROLES);
const mgmtOnly = allowRoles(MGMT_ROLES);
const allRoles = allowRoles(ALL_ROLES);

// ── File uploads for subtask attachments ─────────────────────────────────────

const projectUploadDir = path.join(
  process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', '..', '..', 'uploads'),
  'projects'
);
if (!fs.existsSync(projectUploadDir)) fs.mkdirSync(projectUploadDir, { recursive: true });

const projectStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, projectUploadDir),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const projectUpload = multer({
  storage: projectStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ── Projects ──────────────────────────────────────────────────────────────────

router.get('/',    allRoles,  AsyncHandler(listProjects));
router.post('/',   mgmtOnly,  AsyncHandler(createProject));

// Named sub-routes BEFORE /:id
router.get('/:id/subtasks',                              allRoles,  AsyncHandler(listSubtasks));
router.post('/:id/subtasks',  mgmtOnly,  projectUpload.single('file'), AsyncHandler(createSubtask));
router.put('/:id/subtasks/:subId',        mgmtOnly,  AsyncHandler(updateSubtask));
router.delete('/:id/subtasks/:subId',     mgmtOnly,  AsyncHandler(deleteSubtask));
router.post('/:id/subtasks/:subId/assign', allRoles, AsyncHandler(assignSubtaskEmployees));
router.post('/:id/subtasks/:subId/report', allRoles, projectUpload.single('file'), AsyncHandler(submitSubtaskReport));

router.get('/:id/notes',            allRoles, AsyncHandler(listNotes));
router.post('/:id/notes',           allRoles, AsyncHandler(createNote));
router.delete('/:id/notes/:noteId', allRoles, AsyncHandler(deleteNote));

router.get('/:id/messages',  allRoles, AsyncHandler(getMessages));
router.post('/:id/messages', allRoles, AsyncHandler(sendMessage));

router.post('/:id/members',               mgmtOnly, AsyncHandler(addMembers));
router.delete('/:id/members/:employeeId', mgmtOnly, AsyncHandler(removeMember));

router.put('/:id/complete', allRoles, AsyncHandler(completeProject));

// ── Project CRUD ──────────────────────────────────────────────────────────────

router.get('/:id',    allRoles,  AsyncHandler(getProject));
router.put('/:id',    mgmtOnly,  AsyncHandler(updateProject));
router.delete('/:id', hrOnly,    AsyncHandler(deleteProject));

module.exports = router;
