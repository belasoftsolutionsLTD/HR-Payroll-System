const express = require('express');
const multer  = require('multer');
const PDFDocument = require('pdfkit');
const router = express.Router();
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const crypto = require('crypto');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 4) — jobRequisitions/candidates/applications now live in Postgres. `users`
// has been Postgres since Phase 1 — the unsubscribe routes below were still reading
// it off the Mongo helper, silently broken (writes went to a collection nothing
// syncs anymore) since that phase; fixed here while this file was open for Phase 4.
// project_invites is Postgres too (Phase 9) — see findInviteByToken/
// acceptInviteCore/declineInviteCore in projectsFunctions.js. company_settings
// joined them in Phase 10 — this file is fully migrated, no more Mongo helpers.
const pgDB = require('../../functions/Database/pgDBFunctions');
const { knex, newId, insertOne } = pgDB;
const { sendTemplatedEmail } = require('../../services/emailTemplateService');
const { verifyUnsubscribeToken } = require('../../lib/email/unsubscribeToken');
const { respondToOfferCore } = require('../recruitment/recruitmentFunctions');
const { findInviteByToken, acceptInviteCore, declineInviteCore } = require('../projects/projectsFunctions');

const MAX_APPLICATIONS_PER_REQUISITION = 2;
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { serveCompanyLogo } = require('../config/companySettingsFunctions');
const { sanitizeFilename } = require('../../lib/files/sanitizeFilename');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
  // sanitizeFilename strips any path-traversal sequences from the client-supplied
  // name — this endpoint needs no login at all, so it's the single most important
  // place in the app for this fix (see sanitizeFilename.js for the full writeup).
  filename: (req, file, cb) => cb(null, `resume-${Date.now()}-${sanitizeFilename(file.originalname)}`),
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
    const s = await knex('company_settings').first();
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
    const s = await knex('company_settings').first();
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
// requisition list/status field too. Applied inline per-query (a knex query builder,
// unlike a plain object literal, only evaluates `new Date()` when the query actually runs).
const notExpired = (query) => query.andWhere((qb) => qb.whereNull('applicationDeadline').orWhere('applicationDeadline', '>=', new Date()));

// A requisition with no branchId set (or a company with no branches configured at all)
// is shown to candidates as based at "Headquarters" rather than a blank/missing field.
const withBranchName = async (jobs) => {
  const list = Array.isArray(jobs) ? jobs : [jobs];
  const branchIds = [...new Set(list.filter((j) => j.branchId).map((j) => j.branchId))];
  const branches = branchIds.length ? await knex('branches').whereIn('id', branchIds).select('id', 'name') : [];
  const nameById = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const enriched = list.map((j) => ({ ...j, branchName: (j.branchId && nameById[j.branchId]) || 'Headquarters' }));
  return Array.isArray(jobs) ? enriched : enriched[0];
};

// GET /api/public/jobs — open requisitions for the careers site (no auth)
router.get('/jobs', async (req, res) => {
  try {
    let query = knex('job_requisitions').where({ status: 'open' });
    query = notExpired(query);
    if (req.query.department) query = query.andWhere({ department: req.query.department });
    if (req.query.location) query = query.andWhere({ location: req.query.location });
    const jobs = await query.orderBy('createdAt', 'desc');
    return returnFunction(res, 200, true, 'OK', await withBranchName(jobs));
  } catch (e) {
    return returnFunction(res, 500, false, 'Server error');
  }
});

// GET /api/public/jobs/:id — job detail (no auth)
router.get('/jobs/:id', async (req, res) => {
  try {
    const job = await notExpired(knex('job_requisitions').where({ id: req.params.id, status: 'open' })).first();
    if (!job) return returnFunction(res, 404, false, 'Job not found or closed');
    Object.assign(job, await withBranchName(job));
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

// POST /api/public/jobs/:id/apply — submit application (no auth). Phone and resume are
// required — phone is the fallback contact channel if email doesn't reach the candidate,
// and a resume is the baseline for reviewing any application at all.
router.post('/jobs/:id/apply', upload.single('resume'), async (req, res) => {
  try {
    if (!validateRequiredFields(req, res, ['firstName', 'lastName', 'email', 'phone'])) return;
    if (!req.file) return returnFunction(res, 400, false, 'A resume (PDF) is required.');

    const requisition = await notExpired(knex('job_requisitions').where({ id: req.params.id, status: 'open' })).first();
    if (!requisition) return returnFunction(res, 404, false, 'Job not found or closed');
    if (!requisition.pipelineStages?.length) return returnFunction(res, 400, false, 'This job is not currently accepting applications.');

    const email = req.body.email.toLowerCase().trim();
    let candidate = await knex('candidates').where({ email }).first();
    if (!candidate) {
      const candDoc = {
        id: newId(),
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
      candidate = await insertOne('candidates', candDoc);
    } else if (req.file) {
      await knex('candidates').where({ id: candidate.id }).update({ resumeUrl: req.file.path, updatedAt: new Date() });
    }

    const [{ count: priorApplicationCount }] = await knex('applications').where({ candidateId: candidate.id, requisitionId: requisition.id }).count('* as count');
    if (Number(priorApplicationCount) >= MAX_APPLICATIONS_PER_REQUISITION) {
      return returnFunction(res, 409, false, `You have already applied for this position the maximum number of times (${MAX_APPLICATIONS_PER_REQUISITION}).`);
    }

    const firstStage = requisition.pipelineStages[0];
    const now = new Date();
    const appDoc = {
      id: newId(),
      candidateId: candidate.id,
      requisitionId: requisition.id,
      currentStageId: firstStage.id,
      stageHistory: JSON.stringify([{ stageId: firstStage.id, stageName: firstStage.name, enteredAt: now, movedBy: null }]),
      status: 'active',
      rejectionReason: null,
      offerDetails: null,
      coverLetter: req.body.coverLetter || null,
      answers: JSON.stringify(parseAnswers(req.body.answers)),
      overallScore: null,
      createdAt: now,
      updatedAt: now,
    };
    const result = await insertOne('applications', appDoc);

    const fullName = `${candidate.firstName} ${candidate.lastName}`;

    if (candidate.email) {
      const tokens = { candidateName: fullName, jobTitle: requisition.title, companyName: process.env.COMPANY_NAME || 'Workfola' };
      sendTemplatedEmail({
        trigger: 'applicationReceived',
        to: candidate.email,
        tokens,
        fallbackSubject: `We received your application for ${tokens.jobTitle}`,
        fallbackHtml: `<p>Dear ${tokens.candidateName},</p><p>Thank you for applying to ${tokens.jobTitle} at ${tokens.companyName}. Our team will review your application and be in touch soon.</p><p>Regards,<br/>${tokens.companyName}</p>`,
      }).catch(() => {});
    }

    const hrManagers = await knex('users').whereIn('role', ['super_admin', 'hr_manager']).select('id', 'email');
    if (hrManagers.length) {
      notifyHR({
        type: 'recruitment', subType: 'new_application',
        title: 'New Application Received',
        subtitle: `${fullName} applied for ${requisition.title} via the careers site.`,
        referenceId: result.id, referenceModel: 'applications',
        requiresAction: true, triggeredBy: null,
      }).catch(() => {});
      notifyByRoles(['super_admin', 'hr_manager'], {
        title: 'New Application Received',
        body: `${fullName} applied for ${requisition.title} via the careers site.`,
        type: 'recruitment',
      }).catch(() => {});

      const tokens = { candidateName: fullName, jobTitle: requisition.title };
      hrManagers.filter(u => u.email).forEach(u => sendTemplatedEmail({
        trigger: 'careersApplicationReceived', to: u.email, tokens,
        fallbackSubject: 'New Application Received',
        fallbackHtml: `<p>${tokens.candidateName} applied for ${tokens.jobTitle} via the careers site.</p>`,
      }).catch(() => {}));
    }

    return returnFunction(res, 201, true, 'Application submitted successfully. We will be in touch.', { _id: result.id });
  } catch (e) {
    return returnFunction(res, 500, false, 'Server error');
  }
});

// GET /api/public/jobs/:id/pdf — downloadable job flyer (no auth)
router.get('/jobs/:id/pdf', async (req, res) => {
  try {
    const job = await knex('job_requisitions').where({ id: req.params.id }).first();
    if (!job) return returnFunction(res, 404, false, 'Job not found');

    const settings = await knex('company_settings').first();
    const companyName = settings?.companyName || 'Workfola';
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
    const applyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/en/careers/${job.id}`;
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
  return knex('applications').whereRaw("\"offerDetails\"->>'responseTokenHash' = ?", [tokenHash]).first();
}

// GET /api/public/offers/:token — candidate views their offer before deciding
router.get('/offers/:token', AsyncHandler(async (req, res) => {
  const application = await findApplicationByOfferToken(req.params.token);
  if (!application || !application.offerDetails) return returnFunction(res, 404, false, 'Offer not found or link has expired.');
  if (new Date(application.offerDetails.expiresAt) < new Date()) return returnFunction(res, 410, false, 'This offer has expired.');

  const [candidate, requisition] = await Promise.all([
    knex('candidates').where({ id: application.candidateId }).first(),
    knex('job_requisitions').where({ id: application.requisitionId }).first(),
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

// ── Project invite response (public, token-based — invitee has no account yet) ──

// GET /api/public/project-invites/:token — invitee views the invite before deciding
router.get('/project-invites/:token', AsyncHandler(async (req, res) => {
  const invite = await findInviteByToken(req.params.token);
  if (!invite) return returnFunction(res, 404, false, 'Invite not found or link is invalid.');
  if (invite.status === 'pending' && new Date(invite.expiresAt) < new Date()) {
    await knex('project_invites').where({ id: invite.id }).update({ status: 'expired', updatedAt: new Date() });
    return returnFunction(res, 410, false, 'This invite has expired.');
  }

  return returnFunction(res, 200, true, 'Invite found.', {
    name: invite.name,
    projectName: invite.projectName,
    invitedByName: invite.invitedByName,
    projectRole: invite.projectRole,
    contractEndDate: invite.contractEndDate,
    expiresAt: invite.expiresAt,
    status: invite.status,
  });
}));

// POST /api/public/project-invites/:token/respond — invitee accepts or declines
router.post('/project-invites/:token/respond', AsyncHandler(async (req, res) => {
  if (!validateRequiredFields(req, res, ['status'])) return;
  if (!['accepted', 'declined'].includes(req.body.status)) return returnFunction(res, 400, false, 'status must be accepted or declined.');

  const invite = await findInviteByToken(req.params.token);
  if (!invite) return returnFunction(res, 404, false, 'Invite not found or link is invalid.');
  if (invite.status !== 'pending') return returnFunction(res, 400, false, 'This invite has already been responded to.');
  if (new Date(invite.expiresAt) < new Date()) return returnFunction(res, 410, false, 'This invite has expired.');

  if (req.body.status === 'accepted') {
    await acceptInviteCore(invite);
  } else {
    await declineInviteCore(invite);
  }

  return returnFunction(res, 200, true, `Invite ${req.body.status}.`);
}));

// GET /api/public/unsubscribe/status — read-only check, used to show who/what before
// the user commits to an action (a link-scanning email client prefetching this GET
// must never itself change anything — see the POST route below for the real toggle).
router.get('/unsubscribe/status', AsyncHandler(async (req, res) => {
  const { uid, token } = req.query;
  if (!uid || !token || !verifyUnsubscribeToken(uid, token)) {
    return returnFunction(res, 400, false, 'This unsubscribe link is invalid.');
  }
  const user = await knex('users').where({ id: String(uid) }).select('email', 'name', 'unsubscribedFromEmails').first();
  if (!user) return returnFunction(res, 404, false, 'Account not found.');
  return returnFunction(res, 200, true, 'OK', { email: user.email, name: user.name, unsubscribed: user.unsubscribedFromEmails === true });
}));

// POST /api/public/unsubscribe — the actual state change. No auth beyond the token
// (recipient isn't necessarily logged in when they click this from their inbox).
router.post('/unsubscribe', AsyncHandler(async (req, res) => {
  const { uid, token, unsubscribed } = req.body;
  if (!uid || !token || !verifyUnsubscribeToken(uid, token)) {
    return returnFunction(res, 400, false, 'This unsubscribe link is invalid.');
  }
  const [updated] = await knex('users').where({ id: String(uid) }).update({ unsubscribedFromEmails: unsubscribed !== false, updatedAt: new Date() }).returning('id');
  if (!updated) return returnFunction(res, 404, false, 'Account not found.');
  return returnFunction(res, 200, true, unsubscribed !== false ? 'Unsubscribed.' : 'Resubscribed.');
}));

module.exports = router;
