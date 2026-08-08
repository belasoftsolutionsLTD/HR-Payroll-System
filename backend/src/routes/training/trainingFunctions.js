const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 5) — courses, course_modules, enrollments, learning_paths, quizzes,
// certificates, external_certificates, training_assignment_rules,
// rule_execution_logs, training_feedback, training_sessions, users, counters all
// now live in Postgres.
const { knex, newId, insertOne, updateOne } = require('../../functions/Database/pgDBFunctions');
const { notifyUser, notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');
const { sendTemplatedEmail } = require('../../services/emailTemplateService');

const emailUserByTrigger = async (userId, trigger, tokens, fallbackSubject, fallbackHtml) => {
  const user = await knex('users').where({ id: String(userId) }).select('email').first();
  if (!user?.email) return;
  return sendTemplatedEmail({ trigger, to: user.email, tokens, fallbackSubject, fallbackHtml }).catch(() => {});
};
const { generateCertificatePDF } = require('../../lib/training/generateCertificate');
const {
  recomputeProgress, createSingleCourseEnrollment, createLearningPathEnrollment, maybeAdvanceLearningPath,
} = require('../../lib/training/enrollmentHelpers');
const { runRule } = require('../../lib/training/autoEnrollment');

const COURSE_CATEGORIES = ['Compliance', 'Onboarding', 'Leadership', 'Technical', 'Soft Skills'];
const COURSE_STATUSES = ['draft', 'published', 'archived'];
const MODULE_TYPES = ['video', 'document', 'text', 'quiz', 'scorm', 'link'];
const DELIVERY_METHODS = ['self_paced', 'instructor_led'];
const SESSION_STATUSES = ['scheduled', 'completed', 'cancelled'];
const ENROLLMENT_STATUSES = ['notStarted', 'inProgress', 'completed', 'overdue', 'waived'];

// ── Courses (HR admin) ────────────────────────────────────────────────────────

const createCourse = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'description', 'category', 'estimatedDurationMinutes', 'difficultyLevel'])) return;
  if (!COURSE_CATEGORIES.includes(req.body.category)) return returnFunction(res, 400, false, `category must be one of: ${COURSE_CATEGORIES.join(', ')}`);

  const doc = {
    id: newId(),
    title: req.body.title.trim(),
    description: req.body.description,
    coverImageUrl: req.body.coverImageUrl || null,
    category: req.body.category,
    tags: Array.isArray(req.body.tags) ? req.body.tags : [],
    skillsTaught: Array.isArray(req.body.skillsTaught) ? req.body.skillsTaught : [],
    estimatedDurationMinutes: Number(req.body.estimatedDurationMinutes),
    difficultyLevel: req.body.difficultyLevel,
    status: 'draft',
    isMandatory: !!req.body.isMandatory,
    targetRoles: Array.isArray(req.body.targetRoles) ? req.body.targetRoles : [],
    targetDepartments: Array.isArray(req.body.targetDepartments) ? req.body.targetDepartments : [],
    hasCertificate: !!req.body.hasCertificate,
    certificateValidityDays: req.body.certificateValidityDays ? Number(req.body.certificateValidityDays) : null,
    deliveryMethod: DELIVERY_METHODS.includes(req.body.deliveryMethod) ? req.body.deliveryMethod : 'self_paced',
    createdBy: req.user.id,
    authors: [req.user.id],
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('courses', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listCourses = async (req, res) => {
  let query = knex('courses');
  if (req.query.category) query = query.where({ category: req.query.category });
  if (req.query.status) query = query.where({ status: req.query.status });
  if (req.query.isMandatory !== undefined) query = query.where({ isMandatory: req.query.isMandatory === 'true' });
  if (req.query.author) query = query.whereRaw('"authors" @> ?::text[]', [[req.query.author]]);

  const { page, limit, skip } = getPagination(req.query);
  const [{ count }] = await query.clone().count('* as count');
  const data = await query.orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const ids = data.map((c) => c.id);
  const [enrollCounts, completedCounts] = ids.length ? await Promise.all([
    knex('enrollments').whereIn('courseId', ids).select('courseId').count('* as count').groupBy('courseId'),
    knex('enrollments').whereIn('courseId', ids).where({ status: 'completed' }).select('courseId').count('* as count').groupBy('courseId'),
  ]) : [[], []];
  const enrollMap = Object.fromEntries(enrollCounts.map((c) => [c.courseId, Number(c.count)]));
  const completeMap = Object.fromEntries(completedCounts.map((c) => [c.courseId, Number(c.count)]));

  const enriched = data.map((c) => {
    const enrolledCount = enrollMap[c.id] || 0;
    const completedCount = completeMap[c.id] || 0;
    return { ...c, enrolledCount, completionRate: enrolledCount > 0 ? Math.round((completedCount / enrolledCount) * 100) : 0 };
  });

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const getCourse = async (req, res) => {
  const course = await knex('courses').where({ id: req.params.id }).first();
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);

  const modules = await knex('course_modules').where({ courseId: course.id }).orderBy('order');
  const [{ count: enrolledCount }] = await knex('enrollments').where({ courseId: course.id }).count('* as count');
  return returnFunction(res, 200, true, req.locale.success, { ...course, modules, enrolledCount: Number(enrolledCount) });
};

// A course with role/department targeting shouldn't also need HR to separately visit
// Assignment Center and hand-pick the exact same audience they already specified here —
// this auto-enrolls every currently active user matching that targeting, the moment it's
// set (on initial publish, and again on any later edit to targeting on an already-
// published course — see updateCourse). createSingleCourseEnrollment already no-ops on
// an existing enrollment, so re-running this is always safe to repeat.
// Untargeted courses (open to everyone) are deliberately NOT auto-enrolled this way —
// blasting an enrollment to the entire company by default would be too blunt; those rely
// on self-enroll (non-mandatory — see isEligibleForSelfEnroll) or a manual/rule-based
// assignment (mandatory with no targeting — see the notifyByRoles fallback below).
const autoEnrollTargetedUsers = async (course, actingUserId) => {
  let query = knex('users').whereNot({ isActive: false });
  if (course.targetRoles?.length) query = query.whereIn('role', course.targetRoles);
  if (course.targetDepartments?.length) query = query.whereIn('department', course.targetDepartments);

  const users = await query.select('id');
  let created = 0;
  for (const user of users) {
    const result = await createSingleCourseEnrollment({
      employeeId: user.id, courseId: course.id, enrolledBy: actingUserId, enrollmentTrigger: 'auto_targeted',
    });
    if (result.created) created += 1;
  }
  return created;
};

const isTargeted = (course) => (course.targetRoles?.length > 0) || (course.targetDepartments?.length > 0);

const updateCourse = async (req, res) => {
  const allowed = [
    'title', 'description', 'coverImageUrl', 'category', 'tags', 'skillsTaught',
    'estimatedDurationMinutes', 'difficultyLevel', 'isMandatory', 'targetRoles',
    'targetDepartments', 'hasCertificate', 'certificateValidityDays',
  ];
  const update = { updatedAt: new Date() };
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

  const before = await knex('courses').where({ id: req.params.id }).first();
  if (!before) return returnFunction(res, 404, false, req.locale.notFound);

  await knex('courses').where({ id: before.id }).update(update);

  let autoEnrolledCount = 0;
  const targetingChanged = req.body.targetRoles !== undefined || req.body.targetDepartments !== undefined;
  if (before.status === 'published' && targetingChanged) {
    const course = { ...before, ...update };
    if (isTargeted(course)) autoEnrolledCount = await autoEnrollTargetedUsers(course, req.user.id);
  }

  return returnFunction(res, 200, true, autoEnrolledCount > 0
    ? `${req.locale.updatedSuccessfully} ${autoEnrolledCount} matching employee(s) auto-enrolled.`
    : req.locale.updatedSuccessfully);
};

const publishCourse = async (req, res) => {
  const course = await knex('courses').where({ id: req.params.id }).first();
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);

  if (course.deliveryMethod === 'instructor_led') {
    const [{ count: sessionCount }] = await knex('training_sessions').where({ courseId: course.id }).whereNot({ status: 'cancelled' }).count('* as count');
    if (!Number(sessionCount)) return returnFunction(res, 400, false, 'Schedule at least one session before publishing.');
  } else {
    const [{ count: moduleCount }] = await knex('course_modules').where({ courseId: course.id }).count('* as count');
    if (!Number(moduleCount)) return returnFunction(res, 400, false, 'Add at least one module before publishing.');
  }

  await knex('courses').where({ id: course.id }).update({ status: 'published', publishedAt: new Date(), updatedAt: new Date() });

  const targeted = isTargeted(course);
  const autoEnrolledCount = targeted ? await autoEnrollTargetedUsers(course, req.user.id) : 0;

  // Only still needed when there's no targeting to auto-enroll from — a targeted course
  // just handled its own audience above, so telling HR to "assign it" would be stale advice.
  if (course.isMandatory && !targeted) {
    notifyByRoles(['super_admin', 'hr_manager'], {
      title: 'Mandatory Course Published',
      body: `"${course.title}" is now published and marked mandatory, with no target roles/departments set — assign it to the relevant audience or add targeting so it enrolls automatically.`,
      type: 'training',
      link: `/training/courses/${course.id}`,
    }).catch(() => {});
  }

  return returnFunction(res, 200, true, targeted ? `Course published. ${autoEnrolledCount} matching employee(s) auto-enrolled.` : 'Course published.');
};

const archiveCourse = async (req, res) => {
  const [updated] = await knex('courses').where({ id: req.params.id }).update({ status: 'archived', updatedAt: new Date() }).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// $addToSet on a native Postgres array — a fetch-check-append is simplest and safe
// here (courses.authors is small and edited one HR action at a time, no real
// concurrent-write race to worry about), matching the file's general JS-side idiom
// rather than reaching for a raw array_append + NOT @> guard.
const addCourseAuthor = async (req, res) => {
  if (!validateRequiredFields(req, res, ['authorId'])) return;
  const course = await knex('courses').where({ id: req.params.id }).first();
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);

  const authorId = String(req.body.authorId);
  const authors = course.authors || [];
  if (!authors.includes(authorId)) authors.push(authorId);
  await knex('courses').where({ id: course.id }).update({ authors, updatedAt: new Date() });
  return returnFunction(res, 200, true, 'Co-author added.');
};

// ── Catalog (employee — published courses only) ──────────────────────────────

// Whether a course's targetRoles/targetDepartments (empty = open to all) match the
// given user — used to decide catalog VISIBILITY (see below), separate from
// isEligibleForSelfEnroll further down, which additionally requires non-mandatory
// and gates ENROLLMENT rather than just seeing the course exists.
const matchesCourseTargeting = (course, user) => {
  if (course.targetRoles?.length && !course.targetRoles.includes(user.role)) return false;
  if (course.targetDepartments?.length && !course.targetDepartments.includes(user.department)) return false;
  return true;
};

const listCatalog = async (req, res) => {
  let query = knex('courses').where({ status: 'published' });
  if (req.query.category) query = query.where({ category: req.query.category });
  if (req.query.difficultyLevel) query = query.where({ difficultyLevel: req.query.difficultyLevel });
  if (req.query.skill) query = query.whereRaw('"skillsTaught" @> ?::text[]', [[req.query.skill]]);

  const courses = await query.orderBy('publishedAt', 'desc');

  const ids = courses.map((c) => c.id);
  const [ratingRows, myEnrollments] = await Promise.all([
    ids.length ? knex('training_feedback').whereIn('courseId', ids).select('courseId').avg('rating as avgRating').groupBy('courseId') : [],
    knex('enrollments').where({ employeeId: String(req.user.id) }).whereIn('courseId', ids).select('courseId', 'status', 'progressPercentage'),
  ]);
  const ratingMap = Object.fromEntries(ratingRows.map((r) => [r.courseId, Math.round(Number(r.avgRating) * 10) / 10]));
  const enrollMap = Object.fromEntries(myEnrollments.map((e) => [e.courseId, e]));

  const enriched = courses.map((c) => ({
    ...c,
    avgRating: ratingMap[c.id] || null,
    myEnrollment: enrollMap[c.id] || null,
  }));

  // A course outside your role/department shouldn't even show up as a locked entry —
  // it should be invisible, same as it not existing. Already being enrolled always
  // wins over current targeting (e.g. targeting was edited, or you changed department,
  // after you were assigned) — you never lose visibility into something you're already
  // partway through.
  const visible = enriched.filter((c) => c.myEnrollment || matchesCourseTargeting(c, req.user));

  return returnFunction(res, 200, true, req.locale.success, visible);
};

const getCatalogCourse = async (req, res) => {
  const course = await knex('courses').where({ id: req.params.id, status: 'published' }).first();
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);

  const myEnrollment = await knex('enrollments').where({ employeeId: String(req.user.id), courseId: course.id }).first();
  if (!myEnrollment && !matchesCourseTargeting(course, req.user)) return returnFunction(res, 404, false, req.locale.notFound);

  const modules = await knex('course_modules').where({ courseId: course.id }).orderBy('order');

  return returnFunction(res, 200, true, req.locale.success, { ...course, modules, myEnrollment: myEnrollment || null });
};

// Learner-facing quiz fetch — correctAnswer/explanation are always stripped, and access is
// gated on the requester actually being enrolled in the parent course (not just it being published).
const getModuleQuizForLearner = async (req, res) => {
  const module_ = await knex('course_modules').where({ id: req.params.moduleId }).first();
  if (!module_ || module_.type !== 'quiz') return returnFunction(res, 404, false, 'Quiz module not found.');

  const enrollment = await knex('enrollments').where({ employeeId: String(req.user.id), courseId: module_.courseId }).first();
  if (!enrollment) return returnFunction(res, 403, false, req.locale.noPermission || 'Permission denied.');

  const quiz = await knex('quizzes').where({ moduleId: module_.id }).first();
  if (!quiz) return returnFunction(res, 404, false, 'Quiz not configured for this module.');

  const sanitized = {
    ...quiz,
    questions: quiz.questions.map(({ correctAnswer, explanation, ...q }) => q),
  };
  return returnFunction(res, 200, true, req.locale.success, sanitized);
};

// ── Modules (HR admin) ────────────────────────────────────────────────────────

const addModule = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'type'])) return;
  if (!MODULE_TYPES.includes(req.body.type)) return returnFunction(res, 400, false, `type must be one of: ${MODULE_TYPES.join(', ')}`);

  const course = await knex('courses').where({ id: req.params.id }).first();
  if (!course) return returnFunction(res, 404, false, 'Course not found.');

  let order = req.body.order;
  if (order === undefined) {
    const last = await knex('course_modules').where({ courseId: course.id }).orderBy('order', 'desc').first();
    order = last ? last.order + 1 : 0;
  }

  const doc = {
    id: newId(),
    courseId: course.id,
    title: req.body.title.trim(),
    order: Number(order),
    type: req.body.type,
    content: JSON.stringify(typeof req.body.content === 'object' && req.body.content ? req.body.content : {}),
    isRequired: req.body.isRequired !== false,
    minimumPassScore: req.body.minimumPassScore !== undefined ? Number(req.body.minimumPassScore) : null,
    createdAt: new Date(),
  };
  const result = await insertOne('course_modules', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const updateModule = async (req, res) => {
  const allowed = ['title', 'order', 'type', 'isRequired', 'minimumPassScore'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
  if (req.body.content !== undefined) update.content = JSON.stringify(req.body.content);

  const [updated] = await knex('course_modules').where({ id: req.params.id }).update(update).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteModule = async (req, res) => {
  const deleted = await knex('course_modules').where({ id: req.params.id }).del();
  if (!deleted) return returnFunction(res, 404, false, req.locale.notFound);
  await knex('quizzes').where({ moduleId: req.params.id }).del();
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Quizzes (HR admin) ────────────────────────────────────────────────────────

const createQuiz = async (req, res) => {
  if (!validateRequiredFields(req, res, ['questions', 'passingScore'])) return;
  if (!Array.isArray(req.body.questions) || !req.body.questions.length) {
    return returnFunction(res, 400, false, 'Add at least one question.');
  }

  const module_ = await knex('course_modules').where({ id: req.params.id }).first();
  if (!module_) return returnFunction(res, 404, false, 'Module not found.');

  const existing = await knex('quizzes').where({ moduleId: module_.id }).first();
  if (existing) return returnFunction(res, 409, false, 'This module already has a quiz. Use PATCH to edit it.');

  const doc = {
    id: newId(),
    moduleId: module_.id,
    courseId: module_.courseId,
    questions: JSON.stringify(req.body.questions),
    passingScore: Number(req.body.passingScore),
    maxAttempts: req.body.maxAttempts ? Number(req.body.maxAttempts) : 3,
    shuffleQuestions: !!req.body.shuffleQuestions,
    shuffleOptions: !!req.body.shuffleOptions,
    timeLimitMinutes: req.body.timeLimitMinutes ? Number(req.body.timeLimitMinutes) : null,
  };
  const result = await insertOne('quizzes', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const updateQuiz = async (req, res) => {
  const allowed = ['passingScore', 'maxAttempts', 'shuffleQuestions', 'shuffleOptions', 'timeLimitMinutes'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
  if (req.body.questions !== undefined) update.questions = JSON.stringify(req.body.questions);

  const [updated] = await knex('quizzes').where({ id: req.params.id }).update(update).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Learning Paths (HR admin) ─────────────────────────────────────────────────

const createLearningPath = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'description', 'courses', 'enrollmentTrigger'])) return;
  if (!Array.isArray(req.body.courses) || !req.body.courses.length) {
    return returnFunction(res, 400, false, 'Add at least one course.');
  }

  const doc = {
    id: newId(),
    name: req.body.name.trim(),
    description: req.body.description,
    courses: JSON.stringify(req.body.courses.map((c) => ({
      courseId: String(c.courseId),
      order: Number(c.order) || 0,
      isRequired: c.isRequired !== false,
      unlockAfterCourseId: c.unlockAfterCourseId ? String(c.unlockAfterCourseId) : null,
    }))),
    targetRoles: Array.isArray(req.body.targetRoles) ? req.body.targetRoles : [],
    targetDepartments: Array.isArray(req.body.targetDepartments) ? req.body.targetDepartments : [],
    enrollmentTrigger: req.body.enrollmentTrigger,
    dueDateOffsetDays: req.body.dueDateOffsetDays ? Number(req.body.dueDateOffsetDays) : null,
    status: 'active',
    createdBy: req.user.id,
    createdAt: new Date(),
  };
  const result = await insertOne('learning_paths', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listLearningPaths = async (req, res) => {
  let query = knex('learning_paths');
  if (req.query.status) query = query.where({ status: req.query.status });
  const paths = await query.orderBy('createdAt', 'desc');

  const ids = paths.map((p) => p.id);
  const counts = ids.length
    ? await knex('enrollments').whereIn('learningPathId', ids).select('learningPathId').count('* as count').groupBy('learningPathId')
    : [];
  const countMap = Object.fromEntries(counts.map((c) => [c.learningPathId, Number(c.count)]));

  return returnFunction(res, 200, true, req.locale.success, paths.map((p) => ({ ...p, enrolledCount: countMap[p.id] || 0 })));
};

const getLearningPath = async (req, res) => {
  const path_ = await knex('learning_paths').where({ id: req.params.id }).first();
  if (!path_) return returnFunction(res, 404, false, req.locale.notFound);

  const courseIds = (path_.courses || []).map((c) => c.courseId);
  const courses = courseIds.length
    ? await knex('courses').whereIn('id', courseIds).select('id', 'title', 'category', 'estimatedDurationMinutes')
    : [];
  const courseMap = Object.fromEntries(courses.map((c) => [c.id, c]));

  return returnFunction(res, 200, true, req.locale.success, {
    ...path_,
    courses: (path_.courses || []).map((c) => ({ ...c, course: courseMap[c.courseId] || null })),
  });
};

const updateLearningPath = async (req, res) => {
  const allowed = ['name', 'description', 'targetRoles', 'targetDepartments', 'enrollmentTrigger', 'dueDateOffsetDays'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
  if (req.body.courses !== undefined) {
    update.courses = JSON.stringify(req.body.courses.map((c) => ({
      courseId: String(c.courseId),
      order: Number(c.order) || 0,
      isRequired: c.isRequired !== false,
      unlockAfterCourseId: c.unlockAfterCourseId ? String(c.unlockAfterCourseId) : null,
    })));
  }

  const [updated] = await knex('learning_paths').where({ id: req.params.id }).update(update).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const archiveLearningPath = async (req, res) => {
  const [updated] = await knex('learning_paths').where({ id: req.params.id }).update({ status: 'archived' }).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Enrollments ────────────────────────────────────────────────────────────────
// `employeeId` on an enrollment is the learner's `users.id` (i.e. the JWT's userId) —
// this is what every employee-facing route scopes against, matching the security
// requirement that an employee can only ever see rows where employeeId === req.user.id.
// createSingleCourseEnrollment/createLearningPathEnrollment/recomputeProgress/
// maybeAdvanceLearningPath live in lib/training/enrollmentHelpers.js (shared with the
// autoEnrollment rule engine, which would otherwise circularly require this file).

const assignTraining = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeIds'])) return;
  if (!Array.isArray(req.body.employeeIds) || !req.body.employeeIds.length) return returnFunction(res, 400, false, 'Select at least one employee.');
  if (!req.body.courseId && !req.body.learningPathId) return returnFunction(res, 400, false, 'Select a course or a learning path.');

  const courseId = req.body.courseId ? String(req.body.courseId) : null;
  const learningPathId = req.body.learningPathId ? String(req.body.learningPathId) : null;
  const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
  const enrolledBy = req.user.id;

  let createdCount = 0;
  for (const empId of req.body.employeeIds) {
    const employeeId = String(empId);
    const result = courseId
      ? await createSingleCourseEnrollment({ employeeId, courseId, enrolledBy, enrollmentTrigger: 'manual', dueDate })
      : await createLearningPathEnrollment({ employeeId, learningPathId, enrolledBy, enrollmentTrigger: 'manual', dueDate });
    if (result.created) createdCount += 1;
  }

  return returnFunction(res, 201, true, `${createdCount} enrollment(s) created.`, {
    created: createdCount, skipped: req.body.employeeIds.length - createdCount,
  });
};

const listEnrollments = async (req, res) => {
  let query = knex('enrollments');
  if (req.query.courseId) query = query.where({ courseId: req.query.courseId });
  if (req.query.learningPathId) query = query.where({ learningPathId: req.query.learningPathId });
  if (req.query.employeeId) query = query.where({ employeeId: req.query.employeeId });
  if (req.query.status) query = query.where({ status: req.query.status });

  const { page, limit, skip } = getPagination(req.query);
  const [{ count }] = await query.clone().count('* as count');
  const data = await query.orderBy('createdAt', 'desc').limit(limit).offset(skip);

  const employeeIds = [...new Set(data.map((e) => e.employeeId))];
  const courseIds = [...new Set(data.filter((e) => e.courseId).map((e) => e.courseId))];
  const [users, courses] = await Promise.all([
    employeeIds.length ? knex('users').whereIn('id', employeeIds).select('id', 'name', 'department', 'email') : [],
    courseIds.length ? knex('courses').whereIn('id', courseIds).select('id', 'title', 'category', 'isMandatory', 'hasCertificate') : [],
  ]);
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const courseMap = Object.fromEntries(courses.map((c) => [c.id, c]));

  const enriched = data.map((e) => ({
    ...e,
    employee: userMap[e.employeeId] ? { _id: e.employeeId, fullName: userMap[e.employeeId].name, department: userMap[e.employeeId].department } : null,
    course: e.courseId ? courseMap[e.courseId] || null : null,
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, Number(count), page, limit));
};

const waiveEnrollment = async (req, res) => {
  const [updated] = await knex('enrollments').where({ id: req.params.id }).update({
    status: 'waived', completedAt: new Date(), updatedAt: new Date(),
  }).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, 'Enrollment waived.');
};

// ── Employee — own enrollments only (scoped to req.user.id) ─────────────────

// Self-service enrollment for the catalog above (browsing already only shows courses
// matching your role/department — see matchesCourseTargeting/listCatalog — with
// myEnrollment attached). This is the one narrow additional path beyond assignTraining/
// automation rules: a published, NON-mandatory course whose targetRoles/targetDepartments
// (empty = open to all) match the requester can be self-enrolled directly from there.
// Mandatory/compliance courses deliberately stay assignment/rule-driven — those need due
// dates and an audit trail of who assigned them and why, which self-serve would undermine.
const isEligibleForSelfEnroll = (course, user) => {
  if (course.status !== 'published' || course.isMandatory) return false;
  if (!matchesCourseTargeting(course, user)) return false;
  return true;
};

const selfEnroll = async (req, res) => {
  const course = await knex('courses').where({ id: req.params.id }).first();
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);
  if (!isEligibleForSelfEnroll(course, req.user)) {
    return returnFunction(res, 403, false, 'This course is not available for self-enrollment.');
  }

  const result = await createSingleCourseEnrollment({
    employeeId: req.user.id,
    courseId: course.id,
    enrolledBy: req.user.id,
    enrollmentTrigger: 'self_registered',
  });
  if (!result.created) return returnFunction(res, 409, false, 'You are already enrolled in this course.');

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result._id });
};

const getMyEnrollments = async (req, res) => {
  let query = knex('enrollments').where({ employeeId: String(req.user.id) });
  if (req.query.status) query = query.where({ status: req.query.status });
  const enrollments = await query.orderBy('createdAt', 'desc');

  const courseIds = [...new Set(enrollments.filter((e) => e.courseId).map((e) => e.courseId))];
  const courses = courseIds.length ? await knex('courses').whereIn('id', courseIds) : [];
  const courseMap = Object.fromEntries(courses.map((c) => [c.id, c]));

  const enriched = enrollments.map((e) => ({
    ...e,
    course: e.courseId ? courseMap[e.courseId] || null : null,
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const updateMyProgress = async (req, res) => {
  if (!validateRequiredFields(req, res, ['moduleId', 'status'])) return;
  if (!['notStarted', 'inProgress', 'completed'].includes(req.body.status)) return returnFunction(res, 400, false, 'Invalid status.');

  const enrollment = await knex('enrollments').where({ id: req.params.id }).first();
  if (!enrollment) return returnFunction(res, 404, false, req.locale.notFound);
  if (String(enrollment.employeeId) !== String(req.user.id)) return returnFunction(res, 403, false, req.locale.noPermission || 'Permission denied.');
  if (!enrollment.courseId) return returnFunction(res, 400, false, 'This enrollment has no individual course to track progress on.');

  const module_ = await knex('course_modules').where({ id: req.body.moduleId, courseId: enrollment.courseId }).first();
  if (!module_) return returnFunction(res, 404, false, 'Module not found on this course.');
  if (module_.type === 'quiz') return returnFunction(res, 400, false, 'Submit a quiz attempt instead of marking a quiz module complete directly.');

  const now = new Date();
  const moduleProgress = [...(enrollment.moduleProgress || [])];
  const idx = moduleProgress.findIndex((m) => String(m.moduleId) === String(module_.id));
  const existingEntry = idx >= 0 ? moduleProgress[idx] : null;
  const entry = {
    moduleId: module_.id,
    status: req.body.status,
    startedAt: existingEntry?.startedAt || now,
    completedAt: req.body.status === 'completed' ? now : existingEntry?.completedAt,
    attempts: existingEntry?.attempts || 0,
    lastScore: existingEntry?.lastScore,
  };
  if (idx >= 0) moduleProgress[idx] = entry; else moduleProgress.push(entry);

  const requiredModules = await knex('course_modules').where({ courseId: enrollment.courseId, isRequired: true }).select('id');
  const { progressPercentage, status } = recomputeProgress(moduleProgress, requiredModules.map((m) => m.id));

  const update = { moduleProgress: JSON.stringify(moduleProgress), progressPercentage, status, updatedAt: now };
  if (status === 'completed' && enrollment.status !== 'completed') update.completedAt = now;

  await knex('enrollments').where({ id: enrollment.id }).update(update);

  if (status === 'completed' && enrollment.status !== 'completed') {
    await maybeGenerateCertificate(enrollment.id);
    await maybeAdvanceLearningPath({ ...enrollment, status });
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, { progressPercentage, status });
};

const submitCourseFeedback = async (req, res) => {
  if (!validateRequiredFields(req, res, ['rating'])) return;
  const rating = Number(req.body.rating);
  if (![1, 2, 3, 4, 5].includes(rating)) return returnFunction(res, 400, false, 'rating must be between 1 and 5.');

  const enrollment = await knex('enrollments').where({ id: req.params.id }).first();
  if (!enrollment) return returnFunction(res, 404, false, req.locale.notFound);
  if (String(enrollment.employeeId) !== String(req.user.id)) return returnFunction(res, 403, false, req.locale.noPermission || 'Permission denied.');
  if (!['completed', 'waived'].includes(enrollment.status)) return returnFunction(res, 400, false, 'Complete the course before leaving feedback.');

  const existing = await knex('training_feedback').where({ enrollmentId: enrollment.id }).first();
  if (existing) return returnFunction(res, 409, false, 'You have already submitted feedback for this course.');

  const doc = {
    id: newId(),
    enrollmentId: enrollment.id,
    courseId: enrollment.courseId,
    employeeId: req.user.id,
    rating,
    review: req.body.review || null,
    submittedAt: new Date(),
  };
  const result = await insertOne('training_feedback', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

// ── Quiz scoring ───────────────────────────────────────────────────────────────

const answersMatch = (given, correct) => {
  const norm = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).sort() : String(v ?? '').trim().toLowerCase());
  const g = norm(given);
  const c = norm(correct);
  return Array.isArray(g) || Array.isArray(c) ? JSON.stringify(g) === JSON.stringify(c) : g === c;
};

const submitQuizAttempt = async (req, res) => {
  if (!validateRequiredFields(req, res, ['moduleId', 'answers'])) return;
  if (!Array.isArray(req.body.answers)) return returnFunction(res, 400, false, 'answers must be an array.');

  const enrollment = await knex('enrollments').where({ id: req.params.id }).first();
  if (!enrollment) return returnFunction(res, 404, false, req.locale.notFound);
  if (String(enrollment.employeeId) !== String(req.user.id)) return returnFunction(res, 403, false, req.locale.noPermission || 'Permission denied.');
  if (!enrollment.courseId) return returnFunction(res, 400, false, 'This enrollment has no individual course to track progress on.');

  const moduleId = req.body.moduleId;
  const module_ = await knex('course_modules').where({ id: moduleId, courseId: enrollment.courseId }).first();
  if (!module_ || module_.type !== 'quiz') return returnFunction(res, 404, false, 'Quiz module not found on this course.');

  const quiz = await knex('quizzes').where({ moduleId }).first();
  if (!quiz) return returnFunction(res, 404, false, 'Quiz not configured for this module.');

  const existingEntry = (enrollment.moduleProgress || []).find((m) => String(m.moduleId) === String(moduleId));
  const attemptsUsed = existingEntry?.attempts || 0;
  if (attemptsUsed >= quiz.maxAttempts) return returnFunction(res, 400, false, 'No attempts remaining for this quiz.');

  const answerMap = Object.fromEntries(req.body.answers.map((a) => [a.questionId, a.answer]));
  let earned = 0;
  let total = 0;
  const results = quiz.questions.map((q) => {
    total += q.points;
    const given = answerMap[q.id];
    const correct = answersMatch(given, q.correctAnswer);
    if (correct) earned += q.points;
    return {
      questionId: q.id,
      correct,
      pointsEarned: correct ? q.points : 0,
      yourAnswer: given ?? null,
      correctAnswer: q.correctAnswer,
      explanation: q.explanation || null,
    };
  });

  const score = total > 0 ? Math.round((earned / total) * 100) : 0;
  const passed = score >= quiz.passingScore;
  const attemptsRemaining = Math.max(0, quiz.maxAttempts - (attemptsUsed + 1));

  const now = new Date();
  const moduleProgress = [...(enrollment.moduleProgress || [])];
  const idx = moduleProgress.findIndex((m) => String(m.moduleId) === String(moduleId));
  const entry = {
    moduleId,
    status: passed ? 'completed' : 'inProgress',
    startedAt: existingEntry?.startedAt || now,
    completedAt: passed ? now : existingEntry?.completedAt,
    attempts: attemptsUsed + 1,
    lastScore: score,
  };
  if (idx >= 0) moduleProgress[idx] = entry; else moduleProgress.push(entry);

  const requiredModules = await knex('course_modules').where({ courseId: enrollment.courseId, isRequired: true }).select('id');
  const { progressPercentage, status } = recomputeProgress(moduleProgress, requiredModules.map((m) => m.id));

  const update = { moduleProgress: JSON.stringify(moduleProgress), progressPercentage, status, updatedAt: now };
  if (status === 'completed' && enrollment.status !== 'completed') update.completedAt = now;
  await knex('enrollments').where({ id: enrollment.id }).update(update);

  if (status === 'completed' && enrollment.status !== 'completed') {
    await maybeGenerateCertificate(enrollment.id);
    await maybeAdvanceLearningPath({ ...enrollment, status });
  }

  return returnFunction(res, 200, true, passed ? 'Quiz passed.' : 'Quiz not passed.', { score, passed, attemptsRemaining, results });
};

// ── Certificates ───────────────────────────────────────────────────────────────

// Same real transactional-upsert pattern already established in staffNumberGenerator.js
// (Phase 1) — this used to increment a *Mongo* `counters` doc via global.dbo even after
// `counters` itself moved to Postgres in Phase 1, silently diverging from every other
// numbering sequence in the app. Fixed to use the real Postgres counters table.
const generateCertificateNumber = async (year) => {
  const counterName = `certificate_number_${year}`;
  const [row] = await knex('counters')
    .insert({ id: counterName, seq: 1 })
    .onConflict('id')
    .merge({ seq: knex.raw('"counters"."seq" + 1') })
    .returning('*');
  return `CERT-${year}-${String(row.seq).padStart(5, '0')}`;
};

// Idempotent — safe to call every time an enrollment completes; no-ops if the course
// doesn't offer a certificate or one has already been issued for this enrollment.
const maybeGenerateCertificate = async (enrollmentId) => {
  try {
    const enrollment = await knex('enrollments').where({ id: enrollmentId }).first();
    if (!enrollment || !enrollment.courseId) return null;

    const course = await knex('courses').where({ id: enrollment.courseId }).first();
    if (!course?.hasCertificate) return null;

    const existing = await knex('certificates').where({ enrollmentId }).first();
    if (existing) return existing;

    const user = await knex('users').where({ id: enrollment.employeeId }).first();
    const now = new Date();
    const year = now.getFullYear();
    const certificateNumber = await generateCertificateNumber(year);
    const expiresAt = course.certificateValidityDays ? new Date(now.getTime() + course.certificateValidityDays * 86400000) : null;

    // company_settings is Postgres now (Phase 10).
    const settings = await knex('company_settings').first();
    const pdfUrl = await generateCertificatePDF({
      employeeName: user?.name || 'Employee',
      courseTitle: course.title,
      completedAt: enrollment.completedAt || now,
      certificateNumber,
      companyName: settings?.companyName || undefined,
      brandColor: settings?.primaryColor,
      gradientEndColor: settings?.gradientEnabled ? settings?.gradientEndColor : undefined,
      logoPath: settings?.logoPath,
    });

    const doc = {
      id: newId(),
      employeeId: enrollment.employeeId,
      courseId: enrollment.courseId,
      enrollmentId,
      certificateNumber,
      issuedAt: now,
      expiresAt,
      pdfUrl,
    };
    const result = await insertOne('certificates', doc);

    notifyUser(enrollment.employeeId, {
      title: 'Certificate Earned',
      body: `You've earned a certificate for completing "${course.title}".`,
      type: 'training',
      link: '/my/training/certificates',
    }).catch(() => {});
    emailUserByTrigger(enrollment.employeeId, 'trainingCertificateEarned', { courseTitle: course.title },
      'Certificate Earned', `<p>Congratulations! You've earned a certificate for completing "${course.title}".</p>`);

    return result;
  } catch {
    return null; // Non-critical — never let certificate generation block progress updates
  }
};

const generateMyCertificate = async (req, res) => {
  const enrollment = await knex('enrollments').where({ id: req.params.enrollmentId }).first();
  if (!enrollment) return returnFunction(res, 404, false, req.locale.notFound);
  if (String(enrollment.employeeId) !== String(req.user.id)) return returnFunction(res, 403, false, req.locale.noPermission || 'Permission denied.');
  if (enrollment.status !== 'completed') return returnFunction(res, 400, false, 'Complete the course before generating a certificate.');

  const cert = await maybeGenerateCertificate(enrollment.id);
  if (!cert) return returnFunction(res, 400, false, 'This course does not offer a certificate.');
  return returnFunction(res, 200, true, 'Certificate ready.', cert);
};

const getMyCertificates = async (req, res) => {
  const certs = await knex('certificates').where({ employeeId: String(req.user.id) }).orderBy('issuedAt', 'desc');
  const courseIds = certs.map((c) => c.courseId);
  const courses = courseIds.length ? await knex('courses').whereIn('id', courseIds).select('id', 'title') : [];
  const courseMap = Object.fromEntries(courses.map((c) => [c.id, c]));
  return returnFunction(res, 200, true, req.locale.success, certs.map((c) => ({ ...c, course: courseMap[c.courseId] || null })));
};

const getMyLearningPaths = async (req, res) => {
  const enrollments = await knex('enrollments').where({ employeeId: String(req.user.id) }).whereNotNull('learningPathId').whereNull('courseId');
  const pathIds = enrollments.map((e) => e.learningPathId);
  const paths = pathIds.length ? await knex('learning_paths').whereIn('id', pathIds) : [];
  const pathMap = Object.fromEntries(paths.map((p) => [p.id, p]));

  const enriched = enrollments.map((e) => ({ ...e, learningPath: pathMap[e.learningPathId] || null }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── External Certificates ────────────────────────────────────────────────────

const uploadExternalCertificate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'issuingOrganization', 'issuedDate', 'fileUrl'])) return;

  const doc = {
    id: newId(),
    employeeId: req.user.id,
    name: req.body.name.trim(),
    issuingOrganization: req.body.issuingOrganization,
    issuedDate: new Date(req.body.issuedDate),
    expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
    fileUrl: req.body.fileUrl,
    verificationUrl: req.body.verificationUrl || null,
    status: 'pending',
    verifiedBy: null,
    uploadedAt: new Date(),
  };
  const result = await insertOne('external_certificates', doc);

  notifyHR({
    type: 'training', subType: 'external_cert_uploaded',
    title: 'External Certificate Submitted',
    subtitle: `An employee uploaded "${doc.name}" for verification.`,
    referenceId: result.id, referenceModel: 'external_certificates',
    requiresAction: true, triggeredBy: req.user.id,
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const getMyExternalCertificates = async (req, res) => {
  const certs = await knex('external_certificates').where({ employeeId: String(req.user.id) }).orderBy('uploadedAt', 'desc');
  return returnFunction(res, 200, true, req.locale.success, certs);
};

const listExternalCertificates = async (req, res) => {
  let query = knex('external_certificates');
  if (req.query.status) query = query.where({ status: req.query.status });
  const certs = await query.orderBy('uploadedAt', 'desc');

  const employeeIds = [...new Set(certs.map((c) => c.employeeId))];
  const users = employeeIds.length ? await knex('users').whereIn('id', employeeIds).select('id', 'name', 'department') : [];
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  return returnFunction(res, 200, true, req.locale.success, certs.map((c) => ({ ...c, employee: userMap[c.employeeId] || null })));
};

const verifyExternalCertificate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  if (!['verified', 'rejected'].includes(req.body.status)) return returnFunction(res, 400, false, 'status must be verified or rejected.');

  const cert = await knex('external_certificates').where({ id: req.params.id }).first();
  if (!cert) return returnFunction(res, 404, false, req.locale.notFound);

  await knex('external_certificates').where({ id: cert.id }).update({ status: req.body.status, verifiedBy: req.user.id });

  notifyUser(cert.employeeId, {
    title: `External Certificate ${req.body.status === 'verified' ? 'Verified' : 'Rejected'}`,
    body: `Your certificate "${cert.name}" was ${req.body.status}.`,
    type: 'training',
    link: '/my/training/certificates',
  }).catch(() => {});
  emailUserByTrigger(cert.employeeId, 'trainingCertificateReviewed', { certName: cert.name, status: req.body.status },
    `External Certificate ${req.body.status === 'verified' ? 'Verified' : 'Rejected'}`,
    `<p>Your certificate "${cert.name}" was ${req.body.status}.</p>`);

  return returnFunction(res, 200, true, `Certificate ${req.body.status}.`);
};

// ── Assignment Rules (HR admin) ───────────────────────────────────────────────

const RULE_TRIGGERS = ['onHire', 'onRoleChange', 'onDepartmentChange', 'onPerformanceScore', 'onCertExpiry', 'scheduled'];

const createRule = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'trigger', 'action'])) return;
  if (!RULE_TRIGGERS.includes(req.body.trigger)) return returnFunction(res, 400, false, `trigger must be one of: ${RULE_TRIGGERS.join(', ')}`);

  const doc = {
    id: newId(),
    name: req.body.name.trim(),
    trigger: req.body.trigger,
    triggerConditions: JSON.stringify(req.body.triggerConditions || {}),
    action: JSON.stringify({
      enrollInCourseIds: (req.body.action.enrollInCourseIds || []).map(String),
      enrollInLearningPathIds: (req.body.action.enrollInLearningPathIds || []).map(String),
      dueDateOffsetDays: req.body.action.dueDateOffsetDays ?? null,
      notifyEmployee: req.body.action.notifyEmployee !== false,
      notifyManager: !!req.body.action.notifyManager,
    }),
    isActive: req.body.isActive !== false,
    createdBy: req.user.id,
    createdAt: new Date(),
  };
  const result = await insertOne('training_assignment_rules', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id });
};

const listRules = async (req, res) => {
  const rules = await knex('training_assignment_rules').orderBy('createdAt', 'desc');
  const ids = rules.map((r) => r.id);
  // Ported from a Mongo $sort+$group+$first pipeline — same plain-JS idiom as every
  // other aggregate() ported in this migration.
  const logs = ids.length ? await knex('rule_execution_logs').whereIn('ruleId', ids).orderBy('runAt', 'desc') : [];
  const lastRunMap = {};
  for (const l of logs) {
    if (!lastRunMap[l.ruleId]) lastRunMap[l.ruleId] = { lastRunAt: l.runAt, lastRunMatched: l.matched, lastRunCreated: l.created };
  }

  return returnFunction(res, 200, true, req.locale.success, rules.map((r) => ({ ...r, ...(lastRunMap[r.id] || {}) })));
};

const updateRule = async (req, res) => {
  const allowed = ['name', 'trigger', 'isActive'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
  if (req.body.triggerConditions !== undefined) update.triggerConditions = JSON.stringify(req.body.triggerConditions);
  if (req.body.action !== undefined) {
    update.action = JSON.stringify({
      enrollInCourseIds: (req.body.action.enrollInCourseIds || []).map(String),
      enrollInLearningPathIds: (req.body.action.enrollInLearningPathIds || []).map(String),
      dueDateOffsetDays: req.body.action.dueDateOffsetDays ?? null,
      notifyEmployee: req.body.action.notifyEmployee !== false,
      notifyManager: !!req.body.action.notifyManager,
    });
  }

  const [updated] = await knex('training_assignment_rules').where({ id: req.params.id }).update(update).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const runRuleNow = async (req, res) => {
  const rule = await knex('training_assignment_rules').where({ id: req.params.id }).first();
  if (!rule) return returnFunction(res, 404, false, req.locale.notFound);

  const result = await runRule(rule);
  return returnFunction(res, 200, true, `Matched ${result.matched}, created ${result.created} enrollment(s).`, result);
};

// ── Analytics (HR admin) ──────────────────────────────────────────────────────

const getTrainingOverview = async (req, res) => {
  const now = new Date();
  const [
    [{ count: publishedCourses }], [{ count: activeEnrollments }], [{ count: overdueCount }],
    [{ count: expiringCertCount }], [{ count: totalEnrollments }], [{ count: completedEnrollments }],
  ] = await Promise.all([
    knex('courses').where({ status: 'published' }).count('* as count'),
    knex('enrollments').whereIn('status', ['notStarted', 'inProgress']).count('* as count'),
    knex('enrollments').where({ status: 'overdue' }).count('* as count'),
    knex('certificates').where('expiresAt', '>=', now).where('expiresAt', '<=', new Date(now.getTime() + 30 * 86400000)).count('* as count'),
    knex('enrollments').count('* as count'),
    knex('enrollments').where({ status: 'completed' }).count('* as count'),
  ]);

  return returnFunction(res, 200, true, req.locale.success, {
    publishedCourses: Number(publishedCourses),
    activeEnrollments: Number(activeEnrollments),
    orgCompletionRate: Number(totalEnrollments) > 0 ? Math.round((Number(completedEnrollments) / Number(totalEnrollments)) * 100) : 0,
    overdueCount: Number(overdueCount),
    certsExpiringIn30Days: Number(expiringCertCount),
  });
};

const getComplianceReport = async (req, res) => {
  const mandatoryCourses = await knex('courses').where({ isMandatory: true, status: 'published' });
  const courseIds = mandatoryCourses.map((c) => c.id);
  const enrollments = courseIds.length ? await knex('enrollments').whereIn('courseId', courseIds) : [];

  const byCourse = mandatoryCourses.map((c) => {
    const rows = enrollments.filter((e) => e.courseId === c.id);
    const completed = rows.filter((e) => e.status === 'completed').length;
    const overdue = rows.filter((e) => e.status === 'overdue').length;
    return {
      courseId: c.id,
      title: c.title,
      targetRoles: c.targetRoles,
      targetDepartments: c.targetDepartments,
      enrolled: rows.length,
      completed,
      overdue,
      completionRate: rows.length ? Math.round((completed / rows.length) * 100) : 0,
    };
  });

  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86400000);
  const expiringCerts = await knex('certificates').where('expiresAt', '>=', now).where('expiresAt', '<=', in30);
  const employeeIds = [...new Set(expiringCerts.map((c) => c.employeeId))];
  const [users, allCourses] = await Promise.all([
    employeeIds.length ? knex('users').whereIn('id', employeeIds).select('id', 'name') : [],
    knex('courses').select('id', 'title'),
  ]);
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const courseTitleMap = Object.fromEntries(allCourses.map((c) => [c.id, c.title]));

  const certExpiry = expiringCerts.map((c) => ({
    employeeId: c.employeeId,
    employeeName: userMap[c.employeeId]?.name || 'Unknown',
    courseTitle: courseTitleMap[c.courseId] || 'Unknown',
    certificateNumber: c.certificateNumber,
    expiresAt: c.expiresAt,
    daysRemaining: Math.ceil((new Date(c.expiresAt) - now) / 86400000),
  }));

  return returnFunction(res, 200, true, req.locale.success, { mandatoryCourses: byCourse, certExpiry });
};

const getCourseAnalytics = async (req, res) => {
  const courseId = req.params.id;
  const course = await knex('courses').where({ id: courseId }).first();
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);

  const modules = await knex('course_modules').where({ courseId }).orderBy('order');
  const enrollments = await knex('enrollments').where({ courseId });

  const funnel = modules.map((m) => {
    const completedCount = enrollments.filter((e) => (e.moduleProgress || []).some((mp) => String(mp.moduleId) === String(m.id) && mp.status === 'completed')).length;
    return {
      moduleId: m.id,
      title: m.title,
      completedCount,
      dropOffRate: enrollments.length ? Math.round(((enrollments.length - completedCount) / enrollments.length) * 100) : 0,
    };
  });

  const quizModuleIds = modules.filter((m) => m.type === 'quiz').map((m) => m.id);
  const quizScores = [];
  enrollments.forEach((e) => (e.moduleProgress || []).forEach((mp) => {
    if (quizModuleIds.includes(mp.moduleId) && mp.lastScore != null) quizScores.push(mp.lastScore);
  }));
  const avgQuizScore = quizScores.length ? Math.round(quizScores.reduce((a, b) => a + b, 0) / quizScores.length) : null;

  const feedback = await knex('training_feedback').where({ courseId });
  const ratingBreakdown = [1, 2, 3, 4, 5].map((r) => ({ rating: r, count: feedback.filter((f) => f.rating === r).length }));

  const completedEnrollments = enrollments.filter((e) => e.status === 'completed' && e.completedAt);
  const avgTimeToCompleteDays = completedEnrollments.length
    ? Math.round(completedEnrollments.reduce((sum, e) => sum + (new Date(e.completedAt) - new Date(e.createdAt)) / 86400000, 0) / completedEnrollments.length)
    : null;

  return returnFunction(res, 200, true, req.locale.success, {
    totalEnrollments: enrollments.length, funnel, avgQuizScore, ratingBreakdown, avgTimeToCompleteDays,
  });
};

const getEmployeeTrainingRecord = async (req, res) => {
  const employeeId = req.params.id;
  const user = await knex('users').where({ id: employeeId }).select('id', 'name', 'department', 'role').first();
  if (!user) return returnFunction(res, 404, false, req.locale.notFound);

  const enrollments = await knex('enrollments').where({ employeeId });
  const courseIds = enrollments.filter((e) => e.courseId).map((e) => e.courseId);
  const courses = courseIds.length ? await knex('courses').whereIn('id', courseIds).select('id', 'title', 'category', 'isMandatory') : [];
  const courseMap = Object.fromEntries(courses.map((c) => [c.id, c]));

  const [certificates, externalCertificates] = await Promise.all([
    knex('certificates').where({ employeeId }),
    knex('external_certificates').where({ employeeId }),
  ]);

  return returnFunction(res, 200, true, req.locale.success, {
    employee: { _id: user.id, name: user.name, department: user.department, role: user.role },
    enrollments: enrollments.map((e) => ({ ...e, course: e.courseId ? courseMap[e.courseId] || null : null })),
    certificates, externalCertificates,
  });
};

const getLeaderboard = async (req, res) => {
  // Ported from a Mongo $group+$sort+$limit pipeline.
  const completedRows = await knex('enrollments').where({ status: 'completed' }).whereNotNull('courseId')
    .select('employeeId').count('* as coursesCompleted').groupBy('employeeId')
    .orderBy('coursesCompleted', 'desc').limit(20);
  const completed = completedRows.map((r) => ({ employeeId: r.employeeId, coursesCompleted: Number(r.coursesCompleted) }));

  const employeeIds = completed.map((c) => c.employeeId);
  const [users, certCountRows] = await Promise.all([
    employeeIds.length ? knex('users').whereIn('id', employeeIds).select('id', 'name', 'department') : [],
    employeeIds.length ? knex('certificates').whereIn('employeeId', employeeIds).select('employeeId').count('* as count').groupBy('employeeId') : [],
  ]);
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const certMap = Object.fromEntries(certCountRows.map((c) => [c.employeeId, Number(c.count)]));

  const leaderboard = completed.map((c, i) => ({
    rank: i + 1,
    employeeId: c.employeeId,
    name: userMap[c.employeeId]?.name || 'Unknown',
    department: userMap[c.employeeId]?.department || null,
    coursesCompleted: c.coursesCompleted,
    certificatesEarned: certMap[c.employeeId] || 0,
  }));

  return returnFunction(res, 200, true, req.locale.success, leaderboard);
};

// Ad-hoc reminder from the Compliance Dashboard — either one employee (about an
// overdue course or an expiring certificate) or every currently-overdue enrollment.
const sendComplianceReminder = async (req, res) => {
  if (req.body.employeeId) {
    const employeeId = req.body.employeeId;
    notifyUser(employeeId, {
      title: 'Training Reminder',
      body: req.body.message || 'This is a reminder to complete your assigned training.',
      type: 'training',
      link: '/my/training',
    }).catch(() => {});
    emailUserByTrigger(employeeId, 'trainingReminder', { message: req.body.message || 'This is a reminder to complete your assigned training.' },
      'Training Reminder', `<p>${req.body.message || 'This is a reminder to complete your assigned training.'}</p>`);
    return returnFunction(res, 200, true, 'Reminder sent.');
  }

  const overdue = await knex('enrollments').where({ status: 'overdue' }).select('employeeId');
  const uniqueIds = [...new Set(overdue.map((e) => e.employeeId))];
  for (const id of uniqueIds) {
    notifyUser(id, {
      title: 'Training Reminder',
      body: 'You have overdue training — please complete it as soon as possible.',
      type: 'training',
      link: '/my/training',
    }).catch(() => {});
    emailUserByTrigger(id, 'trainingReminder', { message: 'You have overdue training — please complete it as soon as possible.' },
      'Training Reminder', '<p>You have overdue training — please complete it as soon as possible.</p>');
  }
  return returnFunction(res, 200, true, `Reminder sent to ${uniqueIds.length} employee(s).`);
};

// Stores just the relative path under uploads/ (e.g. "training/172...-slides.pdf"), not a
// full URL — matches the existing convention for profilePhoto/receiptFile elsewhere in
// this app, where the frontend appends its own auth token when constructing the full URL.
const uploadTrainingFile = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, 'No file uploaded, or the file type is not supported (PDF, MP4, WebM, OGG, MOV only).');
  return returnFunction(res, 200, true, req.locale.success, {
    fileUrl: `training/${req.file.filename}`,
    fileName: req.file.originalname,
  });
};

// ── Live / Instructor-led Sessions ─────────────────────────────────────────────
// A separate concept from async modules: a scheduled meeting (Google Meet/Zoom/etc) with
// a facilitator, a capacity, and a roster. Registering auto-creates the learner's course
// enrollment (same collection self-paced courses use) so instructor-led training still
// shows up in "My Training", compliance reports, and analytics without a parallel system.
// Completion is attendance-driven (marked after the session) rather than progress-driven.

const createSession = async (req, res) => {
  if (!validateRequiredFields(req, res, ['scheduledAt', 'durationMinutes', 'meetingLink'])) return;
  const course = await knex('courses').where({ id: req.params.id }).first();
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);

  const doc = {
    id: newId(),
    courseId: course.id,
    title: req.body.title || course.title,
    facilitatorId: req.body.facilitatorId ? String(req.body.facilitatorId) : null,
    facilitatorName: req.body.facilitatorName || null,
    scheduledAt: new Date(req.body.scheduledAt),
    durationMinutes: Number(req.body.durationMinutes),
    meetingLink: req.body.meetingLink,
    capacity: req.body.capacity ? Number(req.body.capacity) : null,
    attendeeIds: [],
    status: 'scheduled',
    attendance: JSON.stringify([]),
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('training_sessions', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id, ...result });
};

const listCourseSessions = async (req, res) => {
  const sessions = await knex('training_sessions').where({ courseId: req.params.id }).orderBy('scheduledAt');
  return returnFunction(res, 200, true, req.locale.success, sessions);
};

const updateSession = async (req, res) => {
  const session = await knex('training_sessions').where({ id: req.params.id }).first();
  if (!session) return returnFunction(res, 404, false, req.locale.notFound);

  const update = { updatedAt: new Date() };
  if (req.body.title !== undefined) update.title = req.body.title;
  if (req.body.facilitatorId !== undefined) update.facilitatorId = req.body.facilitatorId ? String(req.body.facilitatorId) : null;
  if (req.body.facilitatorName !== undefined) update.facilitatorName = req.body.facilitatorName;
  if (req.body.scheduledAt !== undefined) update.scheduledAt = new Date(req.body.scheduledAt);
  if (req.body.durationMinutes !== undefined) update.durationMinutes = Number(req.body.durationMinutes);
  if (req.body.meetingLink !== undefined) update.meetingLink = req.body.meetingLink;
  if (req.body.capacity !== undefined) update.capacity = req.body.capacity ? Number(req.body.capacity) : null;
  if (req.body.status !== undefined) {
    if (!SESSION_STATUSES.includes(req.body.status)) return returnFunction(res, 400, false, `status must be one of: ${SESSION_STATUSES.join(', ')}`);
    update.status = req.body.status;
  }

  await knex('training_sessions').where({ id: session.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteSession = async (req, res) => {
  const [updated] = await knex('training_sessions').where({ id: req.params.id }).update({ status: 'cancelled', updatedAt: new Date() }).returning('id');
  if (!updated) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const registerForSession = async (req, res) => {
  const session = await knex('training_sessions').where({ id: req.params.id }).first();
  if (!session) return returnFunction(res, 404, false, req.locale.notFound);
  if (session.status !== 'scheduled') return returnFunction(res, 400, false, 'This session is no longer open for registration.');

  const employeeId = String(req.user.id);
  const attendeeIds = session.attendeeIds || [];
  if (attendeeIds.includes(employeeId)) {
    return returnFunction(res, 409, false, 'You are already registered for this session.');
  }
  if (session.capacity && attendeeIds.length >= session.capacity) {
    return returnFunction(res, 400, false, 'This session is full.');
  }

  await knex('training_sessions').where({ id: session.id }).update({ attendeeIds: [...attendeeIds, employeeId], updatedAt: new Date() });
  await createSingleCourseEnrollment({ employeeId, courseId: session.courseId, enrolledBy: employeeId, enrollmentTrigger: 'self_registered' });
  return returnFunction(res, 200, true, 'Registered for session.');
};

const unregisterFromSession = async (req, res) => {
  const session = await knex('training_sessions').where({ id: req.params.id }).first();
  if (!session) return returnFunction(res, 404, false, req.locale.notFound);
  const attendeeIds = (session.attendeeIds || []).filter((id) => id !== String(req.user.id));
  await knex('training_sessions').where({ id: session.id }).update({ attendeeIds, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const markSessionAttendance = async (req, res) => {
  const session = await knex('training_sessions').where({ id: req.params.id }).first();
  if (!session) return returnFunction(res, 404, false, req.locale.notFound);
  if (!Array.isArray(req.body.attendance)) return returnFunction(res, 400, false, 'attendance must be an array of {employeeId, attended}.');

  const attendance = req.body.attendance.map((a) => ({ employeeId: String(a.employeeId), attended: !!a.attended }));
  await knex('training_sessions').where({ id: session.id }).update({ attendance: JSON.stringify(attendance), status: 'completed', updatedAt: new Date() });

  for (const a of attendance) {
    if (!a.attended) continue;
    const enrollment = await knex('enrollments').where({ employeeId: a.employeeId, courseId: session.courseId }).first();
    if (!enrollment || enrollment.status === 'completed') continue;
    await knex('enrollments').where({ id: enrollment.id }).update({ status: 'completed', completedAt: new Date(), progressPercentage: 100, updatedAt: new Date() });
    await maybeGenerateCertificate(enrollment.id);
  }

  return returnFunction(res, 200, true, 'Attendance recorded.');
};

const getMySessions = async (req, res) => {
  const sessions = await knex('training_sessions').whereRaw('"attendeeIds" @> ?::text[]', [[String(req.user.id)]]).orderBy('scheduledAt');
  const courseIds = [...new Set(sessions.map((s) => s.courseId))];
  const courses = courseIds.length ? await knex('courses').whereIn('id', courseIds).select('id', 'title') : [];
  const courseMap = Object.fromEntries(courses.map((c) => [c.id, c]));
  const enriched = sessions.map((s) => ({ ...s, course: courseMap[s.courseId] ?? null }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

module.exports = {
  COURSE_CATEGORIES, COURSE_STATUSES, MODULE_TYPES, ENROLLMENT_STATUSES, RULE_TRIGGERS,
  DELIVERY_METHODS, SESSION_STATUSES,
  sendComplianceReminder,
  uploadTrainingFile,
  createSession, listCourseSessions, updateSession, deleteSession,
  registerForSession, unregisterFromSession, markSessionAttendance, getMySessions,
  createCourse, listCourses, getCourse, updateCourse, publishCourse, archiveCourse, addCourseAuthor,
  listCatalog, getCatalogCourse, getModuleQuizForLearner,
  addModule, updateModule, deleteModule,
  createQuiz, updateQuiz,
  createLearningPath, listLearningPaths, getLearningPath, updateLearningPath, archiveLearningPath,
  createSingleCourseEnrollment, createLearningPathEnrollment,
  assignTraining, listEnrollments, waiveEnrollment,
  selfEnroll,
  getMyEnrollments, updateMyProgress, submitQuizAttempt, submitCourseFeedback, getMyLearningPaths,
  generateMyCertificate, getMyCertificates,
  uploadExternalCertificate, getMyExternalCertificates, listExternalCertificates, verifyExternalCertificate,
  createRule, listRules, updateRule, runRuleNow,
  getTrainingOverview, getComplianceReport, getCourseAnalytics, getEmployeeTrainingRecord, getLeaderboard,
};
