// Postgres migration (Phase 9) — award_types/employee_awards/company_values/
// kudos (+ kudos_reactions/kudos_comments)/award_programs/award_nominations/
// recognition_settings are Postgres now. employees/users have been Postgres
// since Phase 1. The Mongo `awards` collection (indexed in initIndexes.js but
// never read/written by any route) is dead and was not migrated — see the
// Phase 9 migration file header.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { notifyEmployee, notifyByRoles } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

const emailAwardGranted = async (employeeId, awardName, notes) => {
  const [empUser, emp] = await Promise.all([
    knex('users').where({ employeeId: String(employeeId) }).select('email').first(),
    knex('employees').where({ id: String(employeeId) }).select('fullName').first(),
  ]);
  if (!empUser?.email) return;
  const tokens = { employeeName: emp?.fullName || 'there', awardName, notes: notes || '' };
  return sendTemplatedEmail({
    trigger: 'awardGranted', to: empUser.email, tokens,
    fallbackSubject: `Congratulations — you received "${awardName}"!`,
    fallbackHtml: `<p>Dear ${tokens.employeeName},</p><p>Congratulations! You've been awarded "${awardName}"${notes ? ': ' + notes : '.'}</p>`,
  }).catch(() => {});
};

// A requester's own id in the id-space this module has always used
// polymorphically for the "who did this" fields (giverId/personId/authorId) —
// employee id when linked, otherwise their user id. See migration file header.
const actingPersonId = (req) => (req.user.employeeId ? String(req.user.employeeId) : req.user.id);

// ── Award Types (templates) ───────────────────────────────────────────────────

const listAwardTypes = async (req, res) => {
  const types = await knex('award_types').orderBy('name', 'asc');
  return returnFunction(res, 200, true, 'OK', types);
};

const createAwardType = async (req, res) => {
  const { name, description, category, repeatInterval, nextDueDate } = req.body;
  if (!name) return returnFunction(res, 400, false, 'Award name is required.');
  const existing = await knex('award_types').whereRaw('lower(name) = lower(?)', [name]).first();
  if (existing) return returnFunction(res, 409, false, 'An award type with this name already exists.');
  const [saved] = await knex('award_types').insert({
    id: newId(), name, description: description || '', category: category || 'general',
    repeatInterval: repeatInterval || 'none',
    nextDueDate: nextDueDate ? new Date(nextDueDate) : null,
    createdAt: new Date(),
  }).returning('*');
  return returnFunction(res, 201, true, 'Award type created.', { id: saved.id });
};

const updateAwardType = async (req, res) => {
  const { name, description, category, repeatInterval, nextDueDate } = req.body;
  await knex('award_types').where({ id: req.params.id }).update({
    name, description, category, repeatInterval: repeatInterval || 'none',
    nextDueDate: nextDueDate ? new Date(nextDueDate) : null, updatedAt: new Date(),
  });
  return returnFunction(res, 200, true, 'Award type updated.');
};

const deleteAwardType = async (req, res) => {
  await knex('award_types').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, 'Award type deleted.');
};

// ── Employee Awards ───────────────────────────────────────────────────────────

const listEmployeeAwards = async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const skip  = (page - 1) * limit;

  let query = knex('employee_awards');
  if (req.query.awardTypeId) query = query.where({ awardTypeId: req.query.awardTypeId });
  if (req.query.year)        query = query.where({ year: parseInt(req.query.year) });
  if (req.query.search)      query = query.whereILike('employeeName', `%${req.query.search}%`);

  const [{ count: total }] = await query.clone().count('* as count');
  const awards = await query.clone().orderBy('awardedAt', 'desc').limit(limit).offset(skip);

  return returnFunction(res, 200, true, 'OK', { data: awards, total: Number(total), page, limit });
};

// Single award
const grantAward = async (req, res) => {
  const { employeeId, awardTypeId, notes, year } = req.body;
  if (!employeeId || !awardTypeId) return returnFunction(res, 400, false, 'employeeId and awardTypeId are required.');

  const [emp, awardType] = await Promise.all([
    knex('employees').where({ id: employeeId }).first(),
    knex('award_types').where({ id: awardTypeId }).first(),
  ]);
  if (!emp)       return returnFunction(res, 404, false, 'Employee not found.');
  if (!awardType) return returnFunction(res, 404, false, 'Award type not found.');

  const [saved] = await knex('employee_awards').insert({
    id: newId(),
    employeeId, employeeName: emp.fullName, staffNumber: emp.staffNumber || null, department: emp.department || null,
    awardTypeId, awardTypeName: awardType.name,
    notes: notes || '', year: year || new Date().getFullYear(),
    awardedBy: req.user?.name || 'HR', awardedAt: new Date(),
  }).returning('*');

  notifyEmployee(employeeId, {
    title: 'You received an award!',
    body: `Congratulations! You've been awarded "${awardType.name}"${notes ? ': ' + notes : '.'}`,
    type: 'general',
  }).catch(() => {});
  emailAwardGranted(employeeId, awardType.name, notes);
  return returnFunction(res, 201, true, 'Award granted.', { id: saved.id });
};

// Bulk award — grant the same award to multiple employees at once
const bulkGrantAward = async (req, res) => {
  const { employeeIds, awardTypeId, notes, year } = req.body;
  if (!Array.isArray(employeeIds) || !employeeIds.length) return returnFunction(res, 400, false, 'employeeIds array is required.');
  if (!awardTypeId) return returnFunction(res, 400, false, 'awardTypeId is required.');

  const awardType = await knex('award_types').where({ id: awardTypeId }).first();
  if (!awardType) return returnFunction(res, 404, false, 'Award type not found.');

  const employees = await knex('employees').whereIn('id', employeeIds).select('id', 'fullName', 'staffNumber', 'department');
  if (!employees.length) return returnFunction(res, 404, false, 'No valid employees found.');

  const awardYear = year || new Date().getFullYear();
  const docs = employees.map((emp) => ({
    id: newId(),
    employeeId: emp.id, employeeName: emp.fullName, staffNumber: emp.staffNumber || null, department: emp.department || null,
    awardTypeId, awardTypeName: awardType.name,
    notes: notes || '', year: awardYear,
    awardedBy: req.user?.name || 'HR', awardedAt: new Date(),
  }));

  await knex('employee_awards').insert(docs);
  await Promise.all(employees.map((emp) =>
    notifyEmployee(emp.id, {
      title: 'You received an award!',
      body: `Congratulations! You've been awarded "${awardType.name}"${notes ? ': ' + notes : '.'}`,
      type: 'general',
    }).catch(() => {})
  ));
  employees.forEach((emp) => emailAwardGranted(emp.id, awardType.name, notes));
  return returnFunction(res, 201, true, `Award granted to ${docs.length} employee(s).`, { count: docs.length });
};

const revokeAward = async (req, res) => {
  await knex('employee_awards').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, 'Award revoked.');
};

// Employee search helper used by the bulk award UI
const searchEmployeesForAward = async (req, res) => {
  const q    = req.query.q || '';
  const dept = req.query.department || '';
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  const skip  = (page - 1) * limit;

  let query = knex('employees').whereIn('status', ['active', 'on_leave']);
  if (q) query = query.where((qb) => qb.whereILike('fullName', `%${q}%`).orWhereILike('staffNumber', `%${q}%`));
  if (dept) query = query.where({ department: dept });

  const [{ count: total }] = await query.clone().count('* as count');
  const employees = await query.clone().select('id', 'fullName', 'staffNumber', 'department', 'designation').orderBy('fullName').limit(limit).offset(skip);

  return returnFunction(res, 200, true, 'OK', { data: employees, total: Number(total), page, limit });
};

// Awards by type + by department + top employees for chart/insight cards
const getAwardStats = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const all  = await knex('employee_awards').where({ year });

  const byType = {};
  const byDept = {};
  const byEmp  = {};

  for (const a of all) {
    byType[a.awardTypeName] = (byType[a.awardTypeName] || 0) + 1;
    if (a.department) byDept[a.department] = (byDept[a.department] || 0) + 1;
    const ek = String(a.employeeId);
    if (!byEmp[ek]) byEmp[ek] = { employeeName: a.employeeName, staffNumber: a.staffNumber, department: a.department, count: 0 };
    byEmp[ek].count++;
  }

  const topEmployees = Object.values(byEmp).sort((a, b) => b.count - a.count).slice(0, 5);

  return returnFunction(res, 200, true, 'OK', {
    year, total: all.length,
    byType: Object.entries(byType).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    byDepartment: Object.entries(byDept).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    topEmployees,
  });
};

// Award types that are scheduled (repeatInterval !== 'none') and due within 60 days
const getUpcomingAwards = async (req, res) => {
  const types = await knex('award_types').whereNotIn('repeatInterval', ['none']).whereNotNull('nextDueDate');
  const now   = new Date();
  const horizon = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  const upcoming = types
    .map((t) => ({ ...t, daysUntilDue: Math.ceil((new Date(t.nextDueDate) - now) / (1000 * 60 * 60 * 24)) }))
    .filter((t) => new Date(t.nextDueDate) <= horizon)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);

  return returnFunction(res, 200, true, 'OK', upcoming);
};

// After granting a scheduled award, advance the nextDueDate by one interval
const advanceAwardSchedule = async (req, res) => {
  const type = await knex('award_types').where({ id: req.params.id }).first();
  if (!type) return returnFunction(res, 404, false, 'Award type not found.');

  const base = type.nextDueDate ? new Date(type.nextDueDate) : new Date();
  const next = new Date(base);
  if (type.repeatInterval === 'monthly')   next.setMonth(next.getMonth() + 1);
  else if (type.repeatInterval === 'quarterly') next.setMonth(next.getMonth() + 3);
  else if (type.repeatInterval === 'annually')  next.setFullYear(next.getFullYear() + 1);

  await knex('award_types').where({ id: req.params.id }).update({ nextDueDate: next, updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Schedule advanced.', { nextDueDate: next });
};

// ── COMPANY VALUES ─────────────────────────────────────────────────────────────

const listValues = async (req, res) => {
  const values = await knex('company_values').where({ companyId: req.user.companyId ?? null }).whereNot({ isActive: false }).orderBy('order', 'asc');
  return returnFunction(res, 200, true, 'OK', values);
};

const createValue = async (req, res) => {
  const { name, description, emoji, color } = req.body;
  if (!name?.trim()) return returnFunction(res, 400, false, 'Value name is required.');
  const [{ count }] = await knex('company_values').where({ companyId: req.user.companyId ?? null }).count('* as count');
  const [saved] = await knex('company_values').insert({
    id: newId(), companyId: req.user.companyId ?? null,
    name: name.trim(), description: description || '',
    emoji: emoji || '⭐', color: color || '#6366f1',
    order: Number(count), isActive: true, createdAt: new Date(),
  }).returning('*');
  return returnFunction(res, 201, true, 'Value created', saved);
};

const updateValue = async (req, res) => {
  const { name, description, emoji, color } = req.body;
  await knex('company_values').where({ id: req.params.id }).update({ name, description, emoji, color, updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Value updated', null);
};

const deleteValue = async (req, res) => {
  await knex('company_values').where({ id: req.params.id }).update({ isActive: false });
  return returnFunction(res, 200, true, 'Value removed', null);
};

const reorderValues = async (req, res) => {
  const { order } = req.body; // array of { _id, order }
  await Promise.all(
    (order || []).map(({ _id, order: ord }) => knex('company_values').where({ id: _id }).update({ order: ord }))
  );
  return returnFunction(res, 200, true, 'Order updated', null);
};

// ── KUDOS ──────────────────────────────────────────────────────────────────────

const listKudos = async (req, res) => {
  const { page = 1, limit = 20, recipientId } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  let query = knex('kudos').where({ companyId: req.user.companyId ?? null });
  if (recipientId) query = query.whereRaw('"recipientIds" @> ?', [JSON.stringify([String(recipientId)])]);

  const kudos = await query.orderBy('createdAt', 'desc').limit(Number(limit)).offset(skip);

  const enriched = await Promise.all(
    kudos.map(async (k) => {
      let granterName = k.giverName ?? '';
      if (!granterName) {
        const giver = await knex('employees').where({ id: k.giverId }).select('fullName').first();
        if (giver) {
          granterName = giver.fullName;
        } else {
          const giverUser = await knex('users').where({ id: k.giverId }).select('name', 'email').first();
          granterName = giverUser?.name ?? giverUser?.email ?? '';
        }
      }
      const recipients = await Promise.all(
        (k.recipientIds || []).map((id) => knex('employees').where({ id }).select('fullName').first())
      );
      const reactions = await knex('kudos_reactions').where({ kudosId: k.id });
      const comments = await knex('kudos_comments').where({ kudosId: k.id }).orderBy('createdAt', 'asc');
      const enrichedComments = comments.map((c) => ({
        id: c.id, content: c.content, authorName: c.authorName || 'Unknown', createdAt: c.createdAt,
      }));
      return { ...k, granterName, recipients: recipients.filter(Boolean), reactions, comments: enrichedComments };
    })
  );

  return returnFunction(res, 200, true, 'OK', enriched);
};

const createKudos = async (req, res) => {
  const { recipientIds, valueId, message, gifUrl, visibility = 'public', pointsAwarded = 0 } = req.body;
  if (!recipientIds?.length || !message?.trim()) {
    return returnFunction(res, 400, false, 'Recipient and message are required.');
  }

  // Enforce recognition settings
  const settings = await knex('recognition_settings').first();
  if (settings) {
    if (!settings.allowSelfRecognition) {
      const giverId = actingPersonId(req);
      const selfIncluded = recipientIds.some((id) => String(id) === giverId);
      if (selfIncluded) return returnFunction(res, 400, false, 'You cannot send kudos to yourself.');
    }
    const minLen = settings.minMessageLength ?? 0;
    if (minLen > 0 && message.trim().length < minLen) {
      return returnFunction(res, 400, false, `Message must be at least ${minLen} characters.`);
    }
    if (settings.maxKudosPerDay) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const [{ count: sentToday }] = await knex('kudos').where({ giverId: actingPersonId(req) }).where('createdAt', '>=', todayStart).count('* as count');
      if (Number(sentToday) >= settings.maxKudosPerDay) {
        return returnFunction(res, 429, false, `Daily kudos limit of ${settings.maxKudosPerDay} reached.`);
      }
    }
  }

  let valueName = '', valueColor = '#6366f1';
  if (valueId) {
    const val = await knex('company_values').where({ id: valueId }).first();
    if (val) { valueName = val.name; valueColor = val.color; }
  }

  let giverName = req.user.fullName ?? '';
  if (!giverName && req.user.employeeId) {
    const giverEmp = await knex('employees').where({ id: String(req.user.employeeId) }).select('fullName').first();
    giverName = giverEmp?.fullName ?? '';
  }

  const doc = {
    id: newId(),
    companyId: req.user.companyId ?? null,
    giverId: actingPersonId(req),
    giverName,
    recipientIds: JSON.stringify(recipientIds.map(String)),
    valueId: valueId || null,
    valueName, valueColor,
    message, gifUrl: gifUrl || null,
    visibility,
    pointsAwarded: Number(pointsAwarded),
    createdAt: new Date(),
  };

  const [saved] = await knex('kudos').insert(doc).returning('*');
  await Promise.all(recipientIds.map((id) =>
    notifyEmployee(id, { title: `You received kudos from ${giverName}!`, body: message, type: 'general' }).catch(() => {})
  ));
  return returnFunction(res, 201, true, 'Kudos sent! 🏅', { id: saved.id });
};

const deleteKudos = async (req, res) => {
  await knex('kudos_reactions').where({ kudosId: req.params.id }).delete();
  await knex('kudos_comments').where({ kudosId: req.params.id }).delete();
  await knex('kudos').where({ id: req.params.id }).delete();
  return returnFunction(res, 200, true, 'Kudos removed', null);
};

const reactToKudos = async (req, res) => {
  const { type } = req.body;
  const personId = actingPersonId(req);
  const kudosId = req.params.id;
  const k = await knex('kudos').where({ id: kudosId }).first();
  if (!k) return returnFunction(res, 404, false, 'Not found', null);

  const existing = await knex('kudos_reactions').where({ kudosId, personId, type }).first();
  if (existing) {
    await knex('kudos_reactions').where({ kudosId, personId, type }).delete();
  } else {
    await knex('kudos_reactions').insert({ kudosId, personId, type, reactedAt: new Date() });
  }
  return returnFunction(res, 200, true, 'Reaction updated', null);
};

const addKudosComment = async (req, res) => {
  const commentText = (req.body.content || req.body.text || '').trim();
  if (!commentText) return returnFunction(res, 400, false, 'Comment text required', null);
  const personId = actingPersonId(req);
  const author = req.user.employeeId ? await knex('employees').where({ id: String(req.user.employeeId) }).select('fullName').first() : null;

  const comment = {
    id: newId(),
    kudosId: req.params.id,
    authorId: personId,
    authorName: author?.fullName ?? 'Unknown',
    content: commentText,
    createdAt: new Date(),
  };
  const [saved] = await knex('kudos_comments').insert(comment).returning('*');
  return returnFunction(res, 201, true, 'Comment added', saved);
};

// ── LEADERBOARD ────────────────────────────────────────────────────────────────
// kudos.recipientIds is a whole-replaced JSONB array (never per-row mutated —
// see migration file header), so the Mongo $unwind/$group here becomes a
// jsonb_array_elements_text unnest + GROUP BY.

const getLeaderboard = async (req, res) => {
  const { period = 'month', department, limit: lim = 20 } = req.query;
  const now = new Date();
  let startDate;
  if (period === 'month')   startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  else if (period === 'quarter') startDate = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  else startDate = new Date(now.getFullYear(), 0, 1);

  const rows = await knex('kudos')
    .where({ companyId: req.user.companyId ?? null }).where('createdAt', '>=', startDate)
    .crossJoin(knex.raw('jsonb_array_elements_text("recipientIds") as "recipientId"'))
    .select('recipientId')
    .count('* as kudosReceived')
    .sum('pointsAwarded as pointsEarned')
    .groupBy('recipientId')
    .orderBy('kudosReceived', 'desc')
    .limit(Number(lim));

  const enriched = await Promise.all(
    rows.map(async (r, i) => {
      const emp = await knex('employees').where({ id: r.recipientId }).select('fullName', 'department', 'designation').first();
      return {
        rank: i + 1,
        employeeId: r.recipientId,
        employeeName: emp?.fullName ?? '',
        designation: emp?.designation ?? '',
        department: emp?.department ?? '',
        kudosReceived: Number(r.kudosReceived),
        pointsEarned: Number(r.pointsEarned) || 0,
      };
    })
  );

  const filtered = department ? enriched.filter((r) => r.department === department) : enriched;
  return returnFunction(res, 200, true, 'OK', filtered);
};

const getMyRank = async (req, res) => {
  const empId = actingPersonId(req);
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), 1);

  const rows = await knex('kudos')
    .where({ companyId: req.user.companyId ?? null }).where('createdAt', '>=', startDate)
    .crossJoin(knex.raw('jsonb_array_elements_text("recipientIds") as "recipientId"'))
    .select('recipientId')
    .count('* as count')
    .groupBy('recipientId')
    .orderBy('count', 'desc');

  const idx = rows.findIndex((r) => String(r.recipientId) === String(empId));
  return returnFunction(res, 200, true, 'OK', {
    rank: idx >= 0 ? idx + 1 : null,
    kudosReceived: idx >= 0 ? Number(rows[idx].count) : 0,
    total: rows.length,
  });
};

// ── AWARD PROGRAMS ─────────────────────────────────────────────────────────────

const listPrograms = async (req, res) => {
  const programs = await knex('award_programs').where({ companyId: req.user.companyId ?? null }).orderBy('createdAt', 'desc');

  const enriched = await Promise.all(programs.map(async (p) => {
    const [{ count: nomineeCount }] = await knex('award_nominations').where({ programId: p.id, cycleStart: p.currentCycleStart }).count('* as count');
    return { ...p, nomineeCount: Number(nomineeCount) };
  }));
  return returnFunction(res, 200, true, 'OK', enriched);
};

const createProgram = async (req, res) => {
  const { name, description, icon, frequency, nominationBy, selectionMethod, prizeType, prizeDescription, announcementMethod, cycleStart, cycleEnd } = req.body;
  if (!name?.trim()) return returnFunction(res, 400, false, 'Program name required', null);

  const [saved] = await knex('award_programs').insert({
    id: newId(), companyId: req.user.companyId ?? null,
    name: name.trim(), description: description || '',
    icon: icon || '🏆', frequency: frequency || 'monthly',
    status: 'active',
    nominationBy: nominationBy || 'anyone',
    selectionMethod: selectionMethod || 'manual',
    prizeType: prizeType || 'certificate',
    prizeDescription: prizeDescription || '',
    announcementMethod: announcementMethod || 'both',
    currentCycleStart: cycleStart ? new Date(cycleStart) : new Date(),
    currentCycleEnd: cycleEnd ? new Date(cycleEnd) : null,
    createdBy: req.user.id,
    createdAt: new Date(),
  }).returning('*');

  return returnFunction(res, 201, true, 'Program created', saved);
};

const getProgram = async (req, res) => {
  const p = await knex('award_programs').where({ id: req.params.id }).first();
  if (!p) return returnFunction(res, 404, false, 'Program not found', null);
  return returnFunction(res, 200, true, 'OK', p);
};

const updateProgram = async (req, res) => {
  const { name, description, status, cycleStart, cycleEnd } = req.body;
  const update = { updatedAt: new Date() };
  if (name) update.name = name;
  if (description !== undefined) update.description = description;
  if (status) update.status = status;
  if (cycleStart) update.currentCycleStart = new Date(cycleStart);
  if (cycleEnd) update.currentCycleEnd = new Date(cycleEnd);

  await knex('award_programs').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, 'Program updated', null);
};

const nominateForProgram = async (req, res) => {
  const { nomineeId, reason, valueId } = req.body;
  if (!nomineeId || !reason?.trim()) return returnFunction(res, 400, false, 'Nominee and reason required', null);

  const program = await knex('award_programs').where({ id: req.params.id }).first();
  if (!program) return returnFunction(res, 404, false, 'Program not found', null);

  const [saved] = await knex('award_nominations').insert({
    id: newId(), companyId: req.user.companyId ?? null,
    programId: req.params.id, nomineeId, nominatorId: req.user.id,
    reason, valueId: valueId || null, cycleStart: program.currentCycleStart,
    isWinner: false, createdAt: new Date(),
  }).returning('*');

  const nominee = await knex('employees').where({ id: nomineeId }).select('fullName').first();
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Award Nomination Submitted',
    body: `${nominee?.fullName || 'An employee'} was nominated for "${program.name}".`,
    type: 'general',
  }).catch(() => {});

  return returnFunction(res, 201, true, 'Nomination submitted', { id: saved.id });
};

const listNominations = async (req, res) => {
  const noms = await knex('award_nominations').where({ programId: req.params.id }).orderBy('createdAt', 'desc');

  const enriched = await Promise.all(noms.map(async (n) => {
    const nominee   = await knex('employees').where({ id: n.nomineeId }).select('fullName', 'department', 'designation').first();
    const nominator = await knex('employees').where({ id: n.nominatorId }).select('fullName').first();
    return { ...n, nominee, nominator };
  }));

  return returnFunction(res, 200, true, 'OK', enriched);
};

const selectWinner = async (req, res) => {
  const { winnerId } = req.body;
  if (!winnerId) return returnFunction(res, 400, false, 'Winner ID required', null);

  const winner = await knex('employees').where({ id: winnerId }).select('fullName', 'department').first();

  await knex('award_nominations').where({ programId: req.params.id }).update({ isWinner: false });
  await knex('award_nominations').where({ programId: req.params.id, nomineeId: winnerId }).update({ isWinner: true, announcedAt: new Date() });

  const program = await knex('award_programs').where({ id: req.params.id }).first();

  // Create a feed post announcing the winner
  if (program) {
    await knex('community_posts').insert({
      id: newId(), companyId: req.user.companyId ?? null,
      communityId: null, authorId: req.user.id, type: 'announcement',
      content: `🏆 **${program.name} Winner: ${winner?.fullName}!**\n\nCongratulations ${winner?.fullName} from ${winner?.department || 'our team'}! ${program.description || ''}`,
      imageUrls: JSON.stringify([]),
      isPinned: true,
      commentCount: 0, viewCount: 0,
      createdAt: new Date(), updatedAt: new Date(),
    });
  }

  notifyEmployee(winnerId, {
    title: 'Congratulations — you won an award!',
    body: `You were selected as the winner of "${program?.name || 'this award'}".`,
    type: 'general',
  }).catch(() => {});
  emailAwardGranted(winnerId, program?.name || 'this award', 'You were selected as the winner.');

  return returnFunction(res, 200, true, 'Winner announced!', { winner });
};

// ── RECOGNITION SETTINGS ───────────────────────────────────────────────────────
// Singleton-per-company row (companyId is always null in real data — see
// migration file header) — matches the one-row-table pattern established since
// Phase 0/1's company_settings/tax_config.

const getRecognitionSettings = async (req, res) => {
  let settings = await knex('recognition_settings').where({ companyId: req.user.companyId ?? null }).first();
  if (!settings) {
    settings = {
      pointsEnabled: false, pointsPerKudos: 10, monthlyBudget: 100,
      allowSelfRecognition: false, minMessageLength: 20, maxKudosPerDay: 5,
      notifyOnKudos: true, postToFeed: true,
    };
  }
  return returnFunction(res, 200, true, 'OK', settings);
};

const updateRecognitionSettings = async (req, res) => {
  const companyId = req.user.companyId ?? null;
  const existing = await knex('recognition_settings').where({ companyId }).first();
  const update = { ...req.body, companyId, updatedAt: new Date() };
  delete update.id;
  if (existing) {
    await knex('recognition_settings').where({ id: existing.id }).update(update);
  } else {
    await knex('recognition_settings').insert({ id: newId(), ...update });
  }
  return returnFunction(res, 200, true, 'Settings saved', null);
};

const searchColleagues = async (req, res) => {
  const { q = '' } = req.query;
  let query = knex('employees').whereNot({ status: 'terminated' });
  if (q.trim()) query = query.whereILike('fullName', `%${q.trim()}%`);
  const employees = await query.select('id', 'fullName', 'designation', 'department').orderBy('fullName').limit(20);
  return returnFunction(res, 200, true, 'OK', employees);
};

module.exports = {
  listAwardTypes, createAwardType, updateAwardType, deleteAwardType,
  listEmployeeAwards, grantAward, bulkGrantAward, revokeAward,
  searchEmployeesForAward, getAwardStats, getUpcomingAwards, advanceAwardSchedule,
  listValues, createValue, updateValue, deleteValue, reorderValues,
  listKudos, createKudos, deleteKudos, reactToKudos, addKudosComment,
  getLeaderboard, getMyRank,
  listPrograms, createProgram, getProgram, updateProgram,
  nominateForProgram, listNominations, selectWinner,
  getRecognitionSettings, updateRecognitionSettings,
  searchColleagues,
};
