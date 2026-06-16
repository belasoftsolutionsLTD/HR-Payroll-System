const express = require('express');
const multer  = require('multer');
const path    = require('path');
const router  = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { ALL_ROLES } = require('../../constants/roles');
const {
  getMyProfile, updateMyProfile, uploadMyProfilePhoto, serveMyProfilePhoto,
  getMyLeaveBalance, getMyLeaveRequests, applyForLeave, disputeLeaveRequest, downloadLeavePdf,
  getMyPayslips, getMyAttendance, getMyOnboardingTasks,
  getMyDocuments, uploadMyDocument, downloadMyDocument, deleteMyDocument,
  getMyPerformance,
  getMyAwards, getMyEvents,
  getNotificationPreference, toggleNotifications,
  getDepartmentData, deptActOnLeave,
} = require('./meFunctions');
const { getMyAnnouncements, markAnnouncementRead } = require('../announcements/announcementFunctions');

const auth = allowRoles(ALL_ROLES);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB

router.get('/profile',            auth, AsyncHandler(getMyProfile));
router.patch('/profile',          auth, AsyncHandler(updateMyProfile));
router.post('/profile/photo',     auth, upload.single('photo'), AsyncHandler(uploadMyProfilePhoto));
router.get('/profile/photo',      auth, AsyncHandler(serveMyProfilePhoto));
router.get('/leave/balance', auth, AsyncHandler(getMyLeaveBalance));
router.get('/leave/requests',auth, AsyncHandler(getMyLeaveRequests));
router.post('/leave/requests',             auth, AsyncHandler(applyForLeave));
router.post('/leave/requests/:id/dispute', auth, AsyncHandler(disputeLeaveRequest));
router.get('/leave/requests/:id/pdf',      auth, AsyncHandler(downloadLeavePdf));
router.get('/payslips',      auth, AsyncHandler(getMyPayslips));
router.get('/attendance',    auth, AsyncHandler(getMyAttendance));
router.get('/onboarding',    auth, AsyncHandler(getMyOnboardingTasks));
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

// Notification preference
router.get('/notifications/preference',  auth, AsyncHandler(getNotificationPreference));
router.patch('/notifications/toggle',    auth, AsyncHandler(toggleNotifications));

// Department portal (department_head)
router.get('/department',                   auth, AsyncHandler(getDepartmentData));
router.patch('/department/leave/:id',       auth, AsyncHandler(deptActOnLeave));

module.exports = router;
