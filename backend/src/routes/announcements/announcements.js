const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { HR_ROLES, ALL_ROLES } = require('../../constants/roles');
const {
  createAnnouncement, listAnnouncements, deleteAnnouncement,
  getMyAnnouncements, markAnnouncementRead,
} = require('./announcementFunctions');

// HR routes
router.get('/hr/announcements',        allowRoles(HR_ROLES),  AsyncHandler(listAnnouncements));
router.post('/hr/announcements',       allowRoles(HR_ROLES),  AsyncHandler(createAnnouncement));
router.delete('/hr/announcements/:id', allowRoles(HR_ROLES),  AsyncHandler(deleteAnnouncement));

// Staff/all routes (mounted under /api/me)
router.get('/announcements',           allowRoles(ALL_ROLES), AsyncHandler(getMyAnnouncements));
router.patch('/announcements/:id/read',allowRoles(ALL_ROLES), AsyncHandler(markAnnouncementRead));

module.exports = router;
