const express = require('express');
const router = express.Router();
const AsyncHandler = require('../../middleware/AsyncHandler');
const { allowRoles } = require('../../middleware/RolesMiddleware');
const {
  listInbox, getInboxCount, getInboxItem,
  markRead, takeAction, markAllRead, dismissItem, bulkAction,
} = require('./inboxFunctions');

const ALL = ['super_admin', 'hr_manager', 'department_head', 'staff'];

router.get('/count',      allowRoles(ALL), AsyncHandler(getInboxCount));
router.put('/read-all',   allowRoles(ALL), AsyncHandler(markAllRead));
router.post('/bulk',      allowRoles(ALL), AsyncHandler(bulkAction));
router.get('/',           allowRoles(ALL), AsyncHandler(listInbox));
router.get('/:id',        allowRoles(ALL), AsyncHandler(getInboxItem));
router.put('/:id/read',   allowRoles(ALL), AsyncHandler(markRead));
router.put('/:id/action', allowRoles(ALL), AsyncHandler(takeAction));
router.delete('/:id',     allowRoles(ALL), AsyncHandler(dismissItem));

module.exports = router;
