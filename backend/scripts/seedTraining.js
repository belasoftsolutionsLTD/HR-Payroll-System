/**
 * Training/LMS module demo seed.
 * Creates 6 published courses (3-5 modules each, at least one quiz per course),
 * 2 learning paths, 20 enrollments across various statuses (10 completed with
 * certificates), 3 automation rules, and 5 feedback records. Idempotent-ish —
 * safe to re-run (skips creating courses/paths that already exist by title/name).
 * Run: node scripts/seedTraining.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_DB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'school-erp';

const uid = (() => { let n = 0; return () => `q-${Date.now()}-${n++}`; })();

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log('Connected to', DB_NAME);

  const { generateCertificatePDF } = require('../src/lib/training/generateCertificate');

  const now = new Date();

  // ── 0. HR author + a pool of employees to enroll ─────────────────────────────
  let hrUser = await db.collection('users').findOne({ role: { $in: ['hr_manager', 'super_admin'] } });
  if (!hrUser) {
    const hashed = await bcrypt.hash('Demo@1234', 12);
    const hrId = new ObjectId();
    await db.collection('users').insertOne({
      _id: hrId, name: 'Demo HR Manager', email: 'hr@demo.com', password: hashed,
      role: 'hr_manager', employeeId: null, department: 'Human Resources', isActive: true, mustResetPassword: false,
      createdAt: now, updatedAt: now,
    });
    hrUser = { _id: hrId, name: 'Demo HR Manager' };
    console.log('Fallback HR user created  ->  hr@demo.com / Demo@1234');
  }
  const hrId = hrUser._id;

  let employees = await db.collection('users').find({ role: 'staff' }).limit(20).toArray();
  if (employees.length < 8) {
    const departments = ['Sales & Marketing', 'Information Technology', 'Finance', 'Operations', 'Human Resources'];
    const hashed = await bcrypt.hash('Demo@1234', 12);
    const toCreate = 12 - employees.length;
    const created = [];
    for (let i = 0; i < toCreate; i++) {
      const id = new ObjectId();
      const doc = {
        _id: id, name: `Demo Staff ${employees.length + i + 1}`, email: `staff${employees.length + i + 1}@demo.com`,
        password: hashed, role: 'staff', employeeId: null,
        department: departments[(employees.length + i) % departments.length],
        isActive: true, mustResetPassword: false, createdAt: now, updatedAt: now,
      };
      await db.collection('users').insertOne(doc);
      created.push(doc);
    }
    employees = [...employees, ...created];
    console.log(`${created.length} fallback staff users created (password: Demo@1234)`);
  }
  console.log(`Using ${employees.length} employees for enrollment`);

  // ── 1. Courses ─────────────────────────────────────────────────────────────
  const quizFor = (extra = {}) => ({
    passingScore: 70, maxAttempts: 3, shuffleQuestions: false, shuffleOptions: false,
    questions: [
      { id: uid(), text: 'Which of the following is a best practice?', type: 'multipleChoice', options: ['Option A', 'Option B', 'Option C', 'Option D'], correctAnswer: 'Option A', explanation: 'Option A follows policy.', points: 1 },
      { id: uid(), text: 'True or False: This training is mandatory for compliance.', type: 'trueFalse', correctAnswer: 'true', points: 1 },
      { id: uid(), text: 'In one word, what should you always prioritize?', type: 'shortAnswer', correctAnswer: 'safety', points: 1 },
    ],
    ...extra,
  });

  const courseSeeds = [
    {
      title: 'Workplace Health & Safety', category: 'Compliance', isMandatory: true, hasCertificate: true, certificateValidityDays: 365,
      difficultyLevel: 'beginner', estimatedDurationMinutes: 45, targetDepartments: [], targetRoles: [],
      description: 'Mandatory annual health and safety training for all employees.',
      modules: [
        { title: 'Introduction to Workplace Safety', type: 'text', content: { markdown: 'Workplace safety starts with awareness. Know your exits, report hazards, and follow posted procedures.' } },
        { title: 'Safety Video Walkthrough', type: 'video', content: { url: 'https://example.com/videos/safety.mp4', durationMinutes: 8 } },
        { title: 'Safety Policy Document', type: 'document', content: { fileUrl: 'https://example.com/docs/safety-policy.pdf', fileName: 'safety-policy.pdf' } },
        { title: 'Safety Knowledge Check', type: 'quiz', quiz: true },
      ],
    },
    {
      title: 'Code of Conduct & Ethics', category: 'Compliance', isMandatory: true, hasCertificate: true, certificateValidityDays: 365,
      difficultyLevel: 'beginner', estimatedDurationMinutes: 30, targetDepartments: [], targetRoles: [],
      description: 'Understand the company code of conduct, anti-harassment policy, and reporting channels.',
      modules: [
        { title: 'Our Values', type: 'text', content: { markdown: 'Integrity, respect, and accountability guide everything we do.' } },
        { title: 'Anti-Harassment Policy', type: 'document', content: { fileUrl: 'https://example.com/docs/conduct.pdf', fileName: 'conduct.pdf' } },
        { title: 'Reporting Channels', type: 'link', content: { linkUrl: 'https://example.com/ethics-hotline', linkDescription: 'Confidential ethics hotline' } },
        { title: 'Conduct Quiz', type: 'quiz', quiz: true },
      ],
    },
    {
      title: 'New Hire Onboarding Essentials', category: 'Onboarding', isMandatory: true, hasCertificate: false,
      difficultyLevel: 'beginner', estimatedDurationMinutes: 40, targetDepartments: [], targetRoles: [],
      description: 'Everything a new employee needs to know in their first two weeks.',
      modules: [
        { title: 'Welcome to Bella ERP', type: 'text', content: { markdown: 'Welcome aboard! Here is what to expect in your first weeks.' } },
        { title: 'Tools & Systems Overview', type: 'video', content: { url: 'https://example.com/videos/tools.mp4', durationMinutes: 12 } },
        { title: 'Benefits Overview', type: 'document', content: { fileUrl: 'https://example.com/docs/benefits.pdf', fileName: 'benefits.pdf' } },
        { title: 'Onboarding Check', type: 'quiz', quiz: true },
      ],
    },
    {
      title: 'People Management Fundamentals', category: 'Leadership', isMandatory: false, hasCertificate: true, certificateValidityDays: null,
      difficultyLevel: 'intermediate', estimatedDurationMinutes: 90, targetDepartments: [], targetRoles: ['department_head'],
      description: 'Core skills for first-time and experienced people managers.',
      modules: [
        { title: 'Setting Expectations', type: 'text', content: { markdown: 'Clear expectations reduce ambiguity and build trust.' } },
        { title: 'Giving Feedback', type: 'video', content: { url: 'https://example.com/videos/feedback.mp4', durationMinutes: 15 } },
        { title: 'Performance Conversations', type: 'document', content: { fileUrl: 'https://example.com/docs/performance.pdf', fileName: 'performance.pdf' } },
        { title: 'Further Reading', type: 'link', content: { linkUrl: 'https://example.com/reading/leadership', linkDescription: 'Recommended articles' } },
        { title: 'Management Quiz', type: 'quiz', quiz: true },
      ],
    },
    {
      title: 'Intro to SQL for Analysts', category: 'Technical', isMandatory: false, hasCertificate: true, certificateValidityDays: null,
      difficultyLevel: 'intermediate', estimatedDurationMinutes: 120, targetDepartments: ['Information Technology'], targetRoles: [],
      description: 'Learn to query relational databases from the ground up.',
      modules: [
        { title: 'SELECT Basics', type: 'text', content: { markdown: 'SELECT columns FROM a table, optionally filtered with WHERE.' } },
        { title: 'Joins Explained', type: 'video', content: { url: 'https://example.com/videos/joins.mp4', durationMinutes: 20 } },
        { title: 'Practice Dataset', type: 'document', content: { fileUrl: 'https://example.com/docs/sql-practice.pdf', fileName: 'sql-practice.pdf' } },
        { title: 'SQL Quiz', type: 'quiz', quiz: true },
      ],
    },
    {
      title: 'Effective Communication Skills', category: 'Soft Skills', isMandatory: false, hasCertificate: true, certificateValidityDays: null,
      difficultyLevel: 'beginner', estimatedDurationMinutes: 50, targetDepartments: [], targetRoles: [],
      description: 'Improve clarity, active listening, and cross-team communication.',
      modules: [
        { title: 'Active Listening', type: 'text', content: { markdown: 'Listening to understand, not to respond, is the foundation of good communication.' } },
        { title: 'Written Communication', type: 'document', content: { fileUrl: 'https://example.com/docs/writing.pdf', fileName: 'writing.pdf' } },
        { title: 'Communication Quiz', type: 'quiz', quiz: true },
      ],
    },
  ];

  const courseIdsByTitle = {};
  const moduleIdsByCourse = {};

  for (const c of courseSeeds) {
    let course = await db.collection('courses').findOne({ title: c.title });
    if (!course) {
      const doc = {
        title: c.title, description: c.description, coverImageUrl: null,
        category: c.category, tags: [], skillsTaught: [],
        estimatedDurationMinutes: c.estimatedDurationMinutes, difficultyLevel: c.difficultyLevel,
        status: 'published', isMandatory: c.isMandatory,
        targetRoles: c.targetRoles, targetDepartments: c.targetDepartments,
        hasCertificate: c.hasCertificate, certificateValidityDays: c.certificateValidityDays ?? null,
        createdBy: hrId, authors: [hrId], publishedAt: now, createdAt: now, updatedAt: now,
      };
      const result = await db.collection('courses').insertOne(doc);
      course = { ...doc, _id: result.insertedId };
      console.log(`Course created: ${c.title}`);
    } else {
      console.log(`Course exists, reusing: ${c.title}`);
    }
    courseIdsByTitle[c.title] = course._id;

    const existingModules = await db.collection('courseModules').find({ courseId: course._id }).sort({ order: 1 }).toArray();
    if (existingModules.length) {
      moduleIdsByCourse[c.title] = existingModules;
      continue;
    }

    const insertedModules = [];
    for (let i = 0; i < c.modules.length; i++) {
      const m = c.modules[i];
      const modDoc = {
        courseId: course._id, title: m.title, order: i, type: m.type,
        content: m.quiz ? {} : m.content, isRequired: true, createdAt: now,
      };
      const modResult = await db.collection('courseModules').insertOne(modDoc);
      const moduleWithId = { ...modDoc, _id: modResult.insertedId };
      insertedModules.push(moduleWithId);

      if (m.quiz) {
        await db.collection('quizzes').insertOne({
          moduleId: moduleWithId._id, courseId: course._id,
          ...quizFor(),
        });
      }
    }
    moduleIdsByCourse[c.title] = insertedModules;
    console.log(`  -> ${insertedModules.length} modules created for "${c.title}"`);
  }

  // ── 2. Learning Paths ──────────────────────────────────────────────────────
  const pathSeeds = [
    {
      name: 'New Employee Journey',
      description: 'Everything a new hire completes in their first month.',
      courseTitles: ['New Hire Onboarding Essentials', 'Workplace Health & Safety', 'Code of Conduct & Ethics'],
      enrollmentTrigger: 'onHire',
    },
    {
      name: 'First-Time Manager Track',
      description: 'A structured path for newly promoted managers.',
      courseTitles: ['People Management Fundamentals', 'Effective Communication Skills'],
      enrollmentTrigger: 'onRoleChange',
    },
  ];

  const pathIdsByName = {};
  for (const p of pathSeeds) {
    let path_ = await db.collection('learningPaths').findOne({ name: p.name });
    if (!path_) {
      const doc = {
        name: p.name, description: p.description,
        courses: p.courseTitles.map((t, i) => ({ courseId: courseIdsByTitle[t], order: i, isRequired: true, unlockAfterCourseId: i > 0 ? courseIdsByTitle[p.courseTitles[i - 1]] : null })),
        targetRoles: [], targetDepartments: [],
        enrollmentTrigger: p.enrollmentTrigger, dueDateOffsetDays: 30,
        status: 'active', createdBy: hrId, createdAt: now,
      };
      const result = await db.collection('learningPaths').insertOne(doc);
      path_ = { ...doc, _id: result.insertedId };
      console.log(`Learning path created: ${p.name}`);
    } else {
      console.log(`Learning path exists, reusing: ${p.name}`);
    }
    pathIdsByName[p.name] = path_._id;
  }

  // ── 3. Enrollments (20 total, various statuses, 10 completed w/ certificates) ─
  const allCourseIds = Object.values(courseIdsByTitle);
  const statusPlan = [
    ...Array(10).fill('completed'),
    ...Array(4).fill('inProgress'),
    ...Array(3).fill('notStarted'),
    ...Array(2).fill('overdue'),
    ...Array(1).fill('waived'),
  ];

  let created = 0;
  let certCount = 0;
  let feedbackCount = 0;
  let planIdx = 0;

  const maxPairs = employees.length * allCourseIds.length;
  for (let i = 0; i < maxPairs && created < 20; i++) {
    const employee = employees[i % employees.length];
    const courseId = allCourseIds[Math.floor(i / employees.length) % allCourseIds.length];
    const course = courseSeeds.find((c) => String(courseIdsByTitle[c.title]) === String(courseId));
    const modules = moduleIdsByCourse[course.title];

    const existing = await db.collection('enrollments').findOne({ employeeId: employee._id, courseId });
    if (existing) continue;

    const status = statusPlan[planIdx++] || 'notStarted';
    let moduleProgress = [];
    let progressPercentage = 0;
    let completedAt = null;
    let dueDate = new Date(now.getTime() + 14 * 86400000);

    if (status === 'completed' || status === 'inProgress') {
      const howMany = status === 'completed' ? modules.length : Math.max(1, Math.floor(modules.length / 2));
      moduleProgress = modules.slice(0, howMany).map((m) => ({
        moduleId: m._id, status: 'completed', startedAt: now, completedAt: now,
        attempts: m.type === 'quiz' ? 1 : 0, lastScore: m.type === 'quiz' ? 87 : undefined,
      }));
      progressPercentage = Math.round((howMany / modules.length) * 100);
      if (status === 'completed') completedAt = now;
    } else if (status === 'overdue') {
      dueDate = new Date(now.getTime() - 5 * 86400000);
    }

    const doc = {
      employeeId: employee._id, courseId, learningPathId: null,
      enrolledBy: hrId, enrollmentTrigger: 'manual',
      dueDate, status, completedAt, progressPercentage, moduleProgress,
      createdAt: now, updatedAt: now,
    };
    const result = await db.collection('enrollments').insertOne(doc);
    created++;

    if (status === 'completed' && course.hasCertificate && certCount < 10) {
      const year = now.getFullYear();
      const counterName = `certificate_number_${year}`;
      const counterResult = await db.collection('counters').findOneAndUpdate(
        { _id: counterName }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }
      );
      const certificateNumber = `CERT-${year}-${String(counterResult.seq).padStart(5, '0')}`;
      let pdfUrl = null;
      try {
        pdfUrl = await generateCertificatePDF({
          employeeName: employee.name, courseTitle: course.title, completedAt: now, certificateNumber,
        });
      } catch (e) {
        console.warn('  (certificate PDF generation skipped:', e.message, ')');
      }
      await db.collection('certificates').insertOne({
        employeeId: employee._id, courseId, enrollmentId: result.insertedId,
        certificateNumber, issuedAt: now,
        expiresAt: course.certificateValidityDays ? new Date(now.getTime() + course.certificateValidityDays * 86400000) : null,
        pdfUrl,
      });
      certCount++;
    }

    if (status === 'completed' && feedbackCount < 5) {
      const existingFeedback = await db.collection('trainingFeedback').findOne({ enrollmentId: result.insertedId });
      if (!existingFeedback) {
        await db.collection('trainingFeedback').insertOne({
          enrollmentId: result.insertedId, courseId, employeeId: employee._id,
          rating: [4, 5, 5, 4, 5][feedbackCount] || 4,
          review: 'Helpful and well-structured course.',
          submittedAt: now,
        });
        feedbackCount++;
      }
    }
  }
  console.log(`${created} enrollments created (${certCount} certificates, ${feedbackCount} feedback records)`);

  // ── 4. Automation Rules ────────────────────────────────────────────────────
  const ruleSeeds = [
    {
      name: 'Auto-enroll new hires in onboarding journey',
      trigger: 'onHire',
      triggerConditions: {},
      action: { enrollInLearningPathIds: [pathIdsByName['New Employee Journey']], dueDateOffsetDays: 30, notifyEmployee: true, notifyManager: false },
    },
    {
      name: 'Auto-enroll new managers in leadership track',
      trigger: 'onRoleChange',
      triggerConditions: { roles: ['department_head'] },
      action: { enrollInLearningPathIds: [pathIdsByName['First-Time Manager Track']], dueDateOffsetDays: 30, notifyEmployee: true, notifyManager: true },
    },
    {
      name: 'Annual compliance refresher',
      trigger: 'scheduled',
      triggerConditions: { scheduledRecurrence: 'annual' },
      action: { enrollInCourseIds: [courseIdsByTitle['Workplace Health & Safety'], courseIdsByTitle['Code of Conduct & Ethics']], dueDateOffsetDays: 14, notifyEmployee: true, notifyManager: false },
    },
  ];

  let rulesCreated = 0;
  for (const r of ruleSeeds) {
    const existing = await db.collection('trainingAssignmentRules').findOne({ name: r.name });
    if (existing) continue;
    await db.collection('trainingAssignmentRules').insertOne({
      name: r.name, trigger: r.trigger, triggerConditions: r.triggerConditions, action: r.action,
      isActive: true, createdBy: hrId, createdAt: now,
    });
    rulesCreated++;
  }
  console.log(`${rulesCreated} automation rules created`);

  console.log('\n----------------------------------------');
  console.log('  TRAINING SEED COMPLETE');
  console.log('----------------------------------------\n');

  await client.close();
}

seed().catch((err) => { console.error(err); process.exit(1); });
