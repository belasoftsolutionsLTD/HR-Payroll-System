const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  getFeed, createPost, updatePost, deletePost, reactToPost, getComments, addComment,
  listCommunities, createCommunity, getCommunity, joinCommunity, leaveCommunity, getCommunityFeed,
  getUpcomingCelebrations, sendClap,
  listMeetingSeries, createMeetingSeries, getMeetingNotes, createMeetingNote, updateMeetingNote,
  adminListTrustReports, adminUpdateTrustReport,
} = require('./communicationFunctions');

const HR   = ['super_admin', 'hr_manager'];
const MGMT = ['super_admin', 'hr_manager', 'department_head'];
const ALL  = ['super_admin', 'hr_manager', 'department_head', 'staff'];

// ── FEED ──────────────────────────────────────────────────────────────────────
router.get('/feed',                  allowRoles(ALL),  AsyncHandler(getFeed));
router.post('/posts',                allowRoles(ALL),  AsyncHandler(createPost));
router.put('/posts/:id',             allowRoles(ALL),  AsyncHandler(updatePost));
router.delete('/posts/:id',          allowRoles(ALL),  AsyncHandler(deletePost));
router.post('/posts/:id/react',      allowRoles(ALL),  AsyncHandler(reactToPost));
router.get('/posts/:id/comments',    allowRoles(ALL),  AsyncHandler(getComments));
router.post('/posts/:id/comments',   allowRoles(ALL),  AsyncHandler(addComment));

// ── COMMUNITIES ───────────────────────────────────────────────────────────────
// Named routes BEFORE /:id
router.get('/communities',           allowRoles(ALL),  AsyncHandler(listCommunities));
router.post('/communities',          allowRoles(HR),   AsyncHandler(createCommunity));
router.post('/communities/:id/join', allowRoles(ALL),  AsyncHandler(joinCommunity));
router.post('/communities/:id/leave',allowRoles(ALL),  AsyncHandler(leaveCommunity));
router.get('/communities/:id/feed',  allowRoles(ALL),  AsyncHandler(getCommunityFeed));
router.get('/communities/:id',       allowRoles(ALL),  AsyncHandler(getCommunity));

// ── CELEBRATIONS ──────────────────────────────────────────────────────────────
router.get('/celebrations',          allowRoles(ALL),  AsyncHandler(getUpcomingCelebrations));
router.post('/celebrations/clap',    allowRoles(ALL),  AsyncHandler(sendClap));

// ── 1:1 MEETINGS ──────────────────────────────────────────────────────────────
router.get('/meetings',                         allowRoles(ALL),  AsyncHandler(listMeetingSeries));
router.post('/meetings',                        allowRoles(ALL),  AsyncHandler(createMeetingSeries));
router.get('/meetings/:id/notes',               allowRoles(ALL),  AsyncHandler(getMeetingNotes));
router.post('/meetings/:id/notes',              allowRoles(ALL),  AsyncHandler(createMeetingNote));
router.put('/meetings/notes/:noteId',           allowRoles(ALL),  AsyncHandler(updateMeetingNote));

// ── TRUST CHANNEL (admin view) ─────────────────────────────────────────────────
// Trust submit + status-check are public routes registered in app.js
router.get('/trust/admin',           allowRoles(HR),   AsyncHandler(adminListTrustReports));
router.put('/trust/admin/:id',       allowRoles(HR),   AsyncHandler(adminUpdateTrustReport));

module.exports = router;
