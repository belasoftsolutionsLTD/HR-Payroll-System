'use strict';
// Postgres migration (Phase 9) — communities/community_posts/post_comments/
// communication_one_on_ones/meeting_notes/trust_reports are Postgres now.
// employees/users have been Postgres since Phase 1. `notifications` joined them in
// Phase 10 — every notification below goes through notifyUser/notifyByRoles, which
// already handle the write (see notifyUser.js).
const crypto = require('crypto');
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { notifyUser, notifyByRoles } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

// ── HELPERS ────────────────────────────────────────────────────────────────────

async function enrichPost(post) {
  // Use stored authorName fast path for older posts or when employee lookup fails
  if (post.authorName) {
    return { ...post, author: { fullName: post.authorName, designation: null, department: null } };
  }
  let author = null;
  if (post.authorId) {
    const userRecord = await knex('users').where({ id: post.authorId }).select('employeeId').first();
    if (userRecord?.employeeId) {
      author = await knex('employees').where({ id: userRecord.employeeId }).select('fullName', 'designation', 'department').first();
    }
  }
  return { ...post, author: author || null };
}

// ── COMPANY FEED ───────────────────────────────────────────────────────────────

const getFeed = async (req, res) => {
  const { page = 1, limit = 20, communityId } = req.query;
  const companyId = req.user.companyId;
  const skip = (Number(page) - 1) * Number(limit);

  let query = knex('community_posts').where({ companyId: companyId ?? null });
  query = communityId ? query.where({ communityId }) : query.whereNull('communityId');

  const [{ count: total }] = await query.clone().count('* as count');
  const posts = await query.clone().orderBy('isPinned', 'desc').orderBy('createdAt', 'desc').limit(Number(limit)).offset(skip);

  const enriched = await Promise.all(posts.map(enrichPost));
  return returnFunction(res, 200, true, req.locale.success, { posts: enriched, total: Number(total) });
};

const createPost = async (req, res) => {
  const { content, type = 'update', imageUrls = [], communityId = null, isPinned = false, pinExpiresAt } = req.body;
  if (!content?.trim()) return returnFunction(res, 400, false, 'Content is required', null);

  const doc = {
    id: newId(),
    companyId: req.user.companyId ?? null,
    communityId: communityId || null,
    authorId: req.user.id,
    type,
    content,
    imageUrls: JSON.stringify(imageUrls || []),
    isPinned: Boolean(isPinned),
    pinExpiresAt: pinExpiresAt ? new Date(pinExpiresAt) : null,
    commentCount: 0,
    viewCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const [saved] = await knex('community_posts').insert(doc).returning('*');
  return returnFunction(res, 201, true, 'Post created', saved);
};

const updatePost = async (req, res) => {
  const { content, imageUrls } = req.body;
  await knex('community_posts').where({ id: req.params.id }).update({
    content, imageUrls: JSON.stringify(imageUrls || []), updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Post updated', null);
};

const deletePost = async (req, res) => {
  await knex('community_post_reactions').where({ postId: req.params.id }).delete();
  await knex('post_comments').where({ postId: req.params.id }).delete();
  await knex('community_posts').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, 'Post deleted', null);
};

const reactToPost = async (req, res) => {
  const { type } = req.body;
  const userId = req.user.id;
  const postId = req.params.id;

  const post = await knex('community_posts').where({ id: postId }).first();
  if (!post) return returnFunction(res, 404, false, 'Post not found', null);

  const existing = await knex('community_post_reactions').where({ postId, userId, type }).first();
  if (existing) {
    await knex('community_post_reactions').where({ postId, userId, type }).delete();
  } else {
    await knex('community_post_reactions').insert({ postId, userId, type, reactedAt: new Date() });
  }
  return returnFunction(res, 200, true, 'Reaction updated', null);
};

const getComments = async (req, res) => {
  const postId = req.params.id;
  const top = await knex('post_comments').where({ postId }).whereNull('parentCommentId').orderBy('createdAt', 'asc');

  // authorId is a USER id (see file header) — resolve display name via the same
  // two-hop users→employees lookup enrichPost already uses correctly. Previously
  // this looked authorId up directly against `employees`, which never matched
  // (authorId is never an employee id), so a comment's author name never displayed.
  const resolveAuthor = async (authorId) => {
    const userRecord = await knex('users').where({ id: authorId }).select('employeeId', 'name').first();
    if (userRecord?.employeeId) {
      const emp = await knex('employees').where({ id: userRecord.employeeId }).select('fullName').first();
      if (emp) return emp;
    }
    return userRecord ? { fullName: userRecord.name } : null;
  };

  const enriched = await Promise.all(
    top.map(async (c) => {
      const author = await resolveAuthor(c.authorId);
      const replies = await knex('post_comments').where({ parentCommentId: c.id }).orderBy('createdAt', 'asc');
      const enrichedReplies = await Promise.all(
        replies.map(async (r) => ({ ...r, author: await resolveAuthor(r.authorId) }))
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
    id: newId(),
    postId: req.params.id,
    authorId: req.user.id,
    content,
    parentCommentId: parentCommentId || null,
    createdAt: new Date(),
  };

  const [saved] = await knex('post_comments').insert(doc).returning('*');
  await knex('community_posts').where({ id: req.params.id }).increment('commentCount', 1);

  const author = req.user.employeeId ? await knex('employees').where({ id: String(req.user.employeeId) }).select('fullName').first() : null;

  // Notify the post author (skip if they commented on their own post)
  const post = await knex('community_posts').where({ id: req.params.id }).first();
  if (post && String(post.authorId) !== String(req.user.id)) {
    notifyUser(post.authorId, {
      title: '💬 New comment on your post',
      body: `${author?.fullName || 'Someone'} commented: "${content.substring(0, 100)}${content.length > 100 ? '…' : ''}"`,
      type: 'general',
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, 'Comment added', { ...saved, author });
};

// ── COMMUNITIES ────────────────────────────────────────────────────────────────

const listCommunities = async (req, res) => {
  const { companyId } = req.user;
  const myPersonIds = [String(req.user.id)];
  if (req.user.employeeId) myPersonIds.push(String(req.user.employeeId));

  const all = await knex('communities').where({ companyId: companyId ?? null }).whereNot({ isArchived: true });
  const enriched = await Promise.all(all.map(async (c) => {
    const [{ count: memberCount }] = await knex('community_members').where({ communityId: c.id }).count('* as count');
    const isMember = await knex('community_members').where({ communityId: c.id }).whereIn('personId', myPersonIds).first();
    return { ...c, memberCount: Number(memberCount), isMember: !!isMember };
  }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createCommunity = async (req, res) => {
  const { name, description, icon, type = 'interest', autoAddType = 'none' } = req.body;
  if (!name?.trim()) return returnFunction(res, 400, false, 'Name is required', null);

  const creatorId = req.user.id;

  const doc = {
    id: newId(),
    companyId: req.user.companyId ?? null,
    name: name.trim(),
    description: description || '',
    icon: icon || '👥',
    type,
    adminIds: JSON.stringify([creatorId]),
    isArchived: false,
    createdBy: creatorId,
    createdAt: new Date(),
  };

  const [saved] = await knex('communities').insert(doc).returning('*');

  let memberIds = [creatorId];
  if (autoAddType === 'all') {
    const all = await knex('employees').where({ status: 'active' }).select('id');
    memberIds = all.map((e) => e.id);
  }
  await knex('community_members').insert(memberIds.map((personId) => ({ communityId: saved.id, personId: String(personId), addedAt: new Date() })));

  return returnFunction(res, 201, true, 'Community created', saved);
};

const getCommunity = async (req, res) => {
  const c = await knex('communities').where({ id: req.params.id }).first();
  if (!c) return returnFunction(res, 404, false, 'Community not found', null);
  const [{ count: memberCount }] = await knex('community_members').where({ communityId: c.id }).count('* as count');
  const isMember = await knex('community_members').where({ communityId: c.id, personId: String(req.user.id) }).first();
  return returnFunction(res, 200, true, req.locale.success, { ...c, memberCount: Number(memberCount), isMember: !!isMember });
};

const joinCommunity = async (req, res) => {
  await knex('community_members').insert({ communityId: req.params.id, personId: String(req.user.id), addedAt: new Date() })
    .onConflict(['communityId', 'personId']).ignore();
  return returnFunction(res, 200, true, 'Joined community', null);
};

const leaveCommunity = async (req, res) => {
  await knex('community_members').where({ communityId: req.params.id, personId: String(req.user.id) }).delete();
  return returnFunction(res, 200, true, 'Left community', null);
};

const getCommunityFeed = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const posts = await knex('community_posts').where({ communityId: req.params.id }).orderBy('createdAt', 'desc').limit(Number(limit)).offset(skip);
  const enriched = await Promise.all(posts.map(enrichPost));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── CELEBRATIONS ───────────────────────────────────────────────────────────────

const getUpcomingCelebrations = async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in30 = new Date(today);
  in30.setDate(today.getDate() + 30);

  const employees = await knex('employees').where({ status: 'active' }).select('id', 'fullName', 'dateOfBirth', 'dateOfHire', 'designation');

  const celebrations = [];
  const thisYear = today.getFullYear();

  for (const emp of employees) {
    // Birthday
    if (emp.dateOfBirth) {
      const dob = new Date(emp.dateOfBirth);
      const bday = new Date(thisYear, dob.getMonth(), dob.getDate());
      if (bday >= today && bday <= in30) {
        celebrations.push({
          type: 'birthday', employee: { id: emp.id, fullName: emp.fullName, designation: emp.designation },
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
          type: 'anniversary', employee: { id: emp.id, fullName: emp.fullName },
          date: ann.toISOString().split('T')[0],
          years, daysUntil: Math.round((ann - today) / 86400000),
        });
      }
    }
  }

  // New joiners last 14 days
  const cutoff = new Date(today);
  cutoff.setDate(today.getDate() - 14);
  const newJoiners = employees.filter((emp) => emp.dateOfHire && new Date(emp.dateOfHire) >= cutoff);
  for (const emp of newJoiners) {
    celebrations.push({
      type: 'new_joiner', employee: { id: emp.id, fullName: emp.fullName },
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
    knex('employees').where({ id: recipientId }).select('fullName').first(),
    req.user.employeeId ? knex('employees').where({ id: String(req.user.employeeId) }).select('fullName').first() : null,
  ]);

  const senderName = senderEmployee?.fullName || req.user.name || 'A colleague';

  const doc = {
    id: newId(),
    companyId: req.user.companyId ?? null,
    communityId: null,
    authorId: req.user.id,
    authorName: senderName,
    type: 'celebration',
    content: message,
    celebrationType: 'clap',
    celebrationEmployeeId: recipientId,
    celebrationEmployeeName: recipient?.fullName || '',
    imageUrls: JSON.stringify([]),
    isPinned: false,
    visibility,
    commentCount: 0,
    viewCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const [saved] = await knex('community_posts').insert(doc).returning('*');

  // Notify the recipient
  const recipientUser = await knex('users').where({ employeeId: recipientId }).select('id').first();
  if (recipientUser) {
    notifyUser(recipientUser.id, { title: `👏 ${senderName} gave you a clap!`, body: message, type: 'general' }).catch(() => {});
  }

  // Notify all HR managers and super admins
  await notifyByRoles(['super_admin', 'hr_manager'], {
    title: `👏 ${senderName} clapped for ${recipient?.fullName || 'a team member'}`,
    body: message,
    type: 'general',
  });

  return returnFunction(res, 201, true, 'Clap sent!', { id: saved.id });
};

// ── 1:1 MEETINGS ───────────────────────────────────────────────────────────────
// Fixed forward this phase (see migration file header): both participants are now
// consistently resolved to EMPLOYEE ids. Previously participant1Id was written as
// a USER id (req.user._id) while participant2Id was an EMPLOYEE id (withEmployeeId),
// and listMeetingSeries queried both columns against a user id — meaning the
// invited participant (stored by employee id) could never find their own series.

const listMeetingSeries = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, req.locale.success, []);
  const myEmployeeId = String(req.user.employeeId);
  const { companyId } = req.user;

  const series = await knex('communication_one_on_ones').where({ companyId: companyId ?? null, isActive: true })
    .where((qb) => qb.where({ participant1Id: myEmployeeId }).orWhere({ participant2Id: myEmployeeId }))
    .orderBy('createdAt', 'desc');

  const enriched = await Promise.all(
    series.map(async (s) => {
      const otherId = s.participant1Id === myEmployeeId ? s.participant2Id : s.participant1Id;
      const other = await knex('employees').where({ id: otherId }).select('fullName', 'designation').first();
      const lastNote = await knex('meeting_notes').where({ seriesId: s.id }).orderBy('date', 'desc').first();
      return { ...s, otherParticipant: other, lastMeeting: lastNote || null };
    })
  );

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const createMeetingSeries = async (req, res) => {
  const { withEmployeeId, frequency = 'weekly', dayOfWeek, time, duration = 30, videoLink } = req.body;
  if (!withEmployeeId) return returnFunction(res, 400, false, 'Participant required', null);
  if (!req.user.employeeId) return returnFunction(res, 400, false, 'Your account is not linked to an employee profile.');

  const doc = {
    id: newId(),
    companyId: req.user.companyId ?? null,
    participant1Id: String(req.user.employeeId),
    participant2Id: String(withEmployeeId),
    frequency, dayOfWeek, time,
    duration: Number(duration),
    videoLink: videoLink || '',
    isActive: true,
    createdAt: new Date(),
  };

  const [saved] = await knex('communication_one_on_ones').insert(doc).returning('*');

  // Notify the other participant
  const otherUser = await knex('users').where({ employeeId: String(withEmployeeId) }).select('id').first();
  if (otherUser) {
    const myEmp = await knex('employees').where({ id: String(req.user.employeeId) }).select('fullName').first();
    notifyUser(otherUser.id, {
      title: '📅 1:1 Meeting Scheduled',
      body: `${myEmp?.fullName || 'Someone'} has scheduled a ${frequency} 1:1 meeting with you${time ? ` at ${time}` : ''}.`,
      type: 'general',
    }).catch(() => {});
  }

  return returnFunction(res, 201, true, '1:1 series created', saved);
};

const getMeetingNotes = async (req, res) => {
  const notes = await knex('meeting_notes').where({ seriesId: req.params.id }).orderBy('date', 'desc');
  return returnFunction(res, 200, true, req.locale.success, notes);
};

const createMeetingNote = async (req, res) => {
  const { date, agendaItems = [], notes = '', actionItems = [] } = req.body;
  const doc = {
    id: newId(),
    seriesId: req.params.id,
    companyId: req.user.companyId ?? null,
    date: date ? new Date(date) : new Date(),
    agendaItems: JSON.stringify(agendaItems), notes, actionItems: JSON.stringify(actionItems),
    aiSummary: '',
    status: 'scheduled',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('meeting_notes').insert(doc).returning('*');
  return returnFunction(res, 201, true, 'Meeting notes created', saved);
};

const updateMeetingNote = async (req, res) => {
  const { agendaItems, notes, actionItems, status } = req.body;
  const update = { updatedAt: new Date() };
  if (agendaItems !== undefined) update.agendaItems = JSON.stringify(agendaItems);
  if (notes !== undefined) update.notes = notes;
  if (actionItems !== undefined) update.actionItems = JSON.stringify(actionItems);
  if (status !== undefined) update.status = status;

  await knex('meeting_notes').where({ id: req.params.noteId }).update(update);
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
    id: newId(),
    trackingCode,
    category,
    description,
    attachmentUrl: req.body.attachmentUrl || null,
    status: 'new',
    adminNotes: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await knex('trust_reports').insert(doc);

  {
    const hrUsers = await knex('users').whereIn('role', ['super_admin', 'hr_manager']).whereNot({ isActive: false }).select('email');
    const tokens = { category, trackingCode };
    hrUsers.filter((u) => u.email).forEach((u) => sendTemplatedEmail({
      trigger: 'trustReportSubmitted', to: u.email, tokens,
      fallbackSubject: '🔒 New anonymous trust report',
      fallbackHtml: `<p>Category: ${category}. Use tracking code ${trackingCode} to reference it.</p>`,
    }).catch(() => {}));
  }

  notifyByRoles(['super_admin', 'hr_manager'], {
    type: 'general',
    title: '🔒 New anonymous trust report',
    body: `Category: ${category}. Use tracking code ${trackingCode} to reference it.`,
    link: '/communications',
  }).catch(() => {});

  return returnFunction(res, 201, true, 'Report submitted anonymously', { trackingCode });
};

const checkTrustStatus = async (req, res) => {
  const report = await knex('trust_reports').where({ trackingCode: req.params.trackingCode }).first();
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
  const all = await knex('trust_reports').orderBy('createdAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, all);
};

const adminUpdateTrustReport = async (req, res) => {
  const { status, adminNotes, responseToReporter } = req.body;
  await knex('trust_reports').where({ id: req.params.id }).update({
    status, adminNotes, responseToReporter: responseToReporter || null, updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Report updated', null);
};

module.exports = {
  getFeed, createPost, updatePost, deletePost, reactToPost, getComments, addComment,
  listCommunities, createCommunity, getCommunity, joinCommunity, leaveCommunity, getCommunityFeed,
  getUpcomingCelebrations, sendClap,
  listMeetingSeries, createMeetingSeries, getMeetingNotes, createMeetingNote, updateMeetingNote,
  submitTrustReport, checkTrustStatus, adminListTrustReports, adminUpdateTrustReport,
};
