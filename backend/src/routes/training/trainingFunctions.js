const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const {
  findOne, findMany, insertOne, updateOne, deleteOne, countDocuments, aggregate,
} = require('../../functions/Database/commonDBFunctions');
const { notifyUser, notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');
const { generateCertificatePDF } = require('../../lib/training/generateCertificate');
const {
  recomputeProgress, createSingleCourseEnrollment, createLearningPathEnrollment, maybeAdvanceLearningPath,
} = require('../../lib/training/enrollmentHelpers');
const { runRule } = require('../../lib/training/autoEnrollment');

const COURSE_CATEGORIES = ['Compliance', 'Onboarding', 'Leadership', 'Technical', 'Soft Skills'];
const COURSE_STATUSES = ['draft', 'published', 'archived'];
const MODULE_TYPES = ['video', 'document', 'text', 'quiz', 'scorm', 'link'];
const ENROLLMENT_STATUSES = ['notStarted', 'inProgress', 'completed', 'overdue', 'waived'];

// ── Courses (HR admin) ────────────────────────────────────────────────────────

const createCourse = async (req, res) => {
  if (!validateRequiredFields(req, res, ['title', 'description', 'category', 'estimatedDurationMinutes', 'difficultyLevel'])) return;
  if (!COURSE_CATEGORIES.includes(req.body.category)) return returnFunction(res, 400, false, `category must be one of: ${COURSE_CATEGORIES.join(', ')}`);

  const doc = {
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
    createdBy: new ObjectId(req.user._id),
    authors: [new ObjectId(req.user._id)],
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('courses', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listCourses = async (req, res) => {
  const filter = {};
  if (req.query.category) filter.category = req.query.category;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.isMandatory !== undefined) filter.isMandatory = req.query.isMandatory === 'true';
  if (req.query.author) filter.authors = new ObjectId(req.query.author);

  const { page, limit, skip } = getPagination(req.query);
  const [total, data] = await Promise.all([
    countDocuments('courses', filter),
    findMany('courses', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const ids = data.map((c) => c._id);
  const [enrollCounts, completedCounts] = ids.length ? await Promise.all([
    aggregate('enrollments', [{ $match: { courseId: { $in: ids } } }, { $group: { _id: '$courseId', count: { $sum: 1 } } }]),
    aggregate('enrollments', [{ $match: { courseId: { $in: ids }, status: 'completed' } }, { $group: { _id: '$courseId', count: { $sum: 1 } } }]),
  ]) : [[], []];
  const enrollMap = Object.fromEntries(enrollCounts.map((c) => [String(c._id), c.count]));
  const completeMap = Object.fromEntries(completedCounts.map((c) => [String(c._id), c.count]));

  const enriched = data.map((c) => {
    const enrolledCount = enrollMap[String(c._id)] || 0;
    const completedCount = completeMap[String(c._id)] || 0;
    return { ...c, enrolledCount, completionRate: enrolledCount > 0 ? Math.round((completedCount / enrolledCount) * 100) : 0 };
  });

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const getCourse = async (req, res) => {
  const course = await findOne('courses', { _id: new ObjectId(req.params.id) });
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);

  const modules = await findMany('courseModules', { courseId: course._id }, { sort: { order: 1 } });
  const enrolledCount = await countDocuments('enrollments', { courseId: course._id });
  return returnFunction(res, 200, true, req.locale.success, { ...course, modules, enrolledCount });
};

const updateCourse = async (req, res) => {
  const allowed = [
    'title', 'description', 'coverImageUrl', 'category', 'tags', 'skillsTaught',
    'estimatedDurationMinutes', 'difficultyLevel', 'isMandatory', 'targetRoles',
    'targetDepartments', 'hasCertificate', 'certificateValidityDays',
  ];
  const update = { updatedAt: new Date() };
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

  const result = await updateOne('courses', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const publishCourse = async (req, res) => {
  const course = await findOne('courses', { _id: new ObjectId(req.params.id) });
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);

  const moduleCount = await countDocuments('courseModules', { courseId: course._id });
  if (!moduleCount) return returnFunction(res, 400, false, 'Add at least one module before publishing.');

  await updateOne('courses', { _id: course._id }, { $set: { status: 'published', publishedAt: new Date(), updatedAt: new Date() } });

  if (course.isMandatory) {
    notifyByRoles(['super_admin', 'hr_manager'], {
      title: 'Mandatory Course Published',
      body: `"${course.title}" is now published and marked mandatory — assign it to the relevant audience.`,
      type: 'training',
    }).catch(() => {});
  }

  return returnFunction(res, 200, true, 'Course published.');
};

const archiveCourse = async (req, res) => {
  const result = await updateOne('courses', { _id: new ObjectId(req.params.id) }, { $set: { status: 'archived', updatedAt: new Date() } });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

const addCourseAuthor = async (req, res) => {
  if (!validateRequiredFields(req, res, ['authorId'])) return;
  const result = await updateOne('courses', { _id: new ObjectId(req.params.id) }, {
    $addToSet: { authors: new ObjectId(req.body.authorId) },
    $set: { updatedAt: new Date() },
  });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, 'Co-author added.');
};

// ── Catalog (employee — published courses only) ──────────────────────────────

const listCatalog = async (req, res) => {
  const filter = { status: 'published' };
  if (req.query.category) filter.category = req.query.category;
  if (req.query.difficultyLevel) filter.difficultyLevel = req.query.difficultyLevel;
  if (req.query.skill) filter.skillsTaught = req.query.skill;

  const courses = await findMany('courses', filter, { sort: { publishedAt: -1 } });

  const ids = courses.map((c) => c._id);
  const [ratingAgg, myEnrollments] = await Promise.all([
    ids.length ? aggregate('trainingFeedback', [
      { $match: { courseId: { $in: ids } } },
      { $group: { _id: '$courseId', avgRating: { $avg: '$rating' } } },
    ]) : [],
    findMany('enrollments', { employeeId: new ObjectId(req.user._id), courseId: { $in: ids } }, { projection: { courseId: 1, status: 1, progressPercentage: 1 } }),
  ]);
  const ratingMap = Object.fromEntries(ratingAgg.map((r) => [String(r._id), Math.round(r.avgRating * 10) / 10]));
  const enrollMap = Object.fromEntries(myEnrollments.map((e) => [String(e.courseId), e]));

  const enriched = courses.map((c) => ({
    ...c,
    avgRating: ratingMap[String(c._id)] || null,
    myEnrollment: enrollMap[String(c._id)] || null,
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const getCatalogCourse = async (req, res) => {
  const course = await findOne('courses', { _id: new ObjectId(req.params.id), status: 'published' });
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);

  const modules = await findMany('courseModules', { courseId: course._id }, { sort: { order: 1 } });
  const myEnrollment = await findOne('enrollments', { employeeId: new ObjectId(req.user._id), courseId: course._id });

  return returnFunction(res, 200, true, req.locale.success, { ...course, modules, myEnrollment: myEnrollment || null });
};

// Learner-facing quiz fetch — correctAnswer/explanation are always stripped, and access is
// gated on the requester actually being enrolled in the parent course (not just it being published).
const getModuleQuizForLearner = async (req, res) => {
  const moduleId = new ObjectId(req.params.moduleId);
  const module_ = await findOne('courseModules', { _id: moduleId });
  if (!module_ || module_.type !== 'quiz') return returnFunction(res, 404, false, 'Quiz module not found.');

  const enrollment = await findOne('enrollments', { employeeId: new ObjectId(req.user._id), courseId: module_.courseId });
  if (!enrollment) return returnFunction(res, 403, false, req.locale.noPermission || 'Permission denied.');

  const quiz = await findOne('quizzes', { moduleId });
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

  const courseId = new ObjectId(req.params.id);
  const course = await findOne('courses', { _id: courseId });
  if (!course) return returnFunction(res, 404, false, 'Course not found.');

  let order = req.body.order;
  if (order === undefined) {
    const last = await findMany('courseModules', { courseId }, { sort: { order: -1 }, limit: 1 });
    order = last.length ? last[0].order + 1 : 0;
  }

  const doc = {
    courseId,
    title: req.body.title.trim(),
    order: Number(order),
    type: req.body.type,
    content: typeof req.body.content === 'object' && req.body.content ? req.body.content : {},
    isRequired: req.body.isRequired !== false,
    minimumPassScore: req.body.minimumPassScore !== undefined ? Number(req.body.minimumPassScore) : undefined,
    createdAt: new Date(),
  };
  const result = await insertOne('courseModules', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateModule = async (req, res) => {
  const allowed = ['title', 'order', 'type', 'content', 'isRequired', 'minimumPassScore'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

  const result = await updateOne('courseModules', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteModule = async (req, res) => {
  const moduleId = new ObjectId(req.params.id);
  const result = await deleteOne('courseModules', { _id: moduleId });
  if (!result.deletedCount) return returnFunction(res, 404, false, req.locale.notFound);
  await deleteOne('quizzes', { moduleId });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Quizzes (HR admin) ────────────────────────────────────────────────────────

const createQuiz = async (req, res) => {
  if (!validateRequiredFields(req, res, ['questions', 'passingScore'])) return;
  if (!Array.isArray(req.body.questions) || !req.body.questions.length) {
    return returnFunction(res, 400, false, 'Add at least one question.');
  }

  const moduleId = new ObjectId(req.params.id);
  const module_ = await findOne('courseModules', { _id: moduleId });
  if (!module_) return returnFunction(res, 404, false, 'Module not found.');

  const existing = await findOne('quizzes', { moduleId });
  if (existing) return returnFunction(res, 409, false, 'This module already has a quiz. Use PATCH to edit it.');

  const doc = {
    moduleId,
    courseId: module_.courseId,
    questions: req.body.questions,
    passingScore: Number(req.body.passingScore),
    maxAttempts: req.body.maxAttempts ? Number(req.body.maxAttempts) : 3,
    shuffleQuestions: !!req.body.shuffleQuestions,
    shuffleOptions: !!req.body.shuffleOptions,
    timeLimitMinutes: req.body.timeLimitMinutes ? Number(req.body.timeLimitMinutes) : undefined,
  };
  const result = await insertOne('quizzes', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateQuiz = async (req, res) => {
  const allowed = ['questions', 'passingScore', 'maxAttempts', 'shuffleQuestions', 'shuffleOptions', 'timeLimitMinutes'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

  const result = await updateOne('quizzes', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// ── Learning Paths (HR admin) ─────────────────────────────────────────────────

const createLearningPath = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'description', 'courses', 'enrollmentTrigger'])) return;
  if (!Array.isArray(req.body.courses) || !req.body.courses.length) {
    return returnFunction(res, 400, false, 'Add at least one course.');
  }

  const doc = {
    name: req.body.name.trim(),
    description: req.body.description,
    courses: req.body.courses.map((c) => ({
      courseId: new ObjectId(c.courseId),
      order: Number(c.order) || 0,
      isRequired: c.isRequired !== false,
      unlockAfterCourseId: c.unlockAfterCourseId ? new ObjectId(c.unlockAfterCourseId) : null,
    })),
    targetRoles: Array.isArray(req.body.targetRoles) ? req.body.targetRoles : [],
    targetDepartments: Array.isArray(req.body.targetDepartments) ? req.body.targetDepartments : [],
    enrollmentTrigger: req.body.enrollmentTrigger,
    dueDateOffsetDays: req.body.dueDateOffsetDays ? Number(req.body.dueDateOffsetDays) : null,
    status: 'active',
    createdBy: new ObjectId(req.user._id),
    createdAt: new Date(),
  };
  const result = await insertOne('learningPaths', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listLearningPaths = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const paths = await findMany('learningPaths', filter, { sort: { createdAt: -1 } });

  const ids = paths.map((p) => p._id);
  const counts = ids.length ? await aggregate('enrollments', [
    { $match: { learningPathId: { $in: ids } } },
    { $group: { _id: '$learningPathId', count: { $sum: 1 } } },
  ]) : [];
  const countMap = Object.fromEntries(counts.map((c) => [String(c._id), c.count]));

  return returnFunction(res, 200, true, req.locale.success, paths.map((p) => ({ ...p, enrolledCount: countMap[String(p._id)] || 0 })));
};

const getLearningPath = async (req, res) => {
  const path_ = await findOne('learningPaths', { _id: new ObjectId(req.params.id) });
  if (!path_) return returnFunction(res, 404, false, req.locale.notFound);

  const courseIds = path_.courses.map((c) => c.courseId);
  const courses = courseIds.length ? await findMany('courses', { _id: { $in: courseIds } }, { projection: { title: 1, category: 1, estimatedDurationMinutes: 1 } }) : [];
  const courseMap = Object.fromEntries(courses.map((c) => [String(c._id), c]));

  return returnFunction(res, 200, true, req.locale.success, {
    ...path_,
    courses: path_.courses.map((c) => ({ ...c, course: courseMap[String(c.courseId)] || null })),
  });
};

const updateLearningPath = async (req, res) => {
  const allowed = ['name', 'description', 'targetRoles', 'targetDepartments', 'enrollmentTrigger', 'dueDateOffsetDays'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
  if (req.body.courses !== undefined) {
    update.courses = req.body.courses.map((c) => ({
      courseId: new ObjectId(c.courseId),
      order: Number(c.order) || 0,
      isRequired: c.isRequired !== false,
      unlockAfterCourseId: c.unlockAfterCourseId ? new ObjectId(c.unlockAfterCourseId) : null,
    }));
  }

  const result = await updateOne('learningPaths', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const archiveLearningPath = async (req, res) => {
  const result = await updateOne('learningPaths', { _id: new ObjectId(req.params.id) }, { $set: { status: 'archived' } });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Enrollments ────────────────────────────────────────────────────────────────
// `employeeId` on an enrollment is the learner's `users._id` (i.e. the JWT's userId) —
// this is what every employee-facing route scopes against, matching the security
// requirement that an employee can only ever see rows where employeeId === req.user._id.
// createSingleCourseEnrollment/createLearningPathEnrollment/recomputeProgress/
// maybeAdvanceLearningPath live in lib/training/enrollmentHelpers.js (shared with the
// autoEnrollment rule engine, which would otherwise circularly require this file).

const assignTraining = async (req, res) => {
  if (!validateRequiredFields(req, res, ['employeeIds'])) return;
  if (!Array.isArray(req.body.employeeIds) || !req.body.employeeIds.length) return returnFunction(res, 400, false, 'Select at least one employee.');
  if (!req.body.courseId && !req.body.learningPathId) return returnFunction(res, 400, false, 'Select a course or a learning path.');

  const courseId = req.body.courseId ? new ObjectId(req.body.courseId) : null;
  const learningPathId = req.body.learningPathId ? new ObjectId(req.body.learningPathId) : null;
  const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
  const enrolledBy = new ObjectId(req.user._id);

  let createdCount = 0;
  for (const empId of req.body.employeeIds) {
    const employeeId = new ObjectId(empId);
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
  const filter = {};
  if (req.query.courseId) filter.courseId = new ObjectId(req.query.courseId);
  if (req.query.learningPathId) filter.learningPathId = new ObjectId(req.query.learningPathId);
  if (req.query.employeeId) filter.employeeId = new ObjectId(req.query.employeeId);
  if (req.query.status) filter.status = req.query.status;

  const { page, limit, skip } = getPagination(req.query);
  const [total, data] = await Promise.all([
    countDocuments('enrollments', filter),
    findMany('enrollments', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  const employeeIds = [...new Set(data.map((e) => String(e.employeeId)))].map((id) => new ObjectId(id));
  const courseIds = [...new Set(data.filter((e) => e.courseId).map((e) => String(e.courseId)))].map((id) => new ObjectId(id));
  const [users, courses] = await Promise.all([
    employeeIds.length ? findMany('users', { _id: { $in: employeeIds } }, { projection: { name: 1, department: 1, email: 1 } }) : [],
    courseIds.length ? findMany('courses', { _id: { $in: courseIds } }, { projection: { title: 1, category: 1, isMandatory: 1, hasCertificate: 1 } }) : [],
  ]);
  const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));
  const courseMap = Object.fromEntries(courses.map((c) => [String(c._id), c]));

  const enriched = data.map((e) => ({
    ...e,
    employee: userMap[String(e.employeeId)] ? { _id: e.employeeId, fullName: userMap[String(e.employeeId)].name, department: userMap[String(e.employeeId)].department } : null,
    course: e.courseId ? courseMap[String(e.courseId)] || null : null,
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const waiveEnrollment = async (req, res) => {
  const result = await updateOne('enrollments', { _id: new ObjectId(req.params.id) }, {
    $set: { status: 'waived', completedAt: new Date(), updatedAt: new Date() },
  });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, 'Enrollment waived.');
};

// ── Employee — own enrollments only (scoped to req.user._id) ─────────────────

const getMyEnrollments = async (req, res) => {
  const filter = { employeeId: new ObjectId(req.user._id) };
  if (req.query.status) filter.status = req.query.status;
  const enrollments = await findMany('enrollments', filter, { sort: { createdAt: -1 } });

  const courseIds = [...new Set(enrollments.filter((e) => e.courseId).map((e) => String(e.courseId)))].map((id) => new ObjectId(id));
  const courses = courseIds.length ? await findMany('courses', { _id: { $in: courseIds } }) : [];
  const courseMap = Object.fromEntries(courses.map((c) => [String(c._id), c]));

  const enriched = enrollments.map((e) => ({
    ...e,
    course: e.courseId ? courseMap[String(e.courseId)] || null : null,
  }));

  return returnFunction(res, 200, true, req.locale.success, enriched);
};

const updateMyProgress = async (req, res) => {
  if (!validateRequiredFields(req, res, ['moduleId', 'status'])) return;
  if (!['notStarted', 'inProgress', 'completed'].includes(req.body.status)) return returnFunction(res, 400, false, 'Invalid status.');

  const enrollment = await findOne('enrollments', { _id: new ObjectId(req.params.id) });
  if (!enrollment) return returnFunction(res, 404, false, req.locale.notFound);
  if (String(enrollment.employeeId) !== String(req.user._id)) return returnFunction(res, 403, false, req.locale.noPermission || 'Permission denied.');
  if (!enrollment.courseId) return returnFunction(res, 400, false, 'This enrollment has no individual course to track progress on.');

  const module_ = await findOne('courseModules', { _id: new ObjectId(req.body.moduleId), courseId: enrollment.courseId });
  if (!module_) return returnFunction(res, 404, false, 'Module not found on this course.');
  if (module_.type === 'quiz') return returnFunction(res, 400, false, 'Submit a quiz attempt instead of marking a quiz module complete directly.');

  const now = new Date();
  const moduleProgress = [...enrollment.moduleProgress];
  const idx = moduleProgress.findIndex((m) => String(m.moduleId) === String(module_._id));
  const existingEntry = idx >= 0 ? moduleProgress[idx] : null;
  const entry = {
    moduleId: module_._id,
    status: req.body.status,
    startedAt: existingEntry?.startedAt || now,
    completedAt: req.body.status === 'completed' ? now : existingEntry?.completedAt,
    attempts: existingEntry?.attempts || 0,
    lastScore: existingEntry?.lastScore,
  };
  if (idx >= 0) moduleProgress[idx] = entry; else moduleProgress.push(entry);

  const requiredModules = await findMany('courseModules', { courseId: enrollment.courseId, isRequired: true }, { projection: { _id: 1 } });
  const { progressPercentage, status } = recomputeProgress(moduleProgress, requiredModules.map((m) => m._id));

  const update = { moduleProgress, progressPercentage, status, updatedAt: now };
  if (status === 'completed' && enrollment.status !== 'completed') update.completedAt = now;

  await updateOne('enrollments', { _id: enrollment._id }, { $set: update });

  if (status === 'completed' && enrollment.status !== 'completed') {
    await maybeGenerateCertificate(enrollment._id);
    await maybeAdvanceLearningPath(enrollment);
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, { progressPercentage, status });
};

const submitCourseFeedback = async (req, res) => {
  if (!validateRequiredFields(req, res, ['rating'])) return;
  const rating = Number(req.body.rating);
  if (![1, 2, 3, 4, 5].includes(rating)) return returnFunction(res, 400, false, 'rating must be between 1 and 5.');

  const enrollment = await findOne('enrollments', { _id: new ObjectId(req.params.id) });
  if (!enrollment) return returnFunction(res, 404, false, req.locale.notFound);
  if (String(enrollment.employeeId) !== String(req.user._id)) return returnFunction(res, 403, false, req.locale.noPermission || 'Permission denied.');
  if (!['completed', 'waived'].includes(enrollment.status)) return returnFunction(res, 400, false, 'Complete the course before leaving feedback.');

  const existing = await findOne('trainingFeedback', { enrollmentId: enrollment._id });
  if (existing) return returnFunction(res, 409, false, 'You have already submitted feedback for this course.');

  const doc = {
    enrollmentId: enrollment._id,
    courseId: enrollment.courseId,
    employeeId: new ObjectId(req.user._id),
    rating,
    review: req.body.review || null,
    submittedAt: new Date(),
  };
  const result = await insertOne('trainingFeedback', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
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

  const enrollment = await findOne('enrollments', { _id: new ObjectId(req.params.id) });
  if (!enrollment) return returnFunction(res, 404, false, req.locale.notFound);
  if (String(enrollment.employeeId) !== String(req.user._id)) return returnFunction(res, 403, false, req.locale.noPermission || 'Permission denied.');
  if (!enrollment.courseId) return returnFunction(res, 400, false, 'This enrollment has no individual course to track progress on.');

  const moduleId = new ObjectId(req.body.moduleId);
  const module_ = await findOne('courseModules', { _id: moduleId, courseId: enrollment.courseId });
  if (!module_ || module_.type !== 'quiz') return returnFunction(res, 404, false, 'Quiz module not found on this course.');

  const quiz = await findOne('quizzes', { moduleId });
  if (!quiz) return returnFunction(res, 404, false, 'Quiz not configured for this module.');

  const existingEntry = enrollment.moduleProgress.find((m) => String(m.moduleId) === String(moduleId));
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
  const moduleProgress = [...enrollment.moduleProgress];
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

  const requiredModules = await findMany('courseModules', { courseId: enrollment.courseId, isRequired: true }, { projection: { _id: 1 } });
  const { progressPercentage, status } = recomputeProgress(moduleProgress, requiredModules.map((m) => m._id));

  const update = { moduleProgress, progressPercentage, status, updatedAt: now };
  if (status === 'completed' && enrollment.status !== 'completed') update.completedAt = now;
  await updateOne('enrollments', { _id: enrollment._id }, { $set: update });

  if (status === 'completed' && enrollment.status !== 'completed') {
    await maybeGenerateCertificate(enrollment._id);
    await maybeAdvanceLearningPath(enrollment);
  }

  return returnFunction(res, 200, true, passed ? 'Quiz passed.' : 'Quiz not passed.', { score, passed, attemptsRemaining, results });
};

// ── Certificates ───────────────────────────────────────────────────────────────

const generateCertificateNumber = async (year) => {
  const counterName = `certificate_number_${year}`;
  const result = await global.dbo.collection('counters').findOneAndUpdate(
    { _id: counterName },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return `CERT-${year}-${String(result.seq).padStart(5, '0')}`;
};

// Idempotent — safe to call every time an enrollment completes; no-ops if the course
// doesn't offer a certificate or one has already been issued for this enrollment.
const maybeGenerateCertificate = async (enrollmentId) => {
  try {
    const enrollment = await findOne('enrollments', { _id: enrollmentId });
    if (!enrollment || !enrollment.courseId) return null;

    const course = await findOne('courses', { _id: enrollment.courseId });
    if (!course?.hasCertificate) return null;

    const existing = await findOne('certificates', { enrollmentId });
    if (existing) return existing;

    const user = await findOne('users', { _id: enrollment.employeeId });
    const now = new Date();
    const year = now.getFullYear();
    const certificateNumber = await generateCertificateNumber(year);
    const expiresAt = course.certificateValidityDays ? new Date(now.getTime() + course.certificateValidityDays * 86400000) : null;

    const pdfUrl = await generateCertificatePDF({
      employeeName: user?.name || 'Employee',
      courseTitle: course.title,
      completedAt: enrollment.completedAt || now,
      certificateNumber,
    });

    const doc = {
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
    }).catch(() => {});

    return { ...doc, _id: result.insertedId };
  } catch {
    return null; // Non-critical — never let certificate generation block progress updates
  }
};

const generateMyCertificate = async (req, res) => {
  const enrollment = await findOne('enrollments', { _id: new ObjectId(req.params.enrollmentId) });
  if (!enrollment) return returnFunction(res, 404, false, req.locale.notFound);
  if (String(enrollment.employeeId) !== String(req.user._id)) return returnFunction(res, 403, false, req.locale.noPermission || 'Permission denied.');
  if (enrollment.status !== 'completed') return returnFunction(res, 400, false, 'Complete the course before generating a certificate.');

  const cert = await maybeGenerateCertificate(enrollment._id);
  if (!cert) return returnFunction(res, 400, false, 'This course does not offer a certificate.');
  return returnFunction(res, 200, true, 'Certificate ready.', cert);
};

const getMyCertificates = async (req, res) => {
  const certs = await findMany('certificates', { employeeId: new ObjectId(req.user._id) }, { sort: { issuedAt: -1 } });
  const courseIds = certs.map((c) => c.courseId);
  const courses = courseIds.length ? await findMany('courses', { _id: { $in: courseIds } }, { projection: { title: 1 } }) : [];
  const courseMap = Object.fromEntries(courses.map((c) => [String(c._id), c]));
  return returnFunction(res, 200, true, req.locale.success, certs.map((c) => ({ ...c, course: courseMap[String(c.courseId)] || null })));
};

const getMyLearningPaths = async (req, res) => {
  const enrollments = await findMany('enrollments', { employeeId: new ObjectId(req.user._id), learningPathId: { $ne: null }, courseId: null });
  const pathIds = enrollments.map((e) => e.learningPathId);
  const paths = pathIds.length ? await findMany('learningPaths', { _id: { $in: pathIds } }) : [];
  const pathMap = Object.fromEntries(paths.map((p) => [String(p._id), p]));

  const enriched = enrollments.map((e) => ({ ...e, learningPath: pathMap[String(e.learningPathId)] || null }));
  return returnFunction(res, 200, true, req.locale.success, enriched);
};

// ── External Certificates ────────────────────────────────────────────────────

const uploadExternalCertificate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'issuingOrganization', 'issuedDate', 'fileUrl'])) return;

  const doc = {
    employeeId: new ObjectId(req.user._id),
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
  const result = await insertOne('externalCertificates', doc);

  notifyHR({
    type: 'training', subType: 'external_cert_uploaded',
    title: 'External Certificate Submitted',
    subtitle: `An employee uploaded "${doc.name}" for verification.`,
    referenceId: result.insertedId, referenceModel: 'externalCertificates',
    requiresAction: true, triggeredBy: new ObjectId(req.user._id),
  }).catch(() => {});

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const getMyExternalCertificates = async (req, res) => {
  const certs = await findMany('externalCertificates', { employeeId: new ObjectId(req.user._id) }, { sort: { uploadedAt: -1 } });
  return returnFunction(res, 200, true, req.locale.success, certs);
};

const listExternalCertificates = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const certs = await findMany('externalCertificates', filter, { sort: { uploadedAt: -1 } });

  const employeeIds = [...new Set(certs.map((c) => String(c.employeeId)))].map((id) => new ObjectId(id));
  const users = employeeIds.length ? await findMany('users', { _id: { $in: employeeIds } }, { projection: { name: 1, department: 1 } }) : [];
  const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));

  return returnFunction(res, 200, true, req.locale.success, certs.map((c) => ({ ...c, employee: userMap[String(c.employeeId)] || null })));
};

const verifyExternalCertificate = async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  if (!['verified', 'rejected'].includes(req.body.status)) return returnFunction(res, 400, false, 'status must be verified or rejected.');

  const cert = await findOne('externalCertificates', { _id: new ObjectId(req.params.id) });
  if (!cert) return returnFunction(res, 404, false, req.locale.notFound);

  await updateOne('externalCertificates', { _id: cert._id }, {
    $set: { status: req.body.status, verifiedBy: new ObjectId(req.user._id) },
  });

  notifyUser(cert.employeeId, {
    title: `External Certificate ${req.body.status === 'verified' ? 'Verified' : 'Rejected'}`,
    body: `Your certificate "${cert.name}" was ${req.body.status}.`,
    type: 'training',
  }).catch(() => {});

  return returnFunction(res, 200, true, `Certificate ${req.body.status}.`);
};

// ── Assignment Rules (HR admin) ───────────────────────────────────────────────

const RULE_TRIGGERS = ['onHire', 'onRoleChange', 'onDepartmentChange', 'onPerformanceScore', 'onCertExpiry', 'scheduled'];

const createRule = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'trigger', 'action'])) return;
  if (!RULE_TRIGGERS.includes(req.body.trigger)) return returnFunction(res, 400, false, `trigger must be one of: ${RULE_TRIGGERS.join(', ')}`);

  const doc = {
    name: req.body.name.trim(),
    trigger: req.body.trigger,
    triggerConditions: req.body.triggerConditions || {},
    action: {
      enrollInCourseIds: (req.body.action.enrollInCourseIds || []).map((id) => new ObjectId(id)),
      enrollInLearningPathIds: (req.body.action.enrollInLearningPathIds || []).map((id) => new ObjectId(id)),
      dueDateOffsetDays: req.body.action.dueDateOffsetDays ?? null,
      notifyEmployee: req.body.action.notifyEmployee !== false,
      notifyManager: !!req.body.action.notifyManager,
    },
    isActive: req.body.isActive !== false,
    createdBy: new ObjectId(req.user._id),
    createdAt: new Date(),
  };
  const result = await insertOne('trainingAssignmentRules', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const listRules = async (req, res) => {
  const rules = await findMany('trainingAssignmentRules', {}, { sort: { createdAt: -1 } });
  const ids = rules.map((r) => r._id);
  const lastRuns = ids.length ? await aggregate('ruleExecutionLogs', [
    { $match: { ruleId: { $in: ids } } },
    { $sort: { runAt: -1 } },
    { $group: { _id: '$ruleId', lastRunAt: { $first: '$runAt' }, lastRunMatched: { $first: '$matched' }, lastRunCreated: { $first: '$created' } } },
  ]) : [];
  const lastRunMap = Object.fromEntries(lastRuns.map((l) => [String(l._id), l]));

  return returnFunction(res, 200, true, req.locale.success, rules.map((r) => ({ ...r, ...(lastRunMap[String(r._id)] || {}) })));
};

const updateRule = async (req, res) => {
  const allowed = ['name', 'trigger', 'triggerConditions', 'isActive'];
  const update = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
  if (req.body.action !== undefined) {
    update.action = {
      enrollInCourseIds: (req.body.action.enrollInCourseIds || []).map((id) => new ObjectId(id)),
      enrollInLearningPathIds: (req.body.action.enrollInLearningPathIds || []).map((id) => new ObjectId(id)),
      dueDateOffsetDays: req.body.action.dueDateOffsetDays ?? null,
      notifyEmployee: req.body.action.notifyEmployee !== false,
      notifyManager: !!req.body.action.notifyManager,
    };
  }

  const result = await updateOne('trainingAssignmentRules', { _id: new ObjectId(req.params.id) }, { $set: update });
  if (!result.matchedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const runRuleNow = async (req, res) => {
  const rule = await findOne('trainingAssignmentRules', { _id: new ObjectId(req.params.id) });
  if (!rule) return returnFunction(res, 404, false, req.locale.notFound);

  const result = await runRule(rule);
  return returnFunction(res, 200, true, `Matched ${result.matched}, created ${result.created} enrollment(s).`, result);
};

// ── Analytics (HR admin) ──────────────────────────────────────────────────────

const getTrainingOverview = async (req, res) => {
  const now = new Date();
  const [publishedCourses, activeEnrollments, overdueCount, expiringCertCount, totalEnrollments, completedEnrollments] = await Promise.all([
    countDocuments('courses', { status: 'published' }),
    countDocuments('enrollments', { status: { $in: ['notStarted', 'inProgress'] } }),
    countDocuments('enrollments', { status: 'overdue' }),
    countDocuments('certificates', { expiresAt: { $gte: now, $lte: new Date(now.getTime() + 30 * 86400000) } }),
    countDocuments('enrollments', {}),
    countDocuments('enrollments', { status: 'completed' }),
  ]);

  return returnFunction(res, 200, true, req.locale.success, {
    publishedCourses,
    activeEnrollments,
    orgCompletionRate: totalEnrollments > 0 ? Math.round((completedEnrollments / totalEnrollments) * 100) : 0,
    overdueCount,
    certsExpiringIn30Days: expiringCertCount,
  });
};

const getComplianceReport = async (req, res) => {
  const mandatoryCourses = await findMany('courses', { isMandatory: true, status: 'published' });
  const courseIds = mandatoryCourses.map((c) => c._id);
  const enrollments = courseIds.length ? await findMany('enrollments', { courseId: { $in: courseIds } }) : [];

  const byCourse = mandatoryCourses.map((c) => {
    const rows = enrollments.filter((e) => String(e.courseId) === String(c._id));
    const completed = rows.filter((e) => e.status === 'completed').length;
    const overdue = rows.filter((e) => e.status === 'overdue').length;
    return {
      courseId: c._id,
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
  const expiringCerts = await findMany('certificates', { expiresAt: { $gte: now, $lte: in30 } });
  const employeeIds = [...new Set(expiringCerts.map((c) => String(c.employeeId)))].map((id) => new ObjectId(id));
  const [users, allCourses] = await Promise.all([
    employeeIds.length ? findMany('users', { _id: { $in: employeeIds } }, { projection: { name: 1 } }) : [],
    findMany('courses', {}, { projection: { title: 1 } }),
  ]);
  const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));
  const courseTitleMap = Object.fromEntries(allCourses.map((c) => [String(c._id), c.title]));

  const certExpiry = expiringCerts.map((c) => ({
    employeeId: c.employeeId,
    employeeName: userMap[String(c.employeeId)]?.name || 'Unknown',
    courseTitle: courseTitleMap[String(c.courseId)] || 'Unknown',
    certificateNumber: c.certificateNumber,
    expiresAt: c.expiresAt,
    daysRemaining: Math.ceil((new Date(c.expiresAt) - now) / 86400000),
  }));

  return returnFunction(res, 200, true, req.locale.success, { mandatoryCourses: byCourse, certExpiry });
};

const getCourseAnalytics = async (req, res) => {
  const courseId = new ObjectId(req.params.id);
  const course = await findOne('courses', { _id: courseId });
  if (!course) return returnFunction(res, 404, false, req.locale.notFound);

  const modules = await findMany('courseModules', { courseId }, { sort: { order: 1 } });
  const enrollments = await findMany('enrollments', { courseId });

  const funnel = modules.map((m) => {
    const completedCount = enrollments.filter((e) => e.moduleProgress.some((mp) => String(mp.moduleId) === String(m._id) && mp.status === 'completed')).length;
    return {
      moduleId: m._id,
      title: m.title,
      completedCount,
      dropOffRate: enrollments.length ? Math.round(((enrollments.length - completedCount) / enrollments.length) * 100) : 0,
    };
  });

  const quizModuleIds = modules.filter((m) => m.type === 'quiz').map((m) => String(m._id));
  const quizScores = [];
  enrollments.forEach((e) => e.moduleProgress.forEach((mp) => {
    if (quizModuleIds.includes(String(mp.moduleId)) && mp.lastScore != null) quizScores.push(mp.lastScore);
  }));
  const avgQuizScore = quizScores.length ? Math.round(quizScores.reduce((a, b) => a + b, 0) / quizScores.length) : null;

  const feedback = await findMany('trainingFeedback', { courseId });
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
  const employeeId = new ObjectId(req.params.id);
  const user = await findOne('users', { _id: employeeId }, { projection: { name: 1, department: 1, role: 1 } });
  if (!user) return returnFunction(res, 404, false, req.locale.notFound);

  const enrollments = await findMany('enrollments', { employeeId });
  const courseIds = enrollments.filter((e) => e.courseId).map((e) => e.courseId);
  const courses = courseIds.length ? await findMany('courses', { _id: { $in: courseIds } }, { projection: { title: 1, category: 1, isMandatory: 1 } }) : [];
  const courseMap = Object.fromEntries(courses.map((c) => [String(c._id), c]));

  const [certificates, externalCertificates] = await Promise.all([
    findMany('certificates', { employeeId }),
    findMany('externalCertificates', { employeeId }),
  ]);

  return returnFunction(res, 200, true, req.locale.success, {
    employee: { _id: user._id, name: user.name, department: user.department, role: user.role },
    enrollments: enrollments.map((e) => ({ ...e, course: e.courseId ? courseMap[String(e.courseId)] || null : null })),
    certificates, externalCertificates,
  });
};

const getLeaderboard = async (req, res) => {
  const completed = await aggregate('enrollments', [
    { $match: { status: 'completed', courseId: { $ne: null } } },
    { $group: { _id: '$employeeId', coursesCompleted: { $sum: 1 } } },
    { $sort: { coursesCompleted: -1 } },
    { $limit: 20 },
  ]);
  const employeeIds = completed.map((c) => c._id);
  const [users, certCounts] = await Promise.all([
    employeeIds.length ? findMany('users', { _id: { $in: employeeIds } }, { projection: { name: 1, department: 1 } }) : [],
    employeeIds.length ? aggregate('certificates', [
      { $match: { employeeId: { $in: employeeIds } } },
      { $group: { _id: '$employeeId', certificatesEarned: { $sum: 1 } } },
    ]) : [],
  ]);
  const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));
  const certMap = Object.fromEntries(certCounts.map((c) => [String(c._id), c.certificatesEarned]));

  const leaderboard = completed.map((c, i) => ({
    rank: i + 1,
    employeeId: c._id,
    name: userMap[String(c._id)]?.name || 'Unknown',
    department: userMap[String(c._id)]?.department || null,
    coursesCompleted: c.coursesCompleted,
    certificatesEarned: certMap[String(c._id)] || 0,
  }));

  return returnFunction(res, 200, true, req.locale.success, leaderboard);
};

// Ad-hoc reminder from the Compliance Dashboard — either one employee (about an
// overdue course or an expiring certificate) or every currently-overdue enrollment.
const sendComplianceReminder = async (req, res) => {
  if (req.body.employeeId) {
    const employeeId = new ObjectId(req.body.employeeId);
    notifyUser(employeeId, {
      title: 'Training Reminder',
      body: req.body.message || 'This is a reminder to complete your assigned training.',
      type: 'training',
      link: '/my/training',
    }).catch(() => {});
    return returnFunction(res, 200, true, 'Reminder sent.');
  }

  const overdue = await findMany('enrollments', { status: 'overdue' }, { projection: { employeeId: 1 } });
  const uniqueIds = [...new Set(overdue.map((e) => String(e.employeeId)))];
  for (const id of uniqueIds) {
    notifyUser(new ObjectId(id), {
      title: 'Training Reminder',
      body: 'You have overdue training — please complete it as soon as possible.',
      type: 'training',
      link: '/my/training',
    }).catch(() => {});
  }
  return returnFunction(res, 200, true, `Reminder sent to ${uniqueIds.length} employee(s).`);
};

module.exports = {
  COURSE_CATEGORIES, COURSE_STATUSES, MODULE_TYPES, ENROLLMENT_STATUSES, RULE_TRIGGERS,
  sendComplianceReminder,
  createCourse, listCourses, getCourse, updateCourse, publishCourse, archiveCourse, addCourseAuthor,
  listCatalog, getCatalogCourse, getModuleQuizForLearner,
  addModule, updateModule, deleteModule,
  createQuiz, updateQuiz,
  createLearningPath, listLearningPaths, getLearningPath, updateLearningPath, archiveLearningPath,
  createSingleCourseEnrollment, createLearningPathEnrollment,
  assignTraining, listEnrollments, waiveEnrollment,
  getMyEnrollments, updateMyProgress, submitQuizAttempt, submitCourseFeedback, getMyLearningPaths,
  generateMyCertificate, getMyCertificates,
  uploadExternalCertificate, getMyExternalCertificates, listExternalCertificates, verifyExternalCertificate,
  createRule, listRules, updateRule, runRuleNow,
  getTrainingOverview, getComplianceReport, getCourseAnalytics, getEmployeeTrainingRecord, getLeaderboard,
};
