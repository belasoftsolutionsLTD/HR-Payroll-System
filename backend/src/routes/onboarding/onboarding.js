const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES } = require('../../constants/roles');
const {
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  addEmployeeTask, updateTask, deleteTask, assignDefaultTasksHandler,
  listOnboarding, getEmployeeOnboarding, getOnboardingDetails, completeTask, clearEmployeeOnboarding,
  serveJdPdf,
  startOffboarding, listOffboarding, getEmployeeOffboarding, completeOffboardingTask, addOffboardingTask, clearEmployeeOffboarding,
  getOverdueTasks,
} = require('./onboardingFunctions');

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

const jdStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = process.env.UPLOAD_DIR || 'uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `jd-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`),
});
const uploadJd = multer({
  storage: jdStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});

const hrOnly = allowRoles(HR_ROLES);

// Templates
router.get('/onboarding/templates',         hrOnly, AsyncHandler(listTemplates));
router.post('/onboarding/templates',        hrOnly, AsyncHandler(createTemplate));
router.put('/onboarding/templates/:id',     hrOnly, AsyncHandler(updateTemplate));
router.delete('/onboarding/templates/:id',  hrOnly, AsyncHandler(deleteTemplate));

// Overdue tasks across all employees
router.get('/onboarding/overdue',                      hrOnly, AsyncHandler(getOverdueTasks));

// Per-employee tasks
router.get('/onboarding',                              hrOnly, AsyncHandler(listOnboarding));
router.get('/onboarding/:employeeId',                  hrOnly, AsyncHandler(getEmployeeOnboarding));
router.get('/onboarding/:employeeId/details',          hrOnly, AsyncHandler(getOnboardingDetails));
router.post('/onboarding/:employeeId/tasks',           hrOnly, AsyncHandler(addEmployeeTask));
router.post('/onboarding/:employeeId/assign-defaults', hrOnly, uploadJd.single('jdPdf'), AsyncHandler(assignDefaultTasksHandler));
router.get('/onboarding/:employeeId/jd-pdf',           hrOnly, AsyncHandler(serveJdPdf));
router.delete('/onboarding/:employeeId',               hrOnly, AsyncHandler(clearEmployeeOnboarding));

// Individual task CRUD
router.put('/onboarding/tasks/:taskId',    hrOnly, AsyncHandler(updateTask));
router.delete('/onboarding/tasks/:taskId', hrOnly, AsyncHandler(deleteTask));
router.patch('/onboarding/tasks/:taskId',  AsyncHandler(completeTask));

// Offboarding
router.get('/offboarding',                              hrOnly, AsyncHandler(listOffboarding));
router.post('/offboarding',                             hrOnly, AsyncHandler(startOffboarding));
router.get('/offboarding/:employeeId',                  hrOnly, AsyncHandler(getEmployeeOffboarding));
router.post('/offboarding/:employeeId/tasks',           hrOnly, AsyncHandler(addOffboardingTask));
router.patch('/offboarding/tasks/:taskId',              AsyncHandler(completeOffboardingTask));
router.delete('/offboarding/:employeeId',               hrOnly, AsyncHandler(clearEmployeeOffboarding));

module.exports = router;
