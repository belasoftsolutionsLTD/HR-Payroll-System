const { ObjectId } = require('mongodb');
const { findOne, insertOne } = require('../Database/commonDBFunctions');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 1) —
// `users`/`employees` now live in Postgres; `notifications` itself is unmigrated (Phase
// 10), so every notification document below is still written straight to Mongo — only
// the "who do I notify" lookups move to Postgres. pgUsers's rows carry a `_id` alias
// (see pgDBFunctions.js) so `u._id` below is still a real ObjectId, safe to write
// straight into notifications.recipientId/userId exactly as before.
const pgUsers = require('../Database/pgDBFunctions');

/**
 * Creates a notification for a specific user.
 * @param {string|ObjectId} userId  - The _id of the user to notify
 * @param {{ title: string, body: string, type: string, link?: string }} payload
 */
const notifyUser = async (userId, { title, body, type, link = null }) => {
  try {
    const user = await pgUsers.findOne('users', { id: String(userId) });
    if (user?.notificationsEnabled === false) return;
    await insertOne('notifications', {
      recipientId: new ObjectId(userId),
      userId: new ObjectId(userId),
      title,
      subtitle: body,
      body,
      type,   // 'payroll' | 'leave' | 'announcement' | 'onboarding' | 'general'
      link,
      navigateTo: link,
      read: false,
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
  const user = await pgUsers.findOne('users', { employeeId: String(employeeId) });
  if (user) await notifyUser(user._id, payload);
};

/**
 * Notifies all users with any of the given roles.
 */
const notifyByRoles = async (roles = [], payload) => {
  const users = await pgUsers.knex('users').whereIn('role', roles);
  await Promise.all(users.map(u => notifyUser(u.id, payload)));
};

/**
 * Notifies all staff affected by a scheduled event.
 * audience = 'all'        → every user with an employeeId
 * audience = 'department' → users whose employee record matches the department name
 */
const notifyStaffByAudience = async (audience, department, payload) => {
  try {
    let employeeQuery = pgUsers.knex('employees');
    if (audience === 'department' && department) employeeQuery = employeeQuery.where({ department });
    const employees = await employeeQuery.select('id');
    const employeeIds = employees.map(e => e.id);
    if (!employeeIds.length) return;

    const users = await pgUsers.knex('users').whereIn('employeeId', employeeIds).select('id');

    await Promise.all(users.map(u => notifyUser(u.id, payload)));
  } catch {
    // Non-critical
  }
};

module.exports = { notifyUser, notifyEmployee, notifyByRoles, notifyStaffByAudience };
