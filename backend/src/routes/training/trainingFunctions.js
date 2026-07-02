const { ObjectId } = require('mongodb');
const PDFDocument = require('pdfkit');
const returnFunction = require('../../functions/returnFunction');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { notifyUser } = require('../../functions/HR/notifyUser');

// Generate a training completion certificate and return base64 PDF
const generateCertificate = (employeeName, courseTitle, completedAt, companyName = 'The Organisation') => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 60 });
    const buffers = [];
    doc.on('data', b => buffers.push(b));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const W = doc.page.width, H = doc.page.height;
    // Border
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

  if (category)  query.category = category;
  if (level)     query.level = level;
  if (search)    query.title = { $regex: search, $options: 'i' };

  const courses = await findMany('training_courses', query, { sort: { createdAt: -1 } });

  // Annotate each course with the current user's enrollment status
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
    startTime = null, endTime = null, venue = null, trainingMode = 'in_person',
  } = req.body;

  if (!title) return returnFunction(res, 400, false, 'Title is required');

  const doc = {
    title, description, category, level, duration,
    instructor, isMandatory, loginUrl,
    trainingType,
    objectives: Array.isArray(objectives) ? objectives.filter(Boolean) : [],
    startTime: startTime || null,
    endTime: endTime || null,
    venue: venue || null,
    trainingMode,
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
  if (req.body.trainingType !== undefined) updates.trainingType = req.body.trainingType;
  if (req.body.startTime    !== undefined) updates.startTime = req.body.startTime || null;
  if (req.body.endTime      !== undefined) updates.endTime = req.body.endTime || null;
  if (req.body.venue        !== undefined) updates.venue = req.body.venue || null;
  if (req.body.trainingMode !== undefined) updates.trainingMode = req.body.trainingMode || 'in_person';
  if (req.body.objectives   !== undefined) updates.objectives = Array.isArray(req.body.objectives) ? req.body.objectives.filter(Boolean) : [];
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

// ── Enrollments ───────────────────────────────────────────────────────────────

const enrollInCourse = async (req, res) => {
  const { id } = req.params; // courseId
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
    dueDate:     null,
    certificateUrl: null,
    enrolledAt:  new Date(),
    updatedAt:   new Date(),
  };

  await insertOne('training_enrollments', enrollment);
  await updateOne('training_courses', { _id: new ObjectId(id) }, { $inc: { enrolledCount: 1 } });

  return returnFunction(res, 201, true, 'Enrolled successfully');
};

const startCourse = async (req, res) => {
  const { id } = req.params; // courseId
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid ID');
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

  // Atomic toggle — no read-modify-write race
  await global.dbo.collection('training_enrollments').updateOne(
    { _id: new ObjectId(id) },
    alreadyDone
      ? { $pull: { completedObjectives: idx }, $set: { updatedAt: new Date() } }
      : { $addToSet: { completedObjectives: idx }, $set: { updatedAt: new Date() } }
  );

  // Re-fetch to get accurate completed list after atomic update
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
    completed:  enrollments.filter(e => e.status === 'completed').length,
    overdue:    enrollments.filter(e => e.dueDate && new Date(e.dueDate) < new Date() && e.status !== 'completed').length,
  };

  return returnFunction(res, 200, true, 'Training fetched', { enrollments, summary });
};

const updateProgress = async (req, res) => {
  const { id } = req.params; // enrollmentId
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
    // For self_paced: only complete if all objectives done
    if (enrollment.trainingType === 'self_paced') {
      const totalObj = (enrollment.objectives || []).length;
      const doneObj  = (enrollment.completedObjectives || []).length;
      if (totalObj > 0 && doneObj < totalObj) {
        return returnFunction(res, 400, false, 'Complete all objectives before marking this course as done.');
      }
    }
    updates.status      = 'completed';
    updates.completedAt = new Date();
  }

  await updateOne('training_enrollments', { _id: new ObjectId(id) }, { $set: updates });

  // Generate certificate when newly completed
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
      // Certificate failure should not block completion
      console.error('Certificate generation failed:', certErr.message);
    }
  }

  return returnFunction(res, 200, true, 'Progress updated', { certificateGenerated: updates.status === 'completed' });
};

const getTeamTraining = async (req, res) => {
  const { departmentId } = req.query;

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
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
        total: { $sum: 1 },
      }},
    ]).toArray();

  return returnFunction(res, 200, true, 'Team training fetched', enrollments);
};

// ── HR: assign course to one or more employees ────────────────────────────────

const assignCourseToEmployees = async (req, res) => {
  const { id } = req.params; // courseId
  if (!ObjectId.isValid(id)) return returnFunction(res, 400, false, 'Invalid course ID');

  const { employeeIds, dueDate } = req.body;
  if (!Array.isArray(employeeIds) || employeeIds.length === 0)
    return returnFunction(res, 400, false, 'employeeIds must be a non-empty array');

  const course = await findOne('training_courses', { _id: new ObjectId(id) });
  if (!course) return returnFunction(res, 404, false, 'Course not found');

  // Fetch user accounts for each employee so we know their userId
  const employees = await global.dbo.collection('users')
    .find({ employeeId: { $in: employeeIds.map(eid => new ObjectId(String(eid))) } })
    .toArray();

  let enrolled = 0;
  let skipped  = 0;

  for (const user of employees) {
    const existing = await findOne('training_enrollments', {
      courseId: new ObjectId(id),
      userId: user._id,
    });
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
      dueDate:     dueDate || null,
      certificateUrl: null,
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
  if (enrollment.status !== 'completed') return returnFunction(res, 400, false, 'Course not yet completed');

  // Return existing cert or regenerate
  let certBase64 = enrollment.certificateData;
  if (!certBase64) {
    const settings = await findOne('company_settings', {});
    const emp = req.user.employeeId ? await findOne('employees', { _id: req.user.employeeId }, { projection: { fullName: 1 } }) : null;
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

module.exports = {
  listCourses, getCourse, createCourse, updateCourse, deleteCourse,
  enrollInCourse, assignCourseToEmployees, getMyTraining, updateProgress, getTeamTraining,
  startCourse, toggleObjective, downloadCertificate,
};
