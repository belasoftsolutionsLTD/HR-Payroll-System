const express = require('express');
const router = express.Router();
const multer = require('multer');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listApplicants, createApplicant, updateApplicant, deleteApplicant, patchApplicantStage, bulkPatchStage, sendOfferLetter,
  createInterview, updateInterview,
} = require('./recruitmentFunctions');

const { SUPER_ADMIN, HR_MANAGER, DEPT_HEAD } = require('../../constants/roles');
const MGMT = [SUPER_ADMIN, HR_MANAGER, DEPT_HEAD];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
  filename: (req, file, cb) => cb(null, `cv-${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

router.get('/applicants', allowRoles(MGMT), AsyncHandler(listApplicants));
router.post('/applicants', allowRoles(MGMT), upload.single('cv'), AsyncHandler(createApplicant));
router.put('/applicants/:id', allowRoles(MGMT), upload.single('cv'), AsyncHandler(updateApplicant));
router.delete('/applicants/:id', allowRoles(MGMT), AsyncHandler(deleteApplicant));
router.patch('/applicants/:id/stage', allowRoles(MGMT), AsyncHandler(patchApplicantStage));
router.post('/applicants/bulk-stage',  allowRoles(MGMT), AsyncHandler(bulkPatchStage));
router.post('/applicants/:id/offer-letter', allowRoles([SUPER_ADMIN, HR_MANAGER]), AsyncHandler(sendOfferLetter));

router.post('/interviews', allowRoles(MGMT), AsyncHandler(createInterview));
router.put('/interviews/:id', allowRoles(MGMT), AsyncHandler(updateInterview));

module.exports = router;
