const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyEmployee, notifyByRoles } = require('../../functions/HR/notifyUser');

// ── Award Types (templates) ───────────────────────────────────────────────────

const listAwardTypes = async (req, res) => {
  const types = await findMany('award_types', {}, { sort: { name: 1 } });
  return returnFunction(res, 200, true, 'OK', types);
};

const createAwardType = async (req, res) => {
  const { name, description, category, repeatInterval, nextDueDate } = req.body;
  if (!name) return returnFunction(res, 400, false, 'Award name is required.');
  const existing = await findOne('award_types', { name: { $regex: `^${name}$`, $options: 'i' } });
  if (existing) return returnFunction(res, 409, false, 'An award type with this name already exists.');
  const result = await insertOne('award_types', {
    name, description: description || '', category: category || 'general',
    repeatInterval: repeatInterval || 'none',
    nextDueDate: nextDueDate ? new Date(nextDueDate) : null,
    createdAt: new Date(),
  });
  return returnFunction(res, 201, true, 'Award type created.', { _id: result.insertedId });
};

const updateAwardType = async (req, res) => {
  const { name, description, category, repeatInterval, nextDueDate } = req.body;
  await global.dbo.collection('award_types').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { name, description, category, repeatInterval: repeatInterval || 'none', nextDueDate: nextDueDate ? new Date(nextDueDate) : null, updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Award type updated.');
};

const deleteAwardType = async (req, res) => {
  await global.dbo.collection('award_types').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, 'Award type deleted.');
};

// ── Employee Awards ───────────────────────────────────────────────────────────

const listEmployeeAwards = async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const skip  = (page - 1) * limit;

  const filter = {};
  if (req.query.awardTypeId) filter.awardTypeId = new ObjectId(req.query.awardTypeId);
  if (req.query.year)        filter.year = parseInt(req.query.year);
  if (req.query.search) {
    filter.employeeName = { $regex: req.query.search, $options: 'i' };
  }

  const [total, awards] = await Promise.all([
    countDocuments('employee_awards', filter),
    global.dbo.collection('employee_awards').find(filter)
      .sort({ awardedAt: -1 }).skip(skip).limit(limit).toArray(),
  ]);

  // Populate award type names
  const typeIds = [...new Set(awards.map(a => String(a.awardTypeId)).filter(Boolean))];
  const types   = await findMany('award_types', { _id: { $in: typeIds.map(id => new ObjectId(id)) } });
  const typeMap  = Object.fromEntries(types.map(t => [String(t._id), t.name]));

  const enriched = awards.map(a => ({ ...a, awardTypeName: typeMap[String(a.awardTypeId)] || 'Unknown' }));
  return returnFunction(res, 200, true, 'OK', { data: enriched, total, page, limit });
};

// Single award
const grantAward = async (req, res) => {
  const { employeeId, awardTypeId, notes, year } = req.body;
  if (!employeeId || !awardTypeId) return returnFunction(res, 400, false, 'employeeId and awardTypeId are required.');

  const [emp, awardType] = await Promise.all([
    findOne('employees', { _id: new ObjectId(employeeId) }),
    findOne('award_types', { _id: new ObjectId(awardTypeId) }),
  ]);
  if (!emp)       return returnFunction(res, 404, false, 'Employee not found.');
  if (!awardType) return returnFunction(res, 404, false, 'Award type not found.');

  const doc = {
    employeeId:   new ObjectId(employeeId),
    employeeName: emp.fullName,
    staffNumber:  emp.staffNumber || null,
    department:   emp.department  || null,
    awardTypeId:  new ObjectId(awardTypeId),
    awardTypeName: awardType.name,
    notes:        notes || '',
    year:         year || new Date().getFullYear(),
    awardedBy:    req.user?.name || 'HR',
    awardedAt:    new Date(),
  };
  const result = await insertOne('employee_awards', doc);
  notifyEmployee(new ObjectId(employeeId), {
    title: 'You received an award!',
    body: `Congratulations! You've been awarded "${awardType.name}"${notes ? ': ' + notes : '.'}`,
    type: 'general',
  }).catch(() => {});
  return returnFunction(res, 201, true, 'Award granted.', { _id: result.insertedId });
};

// Bulk award — grant the same award to multiple employees at once
const bulkGrantAward = async (req, res) => {
  const { employeeIds, awardTypeId, notes, year } = req.body;
  if (!Array.isArray(employeeIds) || !employeeIds.length) return returnFunction(res, 400, false, 'employeeIds array is required.');
  if (!awardTypeId) return returnFunction(res, 400, false, 'awardTypeId is required.');

  const awardType = await findOne('award_types', { _id: new ObjectId(awardTypeId) });
  if (!awardType) return returnFunction(res, 404, false, 'Award type not found.');

  const employees = await global.dbo.collection('employees')
    .find({ _id: { $in: employeeIds.map(id => new ObjectId(id)) } })
    .project({ _id: 1, fullName: 1, staffNumber: 1, department: 1 })
    .toArray();

  if (!employees.length) return returnFunction(res, 404, false, 'No valid employees found.');

  const awardYear = year || new Date().getFullYear();
  const docs = employees.map(emp => ({
    employeeId:   emp._id,
    employeeName: emp.fullName,
    staffNumber:  emp.staffNumber || null,
    department:   emp.department  || null,
    awardTypeId:  new ObjectId(awardTypeId),
    awardTypeName: awardType.name,
    notes:        notes || '',
    year:         awardYear,
    awardedBy:    req.user?.name || 'HR',
    awardedAt:    new Date(),
  }));

  await global.dbo.collection('employee_awards').insertMany(docs);
  await Promise.all(employees.map(emp =>
    notifyEmployee(emp._id, {
      title: 'You received an award!',
      body: `Congratulations! You've been awarded "${awardType.name}"${notes ? ': ' + notes : '.'}`,
      type: 'general',
    }).catch(() => {})
  ));
  return returnFunction(res, 201, true, `Award granted to ${docs.length} employee(s).`, { count: docs.length });
};

const revokeAward = async (req, res) => {
  await global.dbo.collection('employee_awards').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, 'Award revoked.');
};

// Employee search helper used by the bulk award UI
const searchEmployeesForAward = async (req, res) => {
  const q    = req.query.q || '';
  const dept = req.query.department || '';
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 30);
  const skip  = (page - 1) * limit;

  const filter = { status: { $in: ['active', 'on_leave'] } };
  if (q)    filter.$or = [
    { fullName:    { $regex: q, $options: 'i' } },
    { staffNumber: { $regex: q, $options: 'i' } },
  ];
  if (dept) filter.department = dept;

  const [total, employees] = await Promise.all([
    countDocuments('employees', filter),
    global.dbo.collection('employees')
      .find(filter)
      .project({ _id: 1, fullName: 1, staffNumber: 1, department: 1, designation: 1 })
      .sort({ fullName: 1 })
      .skip(skip).limit(limit)
      .toArray(),
  ]);
  return returnFunction(res, 200, true, 'OK', { data: employees, total, page, limit });
};

// Awards by type + by department + top employees for chart/insight cards
const getAwardStats = async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const all  = await global.dbo.collection('employee_awards').find({ year }).toArray();

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
  const types = await findMany('award_types', { repeatInterval: { $nin: ['none', null] }, nextDueDate: { $ne: null } });
  const now   = new Date();
  const horizon = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  const upcoming = types
    .map(t => ({ ...t, daysUntilDue: Math.ceil((new Date(t.nextDueDate) - now) / (1000 * 60 * 60 * 24)) }))
    .filter(t => new Date(t.nextDueDate) <= horizon)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);

  return returnFunction(res, 200, true, 'OK', upcoming);
};

// After granting a scheduled award, advance the nextDueDate by one interval
const advanceAwardSchedule = async (req, res) => {
  const type = await findOne('award_types', { _id: new ObjectId(req.params.id) });
  if (!type) return returnFunction(res, 404, false, 'Award type not found.');

  const base = type.nextDueDate ? new Date(type.nextDueDate) : new Date();
  let next = new Date(base);
  if (type.repeatInterval === 'monthly')   next.setMonth(next.getMonth() + 1);
  else if (type.repeatInterval === 'quarterly') next.setMonth(next.getMonth() + 3);
  else if (type.repeatInterval === 'annually')  next.setFullYear(next.getFullYear() + 1);

  await global.dbo.collection('award_types').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { nextDueDate: next, updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Schedule advanced.', { nextDueDate: next });
};

// ── COMPANY VALUES ─────────────────────────────────────────────────────────────

const listValues = async (req, res) => {
  const values = await findMany('company_values',
    { companyId: req.user.companyId, isActive: { $ne: false } },
    { sort: { order: 1 } }
  );
  return returnFunction(res, 200, true, 'OK', values);
};

const createValue = async (req, res) => {
  const { name, description, emoji, color } = req.body;
  if (!name?.trim()) return returnFunction(res, 400, false, 'Value name is required.');
  const count = await global.dbo.collection('company_values').countDocuments({ companyId: req.user.companyId });
  const doc = {
    companyId: req.user.companyId,
    name: name.trim(), description: description || '',
    emoji: emoji || '⭐', color: color || '#6366f1',
    order: count, isActive: true, createdAt: new Date(),
  };
  const result = await global.dbo.collection('company_values').insertOne(doc);
  return returnFunction(res, 201, true, 'Value created', { _id: result.insertedId, ...doc });
};

const updateValue = async (req, res) => {
  const { name, description, emoji, color } = req.body;
  await global.dbo.collection('company_values').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { name, description, emoji, color, updatedAt: new Date() } }
  );
  return returnFunction(res, 200, true, 'Value updated', null);
};

const deleteValue = async (req, res) => {
  await global.dbo.collection('company_values').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { isActive: false } }
  );
  return returnFunction(res, 200, true, 'Value removed', null);
};

const reorderValues = async (req, res) => {
  const { order } = req.body; // array of { _id, order }
  await Promise.all(
    (order || []).map(({ _id, order: ord }) =>
      global.dbo.collection('company_values').updateOne({ _id: new ObjectId(_id) }, { $set: { order: ord } })
    )
  );
  return returnFunction(res, 200, true, 'Order updated', null);
};

// ── KUDOS ──────────────────────────────────────────────────────────────────────

const listKudos = async (req, res) => {
  const { page = 1, limit = 20, recipientId } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const filter = { companyId: req.user.companyId };
  if (recipientId) filter.recipientIds = new ObjectId(recipientId);

  const kudos = await global.dbo
    .collection('kudos')
    .find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .toArray();

  const enriched = await Promise.all(
    kudos.map(async k => {
      let granterName = k.giverName ?? '';
      if (!granterName) {
        const giver = await findOne('employees', { _id: k.giverId }, { projection: { fullName: 1 } });
        if (giver) {
          granterName = giver.fullName;
        } else {
          const giverUser = await findOne('users', { _id: k.giverId }, { projection: { fullName: 1, email: 1 } });
          granterName = giverUser?.fullName ?? giverUser?.email ?? '';
        }
      }
      const recipients = await Promise.all(
        (k.recipientIds || []).map(id => findOne('employees', { _id: id }, { projection: { fullName: 1 } }))
      );
      const enrichedComments = await Promise.all(
        (k.comments || []).map(async (c, idx) => {
          let authorName = c.authorName;
          if (!authorName && c.authorId) {
            const author = await findOne('employees', { _id: c.authorId }, { projection: { fullName: 1 } });
            authorName = author?.fullName ?? 'Unknown';
          }
          return {
            _id: c._id ? String(c._id) : String(c.authorId || idx),
            content: c.content || c.text || '',
            authorName: authorName || 'Unknown',
            createdAt: c.createdAt,
          };
        })
      );
      return {
        ...k,
        granterId: String(k.giverId),
        granterName,
        recipientNames: recipients.filter(Boolean).map(r => r.fullName),
        comments: enrichedComments,
      };
    })
  );
  const total = await global.dbo.collection('kudos').countDocuments(filter);
  return returnFunction(res, 200, true, 'OK', { kudos: enriched, total });
};

const createKudos = async (req, res) => {
  const { recipientIds, valueId, message, gifUrl, visibility = 'public', pointsAwarded = 0 } = req.body;
  if (!recipientIds?.length || !message?.trim()) {
    return returnFunction(res, 400, false, 'Recipient and message are required.');
  }

  // Enforce recognition settings
  const settings = await findOne('recognition_settings', {});
  if (settings) {
    if (!settings.allowSelfRecognition) {
      const giverId = String(req.user.employeeId || req.user._id);
      const selfIncluded = recipientIds.some(id => String(id) === giverId);
      if (selfIncluded) return returnFunction(res, 400, false, 'You cannot send kudos to yourself.');
    }
    const minLen = settings.minMessageLength ?? 0;
    if (minLen > 0 && message.trim().length < minLen) {
      return returnFunction(res, 400, false, `Message must be at least ${minLen} characters.`);
    }
    if (settings.maxKudosPerDay) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const sentToday = await global.dbo.collection('kudos').countDocuments({
        giverId: req.user.employeeId || req.user._id,
        createdAt: { $gte: todayStart },
      });
      if (sentToday >= settings.maxKudosPerDay) {
        return returnFunction(res, 429, false, `Daily kudos limit of ${settings.maxKudosPerDay} reached.`);
      }
    }
  }

  let valueName = '', valueColor = '#6366f1';
  if (valueId) {
    const val = await findOne('company_values', { _id: new ObjectId(valueId) });
    if (val) { valueName = val.name; valueColor = val.color; }
  }

  let giverName = req.user.fullName ?? '';
  if (!giverName && req.user.employeeId) {
    const giverEmp = await findOne('employees', { _id: req.user.employeeId }, { projection: { fullName: 1 } });
    giverName = giverEmp?.fullName ?? '';
  }

  const doc = {
    companyId: req.user.companyId,
    giverId: req.user.employeeId || req.user._id,
    giverName,
    recipientIds: recipientIds.map(id => new ObjectId(id)),
    valueId: valueId ? new ObjectId(valueId) : null,
    valueName, valueColor,
    message, gifUrl: gifUrl || null,
    visibility,
    pointsAwarded: Number(pointsAwarded),
    reactions: [], comments: [],
    createdAt: new Date(),
  };

  const result = await global.dbo.collection('kudos').insertOne(doc);
  await Promise.all(doc.recipientIds.map(id =>
    notifyEmployee(id, {
      title: `You received kudos from ${giverName}!`,
      body: message,
      type: 'general',
    }).catch(() => {})
  ));
  return returnFunction(res, 201, true, 'Kudos sent! 🏅', { _id: result.insertedId, ...doc });
};

const deleteKudos = async (req, res) => {
  await global.dbo.collection('kudos').deleteOne({ _id: new ObjectId(req.params.id) });
  return returnFunction(res, 200, true, 'Kudos removed', null);
};

const reactToKudos = async (req, res) => {
  const { type } = req.body;
  const empId = req.user.employeeId || req.user._id;
  const kudosId = new ObjectId(req.params.id);
  const k = await findOne('kudos', { _id: kudosId });
  if (!k) return returnFunction(res, 404, false, 'Not found', null);
  const existing = (k.reactions || []).find(r => String(r.employeeId) === String(empId) && r.type === type);
  if (existing) {
    await global.dbo.collection('kudos').updateOne({ _id: kudosId }, { $pull: { reactions: { employeeId: empId, type } } });
  } else {
    await global.dbo.collection('kudos').updateOne({ _id: kudosId }, { $push: { reactions: { type, employeeId: empId, reactedAt: new Date() } } });
  }
  return returnFunction(res, 200, true, 'Reaction updated', null);
};

const addKudosComment = async (req, res) => {
  const commentText = (req.body.content || req.body.text || '').trim();
  if (!commentText) return returnFunction(res, 400, false, 'Comment text required', null);
  const empId = req.user.employeeId || req.user._id;
  const author = await findOne('employees', { _id: empId }, { projection: { fullName: 1 } });
  const commentId = new ObjectId();
  const comment = {
    _id: commentId,
    authorId: empId,
    authorName: author?.fullName ?? 'Unknown',
    content: commentText,
    createdAt: new Date(),
  };
  await global.dbo.collection('kudos').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $push: { comments: comment } }
  );
  return returnFunction(res, 201, true, 'Comment added', { ...comment, _id: String(commentId) });
};

// ── LEADERBOARD ────────────────────────────────────────────────────────────────

const getLeaderboard = async (req, res) => {
  const { period = 'month', department, limit: lim = 20 } = req.query;
  const now = new Date();
  let startDate;
  if (period === 'month')   { startDate = new Date(now.getFullYear(), now.getMonth(), 1); }
  else if (period === 'quarter') { startDate = new Date(now.getFullYear(), Math.floor(now.getMonth()/3)*3, 1); }
  else { startDate = new Date(now.getFullYear(), 0, 1); }

  const pipeline = [
    { $match: { companyId: req.user.companyId, createdAt: { $gte: startDate } } },
    { $unwind: '$recipientIds' },
    { $group: { _id: '$recipientIds', kudosReceived: { $sum: 1 }, pointsEarned: { $sum: '$pointsAwarded' } } },
    { $sort: { kudosReceived: -1 } },
    { $limit: Number(lim) },
  ];

  const results = await global.dbo.collection('kudos').aggregate(pipeline).toArray();
  const enriched = await Promise.all(
    results.map(async (r, i) => {
      const emp = await findOne('employees', { _id: r._id }, { projection: { fullName: 1, department: 1, designation: 1 } });
      return {
        rank: i + 1,
        employeeId: String(r._id),
        employeeName: emp?.fullName ?? '',
        designation: emp?.designation ?? '',
        department: emp?.department ?? '',
        kudosReceived: r.kudosReceived,
        pointsEarned: r.pointsEarned,
      };
    })
  );

  const filtered = department ? enriched.filter(r => r.department === department) : enriched;
  return returnFunction(res, 200, true, 'OK', filtered);
};

const getMyRank = async (req, res) => {
  const empId = req.user.employeeId || req.user._id;
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), 1);

  const pipeline = [
    { $match: { companyId: req.user.companyId, createdAt: { $gte: startDate } } },
    { $unwind: '$recipientIds' },
    { $group: { _id: '$recipientIds', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ];

  const all = await global.dbo.collection('kudos').aggregate(pipeline).toArray();
  const idx = all.findIndex(r => String(r._id) === String(empId));
  return returnFunction(res, 200, true, 'OK', {
    rank: idx >= 0 ? idx + 1 : null,
    kudosReceived: idx >= 0 ? all[idx].count : 0,
    total: all.length,
  });
};

// ── AWARD PROGRAMS ─────────────────────────────────────────────────────────────

const listPrograms = async (req, res) => {
  const programs = await findMany('award_programs', { companyId: req.user.companyId }, { sort: { createdAt: -1 } });

  const enriched = await Promise.all(programs.map(async p => {
    const nomineeCount = await global.dbo.collection('award_nominations')
      .countDocuments({ programId: p._id, cycleStart: p.currentCycleStart });
    return { ...p, nomineeCount };
  }));
  return returnFunction(res, 200, true, 'OK', enriched);
};

const createProgram = async (req, res) => {
  const { name, description, icon, frequency, nominationBy, selectionMethod, prizeType, prizeDescription, announcementMethod, cycleStart, cycleEnd } = req.body;
  if (!name?.trim()) return returnFunction(res, 400, false, 'Program name required', null);

  const doc = {
    companyId: req.user.companyId,
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
    createdBy: new ObjectId(req.user.id),
    createdAt: new Date(),
  };

  const result = await global.dbo.collection('award_programs').insertOne(doc);
  return returnFunction(res, 201, true, 'Program created', { _id: result.insertedId, ...doc });
};

const getProgram = async (req, res) => {
  const p = await findOne('award_programs', { _id: new ObjectId(req.params.id) });
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

  await global.dbo.collection('award_programs').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, 'Program updated', null);
};

const nominateForProgram = async (req, res) => {
  const { nomineeId, reason, valueId } = req.body;
  if (!nomineeId || !reason?.trim()) return returnFunction(res, 400, false, 'Nominee and reason required', null);

  const program = await findOne('award_programs', { _id: new ObjectId(req.params.id) });
  if (!program) return returnFunction(res, 404, false, 'Program not found', null);

  const doc = {
    companyId: req.user.companyId,
    programId: new ObjectId(req.params.id),
    nomineeId: new ObjectId(nomineeId),
    nominatorId: new ObjectId(req.user.id),
    reason,
    valueId: valueId ? new ObjectId(valueId) : null,
    cycleStart: program.currentCycleStart,
    isWinner: false,
    createdAt: new Date(),
  };
  const result = await global.dbo.collection('award_nominations').insertOne(doc);

  const nominee = await findOne('employees', { _id: doc.nomineeId }, { projection: { fullName: 1 } });
  notifyByRoles(['super_admin', 'hr_manager'], {
    title: 'Award Nomination Submitted',
    body: `${nominee?.fullName || 'An employee'} was nominated for "${program.name}".`,
    type: 'general',
  }).catch(() => {});

  return returnFunction(res, 201, true, 'Nomination submitted', { _id: result.insertedId });
};

const listNominations = async (req, res) => {
  const noms = await global.dbo
    .collection('award_nominations')
    .find({ programId: new ObjectId(req.params.id) })
    .sort({ createdAt: -1 })
    .toArray();

  const enriched = await Promise.all(noms.map(async n => {
    const nominee   = await findOne('employees', { _id: n.nomineeId }, { projection: { fullName: 1, department: 1, designation: 1 } });
    const nominator = await findOne('employees', { _id: n.nominatorId }, { projection: { fullName: 1 } });
    return { ...n, nominee, nominator };
  }));

  return returnFunction(res, 200, true, 'OK', enriched);
};

const selectWinner = async (req, res) => {
  const { winnerId } = req.body;
  if (!winnerId) return returnFunction(res, 400, false, 'Winner ID required', null);

  const winner = await findOne('employees', { _id: new ObjectId(winnerId) }, { projection: { fullName: 1, department: 1 } });

  await global.dbo.collection('award_nominations').updateMany(
    { programId: new ObjectId(req.params.id) },
    { $set: { isWinner: false } }
  );
  await global.dbo.collection('award_nominations').updateOne(
    { programId: new ObjectId(req.params.id), nomineeId: new ObjectId(winnerId) },
    { $set: { isWinner: true, announcedAt: new Date() } }
  );

  const program = await findOne('award_programs', { _id: new ObjectId(req.params.id) });

  // Create a feed post announcing the winner
  if (program) {
    await global.dbo.collection('community_posts').insertOne({
      companyId: req.user.companyId,
      communityId: null,
      authorId: new ObjectId(req.user.id),
      type: 'announcement',
      content: `🏆 **${program.name} Winner: ${winner?.fullName}!**\n\nCongratulations ${winner?.fullName} from ${winner?.department || 'our team'}! ${program.description || ''}`,
      imageUrls: [],
      isPinned: true,
      reactions: [],
      commentCount: 0,
      viewCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  notifyEmployee(new ObjectId(winnerId), {
    title: 'Congratulations — you won an award!',
    body: `You were selected as the winner of "${program?.name || 'this award'}".`,
    type: 'general',
  }).catch(() => {});

  return returnFunction(res, 200, true, 'Winner announced!', { winner });
};

// ── RECOGNITION SETTINGS ───────────────────────────────────────────────────────

const getRecognitionSettings = async (req, res) => {
  let settings = await findOne('recognition_settings', { companyId: req.user.companyId });
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
  const update = { ...req.body, companyId: req.user.companyId, updatedAt: new Date() };
  await global.dbo.collection('recognition_settings').updateOne(
    { companyId: req.user.companyId },
    { $set: update },
    { upsert: true }
  );
  return returnFunction(res, 200, true, 'Settings saved', null);
};

const searchColleagues = async (req, res) => {
  const { q = '' } = req.query;
  const filter = { status: { $ne: 'terminated' } };
  if (q.trim()) {
    filter.fullName = { $regex: q.trim(), $options: 'i' };
  }
  const employees = await findMany(
    'employees',
    filter,
    { limit: 20, sort: { fullName: 1 }, projection: { fullName: 1, designation: 1, department: 1 } }
  );
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
