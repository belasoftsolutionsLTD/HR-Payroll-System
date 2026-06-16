const express = require('express');
const router  = express.Router();
const path    = require('path');
const multer  = require('multer');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const { ALL_ROLES } = require('../../constants/roles');
const {
  getContacts, getConversations, getOrCreateConversation,
  getMessages, sendMessage, serveAttachment, getUnreadCount,
  createGroup, getGroupInfo, updateGroup, leaveGroup,
} = require('./messageFunctions');

const allAuth = allowRoles(ALL_ROLES);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
  filename:    (req, file, cb) => {
    const rand = Math.random().toString(36).slice(2, 8);
    cb(null, `msg-${Date.now()}-${rand}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024, files: 5 } });

router.get('/messages/contacts',                  allAuth, AsyncHandler(getContacts));
router.get('/messages/conversations',             allAuth, AsyncHandler(getConversations));
router.post('/messages/conversations',            allAuth, AsyncHandler(getOrCreateConversation));
router.get('/messages/conversations/:id',         allAuth, AsyncHandler(getMessages));
router.post('/messages/conversations/:id',        allAuth, upload.array('files', 5), AsyncHandler(sendMessage));
router.get('/messages/attachments/:filename',     allAuth, AsyncHandler(serveAttachment));
router.get('/messages/unread',                    allAuth, AsyncHandler(getUnreadCount));

// Group chat
router.post('/messages/groups',                   allAuth, AsyncHandler(createGroup));
router.get('/messages/groups/:id',                allAuth, AsyncHandler(getGroupInfo));
router.patch('/messages/groups/:id',              allAuth, AsyncHandler(updateGroup));
router.delete('/messages/groups/:id/leave',       allAuth, AsyncHandler(leaveGroup));

module.exports = router;
