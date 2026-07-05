const { ObjectId } = require('mongodb');
const PDFDocument = require('pdfkit');
const fs   = require('fs');
const path = require('path');
const returnFunction = require('../../functions/returnFunction');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyUser } = require('../../functions/HR/notifyUser');

// ── Certificate ───────────────────────────────────────────────────────────────

const generateCertificate = (employeeName, courseTitle, completedAt, companyName = 'The Organisation') => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 60 });
    const buffers = [];
    doc.on('data', b => buffers.push(b));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const W = doc.page.width, H = doc.page.height;
    doc.rect(20, 20, W - 40, H - 40).lineWidth(3).strokeColor('#0A1931').stroke();
    doc.rect(28, 28, W - 56, H - 56).lineWidth(1).strokeColor('#C9A84C').stroke();

    doc.moveDown(2);
    doc.fontSize(36).font('Helvetica-Bold').fillColor('#0A1931')
       .text('CERTIFICATE OF COMPLETION', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(13).font('Helvetica').fillColor('#555')
       .text('This is to certify that', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(28).font('Helvetica-Bold').fillColor('#C9A84C')
       .text(employeeName, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(13).font('Helvetica').fillColor('#333')
       .text('has successfully completed the course', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#0A1931')
       .text(courseTitle, { align: 'center' });
    doc.moveDown(1);
    const dateStr = new Date(completedAt).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
    doc.fontSize(12).font('Helvetica').fillColor('#555')
       .text(`Completed on ${dateStr}`, { align: 'center' });
    doc.moveDown(2);
    doc.moveTo(W / 2 - 100, doc.y).lineTo(W / 2 + 100, doc.y).strokeColor('#0A1931').lineWidth(1).stroke();
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor('#333').text(companyName, { align: 'center' });
    doc.end();
  });
};

// ── Courses ───────────────────────────────────────────────────────────────────

const listCourses = async (req, res) => {
  const { search, category, level, status = 'published' } = req.query;

  const query = {};
  if (req.user.role === 'staff') query.status = 'published';
  else if (status !== 'all') query.status = status;

  if (category) query.category = category;
  if (level)    query.level = level;
  if (search)   query.title = { $regex: search, $options: 'i' };

  const courses = await findMany('training_courses', query, { sort: { createdAt: -1 } });

  const courseIds = courses.map(c => c._id);
  const myEnrollments = courseIds.length
    ? await findMany('training_enrollments', { userId: req.user._id, courseId: { $in: courseIds } }, {
        projection: { courseId: 1, status: 1, progress: 1, completedObjectives: 1, objectives: 1, trainingType: 1 },
      })
    : [];
  const enrollmentMap = Object.fromEntries(myEnrollments.map(e => [String(e.courseId), e]));

  const annotated = courses.map(c => ({
    ...c,
    myEnrollment: enrollmentMap[String(c._id)] || null,
  }));

  return returnFunction(res, 200, true, 'Courses fetched', annotated);
};

const createCourse = async (req, res) => {
  const {
    title, description, category = 'Other', level = 'beginner',
    duration = 0, instructor = '', isMandatory = false, loginUrl = '',
    trainingType = 'self_paced', objectives = [],
    startTime = null, endTime = null, trainingMode = 'in_person',
    link = null,
    location = null,
    isRecurring = false,
    recurringFrequency = null,
  } = req.body;

  if (!title) return returnFunction(res, 400, false, 'Title is required');

  // Normalise location object
  const locationData = location && typeof location === 'object'
    ? { address: (location.address || '').trim(), venue: (location.venue || '').trim() }
    : null;

  // Rename legacy one_time → recurring_event
  const normalizedType = trainingType === 'one_time' ? 'recurring_event' : trainingType;

  const doc = {
    title, description, category, level, duration,
    instructor, isMandatory, loginUrl,
    trainingType: normalizedType,
    objectives: Array.isArray(objectives) ? objectives.filter(Boolean) : [],
    startTime: startTime || null,
    endTime:   endTime   || null,
    trainingMode,
    link: link || null,
    location: locationData,
    isRecurring: Boolean(isRecurring),
    recurringFrequency: isRecurring ? (recurringFrequency || null) : null,
    materials: [],
    status: 'published',
    rating: 0,
    enrolledCount: 0,
    thumbnail: null,
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('training_courses', doc);
  return returnFunction(res, 201, true, 'Course created', { _id: result.insertedId, ...doc });
};

const getCourse = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');
  const course = await findOne('training_courses', { _id: new ObjectId(id) });
  if (!course) return returnFunction(res, 404, false, 'Course not found');
  return returnFunction(res, 200, true, 'OK', course);
};

const updateCourse = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');

  const { title, description, category, level, duration, instructor, isMandatory, status } = req.body;
  const updates = {};
  if (title       !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (category    !== undefined) updates.category = category;
  if (level       !== undefined) updates.level = level;
  if (duration    !== undefined) updates.duration = duration;
  if (instructor  !== undefined) updates.instructor = instructor;
  if (isMandatory !== undefined) updates.isMandatory = isMandatory;
  if (status      !== undefined) updates.status = status;
  if (req.body.trainingType !== undefined) {
    const t = req.body.trainingType;
    updates.trainingType = t === 'one_time' ? 'recurring_event' : t;
  }
  if (req.body.startTime    !== undefined) updates.startTime = req.body.startTime || null;
  if (req.body.endTime      !== undefined) updates.endTime   = req.body.endTime   || null;
  if (req.body.trainingMode !== undefined) updates.trainingMode = req.body.trainingMode || 'in_person';
  if (req.body.link         !== undefined) updates.link = req.body.link || null;
  if (req.body.location !== undefined) {
    const loc = req.body.location;
    updates.location = loc && typeof loc === 'object'
      ? { address: (loc.address || '').trim(), venue: (loc.venue || '').trim() }
      : null;
  }
  if (req.body.isRecurring        !== undefined) updates.isRecurring = Boolean(req.body.isRecurring);
  if (req.body.recurringFrequency !== undefined) updates.recurringFrequency = req.body.recurringFrequency || null;
  if (req.body.objectives !== undefined) {
    updates.objectives = Array.isArray(req.body.objectives) ? req.body.objectives.filter(Boolean) : [];
  }
  updates.updatedAt = new Date();

  await updateOne('training_courses', { _id: new ObjectId(id) }, { $set: updates });
  return returnFunction(res, 200, true, 'Course updated');
};

const deleteCourse = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');
  await global.dbo.collection('training_courses').deleteOne({ _id: new ObjectId(id) });
  return returnFunction(res, 200, true, 'Course deleted');
};

// ── Materials ─────────────────────────────────────────────────────────────────

const addMaterial = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');

  const course = await findOne('training_courses', { _id: new ObjectId(id) });
  if (!course) return returnFunction(res, 404, false, 'Course not found');
  if (!req.file) return returnFunction(res, 400, false, 'No file uploaded');

  const { wordCount, title: materialTitle } = req.body;
  const isVideo = req.file.mimetype.startsWith('video/');
  const isPDF   = req.file.mimetype === 'application/pdf';

  const parsedWordCount = wordCount ? Number(wordCount) : null;
  // 200 words per minute → convert to seconds
  const minReadTimeSeconds = parsedWordCount ? Math.ceil((parsedWordCount / 200) * 60) : null;

  const material = {
    _id: new ObjectId(),
    title:        materialTitle || req.file.originalname,
    type:         isVideo ? 'video' : isPDF ? 'pdf' : 'other',
    filename:     req.file.filename,
    originalName: req.file.originalname,
    mimetype:     req.file.mimetype,
    size:         req.file.size,
    wordCount:    parsedWordCount,
    minReadTimeSeconds,
    uploadedAt:   new Date(),
  };

  await global.dbo.collection('training_courses').updateOne(
    { _id: new ObjectId(id) },
    { $push: { materials: material }, $set: { updatedAt: new Date() } }
  );

  return returnFunction(res, 201, true, 'Material uploaded', material);
};

const removeMaterial = async (req, res) => {
  const { id, materialId } = req.params;
  if (!ObjectId.isValid(id) || !ObjectId.isValid(materialId)) {
    return returnFunction(res, 400, false, 'Invalid ID');
  }

  await global.dbo.collection('training_courses').updateOne(
    { _id: new ObjectId(id) },
    { $pull: { materials: { _id: new ObjectId(materialId) } }, $set: { updatedAt: new Date() } }
  );

  return returnFunction(res, 200, true, 'Material removed');
};

const saveMaterialProgress = async (req, res) => {
  const { id } = req.params; // enrollmentId
  const { materialId, videoPositionSeconds, timeSpentSeconds, completed } = req.body;

  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');
  if (!materialId) return returnFunction(res, 400, false, 'materialId required');

  const enrollment = await findOne('training_enrollments', { _id: new ObjectId(id), userId: req.user._id });
  if (!enrollment) return returnFunction(res, 404, false, 'Enrollment not found');

  const existing = enrollment.materialProgress?.[materialId] || {};
  const updates = { updatedAt: new Date() };

  if (videoPositionSeconds !== undefined) {
    updates[`materialProgress.${materialId}.videoPositionSeconds`] = Number(videoPositionSeconds);
  }
  if (timeSpentSeconds !== undefined) {
    // Only advance, never go backwards (guards against duplicate saves)
    const prev = existing.timeSpentSeconds || 0;
    updates[`materialProgress.${materialId}.timeSpentSeconds`] = Math.max(prev, Number(timeSpentSeconds));
  }
  if (completed !== undefined) {
    updates[`materialProgress.${materialId}.completed`] = Boolean(completed);
  }

  await updateOne('training_enrollments', { _id: new ObjectId(id) }, { $set: updates });

  const updated = await findOne('training_enrollments', { _id: new ObjectId(id) });
  return returnFunction(res, 200, true, 'Progress saved', {
    materialProgress: updated?.materialProgress || {},
  });
};

// ── Enrollments ───────────────────────────────────────────────────────────────

const enrollInCourse = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');

  const course = await findOne('training_courses', { _id: new ObjectId(id) });
  if (!course) return returnFunction(res, 404, false, 'Course not found');

  const userId = req.user._id;
  const existing = await findOne('training_enrollments', { courseId: new ObjectId(id), userId });
  if (existing) return returnFunction(res, 400, false, 'Already enrolled');

  const enrollment = {
    courseId:    new ObjectId(id),
    userId,
    employeeId:  req.user.employeeId || null,
    courseTitle: course.title,
    category:    course.category,
    trainingType: course.trainingType || 'self_paced',
    objectives:  course.objectives || [],
    completedObjectives: [],
    status:      'not_started',
    progress:    0,
    startedAt:   null,
    completedAt: null,
    minutesPresent: null,
    dueDate:     null,
    certificateUrl: null,
    materialProgress: {},
    enrolledAt:  new Date(),
    updatedAt:   new Date(),
  };

  await insertOne('training_enrollments', enrollment);
  await updateOne('training_courses', { _id: new ObjectId(id) }, { $inc: { enrolledCount: 1 } });

  return returnFunction(res, 201, true, 'Enrolled successfully');
};

const startCourse = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');

  const course = await findOne('training_courses', { _id: new ObjectId(id) });
  if (!course) return returnFunction(res, 404, false, 'Course not found');

  // Enforce start time only when stored as full ISO datetime (contains 'T')
  if (course.startTime && String(course.startTime).includes('T')) {
    const startDate = new Date(course.startTime);
    if (!isNaN(startDate.getTime()) && new Date() < startDate) {
      const label = startDate.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
      return returnFunction(res, 403, false, `Training hasn't started yet — it begins at ${label}.`);
    }
  }

  const enrollment = await findOne('training_enrollments', { courseId: new ObjectId(id), userId: req.user._id });
  if (!enrollment) return returnFunction(res, 404, false, 'Not enrolled in this course');
  if (enrollment.status !== 'not_started') return returnFunction(res, 400, false, 'Course already started');

  await updateOne('training_enrollments', { _id: enrollment._id }, {
    $set: { status: 'in_progress', startedAt: new Date(), updatedAt: new Date() },
  });
  return returnFunction(res, 200, true, 'Course started');
};

const toggleObjective = async (req, res) => {
  const { id } = req.params;
  const { index } = req.body;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');

  const enrollment = await findOne('training_enrollments', { _id: new ObjectId(id), userId: req.user._id });
  if (!enrollment) return returnFunction(res, 404, false, 'Enrollment not found');
  if (enrollment.status !== 'in_progress') return returnFunction(res, 400, false, 'Course not started');

  const idx = Number(index);
  const total = (enrollment.objectives || []).length;
  if (!Number.isInteger(idx) || idx < 0 || (total > 0 && idx >= total)) {
    return returnFunction(res, 400, false, 'Invalid objective index');
  }

  const alreadyDone = (enrollment.completedObjectives || []).includes(idx);

  await global.dbo.collection('training_enrollments').updateOne(
    { _id: new ObjectId(id) },
    alreadyDone
      ? { $pull: { completedObjectives: idx }, $set: { updatedAt: new Date() } }
      : { $addToSet: { completedObjectives: idx }, $set: { updatedAt: new Date() } }
  );

  const updated = await findOne('training_enrollments', { _id: new ObjectId(id) });
  const newCompleted = updated?.completedObjectives ?? [];
  const progress = total > 0 ? Math.min(100, Math.round((newCompleted.length / total) * 100)) : 0;

  await updateOne('training_enrollments', { _id: new ObjectId(id) }, {
    $set: { progress, updatedAt: new Date() },
  });

  return returnFunction(res, 200, true, 'Objective updated', { completedObjectives: newCompleted, progress });
};

const getMyTraining = async (req, res) => {
  const userId = req.user._id;

  const enrollments = await findMany('training_enrollments', { userId }, { sort: { enrolledAt: -1 } });

  const summary = {
    assigned:   enrollments.filter(e => e.status === 'not_started').length,
    inProgress: enrollments.filter(e => e.status === 'in_progress').length,
    completed:  enrollments.filter(e => e.status === 'completed' || e.status === 'auto_completed').length,
    overdue:    enrollments.filter(e =>
      e.dueDate && new Date(e.dueDate) < new Date() &&
      e.status !== 'completed' && e.status !== 'auto_completed'
    ).length,
  };

  return returnFunction(res, 200, true, 'Training fetched', { enrollments, summary });
};

const updateProgress = async (req, res) => {
  const { id } = req.params;
  const { progress } = req.body;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');

  const enrollment = await findOne('training_enrollments', { _id: new ObjectId(id), userId: req.user._id });
  if (!enrollment) return returnFunction(res, 404, false, 'Enrollment not found');

  const pct = Math.min(100, Math.max(0, Number(progress) || 0));
  const updates = { progress: pct, updatedAt: new Date() };

  if (pct > 0 && enrollment.status === 'not_started') {
    updates.status    = 'in_progress';
    updates.startedAt = new Date();
  }
  if (pct >= 100) {
    if (enrollment.trainingType === 'self_paced') {
      const totalObj = (enrollment.objectives || []).length;
      const doneObj  = (enrollment.completedObjectives || []).length;
      if (totalObj > 0 && doneObj < totalObj) {
        return returnFunction(res, 400, false, 'Complete all objectives before marking this course as done.');
      }
    }
    const courseQuiz = await findOne('training_quizzes', { courseId: enrollment.courseId });
    if (courseQuiz && !enrollment.quizPassed) {
      return returnFunction(res, 400, false, 'Pass the assessment quiz before marking this course as complete.');
    }
    const completedAt = new Date();
    updates.status      = 'completed';
    updates.completedAt = completedAt;
    if (enrollment.startedAt) {
      updates.minutesPresent = Math.max(1, Math.round((completedAt - new Date(enrollment.startedAt)) / 60000));
    }
  }

  await updateOne('training_enrollments', { _id: new ObjectId(id) }, { $set: updates });

  if (updates.status === 'completed') {
    try {
      const settings = await findOne('company_settings', {});
      const user = await findOne('users', { _id: enrollment.userId });
      const emp  = user?.employeeId ? await findOne('employees', { _id: user.employeeId }, { projection: { fullName: 1 } }) : null;
      const name = emp?.fullName || user?.name || 'Participant';
      const pdfBuf = await generateCertificate(name, enrollment.courseTitle, updates.completedAt, settings?.companyName);
      const certBase64 = pdfBuf.toString('base64');
      await updateOne('training_enrollments', { _id: new ObjectId(id) }, {
        $set: { certificateData: certBase64, updatedAt: new Date() },
      });
    } catch (certErr) {
      console.error('Certificate generation failed:', certErr.message);
    }
  }

  return returnFunction(res, 200, true, 'Progress updated', { certificateGenerated: updates.status === 'completed' });
};

const getTeamTraining = async (req, res) => {
  let employeeQuery = {};
  if (req.user.role === 'department_head' && req.user.department) {
    employeeQuery.department = req.user.department;
  }

  const employees = await findMany('employees', employeeQuery, { projection: { _id: 1, fullName: 1 } });
  const employeeIds = employees.map(e => e._id);

  const enrollments = await global.dbo.collection('training_enrollments')
    .aggregate([
      { $match: { userId: { $in: employeeIds.map(id => new ObjectId(String(id))) } } },
      { $group: {
        _id: '$userId',
        completed:  { $sum: { $cond: [{ $in: ['$status', ['completed', 'auto_completed']] }, 1, 0] } },
        inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
        total: { $sum: 1 },
      }},
    ]).toArray();

  return returnFunction(res, 200, true, 'Team training fetched', enrollments);
};

// ── HR: assign course to employees ────────────────────────────────────────────

const assignCourseToEmployees = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid course ID');

  const { employeeIds, dueDate } = req.body;
  if (!Array.isArray(employeeIds) || employeeIds.length === 0)
    return returnFunction(res, 400, false, 'employeeIds must be a non-empty array');

  const course = await findOne('training_courses', { _id: new ObjectId(id) });
  if (!course) return returnFunction(res, 404, false, 'Course not found');

  const employees = await global.dbo.collection('users')
    .find({ employeeId: { $in: employeeIds.map(eid => new ObjectId(String(eid))) } })
    .toArray();

  let enrolled = 0;
  let skipped  = 0;

  for (const user of employees) {
    const existing = await findOne('training_enrollments', { courseId: new ObjectId(id), userId: user._id });
    if (existing) { skipped++; continue; }

    await insertOne('training_enrollments', {
      courseId:    new ObjectId(id),
      userId:      user._id,
      employeeId:  user.employeeId || null,
      courseTitle: course.title,
      category:    course.category,
      trainingType: course.trainingType || 'self_paced',
      objectives:  course.objectives || [],
      completedObjectives: [],
      status:      'not_started',
      progress:    0,
      startedAt:   null,
      completedAt: null,
      minutesPresent: null,
      dueDate:     dueDate || null,
      certificateUrl: null,
      materialProgress: {},
      enrolledAt:  new Date(),
      updatedAt:   new Date(),
    });
    notifyUser(user._id, {
      title: 'You have been enrolled in a training course',
      body: `You've been assigned to "${course.title}"${dueDate ? ` — due ${dueDate}` : ''}.`,
      type: 'training',
    }).catch(() => {});
    enrolled++;
  }

  if (enrolled > 0) {
    await updateOne('training_courses', { _id: new ObjectId(id) }, { $inc: { enrolledCount: enrolled } });
  }

  return returnFunction(res, 200, true, `Assigned to ${enrolled} employee(s). ${skipped} already enrolled.`, { enrolled, skipped });
};

const downloadCertificate = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');
  const enrollment = await findOne('training_enrollments', { _id: new ObjectId(id), userId: req.user._id });
  if (!enrollment) return returnFunction(res, 404, false, 'Enrollment not found');
  if (!['completed', 'auto_completed'].includes(enrollment.status)) {
    return returnFunction(res, 400, false, 'Course not yet completed');
  }

  let certBase64 = enrollment.certificateData;
  if (!certBase64) {
    const settings = await findOne('company_settings', {});
    const emp = req.user.employeeId
      ? await findOne('employees', { _id: req.user.employeeId }, { projection: { fullName: 1 } })
      : null;
    const name = emp?.fullName || req.user.name || 'Participant';
    const pdfBuf = await generateCertificate(name, enrollment.courseTitle, enrollment.completedAt, settings?.companyName);
    certBase64 = pdfBuf.toString('base64');
    await updateOne('training_enrollments', { _id: new ObjectId(id) }, { $set: { certificateData: certBase64 } });
  }

  const buf = Buffer.from(certBase64, 'base64');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="certificate-${id}.pdf"`);
  return res.send(buf);
};

// ── Quizzes ───────────────────────────────────────────────────────────────────

const createQuiz = async (req, res) => {
  const { id } = req.params; // courseId
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');

  const { title, questions, passingScore = 70 } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return returnFunction(res, 400, false, 'title and questions are required');
  }
  for (const q of questions) {
    if (!q.text || !Array.isArray(q.options) || q.options.length < 2 || typeof q.correctIndex !== 'number') {
      return returnFunction(res, 400, false, 'Each question needs text, at least 2 options, and a correctIndex');
    }
  }

  await global.dbo.collection('training_quizzes').updateOne(
    { courseId: new ObjectId(id) },
    {
      $set: { courseId: new ObjectId(id), title, questions, passingScore: Number(passingScore), updatedBy: req.user._id, updatedAt: new Date() },
      $setOnInsert: { createdBy: req.user._id, createdAt: new Date() },
    },
    { upsert: true }
  );
  return returnFunction(res, 200, true, 'Quiz saved');
};

const getQuiz = async (req, res) => {
  const { id } = req.params; // courseId
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');

  const quiz = await findOne('training_quizzes', { courseId: new ObjectId(id) });
  if (!quiz) return returnFunction(res, 404, false, 'No quiz for this course');

  // Strip answers for non-HR roles
  const isHR = ['super_admin', 'hr_manager'].includes(req.user.role);
  if (!isHR) {
    quiz.questions = quiz.questions.map(({ correctIndex, explanation, ...rest }) => ({ ...rest, explanation: explanation || null }));
  }
  return returnFunction(res, 200, true, 'Quiz fetched', quiz);
};

const deleteQuiz = async (req, res) => {
  const { id } = req.params; // courseId
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');
  await global.dbo.collection('training_quizzes').deleteOne({ courseId: new ObjectId(id) });
  return returnFunction(res, 200, true, 'Quiz deleted');
};

const submitQuiz = async (req, res) => {
  const { id } = req.params; // courseId
  const { answers } = req.body;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');
  if (!Array.isArray(answers)) return returnFunction(res, 400, false, 'answers array required');

  const quiz = await findOne('training_quizzes', { courseId: new ObjectId(id) });
  if (!quiz) return returnFunction(res, 404, false, 'No quiz for this course');

  const enrollment = await findOne('training_enrollments', { courseId: new ObjectId(id), userId: req.user._id });
  if (!enrollment) return returnFunction(res, 404, false, 'Not enrolled in this course');

  let correct = 0;
  const results = quiz.questions.map((q, i) => {
    const chosen = answers[i] ?? -1;
    const isCorrect = chosen === q.correctIndex;
    if (isCorrect) correct++;
    return { chosen, correct: isCorrect, correctIndex: q.correctIndex, explanation: q.explanation || null };
  });

  const score = quiz.questions.length > 0 ? Math.round((correct / quiz.questions.length) * 100) : 0;
  const passed = score >= (quiz.passingScore ?? 70);

  await global.dbo.collection('training_enrollments').updateOne(
    { _id: enrollment._id },
    {
      $push: { quizAttempts: { score, passed, answers, results, attemptedAt: new Date() } },
      $set: { quizPassed: passed || (enrollment.quizPassed === true), updatedAt: new Date() },
    }
  );

  return returnFunction(res, 200, true, passed ? 'Quiz passed!' : 'Not quite — try again', {
    score, passed, correct, total: quiz.questions.length, passingScore: quiz.passingScore ?? 70, results,
  });
};

// ── Learning Paths ────────────────────────────────────────────────────────────

const listPaths = async (req, res) => {
  const paths = await findMany('learning_paths', {}, { sort: { createdAt: -1 } });
  const userId = req.user._id;

  const annotated = await Promise.all(paths.map(async p => {
    const entries = (p.courseIds || []).sort((a, b) => a.order - b.order);
    const courseIds = entries.map(c => new ObjectId(String(c.courseId)));

    if (!courseIds.length) {
      return { ...p, courses: [], myProgress: { enrolled: 0, completed: 0, total: 0, pct: 0 } };
    }

    const courses = await findMany('training_courses', { _id: { $in: courseIds } }, {
      projection: { _id: 1, title: 1, category: 1, duration: 1, isMandatory: 1 },
    });
    const courseMap = Object.fromEntries(courses.map(c => [String(c._id), c]));

    const annotatedCourses = entries.map(entry => ({
      courseId: String(entry.courseId),
      order: entry.order,
      ...courseMap[String(entry.courseId)] || {},
    }));

    const myEnrollments = await findMany('training_enrollments', { userId, courseId: { $in: courseIds } });
    const completedCount = myEnrollments.filter(e => e.status === 'completed' || e.status === 'auto_completed').length;

    return {
      ...p,
      courses: annotatedCourses,
      myProgress: {
        enrolled: myEnrollments.length,
        completed: completedCount,
        total: courseIds.length,
        pct: courseIds.length > 0 ? Math.round((completedCount / courseIds.length) * 100) : 0,
      },
    };
  }));

  return returnFunction(res, 200, true, 'Paths fetched', annotated);
};

const createPath = async (req, res) => {
  const { name, description = '', courseIds = [] } = req.body;
  if (!name) return returnFunction(res, 400, false, 'name is required');

  const doc = {
    name, description,
    courseIds: courseIds.map((c, i) => ({
      courseId: new ObjectId(String(c.courseId || c)),
      order: c.order ?? i,
    })),
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await insertOne('learning_paths', doc);
  return returnFunction(res, 201, true, 'Learning path created', { _id: result.insertedId, ...doc });
};

const updatePath = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');

  const updates = { updatedAt: new Date() };
  if (req.body.name        !== undefined) updates.name = req.body.name;
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.courseIds   !== undefined) {
    updates.courseIds = req.body.courseIds.map((c, i) => ({
      courseId: new ObjectId(String(c.courseId || c)),
      order: c.order ?? i,
    }));
  }

  await updateOne('learning_paths', { _id: new ObjectId(id) }, { $set: updates });
  return returnFunction(res, 200, true, 'Path updated');
};

const deletePath = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');
  await global.dbo.collection('learning_paths').deleteOne({ _id: new ObjectId(id) });
  return returnFunction(res, 200, true, 'Path deleted');
};

const enrollInPath = async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');

  const pathDoc = await findOne('learning_paths', { _id: new ObjectId(id) });
  if (!pathDoc) return returnFunction(res, 404, false, 'Path not found');

  const userId = req.user._id;
  const sorted = [...(pathDoc.courseIds || [])].sort((a, b) => a.order - b.order);
  let enrolled = 0, alreadyIn = 0;

  for (const entry of sorted) {
    const courseId = new ObjectId(String(entry.courseId));
    const course = await findOne('training_courses', { _id: courseId });
    if (!course) continue;

    const existing = await findOne('training_enrollments', { courseId, userId });
    if (existing) { alreadyIn++; continue; }

    await insertOne('training_enrollments', {
      courseId, userId,
      employeeId:  req.user.employeeId || null,
      courseTitle: course.title,
      category:    course.category,
      trainingType: course.trainingType || 'self_paced',
      objectives:  course.objectives || [],
      completedObjectives: [],
      status:      'not_started',
      progress:    0,
      startedAt:   null, completedAt: null, minutesPresent: null,
      dueDate:     null, certificateUrl: null, materialProgress: {},
      pathId:      new ObjectId(id),
      enrolledAt:  new Date(), updatedAt: new Date(),
    });
    await updateOne('training_courses', { _id: courseId }, { $inc: { enrolledCount: 1 } });
    enrolled++;
  }

  return returnFunction(res, 200, true, `Enrolled in ${enrolled} course(s). ${alreadyIn} already enrolled.`, { enrolled, alreadyIn });
};

module.exports = {
  listCourses, getCourse, createCourse, updateCourse, deleteCourse,
  enrollInCourse, assignCourseToEmployees, getMyTraining, updateProgress, getTeamTraining,
  startCourse, toggleObjective, downloadCertificate,
  addMaterial, removeMaterial, saveMaterialProgress,
  createQuiz, getQuiz, deleteQuiz, submitQuiz,
  listPaths, createPath, updatePath, deletePath, enrollInPath,
};
