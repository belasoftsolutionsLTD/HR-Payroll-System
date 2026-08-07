// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 5) — enrollments, courses, learningPaths now live in Postgres. `employeeId`
// on an enrollment is a users.id (see trainingFunctions.js's own header comment for
// the full naming-quirk explanation) — users has been Postgres since Phase 1.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const { notifyUser } = require('../../functions/HR/notifyUser');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

// Shared between trainingFunctions.js (HR assignment + employee progress routes) and
// autoEnrollment.js (rule engine) — kept in its own module so neither has to require
// the other directly (avoids a circular require between the two).

const recomputeProgress = (moduleProgress, requiredModuleIds) => {
  if (!requiredModuleIds.length) return { progressPercentage: 0, status: 'notStarted' };
  const completedCount = requiredModuleIds.filter((mid) => {
    const mp = moduleProgress.find((m) => String(m.moduleId) === String(mid));
    return mp?.status === 'completed';
  }).length;
  const progressPercentage = Math.round((completedCount / requiredModuleIds.length) * 100);
  const anyStarted = moduleProgress.some((m) => m.status !== 'notStarted');
  const status = completedCount === requiredModuleIds.length ? 'completed' : anyStarted ? 'inProgress' : 'notStarted';
  return { progressPercentage, status };
};

const createSingleCourseEnrollment = async ({ employeeId, courseId, learningPathId = null, enrolledBy, enrollmentTrigger, dueDate }) => {
  const existing = await knex('enrollments').where({ employeeId: String(employeeId), courseId: String(courseId) }).first();
  if (existing) return { created: false, _id: existing.id };

  const id = newId();
  const doc = {
    id, employeeId: String(employeeId), courseId: String(courseId), learningPathId: learningPathId ? String(learningPathId) : null,
    enrolledBy: enrolledBy ? String(enrolledBy) : null, enrollmentTrigger,
    dueDate: dueDate || null,
    status: 'notStarted',
    completedAt: null,
    progressPercentage: 0,
    moduleProgress: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await knex('enrollments').insert(doc);
  notifyUser(employeeId, {
    title: 'New Training Assigned',
    body: 'You have been assigned a new course.',
    type: 'training',
    link: `/my/training/courses/${courseId}/learn`,
  }).catch(() => {});
  (async () => {
    const [user, course] = await Promise.all([
      knex('users').where({ id: String(employeeId) }).select('email', 'name').first(),
      knex('courses').where({ id: String(courseId) }).select('title').first(),
    ]);
    if (!user?.email) return;
    const tokens = { employeeName: user.name || 'there', courseTitle: course?.title || 'a new course' };
    sendTemplatedEmail({
      trigger: 'trainingCourseAssigned', to: user.email, tokens,
      fallbackSubject: 'New training assigned',
      fallbackHtml: `<p>Dear ${tokens.employeeName},</p><p>You have been assigned a new course: "${tokens.courseTitle}".</p>`,
    }).catch(() => {});
  })().catch(() => {});
  return { created: true, _id: id };
};

const createLearningPathEnrollment = async ({ employeeId, learningPathId, enrolledBy, enrollmentTrigger, dueDate }) => {
  const existingPathEnrollment = await knex('enrollments').where({ employeeId: String(employeeId), learningPathId: String(learningPathId) }).whereNull('courseId').first();
  if (existingPathEnrollment) return { created: false, _id: existingPathEnrollment.id };

  const path_ = await knex('learning_paths').where({ id: String(learningPathId) }).first();
  if (!path_) return { created: false, error: 'Learning path not found.' };

  const id = newId();
  const doc = {
    id, employeeId: String(employeeId), courseId: null, learningPathId: String(learningPathId),
    enrolledBy: enrolledBy ? String(enrolledBy) : null, enrollmentTrigger,
    dueDate: dueDate || null,
    status: 'notStarted',
    completedAt: null,
    progressPercentage: 0,
    moduleProgress: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await knex('enrollments').insert(doc);

  // Also enroll the employee in each course that makes up the path, so it shows up
  // in their regular course list and can be started/continued individually.
  for (const c of (path_.courses || [])) {
    await createSingleCourseEnrollment({
      employeeId, courseId: c.courseId, learningPathId,
      enrolledBy, enrollmentTrigger, dueDate,
    });
  }

  notifyUser(employeeId, {
    title: 'New Learning Path Assigned',
    body: `You have been enrolled in "${path_.name}".`,
    type: 'training',
    link: `/my/training/learning-paths/${learningPathId}`,
  }).catch(() => {});
  (async () => {
    const user = await knex('users').where({ id: String(employeeId) }).select('email', 'name').first();
    if (!user?.email) return;
    const tokens = { employeeName: user.name || 'there', pathName: path_.name };
    sendTemplatedEmail({
      trigger: 'trainingPathAssigned', to: user.email, tokens,
      fallbackSubject: 'New learning path assigned',
      fallbackHtml: `<p>Dear ${tokens.employeeName},</p><p>You have been enrolled in "${tokens.pathName}".</p>`,
    }).catch(() => {});
  })().catch(() => {});

  return { created: true, _id: id };
};

// When a course-level enrollment that belongs to a learning path completes, recompute
// the parent path-level enrollment's aggregate progress (and mark it completed once
// every required course in the path is done).
const maybeAdvanceLearningPath = async (courseEnrollment) => {
  if (!courseEnrollment.learningPathId) return;

  const pathEnrollment = await knex('enrollments').where({
    employeeId: String(courseEnrollment.employeeId), learningPathId: String(courseEnrollment.learningPathId),
  }).whereNull('courseId').first();
  if (!pathEnrollment) return;

  const path_ = await knex('learning_paths').where({ id: String(courseEnrollment.learningPathId) }).first();
  if (!path_) return;

  const courseIds = (path_.courses || []).map((c) => c.courseId);
  const requiredCourseIds = (path_.courses || []).filter((c) => c.isRequired).map((c) => c.courseId);
  const courseEnrollments = courseIds.length
    ? await knex('enrollments').where({ employeeId: String(courseEnrollment.employeeId) }).whereIn('courseId', courseIds).select('courseId', 'status')
    : [];
  const statusByCourse = Object.fromEntries(courseEnrollments.map((e) => [e.courseId, e.status]));

  const completedRequired = requiredCourseIds.filter((cid) => statusByCourse[cid] === 'completed').length;
  const progressPercentage = requiredCourseIds.length ? Math.round((completedRequired / requiredCourseIds.length) * 100) : 0;
  const allDone = requiredCourseIds.length > 0 && completedRequired === requiredCourseIds.length;

  const now = new Date();
  await knex('enrollments').where({ id: pathEnrollment.id }).update({
    progressPercentage,
    status: allDone ? 'completed' : progressPercentage > 0 ? 'inProgress' : 'notStarted',
    ...(allDone && pathEnrollment.status !== 'completed' ? { completedAt: now } : {}),
    updatedAt: now,
  });
};

module.exports = {
  recomputeProgress, createSingleCourseEnrollment, createLearningPathEnrollment, maybeAdvanceLearningPath,
};
