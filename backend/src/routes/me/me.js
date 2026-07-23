const express = require('express');
const multer  = require('multer');
const path    = require('path');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { ALL_ROLES } = require('../../constants/roles');
const {
  getMyProfile, updateMyProfile, getMyJobHistory, contactHR, uploadMyProfilePhoto, serveMyProfilePhoto,
  updateMySkills, addMyCertification, deleteMyCertification, addMyEducation, deleteMyEducation,
  getMyPayslips, getMyAttendance,
  getMyDocuments, uploadMyDocument, downloadMyDocument, deleteMyDocument,
  getMyPerformance,
  getMyAwards, getMyEvents,
  getNotificationPreference, toggleNotifications,
  getDepartmentData,
  getMyTasks,
  getMyProjects,
  getMyNotes,
  getOpenPositions, applyInternal, getMyApplications,
} = require('./meFunctions');
const { getMyAnnouncements, markAnnouncementRead } = require('../announcements/announcementFunctions');
const { getMyWelfare } = require('../welfare/welfareFunctions');

const auth = allowRoles(ALL_ROLES);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB

router.get('/profile',            auth, AsyncHandler(getMyProfile));
router.patch('/profile',          auth, AsyncHandler(updateMyProfile));
router.get('/job-history',        auth, AsyncHandler(getMyJobHistory));
router.patch('/skills',                    auth, AsyncHandler(updateMySkills));
router.post('/certifications',             auth, AsyncHandler(addMyCertification));
router.delete('/certifications/:certId',   auth, AsyncHandler(deleteMyCertification));
router.post('/education',                  auth, AsyncHandler(addMyEducation));
router.delete('/education/:eduId',         auth, AsyncHandler(deleteMyEducation));
router.post('/contact-hr',        auth, AsyncHandler(contactHR));
router.post('/profile/photo',     auth, upload.single('photo'), AsyncHandler(uploadMyProfilePhoto));
router.get('/profile/photo',      auth, AsyncHandler(serveMyProfilePhoto));
router.get('/payslips',      auth, AsyncHandler(getMyPayslips));
router.get('/attendance',    auth, AsyncHandler(getMyAttendance));
router.get('/announcements',            auth, AsyncHandler(getMyAnnouncements));
router.patch('/announcements/:id/read', auth, AsyncHandler(markAnnouncementRead));

// Documents
router.get('/documents',                    auth, AsyncHandler(getMyDocuments));
router.post('/documents', auth, upload.single('file'), AsyncHandler(uploadMyDocument));
router.get('/documents/:docId/download',    auth, AsyncHandler(downloadMyDocument));
router.delete('/documents/:docId',          auth, AsyncHandler(deleteMyDocument));

// Performance (self-view)
router.get('/performance', auth, AsyncHandler(getMyPerformance));

// Awards (self-view)
router.get('/awards', auth, AsyncHandler(getMyAwards));

// Upcoming events (training & team building)
router.get('/events', auth, AsyncHandler(getMyEvents));

// Welfare scheme memberships (self-view)
router.get('/welfare', auth, AsyncHandler(getMyWelfare));

// Notification preference
router.get('/notifications/preference',  auth, AsyncHandler(getNotificationPreference));
router.patch('/notifications/toggle',    auth, AsyncHandler(toggleNotifications));

// Department portal (department_head and above only)
const deptAuth = allowRoles(['super_admin', 'hr_manager', 'department_head']);
router.get('/department', deptAuth, AsyncHandler(getDepartmentData));

// Tasks assigned to me
router.get('/tasks', auth, AsyncHandler(getMyTasks));

// Projects I'm a member of
router.get('/projects', auth, AsyncHandler(getMyProjects));

// My HR notes (staff can read their own notes)
router.get('/notes', auth, AsyncHandler(getMyNotes));

// Internal job board
router.get('/jobs',                           auth, AsyncHandler(getOpenPositions));
router.get('/jobs/applications',              auth, AsyncHandler(getMyApplications));
router.post('/jobs/:positionId/apply',        auth, AsyncHandler(applyInternal));

module.exports = router;
