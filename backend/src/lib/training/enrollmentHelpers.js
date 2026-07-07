const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { notifyUser } = require('../../functions/HR/notifyUser');

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
  const existing = await findOne('enrollments', { employeeId, courseId });
  if (existing) return { created: false, _id: existing._id };

  const doc = {
    employeeId, courseId, learningPathId,
    enrolledBy, enrollmentTrigger,
    dueDate: dueDate || null,
    status: 'notStarted',
    completedAt: null,
    progressPercentage: 0,
    moduleProgress: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('enrollments', doc);
  notifyUser(employeeId, {
    title: 'New Training Assigned',
    body: 'You have been assigned a new course.',
    type: 'training',
  }).catch(() => {});
  return { created: true, _id: result.insertedId };
};

const createLearningPathEnrollment = async ({ employeeId, learningPathId, enrolledBy, enrollmentTrigger, dueDate }) => {
  const existingPathEnrollment = await findOne('enrollments', { employeeId, learningPathId, courseId: null });
  if (existingPathEnrollment) return { created: false, _id: existingPathEnrollment._id };

  const path_ = await findOne('learningPaths', { _id: learningPathId });
  if (!path_) return { created: false, error: 'Learning path not found.' };

  const doc = {
    employeeId, courseId: null, learningPathId,
    enrolledBy, enrollmentTrigger,
    dueDate: dueDate || null,
    status: 'notStarted',
    completedAt: null,
    progressPercentage: 0,
    moduleProgress: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('enrollments', doc);

  // Also enroll the employee in each course that makes up the path, so it shows up
  // in their regular course list and can be started/continued individually.
  for (const c of path_.courses) {
    await createSingleCourseEnrollment({
      employeeId, courseId: c.courseId, learningPathId,
      enrolledBy, enrollmentTrigger, dueDate,
    });
  }

  notifyUser(employeeId, {
    title: 'New Learning Path Assigned',
    body: `You have been enrolled in "${path_.name}".`,
    type: 'training',
  }).catch(() => {});

  return { created: true, _id: result.insertedId };
};

// When a course-level enrollment that belongs to a learning path completes, recompute
// the parent path-level enrollment's aggregate progress (and mark it completed once
// every required course in the path is done).
const maybeAdvanceLearningPath = async (courseEnrollment) => {
  if (!courseEnrollment.learningPathId) return;

  const pathEnrollment = await findOne('enrollments', {
    employeeId: courseEnrollment.employeeId, learningPathId: courseEnrollment.learningPathId, courseId: null,
  });
  if (!pathEnrollment) return;

  const path_ = await findOne('learningPaths', { _id: courseEnrollment.learningPathId });
  if (!path_) return;

  const requiredCourseIds = path_.courses.filter((c) => c.isRequired).map((c) => c.courseId);
  const courseEnrollments = await findMany('enrollments', {
    employeeId: courseEnrollment.employeeId,
    courseId: { $in: path_.courses.map((c) => c.courseId) },
  }, { projection: { courseId: 1, status: 1 } });
  const statusByCourse = Object.fromEntries(courseEnrollments.map((e) => [String(e.courseId), e.status]));

  const completedRequired = requiredCourseIds.filter((cid) => statusByCourse[String(cid)] === 'completed').length;
  const progressPercentage = requiredCourseIds.length ? Math.round((completedRequired / requiredCourseIds.length) * 100) : 0;
  const allDone = requiredCourseIds.length > 0 && completedRequired === requiredCourseIds.length;

  const now = new Date();
  await updateOne('enrollments', { _id: pathEnrollment._id }, {
    $set: {
      progressPercentage,
      status: allDone ? 'completed' : progressPercentage > 0 ? 'inProgress' : 'notStarted',
      ...(allDone && pathEnrollment.status !== 'completed' ? { completedAt: now } : {}),
      updatedAt: now,
    },
  });
};

module.exports = {
  recomputeProgress, createSingleCourseEnrollment, createLearningPathEnrollment, maybeAdvanceLearningPath,
};
