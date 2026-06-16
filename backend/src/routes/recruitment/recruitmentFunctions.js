const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { generateStaffNumber } = require('../../functions/HR/staffNumberGenerator');
const { getDefaultOnboardingTasks } = require('../../functions/HR/onboardingTemplates');
const { sendEmail } = require('../../services/emailService');

const STAGES = ['applied', 'shortlisted', 'interview_scheduled', 'offer_sent', 'hired', 'rejected'];

const buildStageEmail = (name, position, stage) => {
  const messages = {
    shortlisted: `We are pleased to inform you that you have been shortlisted for the position of <strong>${position}</strong>. Our team will be in touch shortly.`,
    interview_scheduled: `You have been invited for an interview for the position of <strong>${position}</strong>. Further details will follow.`,
    offer_sent: `We are delighted to extend an offer for the position of <strong>${position}</strong>. Please check your email for the offer letter.`,
    hired: `Congratulations! You have been successfully hired as <strong>${position}</strong>. Welcome to the team!`,
    rejected: `Thank you for your interest in <strong>${position}</strong>. After careful consideration, we are unable to proceed with your application at this time.`,
  };
  return `<p>Dear ${name},</p><p>${messages[stage] || 'Your application status has been updated.'}</p><p>Regards,<br/>HR Department</p>`;
};

const listApplicants = async (req, res) => {
  const filter = {};
  if (req.query.stage) filter.stage = req.query.stage;
  if (req.query.positionApplied) filter.positionApplied = new ObjectId(req.query.positionApplied);
  const { page, limit, skip } = getPagination(req.query);
  const [total, data] = await Promise.all([
    countDocuments('applicants', filter),
    findMany('applicants', filter, { skip, limit, sort: { createdAt: -1 } }),
  ]);

  // Enrich interview_scheduled applicants with their schedule details
  const enriched = await Promise.all(data.map(async (a) => {
    if (a.interviewScheduleId) {
      const sched = await findOne('interview_schedules', { _id: a.interviewScheduleId }, {
        projection: { scheduledDate: 1, scheduledTime: 1, location: 1, interviewNotes: 1 },
      });
      if (sched) return { ...a, interviewSchedule: sched };
    }
    return a;
  }));

  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(enriched, total, page, limit));
};

const createApplicant = async (req, res) => {
  if (!validateRequiredFields(req, res, ['fullName', 'email', 'positionApplied'])) return;
  const doc = {
    fullName: req.body.fullName,
    email: req.body.email,
    phone: req.body.phone || null,
    positionApplied: new ObjectId(req.body.positionApplied),
    stage: 'applied',
    approvalStatus: 'pending',
    approvedBy: null,
    cvFilePath: req.file ? req.file.path : null,
    cvFilename: req.file ? req.file.filename : null,
    coverLetter: req.body.coverLetter || null,
    otherDocuments: [],
    interviewNotes: null,
    interviewScheduleId: null,
    offeredSalary: null,
    offerLetterSentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('applicants', doc);

  // Notify HR managers
  const position = await findOne('job_positions', { _id: doc.positionApplied }, { projection: { jobTitle: 1 } });
  const hrUsers = await findMany('users', { role: { $in: ['hr_manager', 'super_admin'] } }, { projection: { _id: 1 } });
  if (hrUsers.length) {
    await global.dbo.collection('notifications').insertMany(hrUsers.map((u) => ({
      userId: u._id,
      title: 'New Application',
      message: `${doc.fullName} applied for ${position?.jobTitle || 'a position'}.`,
      type: 'recruitment',
      read: false,
      createdAt: new Date(),
    })));
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateApplicant = async (req, res) => {
  const update = { ...req.body, updatedAt: new Date() };
  delete update._id;
  if (req.file) {
    update.cvFilePath = req.file.path;
    update.cvFilename = req.file.filename;
  }
  await updateOne('applicants', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const patchApplicantStage = async (req, res) => {
  if (!validateRequiredFields(req, res, ['stage'])) return;
  if (!STAGES.includes(req.body.stage)) return returnFunction(res, 400, false, 'Invalid stage.');

  const applicant = await findOne('applicants', { _id: new ObjectId(req.params.id) });
  if (!applicant) return returnFunction(res, 404, false, req.locale.notFound);

  const updates = {
    stage: req.body.stage,
    approvalStatus: 'approved',
    approvedBy: new ObjectId(req.user._id),
    approvedAt: new Date(),
    updatedAt: new Date(),
  };
  if (req.body.offeredSalary) updates.offeredSalary = Number(req.body.offeredSalary);
  if (req.body.interviewNotes) updates.interviewNotes = req.body.interviewNotes;

  await updateOne('applicants', { _id: new ObjectId(req.params.id) }, { $set: updates });

  // Email the candidate about the stage change
  if (applicant.email && req.body.stage !== 'applied') {
    const pos = applicant.positionApplied
      ? await findOne('job_positions', { _id: applicant.positionApplied }, { projection: { jobTitle: 1 } })
      : null;
    sendEmail({
      to: applicant.email,
      subject: `Application Update: ${req.body.stage.replace(/_/g, ' ')} — ${pos?.jobTitle || 'Position'}`,
      html: buildStageEmail(applicant.fullName, pos?.jobTitle || 'the position', req.body.stage),
    }).catch((e) => console.error('Email failed:', e.message));
  }

  if (req.body.stage === 'hired') {
    const position = applicant.positionApplied
      ? await findOne('job_positions', { _id: applicant.positionApplied })
      : null;

    const hireDate = new Date();
    const staffNumber = await generateStaffNumber(hireDate.getFullYear());

    const empDoc = {
      fullName: applicant.fullName,
      email: applicant.email,
      phone: applicant.phone || null,
      nationalId: null,
      staffNumber,
      designation: position?.designation || position?.jobTitle || 'Staff',
      employmentType: 'permanent',
      department: position?.department || 'Administration',
      dateOfHire: hireDate,
      contractEndDate: null,
      salaryGrade: updates.offeredSalary || applicant.offeredSalary || position?.salaryBandMin || null,
      nextOfKin: null,
      profilePhoto: null,
      documents: applicant.cvFilePath
        ? [{ docId: new ObjectId(), docType: 'CV', fileName: 'cv.pdf', filePath: applicant.cvFilePath, uploadedAt: new Date() }]
        : [],
      staffCategory: 'non-teaching',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const empResult = await insertOne('employees', empDoc);
    const employeeId = empResult.insertedId;

    await insertOne('leave_balances', {
      employeeId,
      year: hireDate.getFullYear(),
      balances: {
        annual:    { allocated: 21,   used: 0, remaining: 21 },
        sick:      { allocated: 30,   used: 0, remaining: 30 },
        maternity: { allocated: 90,   used: 0, remaining: 90 },
        paternity: { allocated: 14,   used: 0, remaining: 14 },
        unpaid:    { allocated: null, used: 0, remaining: null },
        emergency: { allocated: 3,    used: 0, remaining: 3 },
      },
    });

    const tasks = getDefaultOnboardingTasks(employeeId, hireDate.toISOString());
    await global.dbo.collection('onboarding_tasks').insertMany(tasks);

    const hrUsers = await findMany('users', { role: { $in: ['hr_manager', 'super_admin'] } }, { projection: { _id: 1 } });
    if (hrUsers.length) {
      await global.dbo.collection('notifications').insertMany(hrUsers.map((u) => ({
        userId: u._id,
        title: 'New Hire',
        message: `${applicant.fullName} has been hired as ${empDoc.designation}. Staff #: ${staffNumber}`,
        type: 'new_hire',
        read: false,
        createdAt: new Date(),
      })));
    }

    if (position) {
      await updateOne('job_positions', { _id: applicant.positionApplied }, { $inc: { filledCount: 1 } });
    }
  }

  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Send offer letter as PDF via email
const sendOfferLetter = async (req, res) => {
  const applicant = await findOne('applicants', { _id: new ObjectId(req.params.id) });
  if (!applicant) return returnFunction(res, 404, false, req.locale.notFound);

  const position = applicant.positionApplied
    ? await findOne('job_positions', { _id: applicant.positionApplied })
    : null;

  const offeredSalary = req.body.offeredSalary ? Number(req.body.offeredSalary) : (applicant.offeredSalary || null);
  const startDate = req.body.startDate || null;
  const positionTitle = position?.jobTitle || 'Staff';

  const PDFDocument = require('pdfkit');
  const companyName = process.env.COMPANY_NAME || 'School ERP';
  const today = new Date().toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });

  const pdfBuffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60 });
    const buffers = [];
    doc.on('data', (c) => buffers.push(c));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.fontSize(18).font('Helvetica-Bold').text(companyName, { align: 'center' });
    doc.moveDown(0.5).fontSize(14).text('LETTER OF OFFER', { align: 'center' });
    doc.moveDown(1).fontSize(11).font('Helvetica').text(today, { align: 'right' });
    doc.moveDown(1);
    doc.font('Helvetica-Bold').text(`Dear ${applicant.fullName},`);
    doc.moveDown(0.5).font('Helvetica').text(
      `We are pleased to offer you the position of ${positionTitle}${position?.department ? ` in the ${position.department} department` : ''}.`
    );
    if (offeredSalary) {
      doc.moveDown(0.5).text(`Your gross monthly salary will be KES ${Number(offeredSalary).toLocaleString('en-KE', { minimumFractionDigits: 2 })}.`);
    }
    if (startDate) {
      doc.moveDown(0.5).text(`Your expected start date is ${new Date(startDate).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })}.`);
    }
    doc.moveDown(1).text(
      'This offer is conditional upon successful completion of reference checks and submission of required documents. Please sign and return a copy of this letter to confirm your acceptance.'
    );
    doc.moveDown(2).text('Yours sincerely,').moveDown(2).text('____________________________').text('HR Manager').text(companyName);
    doc.moveDown(2).fontSize(10).fillColor('grey').text('ACCEPTANCE', { underline: true }).fillColor('black');
    doc.text(`I, ${applicant.fullName}, accept the offer of employment as stated above.`);
    doc.moveDown(1).text('Signature: ____________________________     Date: ______________');
    doc.end();
  });

  await sendEmail({
    to: applicant.email,
    subject: `Offer Letter — ${positionTitle}`,
    html: `<p>Dear ${applicant.fullName},</p><p>Please find attached your offer letter. We look forward to welcoming you to the team.</p><p>Regards,<br/>HR Department</p>`,
    attachments: [{ filename: 'Offer_Letter.pdf', content: pdfBuffer, contentType: 'application/pdf' }],
  });

  await updateOne('applicants', { _id: new ObjectId(req.params.id) }, {
    $set: { stage: 'offer_sent', offeredSalary, offerLetterSentAt: new Date(), updatedAt: new Date() },
  });

  return returnFunction(res, 200, true, 'Offer letter sent successfully.');
};

const createInterview = async (req, res) => {
  if (!validateRequiredFields(req, res, ['applicantId', 'interviewerId', 'scheduledDate', 'scheduledTime'])) return;
  const doc = {
    applicantId: new ObjectId(req.body.applicantId),
    interviewerId: new ObjectId(req.body.interviewerId),
    scheduledDate: req.body.scheduledDate,
    scheduledTime: req.body.scheduledTime,
    location: req.body.location || null,
    status: 'scheduled',
    notes: req.body.notes || null,
    createdAt: new Date(),
  };
  const result = await insertOne('interview_schedules', doc);

  await updateOne('applicants', { _id: doc.applicantId }, { $set: { interviewScheduleId: result.insertedId, stage: 'interview_scheduled', updatedAt: new Date() } });

  const interviewerUser = await findOne('users', { employeeId: doc.interviewerId }, { projection: { _id: 1 } });
  if (interviewerUser) {
    await insertOne('notifications', {
      userId: interviewerUser._id,
      title: 'Interview Scheduled',
      message: `You have an interview scheduled on ${doc.scheduledDate} at ${doc.scheduledTime}.`,
      type: 'interview',
      read: false,
      createdAt: new Date(),
    });
  }

  // Email the applicant
  const applicant = await findOne('applicants', { _id: doc.applicantId }, { projection: { fullName: 1, email: 1 } });
  if (applicant?.email) {
    sendEmail({
      to: applicant.email,
      subject: 'Interview Invitation',
      html: `<p>Dear ${applicant.fullName},</p><p>You have been invited for an interview on <strong>${doc.scheduledDate}</strong> at <strong>${doc.scheduledTime}</strong>${doc.location ? ` at ${doc.location}` : ''}.</p><p>Regards,<br/>HR Department</p>`,
    }).catch((e) => console.error('Email failed:', e.message));
  }

  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId });
};

const updateInterview = async (req, res) => {
  const update = { ...req.body };
  delete update._id;
  await updateOne('interview_schedules', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteApplicant = async (req, res) => {
  const result = await global.dbo.collection('applicants').deleteOne({ _id: new ObjectId(req.params.id) });
  if (!result.deletedCount) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully);
};

// ── Bulk stage update ─────────────────────────────────────────────────────────
const bulkPatchStage = async (req, res) => {
  const { ids, stage } = req.body;
  if (!Array.isArray(ids) || !ids.length) return returnFunction(res, 400, false, 'ids array is required.');
  if (!STAGES.includes(stage)) return returnFunction(res, 400, false, 'Invalid stage.');

  const objectIds = ids.map(id => new ObjectId(id));
  await global.dbo.collection('applicants').updateMany(
    { _id: { $in: objectIds } },
    { $set: { stage, approvalStatus: 'approved', approvedBy: new ObjectId(req.user._id), approvedAt: new Date(), updatedAt: new Date() } }
  );

  // Send email to every applicant
  const applicants = await findMany('applicants', { _id: { $in: objectIds } }, { projection: { fullName: 1, email: 1, positionApplied: 1, positionTitle: 1 } });
  for (const applicant of applicants) {
    if (!applicant.email) continue;
    const posTitle = applicant.positionTitle || 'the position';
    sendEmail({
      to: applicant.email,
      subject: `Application Update — ${stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`,
      html: buildStageEmail(applicant.fullName, posTitle, stage),
    }).catch(e => console.error('Bulk email failed:', e.message));
  }

  return returnFunction(res, 200, true, `${ids.length} applicant(s) updated to ${stage}.`);
};

module.exports = { listApplicants, createApplicant, updateApplicant, deleteApplicant, patchApplicantStage, bulkPatchStage, sendOfferLetter, createInterview, updateInterview };
