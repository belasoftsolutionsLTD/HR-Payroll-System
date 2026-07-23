const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyEmployee, notifyByRoles } = require('../../functions/HR/notifyUser');

// ── HR: create announcement ───────────────────────────────────────────────────
// audiences: array — any combo of 'all' | 'staff' | 'department_head' | 'hr_only' |
// 'department:<name>' | 'employee:<employeeId>' | 'jobGroup:<jobGroupId>' | 'employmentType:<type>'
// type: 'news' | 'alert' | 'campaign' (defaults to 'news')
const createAnnouncement = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'body'])) return;
  const { title, body } = req.body;

  // Support both legacy single string and new array
  let audiences = req.body.audiences || req.body.audience;
  if (!audiences) return returnFunction(res, 400, false, 'At least one audience is required.');
  if (!Array.isArray(audiences)) audiences = [audiences];

  const type = ['news', 'alert', 'campaign'].includes(req.body.type) ? req.body.type : 'news';

  const doc = {
    title,
    body,
    type,
    audiences,
    // Keep legacy field for backward compat with staff portal read queries
    audience: audiences.includes('all') ? 'all' : (audiences.some(a => a.startsWith('department:')) ? 'department' : 'staff'),
    department: null,
    createdBy: new ObjectId(req.user._id),
    createdByName: req.user.name || '',
    readBy: [],
    createdAt: new Date(),
  };

  // Extract department names from 'department:Finance' style entries
  const deptTargets = audiences.filter(a => a.startsWith('department:')).map(a => a.replace('department:', ''));
  if (deptTargets.length === 1) doc.department = deptTargets[0];

  // Same 'prefix:value' convention for the newer targeting dimensions.
  const empTargets = audiences.filter(a => a.startsWith('employee:')).map(a => a.replace('employee:', ''));
  const jobGroupTargets = audiences.filter(a => a.startsWith('jobGroup:')).map(a => a.replace('jobGroup:', ''));
  const employmentTypeTargets = audiences.filter(a => a.startsWith('employmentType:')).map(a => a.replace('employmentType:', ''));

  const result = await insertOne('announcements', doc);

  const notifySnippet = body.substring(0, 120) + (body.length > 120 ? '…' : '');

  // Notify all staff + dept heads
  if (audiences.includes('all')) {
    notifyByRoles(['staff', 'department_head'], {
      type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal',
    }).catch(() => {});
  } else {
    // Staff group
    if (audiences.includes('staff')) {
      notifyByRoles(['staff'], { type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal' }).catch(() => {});
    }
    // Dept head group
    if (audiences.includes('department_head')) {
      notifyByRoles(['department_head'], { type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal' }).catch(() => {});
    }
    // Specific departments
    for (const dept of deptTargets) {
      const emps = await findMany('employees', { department: dept, status: { $in: ['active', 'on_leave'] } }, { projection: { _id: 1 } });
      emps.forEach(emp => notifyEmployee(emp._id, { type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal' }).catch(() => {}));
    }
    // Specific employees
    for (const empId of empTargets) {
      notifyEmployee(empId, { type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal' }).catch(() => {});
    }
    // Job groups
    for (const jgId of jobGroupTargets) {
      const emps = await findMany('employees', { jobGroupId: new ObjectId(jgId), status: { $in: ['active', 'on_leave'] } }, { projection: { _id: 1 } });
      emps.forEach(emp => notifyEmployee(emp._id, { type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal' }).catch(() => {}));
    }
    // Employment types
    for (const et of employmentTypeTargets) {
      const emps = await findMany('employees', { employmentType: et, status: { $in: ['active', 'on_leave'] } }, { projection: { _id: 1 } });
      emps.forEach(emp => notifyEmployee(emp._id, { type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal' }).catch(() => {}));
    }
  }

  return returnFunction(res, 201, true, 'Announcement published.', { _id: result.insertedId });
};

// ── HR: list all announcements ────────────────────────────────────────────────
const listAnnouncements = async (req, res) => {
  const announcements = await findMany('announcements', {}, { sort: { createdAt: -1 }, limit: 50 });
  return returnFunction(res, 200, true, req.locale.success, announcements);
};

// ── HR: delete announcement ───────────────────────────────────────────────────
const deleteAnnouncement = async (req, res) => {
  const ann = await findOne('announcements', { _id: new ObjectId(req.params.id) });
  if (!ann) return returnFunction(res, 404, false, req.locale.notFound);
  await global.dbo.collection('announcements').deleteOne({ _id: ann._id });
  return returnFunction(res, 200, true, 'Announcement deleted.');
};

// ── Staff: get announcements visible to them ──────────────────────────────────
// Matches directly against the stored `audiences` array (Mongo matches an array field
// against a scalar by containment) rather than the derived legacy `audience` singular
// field, so every targeting dimension HR can pick from actually becomes visible here.
const getMyAnnouncements = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'OK', []);

  const emp = await findOne('employees', { _id: req.user.employeeId }, { projection: { department: 1, jobGroupId: 1, employmentType: 1 } });
  const dept = emp?.department;

  const orClauses = [
    { audiences: 'all' },
    { audiences: 'staff' },
    { audiences: `employee:${String(req.user.employeeId)}` },
    // Legacy fallback — any announcement written before the `audiences` array existed
    // only has these singular fields set, and would otherwise match nothing above and
    // silently vanish from every staff member's view.
    { audience: 'all' },
    { audience: 'staff' },
  ];
  if (dept) {
    orClauses.push({ audiences: `department:${dept}` });
    orClauses.push({ audience: 'department', department: dept });
  }
  if (emp?.jobGroupId) orClauses.push({ audiences: `jobGroup:${String(emp.jobGroupId)}` });
  if (emp?.employmentType) orClauses.push({ audiences: `employmentType:${emp.employmentType}` });
  if (req.user.role === 'department_head') orClauses.push({ audiences: 'department_head' });
  if (['hr_manager', 'super_admin'].includes(req.user.role)) orClauses.push({ audiences: 'hr_only' });

  const announcements = await findMany('announcements', { $or: orClauses }, { sort: { createdAt: -1 }, limit: 30 });

  // Attach read status for this user
  const userId = String(req.user._id);
  const enriched = announcements.map(a => ({
    ...a,
    isRead: (a.readBy || []).some(id => String(id) === userId),
  }));

  return returnFunction(res, 200, true, 'OK', enriched);
};

// ── Staff: mark announcement as read ─────────────────────────────────────────
const markAnnouncementRead = async (req, res) => {
  await updateOne('announcements', { _id: new ObjectId(req.params.id) }, {
    $addToSet: { readBy: new ObjectId(req.user._id) },
  });
  return returnFunction(res, 200, true, 'OK');
};

module.exports = { createAnnouncement, listAnnouncements, deleteAnnouncement, getMyAnnouncements, markAnnouncementRead };
