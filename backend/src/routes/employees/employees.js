const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listEmployees, getEmployee, createEmployee, updateEmployee,
  patchEmployeeStatus, deleteEmployee, uploadDocument, downloadDocument, getOrgChart,
} = require('./employeesFunctions');

const SUPER_ADMIN  = 'super_admin';
const HR_MANAGER   = 'hr_manager';
const DEPT_HEAD    = 'department_head';

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max for employee documents
});

router.get('/org-chart', allowRoles([SUPER_ADMIN, HR_MANAGER, DEPT_HEAD]), AsyncHandler(getOrgChart));
router.get('/', allowRoles([SUPER_ADMIN, HR_MANAGER, DEPT_HEAD]), AsyncHandler(listEmployees));
router.get('/:id', allowRoles([SUPER_ADMIN, HR_MANAGER, DEPT_HEAD]), AsyncHandler(getEmployee));
router.post('/', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(createEmployee));
router.put('/:id', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(updateEmployee));
router.patch('/:id/status', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(patchEmployeeStatus));
router.delete('/:id', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(deleteEmployee));
router.post('/:id/documents', allowRoles([SUPER_ADMIN, HR_MANAGER]), upload.single('document'), AsyncHandler(uploadDocument));
router.get('/:id/documents/:docId/download', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(downloadDocument));

module.exports = router;
