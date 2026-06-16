const { ObjectId } = require('mongodb');
const fs   = require('fs');
const path = require('path');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne } = require('../../functions/Database/commonDBFunctions');

// Helper: ensure ObjectId
const oid = (id) => new ObjectId(id);

// ── Get contacts you can message ──────────────────────────────────────────────
const getContacts = async (req, res) => {
  const { _id: userId, role } = req.user;
  const forGroup = req.query.forGroup === 'true';

  // For group creation, return all users so anyone can be added to any group
  if (forGroup) {
    const everyone = await findMany('users',
      { _id: { $ne: oid(userId) }, role: { $in: ['staff', 'department_head', 'hr_manager', 'super_admin'] } },
      { projection: { _id: 1, name: 1, role: 1 }, sort: { name: 1 } }
    );
    return returnFunction(res, 200, true, 'OK', everyone);
  }

  const emp = req.user.employeeId
    ? await findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1 } })
    : null;
  const dept = emp?.department;

  let userFilter = {};

  if (role === 'staff') {
    userFilter = { role: { $in: ['hr_manager', 'super_admin', 'department_head'] } };
  } else if (role === 'department_head') {
    if (dept) {
      const deptEmployees = await findMany('employees',
        { department: dept, status: { $in: ['active', 'on_leave'] } },
        { projection: { _id: 1 } }
      );
      const empIds = deptEmployees.map(e => e._id);
      const staffUsers = await global.dbo.collection('users')
        .find({ employeeId: { $in: empIds }, role: 'staff' })
        .project({ _id: 1, name: 1, role: 1, employeeId: 1 })
        .toArray();
      const hrUsers = await findMany('users',
        { role: { $in: ['hr_manager', 'super_admin'] } },
        { projection: { _id: 1, name: 1, role: 1 } }
      );
      const all = [...hrUsers, ...staffUsers].filter(u => String(u._id) !== String(userId));
      return returnFunction(res, 200, true, 'OK', all);
    }
    userFilter = { role: { $in: ['hr_manager', 'super_admin'] } };
  } else {
    userFilter = { role: { $in: ['staff', 'department_head', 'hr_manager', 'super_admin'] } };
  }

  const contacts = await findMany('users', { ...userFilter, _id: { $ne: oid(userId) } },
    { projection: { _id: 1, name: 1, role: 1 }, sort: { name: 1 } }
  );
  return returnFunction(res, 200, true, 'OK', contacts);
};

// ── List conversations for current user ───────────────────────────────────────
const getConversations = async (req, res) => {
  const userId = oid(req.user._id);
  const convos = await global.dbo.collection('conversations')
    .find({ participants: userId })
    .sort({ lastMessageAt: -1 })
    .limit(50)
    .toArray();

  const enriched = await Promise.all(convos.map(async (c) => {
    let other = null;
    if (!c.isGroup) {
      const otherId = c.participants.find(p => String(p) !== String(userId));
      other = otherId
        ? await findOne('users', { _id: otherId }, { projection: { name: 1, role: 1 } })
        : null;
    }

    const unread = await global.dbo.collection('messages').countDocuments({
      conversationId: c._id,
      senderId: { $ne: userId },
      readBy: { $ne: userId },
    });

    const isAdmin = c.isGroup
      ? (c.admins ?? []).some(a => String(a) === String(userId))
      : false;

    return { ...c, other, unread, participantCount: c.participants?.length ?? 0, isAdmin };
  }));

  return returnFunction(res, 200, true, 'OK', enriched);
};

// ── Get or create conversation with a user ────────────────────────────────────
const getOrCreateConversation = async (req, res) => {
  const userId = oid(req.user._id);
  const recipientId = oid(req.body.recipientId || req.params.recipientId);

  // Look for existing convo between these two
  let convo = await global.dbo.collection('conversations').findOne({
    participants: { $all: [userId, recipientId], $size: 2 },
  });

  if (!convo) {
    const result = await global.dbo.collection('conversations').insertOne({
      participants: [userId, recipientId],
      lastMessage: '',
      lastMessageAt: new Date(),
      createdAt: new Date(),
    });
    convo = await global.dbo.collection('conversations').findOne({ _id: result.insertedId });
  }

  return returnFunction(res, 200, true, 'OK', convo);
};

// ── Get messages in a conversation ────────────────────────────────────────────
const getMessages = async (req, res) => {
  const userId = oid(req.user._id);
  const convoId = oid(req.params.id);

  // Verify user is a participant
  const convo = await global.dbo.collection('conversations').findOne({
    _id: convoId, participants: userId,
  });
  if (!convo) return returnFunction(res, 403, false, 'Forbidden');

  const messages = await global.dbo.collection('messages')
    .find({ conversationId: convoId })
    .sort({ createdAt: 1 })
    .limit(100)
    .toArray();

  // Mark all unread as read
  await global.dbo.collection('messages').updateMany(
    { conversationId: convoId, senderId: { $ne: userId }, readBy: { $ne: userId } },
    { $addToSet: { readBy: userId } }
  );

  return returnFunction(res, 200, true, 'OK', messages);
};

// ── Send a message (text + optional file attachments) ────────────────────────
const sendMessage = async (req, res) => {
  const content = (req.body.content || '').trim();
  const files   = req.files || [];

  if (!content && files.length === 0) {
    return returnFunction(res, 400, false, 'Message must have text or an attachment.');
  }

  const userId  = oid(req.user._id);
  const convoId = oid(req.params.id);

  const convo = await global.dbo.collection('conversations').findOne({
    _id: convoId, participants: userId,
  });
  if (!convo) return returnFunction(res, 403, false, 'Forbidden');

  const attachments = files.map(f => ({
    filename:     f.filename,
    originalName: f.originalname,
    mimetype:     f.mimetype,
    size:         f.size,
  }));

  const msg = {
    conversationId: convoId,
    senderId:   userId,
    senderName: req.user.name || 'Unknown',
    content,
    attachments,
    readBy:    [userId],
    createdAt: new Date(),
  };

  const result = await global.dbo.collection('messages').insertOne(msg);

  const preview = content || (attachments.length ? `📎 ${attachments[0].originalName}` : '');
  await global.dbo.collection('conversations').updateOne(
    { _id: convoId },
    { $set: { lastMessage: preview.substring(0, 80), lastMessageAt: new Date() } }
  );

  return returnFunction(res, 201, true, 'Sent', { _id: result.insertedId, ...msg });
};

// ── Create a group conversation ───────────────────────────────────────────────
const createGroup = async (req, res) => {
  const userId = oid(req.user._id);
  const { groupName, participantIds } = req.body;

  if (!groupName?.trim()) return returnFunction(res, 400, false, 'Group name is required.');
  if (!Array.isArray(participantIds) || participantIds.length === 0)
    return returnFunction(res, 400, false, 'At least one other participant is required.');

  const rawIds = [userId, ...participantIds.map(id => oid(id))];
  // deduplicate by string representation
  const seen = new Set();
  const participants = rawIds.filter(p => { const k = String(p); return seen.has(k) ? false : (seen.add(k), true); });

  const now = new Date();
  const systemText = `${req.user.name} created the group "${groupName.trim()}"`;

  const result = await global.dbo.collection('conversations').insertOne({
    isGroup:       true,
    groupName:     groupName.trim(),
    participants,
    admins:        [userId],
    createdBy:     userId,
    lastMessage:   systemText,
    lastMessageAt: now,
    createdAt:     now,
  });

  const convoId = result.insertedId;

  // Post a system message so the timeline shows who created the group
  await global.dbo.collection('messages').insertOne({
    conversationId: convoId,
    senderId:       null,
    senderName:     'System',
    content:        systemText,
    isSystem:       true,
    attachments:    [],
    readBy:         participants,
    createdAt:      now,
  });

  // Notify every participant except the creator
  const others = participants.filter(p => String(p) !== String(userId));
  if (others.length > 0) {
    await global.dbo.collection('notifications').insertMany(
      others.map(uid => ({
        userId:    uid,
        title:     `Added to group: ${groupName.trim()}`,
        message:   `${req.user.name} added you to the group "${groupName.trim()}".`,
        type:      'group_chat',
        read:      false,
        createdAt: now,
      }))
    );
  }

  const convo = await global.dbo.collection('conversations').findOne({ _id: convoId });
  return returnFunction(res, 201, true, 'Group created', convo);
};

// ── Get group info (full member list) ─────────────────────────────────────────
const getGroupInfo = async (req, res) => {
  const userId  = oid(req.user._id);
  const convoId = oid(req.params.id);

  const convo = await global.dbo.collection('conversations').findOne({
    _id: convoId, isGroup: true, participants: userId,
  });
  if (!convo) return returnFunction(res, 404, false, 'Group not found.');

  const members = await global.dbo.collection('users')
    .find({ _id: { $in: convo.participants } })
    .project({ _id: 1, name: 1, role: 1 })
    .toArray();

  const adminSet = new Set((convo.admins ?? []).map(String));
  const enrichedMembers = members.map(m => ({
    ...m,
    isAdmin: adminSet.has(String(m._id)),
    isMe:    String(m._id) === String(userId),
  }));

  return returnFunction(res, 200, true, 'OK', {
    ...convo,
    members: enrichedMembers,
    isAdmin: adminSet.has(String(userId)),
  });
};

// ── Update group (rename / add / remove members) — admin only ─────────────────
const updateGroup = async (req, res) => {
  const userId  = oid(req.user._id);
  const convoId = oid(req.params.id);

  const convo = await global.dbo.collection('conversations').findOne({
    _id: convoId, isGroup: true, participants: userId,
  });
  if (!convo) return returnFunction(res, 404, false, 'Group not found.');

  const isAdmin = (convo.admins ?? []).some(a => String(a) === String(userId));
  if (!isAdmin) return returnFunction(res, 403, false, 'Only admins can update the group.');

  const sets = {};
  if (req.body.groupName?.trim()) sets.groupName = req.body.groupName.trim();

  if (Object.keys(sets).length) {
    await global.dbo.collection('conversations').updateOne({ _id: convoId }, { $set: sets });
  }

  const now = new Date();

  if (Array.isArray(req.body.addMembers) && req.body.addMembers.length > 0) {
    const newIds = req.body.addMembers.map(id => oid(id));
    await global.dbo.collection('conversations').updateOne(
      { _id: convoId },
      { $addToSet: { participants: { $each: newIds } } }
    );

    // System message + notifications for each newly added member
    const addedUsers = await global.dbo.collection('users')
      .find({ _id: { $in: newIds } })
      .project({ _id: 1, name: 1 })
      .toArray();

    for (const u of addedUsers) {
      const text = `${req.user.name} added ${u.name} to the group`;
      await global.dbo.collection('messages').insertOne({
        conversationId: convoId,
        senderId:       null,
        senderName:     'System',
        content:        text,
        isSystem:       true,
        attachments:    [],
        readBy:         [userId],
        createdAt:      now,
      });
      await global.dbo.collection('notifications').insertOne({
        userId:    u._id,
        title:     `Added to group: ${convo.groupName}`,
        message:   `${req.user.name} added you to the group "${convo.groupName}".`,
        type:      'group_chat',
        read:      false,
        createdAt: now,
      });
    }

    await global.dbo.collection('conversations').updateOne(
      { _id: convoId },
      { $set: { lastMessage: `${req.user.name} added ${addedUsers.map(u => u.name).join(', ')}`, lastMessageAt: now } }
    );
  }

  if (Array.isArray(req.body.removeMembers) && req.body.removeMembers.length > 0) {
    const removeIds = req.body.removeMembers.map(id => oid(id));

    const removedUsers = await global.dbo.collection('users')
      .find({ _id: { $in: removeIds } })
      .project({ _id: 1, name: 1 })
      .toArray();

    await global.dbo.collection('conversations').updateOne(
      { _id: convoId },
      { $pull: { participants: { $in: removeIds }, admins: { $in: removeIds } } }
    );

    for (const u of removedUsers) {
      const text = `${req.user.name} removed ${u.name} from the group`;
      await global.dbo.collection('messages').insertOne({
        conversationId: convoId,
        senderId:       null,
        senderName:     'System',
        content:        text,
        isSystem:       true,
        attachments:    [],
        readBy:         [userId],
        createdAt:      now,
      });
    }
  }

  const updated = await global.dbo.collection('conversations').findOne({ _id: convoId });
  return returnFunction(res, 200, true, 'Updated', updated);
};

// ── Leave group ───────────────────────────────────────────────────────────────
const leaveGroup = async (req, res) => {
  const userId  = oid(req.user._id);
  const convoId = oid(req.params.id);

  const convo = await global.dbo.collection('conversations').findOne({
    _id: convoId, isGroup: true, participants: userId,
  });
  if (!convo) return returnFunction(res, 404, false, 'Group not found.');

  await global.dbo.collection('conversations').updateOne(
    { _id: convoId },
    { $pull: { participants: userId, admins: userId } }
  );

  return returnFunction(res, 200, true, 'Left group.');
};

// ── Serve a message attachment ────────────────────────────────────────────────
const serveAttachment = async (req, res) => {
  const safeName = path.basename(req.params.filename);
  if (!safeName.startsWith('msg-')) return returnFunction(res, 403, false, 'Access denied.');

  const filePath = path.resolve(process.env.UPLOAD_DIR || 'uploads', safeName);
  if (!fs.existsSync(filePath)) return returnFunction(res, 404, false, 'File not found.');

  const ext = path.extname(safeName).toLowerCase();
  const MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif',  '.webp': 'image/webp',  '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain',
  };
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(filePath).pipe(res);
};

// ── Unread count across all conversations ─────────────────────────────────────
const getUnreadCount = async (req, res) => {
  const userId = oid(req.user._id);
  const myConvos = await global.dbo.collection('conversations')
    .find({ participants: userId })
    .project({ _id: 1 })
    .toArray();
  const convoIds = myConvos.map(c => c._id);

  const count = await global.dbo.collection('messages').countDocuments({
    conversationId: { $in: convoIds },
    senderId: { $ne: userId },
    readBy: { $ne: userId },
  });

  return returnFunction(res, 200, true, 'OK', { count });
};

module.exports = {
  getContacts, getConversations, getOrCreateConversation,
  getMessages, sendMessage, serveAttachment, getUnreadCount,
  createGroup, getGroupInfo, updateGroup, leaveGroup,
};
