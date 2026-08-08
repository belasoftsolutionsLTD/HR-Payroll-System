// Postgres migration (Phase 10 cross-cutting sweep) — announcements/announcement_reads
// are Postgres now. This module was a live, mounted route (/api/announcements) that
// every prior phase's plan simply never named — 1 real row, no orphan concerns.
// `readBy`'s Mongo $addToSet became its
// own announcement_reads child table (see the migration file's header for the full
// rationale); `audiences` stays a JSONB string array (always whole-replaced, never
// per-element mutated).
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { notifyEmployee, notifyByRoles } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

// Mirrors createAnnouncement's audience-resolution branches but collects real email
// addresses instead of firing in-app notifications — kept as its own pass rather than
// threading email-sending into each existing branch, so the in-app logic above stays
// untouched and this can be read/tested as one self-contained fan-out.
const emailAnnouncementAudience = async ({ audiences, deptTargets, empTargets, jobGroupTargets, employmentTypeTargets, title, body }) => {
  const emails = new Set();
  const addByRole = async (roles) => {
    const users = await knex('users').whereIn('role', roles).whereNot('isActive', false).select('email');
    users.forEach(u => u.email && emails.add(u.email));
  };
  const addByEmployeeIds = async (empIds) => {
    if (!empIds.length) return;
    const users = await knex('users').whereIn('employeeId', empIds).select('email');
    users.forEach(u => u.email && emails.add(u.email));
  };

  if (audiences.includes('all')) {
    await addByRole(['staff', 'department_head']);
  } else {
    if (audiences.includes('staff')) await addByRole(['staff']);
    if (audiences.includes('department_head')) await addByRole(['department_head']);
    for (const dept of deptTargets) {
      const emps = await knex('employees').where({ department: dept }).whereIn('status', ['active', 'on_leave']).select('id');
      await addByEmployeeIds(emps.map(e => e.id));
    }
    if (empTargets.length) {
      const emps = await knex('employees').whereIn('id', empTargets).whereIn('status', ['active', 'on_leave']).select('id');
      await addByEmployeeIds(emps.map(e => e.id));
    }
    for (const jgId of jobGroupTargets) {
      const emps = await knex('employees').where({ jobGroupId: jgId }).whereIn('status', ['active', 'on_leave']).select('id');
      await addByEmployeeIds(emps.map(e => e.id));
    }
    for (const et of employmentTypeTargets) {
      const emps = await knex('employees').where({ employmentType: et }).whereIn('status', ['active', 'on_leave']).select('id');
      await addByEmployeeIds(emps.map(e => e.id));
    }
  }

  const tokens = { title, body };
  emails.forEach(email => sendTemplatedEmail({
    trigger: 'announcementPublished', to: email, tokens,
    fallbackSubject: `📢 ${title}`,
    fallbackHtml: `<p>${body}</p>`,
  }).catch(() => {}));
};

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

  // Extract department names from 'department:Finance' style entries
  const deptTargets = audiences.filter(a => a.startsWith('department:')).map(a => a.replace('department:', ''));

  // Same 'prefix:value' convention for the newer targeting dimensions.
  const empTargets = audiences.filter(a => a.startsWith('employee:')).map(a => a.replace('employee:', ''));
  const jobGroupTargets = audiences.filter(a => a.startsWith('jobGroup:')).map(a => a.replace('jobGroup:', ''));
  const employmentTypeTargets = audiences.filter(a => a.startsWith('employmentType:')).map(a => a.replace('employmentType:', ''));

  const doc = {
    id: newId(),
    title,
    body,
    type,
    audiences: JSON.stringify(audiences),
    // Keep legacy field for backward compat with staff portal read queries
    audience: audiences.includes('all') ? 'all' : (deptTargets.length ? 'department' : 'staff'),
    department: deptTargets.length === 1 ? deptTargets[0] : null,
    createdBy: req.user.id,
    createdByName: req.user.name || '',
    createdAt: new Date(),
  };

  const [saved] = await knex('announcements').insert(doc).returning('*');

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
      const emps = await knex('employees').where({ department: dept }).whereIn('status', ['active', 'on_leave']).select('id');
      emps.forEach(emp => notifyEmployee(emp.id, { type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal' }).catch(() => {}));
    }
    // Specific employees
    for (const empId of empTargets) {
      notifyEmployee(empId, { type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal' }).catch(() => {});
    }
    // Job groups
    for (const jgId of jobGroupTargets) {
      const emps = await knex('employees').where({ jobGroupId: jgId }).whereIn('status', ['active', 'on_leave']).select('id');
      emps.forEach(emp => notifyEmployee(emp.id, { type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal' }).catch(() => {}));
    }
    // Employment types
    for (const et of employmentTypeTargets) {
      const emps = await knex('employees').where({ employmentType: et }).whereIn('status', ['active', 'on_leave']).select('id');
      emps.forEach(emp => notifyEmployee(emp.id, { type: 'announcement', title: `📢 ${title}`, body: notifySnippet, link: '/staff-portal' }).catch(() => {}));
    }
  }

  emailAnnouncementAudience({ audiences, deptTargets, empTargets, jobGroupTargets, employmentTypeTargets, title, body }).catch(() => {});

  return returnFunction(res, 201, true, 'Announcement published.', { _id: saved.id });
};

// ── HR: list all announcements ────────────────────────────────────────────────
const listAnnouncements = async (req, res) => {
  const announcements = await knex('announcements').orderBy('createdAt', 'desc').limit(50);
  return returnFunction(res, 200, true, req.locale.success, announcements);
};

// ── HR: delete announcement ───────────────────────────────────────────────────
const deleteAnnouncement = async (req, res) => {
  const ann = await knex('announcements').where({ id: req.params.id }).first();
  if (!ann) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('announcements').where({ id: ann.id }).delete(); // announcement_reads cascade on delete
  return returnFunction(res, 200, true, 'Announcement deleted.');
};

// ── Staff: get announcements visible to them ──────────────────────────────────
// Matches against the stored `audiences` JSONB array (via a `?` containment check)
// rather than the derived legacy `audience` singular field, so every targeting
// dimension HR can pick from actually becomes visible here.
const getMyAnnouncements = async (req, res) => {
  if (!req.user.employeeId) return returnFunction(res, 200, true, 'OK', []);
  const empId = String(req.user.employeeId);

  const emp = await knex('employees').where({ id: empId }).select('department', 'jobGroupId', 'employmentType').first();
  const dept = emp?.department;

  const audienceValues = ['all', 'staff', `employee:${empId}`];
  if (dept) audienceValues.push(`department:${dept}`);
  if (emp?.jobGroupId) audienceValues.push(`jobGroup:${emp.jobGroupId}`);
  if (emp?.employmentType) audienceValues.push(`employmentType:${emp.employmentType}`);
  if (req.user.role === 'department_head') audienceValues.push('department_head');
  if (['hr_manager', 'super_admin'].includes(req.user.role)) audienceValues.push('hr_only');

  const announcements = await knex('announcements')
    .where((qb) => {
      // `audiences ?| array[...]` — true if the JSONB array contains any of the given
      // strings. The first `?` is Postgres' own jsonb operator, not a knex bind
      // placeholder — escaped as `\?` so knex doesn't count it as a second binding.
      qb.whereRaw(`"audiences" \\?| ?::text[]`, [audienceValues]);
      // Legacy fallback — any announcement written before the `audiences` array existed
      // only has these singular fields set, and would otherwise match nothing above and
      // silently vanish from every staff member's view.
      qb.orWhere({ audience: 'all' }).orWhere({ audience: 'staff' });
      if (dept) qb.orWhere({ audience: 'department', department: dept });
    })
    .orderBy('createdAt', 'desc').limit(30);

  // Attach read status for this user
  const announcementIds = announcements.map(a => a.id);
  const reads = announcementIds.length
    ? await knex('announcement_reads').whereIn('announcementId', announcementIds).where({ userId: req.user.id }).select('announcementId')
    : [];
  const readSet = new Set(reads.map(r => r.announcementId));
  const enriched = announcements.map(a => ({ ...a, isRead: readSet.has(a.id) }));

  return returnFunction(res, 200, true, 'OK', enriched);
};

// ── Staff: mark announcement as read ─────────────────────────────────────────
const markAnnouncementRead = async (req, res) => {
  const existing = await knex('announcement_reads').where({ announcementId: req.params.id, userId: req.user.id }).first();
  if (!existing) {
    await knex('announcement_reads').insert({ id: newId(), announcementId: req.params.id, userId: req.user.id, readAt: new Date() });
  }
  return returnFunction(res, 200, true, 'OK');
};

module.exports = { createAnnouncement, listAnnouncements, deleteAnnouncement, getMyAnnouncements, markAnnouncementRead };
