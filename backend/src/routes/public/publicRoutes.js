const express = require('express');
const multer  = require('multer');
const PDFDocument = require('pdfkit');
const { ObjectId } = require('mongodb');
const router = express.Router();
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const crypto = require('crypto');
const { findMany, findOne, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { sendTemplatedEmail } = require('../../lib/recruitment/emailTemplateHelpers');
const { respondToOfferCore } = require('../recruitment/recruitmentFunctions');

const MAX_APPLICATIONS_PER_REQUISITION = 2;
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { serveCompanyLogo } = require('../config/companySettingsFunctions');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
  filename: (req, file, cb) => cb(null, `resume-${Date.now()}-${file.originalname}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max for public resume uploads
  fileFilter: (req, file, cb) => {
    // CVs are PDF-only — Word docs used to be accepted too, but reviewers need a
    // consistent, previewable format across every application.
    if (file.mimetype === 'application/pdf') return cb(null, true);
    const err = new Error('Only PDF files are accepted for your CV.');
    err.statusCode = 400;
    cb(err);
  },
});

// GET /api/public/company-logo — serve logo without auth (used by sidebar img tag)
router.get('/company-logo', AsyncHandler(serveCompanyLogo));

// GET /api/public/theme — branding colors (no auth, used by ThemeLoader)
router.get('/theme', async (req, res) => {
  try {
    const s = await findOne('company_settings', {});
    return returnFunction(res, 200, true, 'OK', {
      primaryColor:    s?.primaryColor    || '#0A1931',
      gradientEndColor: s?.gradientEndColor || '#C9A84C',
      gradientEnabled: s?.gradientEnabled  ?? false,
      companyName:     s?.companyName      || 'School ERP',
    });
  } catch {
    return returnFunction(res, 200, true, 'OK', {
      primaryColor: '#0A1931', gradientEndColor: '#C9A84C',
      gradientEnabled: false,  companyName: 'School ERP',
    });
  }
});

// GET /api/public/company-info — name, contact, socials (no auth, used by footer)
router.get('/company-info', async (req, res) => {
  try {
    const s = await findOne('company_settings', {});
    return returnFunction(res, 200, true, 'OK', {
      companyName: s?.companyName || '',
      address:     s?.address     || '',
      phone:       s?.phone       || '',
      email:       s?.email       || '',
      website:     s?.website     || '',
      facebook:    s?.facebook    || '',
      twitter:     s?.twitter     || '',
      linkedin:    s?.linkedin    || '',
      instagram:   s?.instagram   || '',
      youtube:     s?.youtube     || '',
      tiktok:      s?.tiktok      || '',
    });
  } catch {
    return returnFunction(res, 200, true, 'OK', {});
  }
});

// A requisition with a past applicationDeadline is treated as closed immediately, even
// before the daily cron (closeExpiredRequisitions) has flipped its status — this filter
// is the real-time guarantee, the cron is just what makes the change visible in HR's own
// requisition list/status field too. Must be a function, not a static object — a plain
// object literal would capture `new Date()` once at server startup and never advance.
const notExpired = () => ({ $or: [{ applicationDeadline: null }, { applicationDeadline: { $gte: new Date() } }] });

// GET /api/public/jobs — open requisitions for the careers site (no auth)
router.get('/jobs', async (req, res) => {
  try {
    const filter = { status: 'open', ...notExpired() };
    if (req.query.department) filter.department = req.query.department;
    if (req.query.location) filter.location = req.query.location;
    const jobs = await findMany('jobRequisitions', filter, { sort: { createdAt: -1 } });
    return returnFunction(res, 200, true, 'OK', jobs);
  } catch (e) {
    return returnFunction(res, 500, false, 'Server error');
  }
});

// GET /api/public/jobs/:id — job detail (no auth)
router.get('/jobs/:id', async (req, res) => {
  try {
    const job = await findOne('jobRequisitions', { _id: new ObjectId(req.params.id), status: 'open', ...notExpired() });
    if (!job) return returnFunction(res, 404, false, 'Job not found or closed');
    return returnFunction(res, 200, true, 'OK', job);
  } catch (e) {
    return returnFunction(res, 500, false, 'Server error');
  }
});

// Multipart form submissions send arrays/objects as JSON strings.
const parseAnswers = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
};

// POST /api/public/jobs/:id/apply — submit application (no auth, resume upload optional)
router.post('/jobs/:id/apply', upload.single('resume'), async (req, res) => {
  try {
    if (!validateRequiredFields(req, res, ['firstName', 'lastName', 'email'])) return;

    const requisition = await findOne('jobRequisitions', { _id: new ObjectId(req.params.id), status: 'open', ...notExpired() });
    if (!requisition) return returnFunction(res, 404, false, 'Job not found or closed');
    if (!requisition.pipelineStages?.length) return returnFunction(res, 400, false, 'This job is not currently accepting applications.');

    const email = req.body.email.toLowerCase().trim();
    let candidate = await findOne('candidates', { email });
    if (!candidate) {
      const candDoc = {
        firstName: req.body.firstName.trim(),
        lastName: req.body.lastName.trim(),
        email,
        phone: req.body.phone || null,
        location: req.body.location || null,
        resumeUrl: req.file ? req.file.path : null,
        linkedInUrl: req.body.linkedInUrl || null,
        source: 'careerSite',
        referredBy: null,
        tags: [],
        isPassiveTalent: false,
        consentGivenAt: new Date(),
        consentVersion: req.body.consentVersion || '1.0',
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const candResult = await insertOne('candidates', candDoc);
      candidate = { _id: candResult.insertedId, ...candDoc };
    } else if (req.file) {
      await updateOne('candidates', { _id: candidate._id }, { $set: { resumeUrl: req.file.path, updatedAt: new Date() } });
    }

    const priorApplicationCount = await countDocuments('applications', { candidateId: candidate._id, requisitionId: requisition._id });
    if (priorApplicationCount >= MAX_APPLICATIONS_PER_REQUISITION) {
      return returnFunction(res, 409, false, `You have already applied for this position the maximum number of times (${MAX_APPLICATIONS_PER_REQUISITION}).`);
    }

    const firstStage = requisition.pipelineStages[0];
    const now = new Date();
    const appDoc = {
      candidateId: candidate._id,
      requisitionId: requisition._id,
      currentStageId: firstStage.id,
      stageHistory: [{ stageId: firstStage.id, stageName: firstStage.name, enteredAt: now, movedBy: null }],
      status: 'active',
      rejectionReason: null,
      offerDetails: null,
      coverLetter: req.body.coverLetter || null,
      answers: parseAnswers(req.body.answers),
      scorecards: [],
      overallScore: null,
      createdAt: now,
      updatedAt: now,
    };
    const result = await insertOne('applications', appDoc);

    const fullName = `${candidate.firstName} ${candidate.lastName}`;

    if (candidate.email) {
      const tokens = { candidateName: fullName, jobTitle: requisition.title, companyName: process.env.COMPANY_NAME || 'Bella ERP' };
      sendTemplatedEmail({
        trigger: 'applicationReceived',
        to: candidate.email,
        tokens,
        fallbackSubject: `We received your application for ${tokens.jobTitle}`,
        fallbackHtml: `<p>Dear ${tokens.candidateName},</p><p>Thank you for applying to ${tokens.jobTitle} at ${tokens.companyName}. Our team will review your application and be in touch soon.</p><p>Regards,<br/>${tokens.companyName}</p>`,
      }).catch(() => {});
    }

    const hrManagers = await findMany('users', { role: { $in: ['super_admin', 'hr_manager'] } }, { projection: { _id: 1 } });
    if (hrManagers.length) {
      notifyHR({
        type: 'recruitment', subType: 'new_application',
        title: 'New Application Received',
        subtitle: `${fullName} applied for ${requisition.title} via the careers site.`,
        referenceId: result.insertedId, referenceModel: 'applications',
        requiresAction: true, triggeredBy: null,
      }).catch(() => {});
      notifyByRoles(['super_admin', 'hr_manager'], {
        title: 'New Application Received',
        body: `${fullName} applied for ${requisition.title} via the careers site.`,
        type: 'recruitment',
      }).catch(() => {});
    }

    return returnFunction(res, 201, true, 'Application submitted successfully. We will be in touch.', { _id: result.insertedId });
  } catch (e) {
    return returnFunction(res, 500, false, 'Server error');
  }
});

// GET /api/public/jobs/:id/pdf — downloadable job flyer (no auth)
router.get('/jobs/:id/pdf', async (req, res) => {
  try {
    const job = await findOne('jobRequisitions', { _id: new ObjectId(req.params.id) });
    if (!job) return returnFunction(res, 404, false, 'Job not found');

    const settings = await findOne('company_settings', {});
    const companyName = settings?.companyName || 'Bella ERP';
    const primaryHex  = settings?.primaryColor || '#0A1931';

    // parse hex to r,g,b for pdfkit fill
    const hexToRgb = (h) => {
      const c = h.replace('#', '');
      return [
        parseInt(c.substring(0, 2), 16),
        parseInt(c.substring(2, 4), 16),
        parseInt(c.substring(4, 6), 16),
      ];
    };
    const [pr, pg, pb] = hexToRgb(primaryHex);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${job.title.replace(/\s+/g, '_')}_Job_Post.pdf"`);
    doc.pipe(res);

    // Header bar
    doc.rect(0, 0, doc.page.width, 80).fill([pr, pg, pb]);
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold')
       .text(companyName, 50, 25, { align: 'center', width: doc.page.width - 100 });

    doc.moveDown(3).fillColor('#000000');

    // Title block
    doc.fontSize(18).font('Helvetica-Bold').fillColor([pr, pg, pb])
       .text(job.title, { align: 'center' });
    doc.fontSize(12).font('Helvetica').fillColor('#555555')
       .text(job.department, { align: 'center' });
    doc.moveDown();

    // Divider
    const divY = doc.y;
    doc.moveTo(50, divY).lineTo(doc.page.width - 50, divY).strokeColor([pr, pg, pb]).lineWidth(2).stroke();
    doc.moveDown();

    const section = (title) => {
      doc.fontSize(11).font('Helvetica-Bold').fillColor([pr, pg, pb]).text(title.toUpperCase());
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#cccccc').lineWidth(0.5).stroke();
      doc.moveDown(0.4);
      doc.font('Helvetica').fillColor('#333333').fontSize(10);
    };

    // Details
    section('Position Details');
    const details = [
      ['Openings', job.headcount],
      ['Location', job.location],
      ['Employment Type', job.employmentType || 'fullTime'],
    ];
    if (job.salaryRange?.min) {
      details.push(['Salary Band', `${job.salaryRange.currency || 'KES'} ${job.salaryRange.min.toLocaleString()} – ${(job.salaryRange.max || 0).toLocaleString()}`]);
    }
    details.forEach(([k, v]) => doc.text(`${k}:  ${v}`));
    doc.moveDown();

    if (job.description) {
      section('Job Description');
      doc.text(job.description, { lineGap: 3 });
      doc.moveDown();
    }

    // How to apply
    section('How to Apply');
    const applyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/en/careers/${job._id}`;
    doc.text('Apply online at:');
    doc.fillColor([pr, pg, pb]).text(applyUrl, { underline: true });
    doc.fillColor('#333333').moveDown();

    // Footer
    doc.fontSize(8).fillColor('#aaaaaa').font('Helvetica')
       .text(`Generated by ${companyName} · ${new Date().toLocaleDateString('en-KE')}`, { align: 'center' });

    doc.end();
  } catch (e) {
    if (!res.headersSent) returnFunction(res, 500, false, 'Failed to generate PDF');
  }
});

// ── Candidate offer response (public, token-based — no login exists for candidates) ──

// Finds the application whose offerDetails.responseTokenHash matches the given raw
// token, if any, and if the offer hasn't already been responded to or expired.
async function findApplicationByOfferToken(rawToken) {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return findOne('applications', { 'offerDetails.responseTokenHash': tokenHash });
}

// GET /api/public/offers/:token — candidate views their offer before deciding
router.get('/offers/:token', AsyncHandler(async (req, res) => {
  const application = await findApplicationByOfferToken(req.params.token);
  if (!application || !application.offerDetails) return returnFunction(res, 404, false, 'Offer not found or link has expired.');
  if (new Date(application.offerDetails.expiresAt) < new Date()) return returnFunction(res, 410, false, 'This offer has expired.');

  const [candidate, requisition] = await Promise.all([
    findOne('candidates', { _id: application.candidateId }),
    findOne('jobRequisitions', { _id: application.requisitionId }),
  ]);

  return returnFunction(res, 200, true, 'Offer found.', {
    candidateName: candidate ? `${candidate.firstName} ${candidate.lastName}` : '',
    jobTitle: requisition?.title || '',
    department: requisition?.department || '',
    salary: application.offerDetails.salary,
    currency: application.offerDetails.currency,
    startDate: application.offerDetails.startDate,
    expiresAt: application.offerDetails.expiresAt,
    status: application.offerDetails.status,
  });
}));

// POST /api/public/offers/:token/respond — candidate accepts or declines
router.post('/offers/:token/respond', AsyncHandler(async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  if (!['accepted', 'declined'].includes(req.body.status)) return returnFunction(res, 400, false, 'status must be accepted or declined.');

  const application = await findApplicationByOfferToken(req.params.token);
  if (!application || !application.offerDetails) return returnFunction(res, 404, false, 'Offer not found or link has expired.');
  if (application.offerDetails.status !== 'pending') return returnFunction(res, 400, false, 'This offer has already been responded to.');
  if (new Date(application.offerDetails.expiresAt) < new Date()) return returnFunction(res, 410, false, 'This offer has expired.');

  await respondToOfferCore(application, req.body.status, null);

  return returnFunction(res, 200, true, `Offer ${req.body.status}.`);
}));

module.exports = router;
