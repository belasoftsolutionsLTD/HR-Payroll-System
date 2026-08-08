// Postgres migration (Phase 9) — conversations/messages (+ child tables
// conversation_participants/message_reads) are Postgres now. employees/users
// have been Postgres since Phase 1.
const fs   = require('fs');
const path = require('path');
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { notifyUser } = require('../../functions/HR/notifyUser');

// ── Get contacts you can message ──────────────────────────────────────────────
const getContacts = async (req, res) => {
  const { id: userId, role } = req.user;
  const forGroup = req.query.forGroup === 'true';

  // For group creation, return all users so anyone can be added to any group
  if (forGroup) {
    const everyone = await knex('users').whereNot({ id: userId }).whereIn('role', ['staff', 'department_head', 'hr_manager', 'super_admin'])
      .select('id', 'name', 'role').orderBy('name');
    return returnFunction(res, 200, true, 'OK', everyone);
  }

  const emp = req.user.employeeId ? await knex('employees').where({ id: String(req.user.employeeId) }).select('department').first() : null;
  const dept = emp?.department;

  if (role === 'department_head') {
    if (dept) {
      const deptEmployees = await knex('employees').where({ department: dept }).whereIn('status', ['active', 'on_leave']).select('id');
      const empIds = deptEmployees.map((e) => e.id);
      const staffUsers = empIds.length ? await knex('users').whereIn('employeeId', empIds).where({ role: 'staff' }).select('id', 'name', 'role', 'employeeId') : [];
      const hrUsers = await knex('users').whereIn('role', ['hr_manager', 'super_admin']).select('id', 'name', 'role');
      const all = [...hrUsers, ...staffUsers].filter((u) => String(u.id) !== String(userId));
      return returnFunction(res, 200, true, 'OK', all);
    }
    const contacts = await knex('users').whereIn('role', ['hr_manager', 'super_admin']).whereNot({ id: userId }).select('id', 'name', 'role').orderBy('name');
    return returnFunction(res, 200, true, 'OK', contacts);
  }

  const roles = role === 'staff' ? ['hr_manager', 'super_admin', 'department_head'] : ['staff', 'department_head', 'hr_manager', 'super_admin'];
  const contacts = await knex('users').whereIn('role', roles).whereNot({ id: userId }).select('id', 'name', 'role').orderBy('name');
  return returnFunction(res, 200, true, 'OK', contacts);
};

// ── List conversations for current user ───────────────────────────────────────
const getConversations = async (req, res) => {
  const userId = req.user.id;
  const myConvoRows = await knex('conversation_participants').where({ userId }).select('conversationId', 'isAdmin');
  const convoIds = myConvoRows.map((r) => r.conversationId);
  if (!convoIds.length) return returnFunction(res, 200, true, 'OK', []);
  const adminOf = new Set(myConvoRows.filter((r) => r.isAdmin).map((r) => r.conversationId));

  const convos = await knex('conversations').whereIn('id', convoIds).orderBy('lastMessageAt', 'desc').limit(50);

  const enriched = await Promise.all(convos.map(async (c) => {
    let other = null;
    let participantCount;
    if (!c.isGroup) {
      const participants = await knex('conversation_participants').where({ conversationId: c.id }).select('userId');
      participantCount = participants.length;
      const otherRow = participants.find((p) => String(p.userId) !== String(userId));
      other = otherRow ? await knex('users').where({ id: otherRow.userId }).select('name', 'role').first() : null;
    } else {
      const [{ count }] = await knex('conversation_participants').where({ conversationId: c.id }).count('* as count');
      participantCount = Number(count);
    }

    const [{ count: unread }] = await knex('messages').where({ conversationId: c.id }).whereNot({ senderId: userId })
      .whereNotExists(knex('message_reads').whereRaw('"message_reads"."messageId" = "messages"."id"').andWhere('message_reads.userId', userId))
      .count('* as count');

    return { ...c, other, unread: Number(unread), participantCount, isAdmin: adminOf.has(c.id) };
  }));

  return returnFunction(res, 200, true, 'OK', enriched);
};

// ── Get or create conversation with a user ────────────────────────────────────
const getOrCreateConversation = async (req, res) => {
  const userId = req.user.id;
  const recipientId = req.body.recipientId || req.params.recipientId;

  // Look for existing 1:1 (non-group) convo between these two — a conversation
  // whose full participant set is exactly {userId, recipientId}.
  const mine = await knex('conversation_participants').where({ userId }).select('conversationId');
  let convo = null;
  for (const row of mine) {
    const c = await knex('conversations').where({ id: row.conversationId, isGroup: false }).first();
    if (!c) continue;
    const participants = await knex('conversation_participants').where({ conversationId: c.id }).select('userId');
    if (participants.length === 2 && participants.some((p) => String(p.userId) === String(recipientId))) {
      convo = c;
      break;
    }
  }

  if (!convo) {
    const now = new Date();
    const [saved] = await knex('conversations').insert({
      id: newId(), isGroup: false, lastMessage: '', lastMessageAt: now, createdAt: now,
    }).returning('*');
    await knex('conversation_participants').insert([
      { conversationId: saved.id, userId, isAdmin: false, joinedAt: now },
      { conversationId: saved.id, userId: recipientId, isAdmin: false, joinedAt: now },
    ]);
    convo = saved;
  }

  return returnFunction(res, 200, true, 'OK', convo);
};

// ── Get messages in a conversation ────────────────────────────────────────────
const getMessages = async (req, res) => {
  const userId = req.user.id;
  const convoId = req.params.id;

  // Verify user is a participant
  const isParticipant = await knex('conversation_participants').where({ conversationId: convoId, userId }).first();
  if (!isParticipant) return returnFunction(res, 403, false, 'Forbidden');

  const messages = await knex('messages').where({ conversationId: convoId }).orderBy('createdAt', 'asc').limit(100);

  // Mark all unread as read
  const unreadIds = [];
  for (const m of messages) {
    if (String(m.senderId) === String(userId)) continue;
    const already = await knex('message_reads').where({ messageId: m.id, userId }).first();
    if (!already) unreadIds.push(m.id);
  }
  if (unreadIds.length) {
    await knex('message_reads').insert(unreadIds.map((messageId) => ({ messageId, userId, readAt: new Date() })))
      .onConflict(['messageId', 'userId']).ignore();
  }

  return returnFunction(res, 200, true, 'OK', messages);
};

// ── Send a message (text + optional file attachments) ────────────────────────
const sendMessage = async (req, res) => {
  const content = (req.body.content || '').trim();
  const files   = req.files || [];

  if (!content && files.length === 0) {
    return returnFunction(res, 400, false, 'Message must have text or an attachment.');
  }

  const userId  = req.user.id;
  const convoId = req.params.id;

  const isParticipant = await knex('conversation_participants').where({ conversationId: convoId, userId }).first();
  if (!isParticipant) return returnFunction(res, 403, false, 'Forbidden');

  const attachments = files.map((f) => ({
    filename:     f.filename,
    originalName: f.originalname,
    mimetype:     f.mimetype,
    size:         f.size,
  }));

  const msg = {
    id: newId(),
    conversationId: convoId,
    senderId:   userId,
    senderName: req.user.name || 'Unknown',
    content,
    attachments: JSON.stringify(attachments),
    isSystem: false,
    createdAt: new Date(),
  };

  const [saved] = await knex('messages').insert(msg).returning('*');
  await knex('message_reads').insert({ messageId: saved.id, userId, readAt: new Date() }); // sender has implicitly "read" their own message

  const preview = content || (attachments.length ? `📎 ${attachments[0].originalName}` : '');
  await knex('conversations').where({ id: convoId }).update({ lastMessage: preview.substring(0, 80), lastMessageAt: new Date() });

  return returnFunction(res, 201, true, 'Sent', saved);
};

// ── Create a group conversation ───────────────────────────────────────────────
const createGroup = async (req, res) => {
  const userId = req.user.id;
  const { groupName, participantIds } = req.body;

  if (!groupName?.trim()) return returnFunction(res, 400, false, 'Group name is required.');
  if (!Array.isArray(participantIds) || participantIds.length === 0)
    return returnFunction(res, 400, false, 'At least one other participant is required.');

  const rawIds = [userId, ...participantIds];
  const seen = new Set();
  const participants = rawIds.filter((p) => { const k = String(p); return seen.has(k) ? false : (seen.add(k), true); });

  const now = new Date();
  const systemText = `${req.user.name} created the group "${groupName.trim()}"`;

  const [convo] = await knex('conversations').insert({
    id: newId(), isGroup: true, groupName: groupName.trim(), lastMessage: systemText, lastMessageAt: now,
    createdBy: userId, createdAt: now,
  }).returning('*');

  await knex('conversation_participants').insert(
    participants.map((p) => ({ conversationId: convo.id, userId: p, isAdmin: String(p) === String(userId), joinedAt: now }))
  );

  // Post a system message so the timeline shows who created the group
  const [sysMsg] = await knex('messages').insert({
    id: newId(), conversationId: convo.id, senderId: null, senderName: 'System', content: systemText,
    isSystem: true, attachments: JSON.stringify([]), createdAt: now,
  }).returning('*');
  await knex('message_reads').insert(participants.map((p) => ({ messageId: sysMsg.id, userId: p, readAt: now })));

  // Notify every participant except the creator
  const others = participants.filter((p) => String(p) !== String(userId));
  for (const uid of others) {
    notifyUser(uid, { title: `Added to group: ${groupName.trim()}`, body: `${req.user.name} added you to the group "${groupName.trim()}".`, type: 'group_chat' }).catch(() => {});
  }

  return returnFunction(res, 201, true, 'Group created', convo);
};

// ── Get group info (full member list) ─────────────────────────────────────────
const getGroupInfo = async (req, res) => {
  const userId  = req.user.id;
  const convoId = req.params.id;

  const convo = await knex('conversations').where({ id: convoId, isGroup: true }).first();
  if (!convo) return returnFunction(res, 404, false, 'Group not found.');
  const myRow = await knex('conversation_participants').where({ conversationId: convoId, userId }).first();
  if (!myRow) return returnFunction(res, 404, false, 'Group not found.');

  const participantRows = await knex('conversation_participants').where({ conversationId: convoId });
  const userIds = participantRows.map((p) => p.userId);
  const members = userIds.length ? await knex('users').whereIn('id', userIds).select('id', 'name', 'role') : [];

  const adminSet = new Set(participantRows.filter((p) => p.isAdmin).map((p) => String(p.userId)));
  const enrichedMembers = members.map((m) => ({
    ...m,
    isAdmin: adminSet.has(String(m.id)),
    isMe:    String(m.id) === String(userId),
  }));

  return returnFunction(res, 200, true, 'OK', {
    ...convo,
    members: enrichedMembers,
    isAdmin: adminSet.has(String(userId)),
  });
};

// ── Update group (rename / add / remove members) — admin only ─────────────────
const updateGroup = async (req, res) => {
  const userId  = req.user.id;
  const convoId = req.params.id;

  const convo = await knex('conversations').where({ id: convoId, isGroup: true }).first();
  if (!convo) return returnFunction(res, 404, false, 'Group not found.');
  const myRow = await knex('conversation_participants').where({ conversationId: convoId, userId }).first();
  if (!myRow) return returnFunction(res, 404, false, 'Group not found.');
  if (!myRow.isAdmin) return returnFunction(res, 403, false, 'Only admins can update the group.');

  const sets = {};
  if (req.body.groupName?.trim()) sets.groupName = req.body.groupName.trim();
  if (Object.keys(sets).length) await knex('conversations').where({ id: convoId }).update(sets);

  const now = new Date();

  if (Array.isArray(req.body.addMembers) && req.body.addMembers.length > 0) {
    const newIds = req.body.addMembers;
    await knex('conversation_participants').insert(newIds.map((uid) => ({ conversationId: convoId, userId: uid, isAdmin: false, joinedAt: now })))
      .onConflict(['conversationId', 'userId']).ignore();

    const addedUsers = await knex('users').whereIn('id', newIds).select('id', 'name');

    for (const u of addedUsers) {
      const text = `${req.user.name} added ${u.name} to the group`;
      const [sysMsg] = await knex('messages').insert({
        id: newId(), conversationId: convoId, senderId: null, senderName: 'System', content: text,
        isSystem: true, attachments: JSON.stringify([]), createdAt: now,
      }).returning('*');
      await knex('message_reads').insert({ messageId: sysMsg.id, userId, readAt: now }).onConflict(['messageId', 'userId']).ignore();
      notifyUser(u.id, { title: `Added to group: ${convo.groupName}`, body: `${req.user.name} added you to the group "${convo.groupName}".`, type: 'group_chat' }).catch(() => {});
    }

    await knex('conversations').where({ id: convoId }).update({
      lastMessage: `${req.user.name} added ${addedUsers.map((u) => u.name).join(', ')}`, lastMessageAt: now,
    });
  }

  if (Array.isArray(req.body.removeMembers) && req.body.removeMembers.length > 0) {
    const removeIds = req.body.removeMembers;
    const removedUsers = await knex('users').whereIn('id', removeIds).select('id', 'name');

    await knex('conversation_participants').where({ conversationId: convoId }).whereIn('userId', removeIds).delete();

    for (const u of removedUsers) {
      const text = `${req.user.name} removed ${u.name} from the group`;
      const [sysMsg] = await knex('messages').insert({
        id: newId(), conversationId: convoId, senderId: null, senderName: 'System', content: text,
        isSystem: true, attachments: JSON.stringify([]), createdAt: now,
      }).returning('*');
      await knex('message_reads').insert({ messageId: sysMsg.id, userId, readAt: now }).onConflict(['messageId', 'userId']).ignore();
    }
  }

  const updated = await knex('conversations').where({ id: convoId }).first();
  return returnFunction(res, 200, true, 'Updated', updated);
};

// ── Leave group ───────────────────────────────────────────────────────────────
const leaveGroup = async (req, res) => {
  const userId  = req.user.id;
  const convoId = req.params.id;

  const convo = await knex('conversations').where({ id: convoId, isGroup: true }).first();
  if (!convo) return returnFunction(res, 404, false, 'Group not found.');
  const myRow = await knex('conversation_participants').where({ conversationId: convoId, userId }).first();
  if (!myRow) return returnFunction(res, 404, false, 'Group not found.');

  await knex('conversation_participants').where({ conversationId: convoId, userId }).delete();

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
  const userId = req.user.id;
  const myConvos = await knex('conversation_participants').where({ userId }).select('conversationId');
  const convoIds = myConvos.map((c) => c.conversationId);
  if (!convoIds.length) return returnFunction(res, 200, true, 'OK', { count: 0 });

  const [{ count }] = await knex('messages').whereIn('conversationId', convoIds).whereNot({ senderId: userId })
    .whereNotExists(knex('message_reads').whereRaw('"message_reads"."messageId" = "messages"."id"').andWhere('message_reads.userId', userId))
    .count('* as count');

  return returnFunction(res, 200, true, 'OK', { count: Number(count) });
};

module.exports = {
  getContacts, getConversations, getOrCreateConversation,
  getMessages, sendMessage, serveAttachment, getUnreadCount,
  createGroup, getGroupInfo, updateGroup, leaveGroup,
};
