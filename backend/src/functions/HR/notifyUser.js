// Postgres migration (Phase 10) — notifications is Postgres now, with the
// recipientId/userId dual key normalized to a single recipientId column (see
// migrations/20260808130000_phase10_notifications_config_reports_schema.js's
// header for the live-data check that made this safe). employees/users have
// been Postgres since Phase 1.
const { knex, newId } = require('../Database/pgDBFunctions');

/**
 * Creates a notification for a specific user.
 * @param {string} userId  - the id of the user to notify
 * @param {{ title: string, body: string, type: string, link?: string }} payload
 */
const notifyUser = async (userId, { title, body, type, link = null }) => {
  try {
    const id = String(userId);
    const user = await knex('users').where({ id }).first();
    if (user?.notificationsEnabled === false) return;
    await knex('notifications').insert({
      id: newId(),
      recipientId: id,
      title,
      body,
      type,   // 'payroll' | 'leave' | 'announcement' | 'onboarding' | 'general'
      navigateTo: link,
      isRead: false,
      createdAt: new Date(),
    });
  } catch {
    // Non-critical — never let a notification failure break the main flow
  }
};

/**
 * Finds the user account linked to an employeeId and sends them a notification.
 */
const notifyEmployee = async (employeeId, payload) => {
  const user = await knex('users').where({ employeeId: String(employeeId) }).first();
  if (user) await notifyUser(user.id, payload);
};

/**
 * Notifies all users with any of the given roles.
 */
const notifyByRoles = async (roles = [], payload) => {
  const users = await knex('users').whereIn('role', roles);
  await Promise.all(users.map((u) => notifyUser(u.id, payload)));
};

/**
 * Notifies all staff affected by a scheduled event.
 * audience = 'all'        → every user with an employeeId
 * audience = 'department' → users whose employee record matches the department name
 */
const notifyStaffByAudience = async (audience, department, payload) => {
  try {
    let employeeQuery = knex('employees');
    if (audience === 'department' && department) employeeQuery = employeeQuery.where({ department });
    const employees = await employeeQuery.select('id');
    const employeeIds = employees.map((e) => e.id);
    if (!employeeIds.length) return;

    const users = await knex('users').whereIn('employeeId', employeeIds).select('id');

    await Promise.all(users.map((u) => notifyUser(u.id, payload)));
  } catch {
    // Non-critical
  }
};

module.exports = { notifyUser, notifyEmployee, notifyByRoles, notifyStaffByAudience };
