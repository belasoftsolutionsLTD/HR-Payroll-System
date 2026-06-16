const { ObjectId } = require('mongodb');
const { findOne, insertOne } = require('../Database/commonDBFunctions');

/**
 * Creates a notification for a specific user.
 * @param {string|ObjectId} userId  - The _id of the user to notify
 * @param {{ title: string, body: string, type: string, link?: string }} payload
 */
const notifyUser = async (userId, { title, body, type, link = null }) => {
  try {
    const user = await findOne('users', { _id: new ObjectId(userId) }, { projection: { notificationsEnabled: 1 } });
    if (user?.notificationsEnabled === false) return;
    await insertOne('notifications', {
      userId: new ObjectId(userId),
      title,
      body,
      type,   // 'payroll' | 'leave' | 'announcement' | 'onboarding' | 'general'
      link,
      read: false,
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
  const user = await findOne('users', { employeeId: new ObjectId(employeeId) });
  if (user) await notifyUser(user._id, payload);
};

/**
 * Notifies all users with any of the given roles.
 */
const notifyByRoles = async (roles = [], payload) => {
  const users = await global.dbo.collection('users').find({ role: { $in: roles } }).toArray();
  await Promise.all(users.map(u => notifyUser(u._id, payload)));
};

/**
 * Notifies all staff affected by a scheduled event.
 * audience = 'all'        → every user with an employeeId
 * audience = 'department' → users whose employee record matches the department name
 */
const notifyStaffByAudience = async (audience, department, payload) => {
  try {
    let employeeFilter = {};
    if (audience === 'department' && department) {
      employeeFilter = { department };
    }
    const employees = await global.dbo.collection('employees').find(employeeFilter, { projection: { _id: 1 } }).toArray();
    const employeeIds = employees.map(e => e._id);
    if (!employeeIds.length) return;

    const users = await global.dbo.collection('users')
      .find({ employeeId: { $in: employeeIds } }, { projection: { _id: 1 } })
      .toArray();

    await Promise.all(users.map(u => notifyUser(u._id, payload)));
  } catch {
    // Non-critical
  }
};

module.exports = { notifyUser, notifyEmployee, notifyByRoles, notifyStaffByAudience };
