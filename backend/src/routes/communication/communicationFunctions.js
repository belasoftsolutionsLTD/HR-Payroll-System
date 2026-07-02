'use strict';
const { ObjectId } = require('mongodb');
const { findMany, findOne } = require('../../functions/Database/commonDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const crypto = require('crypto');

// ── HELPERS ────────────────────────────────────────────────────────────────────

async function enrichPost(post) {
  // Use stored authorName fast path for older posts or when employee lookup fails
  if (post.authorName) {
    return { ...post, author: { fullName: post.authorName, designation: null, department: null } };
  }
  let author = null;
  if (post.authorId) {
    const userRecord = await findOne('users', { _id: post.authorId }, { projection: { employeeId: 1 } });
    if (userRecord?.employeeId) {
      author = await findOne('employees', { _id: userRecord.employeeId }, {
        projection: { fullName: 1, designation: 1, department: 1 },
      });
    }
  }
  return { ...post, author: author || null };
}

// ── COMPANY FEED ───────────────────────────────────────────────────────────────

const getFeed = async (req, res) => {
  const { page = 1, limit = 20, communityId } = req.query;
  const companyId = req.user.companyId;
  const skip = (Number(page) - 1) * Number(limit);

  const filter = { companyId };
  if (communityId) filter.communityId = new ObjectId(communityId);
  else filter.communityId = null;

  const posts = await global.dbo
    .collection('community_posts')
    .find(filter)
    .sort({ isPinned: -1, createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .toArray();

  const total = await global.dbo.collection('community_posts').countDocuments(filter);
  const enriched = await Promise.all(posts.map(enrichPost));
  return returnFunction(res, 200, true, req.locale.success, { posts: enriched, total });
};

const createPost = async (req, res) => {
  const { content, type = 'update', imageUrls = [], communityId = null, isPinned = false, pinExpiresAt } = req.body;
  if (!content?.trim()) return returnFunction(res, 400, false, 'Content is required', null);

  const doc = {
    companyId: req.user.companyId,
    communityId: communityId ? new ObjectId(communityId) : null,
    authorId: new ObjectId(req.user._id),
    type,
    content,
    imageUrls: imageUrls || [],
    isPinned: Boolean(isPinned),
    pinExpiresAt: pinExpiresAt ? new Date(pinExpiresAt) : null,
    reactions: [],
    commentCount: 0,
    viewCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await global.dbo.collection('community_posts').insertOne(doc);
  return returnFunction(res, 201, true, 'Post created', { _id: result.insertedId, ...doc });
};

const updatePost = async (req, res) => {
  const { content, imageUrls } = req.body;
  await global.dbo.collection('community_posts').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { content, imageUrls: imageUrls || [], updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Post updated', null);
};

const deletePost = async (req, res) => {
  await global.dbo.collection('community_posts').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, 'Post deleted', null);
};

const reactToPost = async (req, res) => {
  const { type } = req.body;
  const employeeId = new ObjectId(req.user._id);
  const postId = new ObjectId(req.params.id);

  const post = await findOne('community_posts', { _id: postId });
  if (!post) return returnFunction(res, 404, false, 'Post not found', null);

  const existing = post.reactions.find(r => String(r.employeeId) === String(employeeId) && r.type === type);
  if (existing) {
    await global.dbo.collection('community_posts').updateOne(
      { _id: postId },
      { $pull: { reactions: { employeeId, type } } }
    );
  } else {
    await global.dbo.collection('community_posts').updateOne(
      { _id: postId },
      { $push: { reactions: { type, employeeId, reactedAt: new Date() } } }
    );
  }
  return returnFunction(res, 200, true, 'Reaction updated', null);
};

const getComments = async (req, res) => {
  const postId = new ObjectId(req.params.id);
  const top = await global.dbo
    .collection('post_comments')
    .find({ postId, parentCommentId: null })
    .sort({ createdAt: 1 })
    .toArray();

  const enriched = await Promise.all(
    top.map(async c => {
      const author = await findOne('employees', { _id: c.authorId }, { projection: { fullName: 1 } });
      const replies = await global.dbo
        .collection('post_comments')
        .find({ parentCommentId: c._id })
        .sort({ createdAt: 1 })
        .toArray();
      const enrichedReplies = await Promise.all(
        replies.map(async r => {
          const ra = await findOne('employees', { _id: r.authorId }, { projection: { fullName: 1 } });
          return { ...r, author: ra };
        })
      );
      return { ...c, author, replies: enrichedReplies };
    })
  );
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const addComment = async (req, res) => {
  const { content, parentCommentId } = req.body;
  if (!content?.trim()) return returnFunction(res, 400, false, 'Comment cannot be empty', null);

  const doc = {
    postId: new ObjectId(req.params.id),
    authorId: new ObjectId(req.user._id),
    content,
    parentCommentId: parentCommentId ? new ObjectId(parentCommentId) : null,
    reactions: [],
    createdAt: new Date(),
  };

  const result = await global.dbo.collection('post_comments').insertOne(doc);
  await global.dbo
    .collection('community_posts')
    .updateOne({ _id: new ObjectId(req.params.id) }, { $inc: { commentCount: 1 } });

  const author = await findOne('employees', { _id: req.user.employeeId }, { projection: { fullName: 1 } });

  // Notify the post author (skip if they commented on their own post)
  const post = await findOne('community_posts', { _id: new ObjectId(req.params.id) });
  if (post && String(post.authorId) !== String(new ObjectId(req.user._id))) {
    const postAuthorUser = await findOne('users', { _id: post.authorId });
    if (postAuthorUser) {
      await global.dbo.collection('notifications').insertOne({
        userId: postAuthorUser._id,
        title: '💬 New comment on your post',
        message: `${author?.fullName || 'Someone'} commented: "${content.substring(0, 100)}${content.length > 100 ? '…' : ''}"`,
        type: 'general',
        read: false,
        createdAt: new Date(),
      });
    }
  }

  return returnFunction(res, 201, true, 'Comment added', { _id: result.insertedId, ...doc, author });
};

// ── COMMUNITIES ────────────────────────────────────────────────────────────────

const listCommunities = async (req, res) => {
  const { companyId } = req.user;
  const employeeId = new ObjectId(req.user._id);
  const all = await global.dbo
    .collection('communities')
    .find({ companyId, isArchived: { $ne: true } })
    .toArray();

  const enriched = all.map(c => ({
    ...c,
    memberCount: (c.memberIds || []).length,
    isMember: (c.memberIds || []).some(m => String(m) === String(employeeId)),
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createCommunity = async (req, res) => {
  const { name, description, icon, type = 'interest', autoAddType = 'none' } = req.body;
  if (!name?.trim()) return returnFunction(res, 400, false, 'Name is required', null);

  const creatorId = new ObjectId(req.user._id);
  let memberIds = [creatorId];

  if (autoAddType === 'all') {
    const all = await findMany(
      'employees',
      { status: 'active', companyId: req.user.companyId },
      { projection: { _id: 1 } }
    );
    memberIds = all.map(e => e._id);
  }

  const doc = {
    companyId: req.user.companyId,
    name: name.trim(),
    description: description || '',
    icon: icon || '👥',
    type,
    memberIds,
    adminIds: [creatorId],
    isArchived: false,
    createdBy: creatorId,
    createdAt: new Date(),
  };

  const result = await global.dbo.collection('communities').insertOne(doc);
  return returnFunction(res, 201, true, 'Community created', { _id: result.insertedId, ...doc });
};

const getCommunity = async (req, res) => {
  const c = await findOne('communities', { _id: new ObjectId(req.params.id) });
  if (!c) return returnFunction(res, 404, false, 'Community not found', null);
  return returnFunction(res, 200, true, req.locale.success, {
    ...c,
    memberCount: (c.memberIds || []).length,
    isMember: (c.memberIds || []).some(m => String(m) === String(req.user._id)),
  });
};

const joinCommunity = async (req, res) => {
  await global.dbo.collection('communities').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $addToSet: { memberIds: new ObjectId(req.user._id) } }
  );
  return returnFunction(res, 200, true, 'Joined community', null);
};

const leaveCommunity = async (req, res) => {
  await global.dbo.collection('communities').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $pull: { memberIds: new ObjectId(req.user._id) } }
  );
  return returnFunction(res, 200, true, 'Left community', null);
};

const getCommunityFeed = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const posts = await global.dbo
    .collection('community_posts')
    .find({ communityId: new ObjectId(req.params.id) })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .toArray();
  const enriched = await Promise.all(posts.map(enrichPost));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── CELEBRATIONS ───────────────────────────────────────────────────────────────

const getUpcomingCelebrations = async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in30 = new Date(today);
  in30.setDate(today.getDate() + 30);
  const { companyId } = req.user;

  const employees = await findMany(
    'employees',
    { status: 'active' },
    { projection: { fullName: 1, dateOfBirth: 1, dateOfHire: 1, designation: 1 } }
  );

  const celebrations = [];
  const thisYear = today.getFullYear();

  for (const emp of employees) {
    // Birthday
    if (emp.dateOfBirth) {
      const dob = new Date(emp.dateOfBirth);
      const bday = new Date(thisYear, dob.getMonth(), dob.getDate());
      if (bday >= today && bday <= in30) {
        celebrations.push({
          type: 'birthday', employee: { _id: emp._id, fullName: emp.fullName, designation: emp.designation },
          date: bday.toISOString().split('T')[0],
          daysUntil: Math.round((bday - today) / 86400000),
        });
      }
    }
    // Work anniversary
    if (emp.dateOfHire) {
      const s = new Date(emp.dateOfHire);
      const ann = new Date(thisYear, s.getMonth(), s.getDate());
      const years = thisYear - s.getFullYear();
      if (ann >= today && ann <= in30 && years > 0) {
        celebrations.push({
          type: 'anniversary', employee: { _id: emp._id, fullName: emp.fullName },
          date: ann.toISOString().split('T')[0],
          years, daysUntil: Math.round((ann - today) / 86400000),
        });
      }
    }
  }

  // New joiners last 14 days
  const cutoff = new Date(today);
  cutoff.setDate(today.getDate() - 14);
  const newJoiners = employees.filter(emp => emp.dateOfHire && new Date(emp.dateOfHire) >= cutoff);
  for (const emp of newJoiners) {
    celebrations.push({
      type: 'new_joiner', employee: { _id: emp._id, fullName: emp.fullName },
      date: new Date(emp.dateOfHire).toISOString().split('T')[0],
      daysUntil: 0,
    });
  }

  celebrations.sort((a, b) => a.daysUntil - b.daysUntil);
  return returnFunction(res, 200, true, req.locale.success, celebrations);
};

const sendClap = async (req, res) => {
  const { recipientId, message, visibility = 'public' } = req.body;
  if (!recipientId || !message?.trim()) {
    return returnFunction(res, 400, false, 'Recipient and message are required', null);
  }

  const [recipient, senderEmployee] = await Promise.all([
    findOne('employees', { _id: new ObjectId(recipientId) }, { projection: { fullName: 1 } }),
    req.user.employeeId
      ? findOne('employees', { _id: req.user.employeeId }, { projection: { fullName: 1 } })
      : null,
  ]);

  const senderName = senderEmployee?.fullName || req.user.name || 'A colleague';

  const doc = {
    companyId: req.user.companyId,
    communityId: null,
    authorId: new ObjectId(req.user._id),
    authorName: senderName,
    type: 'celebration',
    content: message,
    celebrationType: 'clap',
    celebrationEmployeeId: new ObjectId(recipientId),
    celebrationEmployeeName: recipient?.fullName || '',
    imageUrls: [],
    isPinned: false,
    visibility,
    reactions: [],
    commentCount: 0,
    viewCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await global.dbo.collection('community_posts').insertOne(doc);

  // Notify the recipient
  const recipientUser = await findOne('users', { employeeId: new ObjectId(recipientId) });
  if (recipientUser) {
    await global.dbo.collection('notifications').insertOne({
      userId: recipientUser._id,
      title: `👏 ${senderName} gave you a clap!`,
      message,
      type: 'general',
      read: false,
      createdAt: new Date(),
    });
  }

  // Notify all HR managers and super admins
  await notifyByRoles(['super_admin', 'hr_manager'], {
    title: `👏 ${senderName} clapped for ${recipient?.fullName || 'a team member'}`,
    body: message,
    type: 'general',
  });

  return returnFunction(res, 201, true, 'Clap sent!', { _id: result.insertedId });
};

// ── 1:1 MEETINGS ───────────────────────────────────────────────────────────────

const listMeetingSeries = async (req, res) => {
  const empId = new ObjectId(req.user._id);
  const { companyId } = req.user;

  const series = await global.dbo
    .collection('one_on_ones')
    .find({ companyId, $or: [{ participant1Id: empId }, { participant2Id: empId }], isActive: true })
    .sort({ createdAt: -1 })
    .toArray();

  const enriched = await Promise.all(
    series.map(async s => {
      const otherId = String(s.participant1Id) === String(empId) ? s.participant2Id : s.participant1Id;
      const other = await findOne('employees', { _id: otherId }, { projection: { fullName: 1, designation: 1 } });
      const [lastNote] = await global.dbo
        .collection('meeting_notes')
        .find({ seriesId: s._id })
        .sort({ date: -1 })
        .limit(1)
        .toArray();
      return { ...s, otherParticipant: other, lastMeeting: lastNote || null };
    })
  );

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createMeetingSeries = async (req, res) => {
  const { withEmployeeId, frequency = 'weekly', dayOfWeek, time, duration = 30, videoLink } = req.body;
  if (!withEmployeeId) return returnFunction(res, 400, false, 'Participant required', null);

  const doc = {
    companyId: req.user.companyId,
    participant1Id: new ObjectId(req.user._id),
    participant2Id: new ObjectId(withEmployeeId),
    frequency, dayOfWeek, time,
    duration: Number(duration),
    videoLink: videoLink || '',
    isActive: true,
    createdAt: new Date(),
  };

  const result = await global.dbo.collection('one_on_ones').insertOne(doc);

  // Notify the other participant
  const otherUser = await findOne('users', { employeeId: new ObjectId(withEmployeeId) });
  if (otherUser) {
    const myEmp = await findOne('employees', { _id: req.user.employeeId }, { projection: { fullName: 1 } });
    await global.dbo.collection('notifications').insertOne({
      userId: otherUser._id,
      title: '📅 1:1 Meeting Scheduled',
      message: `${myEmp?.fullName || 'Someone'} has scheduled a ${frequency} 1:1 meeting with you${time ? ` at ${time}` : ''}.`,
      type: 'general',
      read: false,
      createdAt: new Date(),
    });
  }

  return returnFunction(res, 201, true, '1:1 series created', { _id: result.insertedId, ...doc });
};

const getMeetingNotes = async (req, res) => {
  const notes = await global.dbo
    .collection('meeting_notes')
    .find({ seriesId: new ObjectId(req.params.id) })
    .sort({ date: -1 })
    .toArray();
  return returnFunction(res, 200, true, req.locale.success, notes);
};

const createMeetingNote = async (req, res) => {
  const { date, agendaItems = [], notes = '', actionItems = [] } = req.body;
  const doc = {
    seriesId: new ObjectId(req.params.id),
    companyId: req.user.companyId,
    date: date ? new Date(date) : new Date(),
    agendaItems, notes, actionItems,
    aiSummary: '',
    status: 'scheduled',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await global.dbo.collection('meeting_notes').insertOne(doc);
  return returnFunction(res, 201, true, 'Meeting notes created', { _id: result.insertedId, ...doc });
};

const updateMeetingNote = async (req, res) => {
  const { agendaItems, notes, actionItems, status } = req.body;
  const update = { updatedAt: new Date() };
  if (agendaItems !== undefined) update.agendaItems = agendaItems;
  if (notes !== undefined) update.notes = notes;
  if (actionItems !== undefined) update.actionItems = actionItems;
  if (status !== undefined) update.status = status;

  await global.dbo
    .collection('meeting_notes')
    .updateOne({ _id: new ObjectId(req.params.noteId) }, { $set: update });
  return returnFunction(res, 200, true, 'Notes updated', null);
};

// ── TRUST CHANNEL (public routes — no req.user needed) ─────────────────────────

const submitTrustReport = async (req, res) => {
  const { category, description } = req.body;
  if (!category || !description || description.length < 20) {
    return returnFunction(res, 400, false, 'Category and a description (min 20 chars) are required', null);
  }

  const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
  const trackingCode = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;

  const doc = {
    trackingCode,
    category,
    description,
    attachmentUrl: req.body.attachmentUrl || null,
    status: 'new',
    adminNotes: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await global.dbo.collection('trust_reports').insertOne(doc);

  notifyByRoles(['super_admin', 'hr_manager'], {
    type: 'general',
    title: '🔒 New anonymous trust report',
    body: `Category: ${category}. Use tracking code ${trackingCode} to reference it.`,
    link: '/communications',
  }).catch(() => {});

  return returnFunction(res, 201, true, 'Report submitted anonymously', { trackingCode });
};

const checkTrustStatus = async (req, res) => {
  const report = await findOne('trust_reports', { trackingCode: req.params.trackingCode });
  if (!report) return returnFunction(res, 404, false, 'Report not found', null);
  return returnFunction(res, 200, true, req.locale.success, {
    trackingCode: report.trackingCode,
    category: report.category,
    status: report.status,
    responseToReporter: report.responseToReporter || null,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  });
};

const adminListTrustReports = async (req, res) => {
  const all = await global.dbo
    .collection('trust_reports')
    .find({})
    .sort({ createdAt: -1 })
    .toArray();
  return returnFunction(res, 200, true, req.locale.success, all);
};

const adminUpdateTrustReport = async (req, res) => {
  const { status, adminNotes, responseToReporter } = req.body;
  await global.dbo
    .collection('trust_reports')
    .updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, adminNotes, responseToReporter: responseToReporter || null, updatedAt: new Date() } }
    );
  return returnFunction(res, 200, true, 'Report updated', null);
};

module.exports = {
  getFeed, createPost, updatePost, deletePost, reactToPost, getComments, addComment,
  listCommunities, createCommunity, getCommunity, joinCommunity, leaveCommunity, getCommunityFeed,
  getUpcomingCelebrations, sendClap,
  listMeetingSeries, createMeetingSeries, getMeetingNotes, createMeetingNote, updateMeetingNote,
  submitTrustReport, checkTrustStatus, adminListTrustReports, adminUpdateTrustReport,
};
