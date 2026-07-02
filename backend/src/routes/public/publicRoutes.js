const express = require('express');
const multer  = require('multer');
const PDFDocument = require('pdfkit');
const { ObjectId } = require('mongodb');
const router = express.Router();
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findMany, findOne, insertOne } = require('../../functions/Database/commonDBFunctions');
const { notifyByRoles } = require('../../functions/HR/notifyUser');
const { notifyHR } = require('../inbox/inboxFunctions');
const AsyncHandler = require('../../middleware/AsyncHandler');
const { serveCompanyLogo } = require('../config/companySettingsFunctions');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || 'uploads'),
  filename: (req, file, cb) => cb(null, `cv-${Date.now()}-${file.originalname}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max for public CV uploads
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
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

// GET /api/public/positions — open positions (no auth)
router.get('/positions', async (req, res) => {
  try {
    const positions = await findMany('job_positions', { status: 'open' }, { sort: { createdAt: -1 } });
    return returnFunction(res, 200, true, 'OK', positions);
  } catch (e) {
    return returnFunction(res, 500, false, 'Server error');
  }
});

// GET /api/public/positions/:id — single position detail (no auth)
router.get('/positions/:id', async (req, res) => {
  try {
    const position = await findOne('job_positions', { _id: new ObjectId(req.params.id), status: 'open' });
    if (!position) return returnFunction(res, 404, false, 'Position not found or closed');
    return returnFunction(res, 200, true, 'OK', position);
  } catch (e) {
    return returnFunction(res, 500, false, 'Server error');
  }
});

// POST /api/public/apply — submit application (no auth, CV upload optional)
router.post('/apply', upload.single('cv'), async (req, res) => {
  try {
    if (!validateRequiredFields(req, res, ['fullName', 'email', 'positionId'])) return;

    const position = await findOne('job_positions', { _id: new ObjectId(req.body.positionId), status: 'open' });
    if (!position) return returnFunction(res, 404, false, 'Position not found or closed');

    // Check for duplicate application
    const existing = await findOne('applicants', {
      email: req.body.email.toLowerCase().trim(),
      positionId: new ObjectId(req.body.positionId),
    });
    if (existing) return returnFunction(res, 409, false, 'You have already applied for this position.');

    const doc = {
      positionId: new ObjectId(req.body.positionId),
      positionTitle: position.jobTitle,
      fullName: req.body.fullName.trim(),
      email: req.body.email.toLowerCase().trim(),
      phone: req.body.phone || null,
      coverLetter: req.body.coverLetter || null,
      cvPath: req.file ? req.file.path : null,
      cvFilename: req.file ? req.file.originalname : null,
      stage: 'applied',
      approvalStatus: 'pending',
      approvedBy: null,
      offerLetterSentAt: null,
      source: 'public_portal',
      appliedAt: new Date(),
      createdAt: new Date(),
    };

    const result = await insertOne('applicants', doc);

    // Notify HR managers
    const hrManagers = await findMany('users', { role: 'hr_manager' }, { projection: { _id: 1 } });
    if (hrManagers.length) {
      notifyHR({
        type: 'recruitment', subType: 'new_application',
        title: 'New Application Received',
        subtitle: `${doc.fullName} applied for ${position.jobTitle} via the public portal.`,
        referenceId: result.insertedId, referenceModel: 'applicants',
        requiresAction: true, triggeredBy: null,
      }).catch(() => {});
      notifyByRoles(['super_admin', 'hr_manager'], {
        title: 'New Application Received',
        body: `${doc.fullName} applied for ${position.jobTitle} via the public portal.`,
        type: 'recruitment',
      }).catch(() => {});
    }

    return returnFunction(res, 201, true, 'Application submitted successfully. We will be in touch.', { _id: result.insertedId });
  } catch (e) {
    return returnFunction(res, 500, false, 'Server error');
  }
});

// GET /api/public/positions/:id/pdf — downloadable job flyer (no auth)
router.get('/positions/:id/pdf', async (req, res) => {
  try {
    const position = await findOne('job_positions', { _id: new ObjectId(req.params.id) });
    if (!position) return returnFunction(res, 404, false, 'Position not found');

    const settings = await findOne('company_settings', {});
    const companyName = settings?.companyName || 'School ERP';
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
    res.setHeader('Content-Disposition', `attachment; filename="${position.jobTitle.replace(/\s+/g, '_')}_Job_Post.pdf"`);
    doc.pipe(res);

    // Header bar
    doc.rect(0, 0, doc.page.width, 80).fill([pr, pg, pb]);
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold')
       .text(companyName, 50, 25, { align: 'center', width: doc.page.width - 100 });

    doc.moveDown(3).fillColor('#000000');

    // Title block
    doc.fontSize(18).font('Helvetica-Bold').fillColor([pr, pg, pb])
       .text(position.jobTitle, { align: 'center' });
    doc.fontSize(12).font('Helvetica').fillColor('#555555')
       .text(position.department, { align: 'center' });
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
      ['Openings', position.numberOfOpenings],
      ['Employment Type', position.employmentType || 'Full-time'],
      ['Status', position.status],
    ];
    if (position.salaryBandMin) {
      details.push(['Salary Band', `KES ${position.salaryBandMin.toLocaleString()} – ${(position.salaryBandMax || 0).toLocaleString()}`]);
    }
    if (position.yearsOfExperience) {
      details.push(['Experience Required', `${position.yearsOfExperience} year(s)`]);
    }
    details.forEach(([k, v]) => doc.text(`${k}:  ${v}`));
    doc.moveDown();

    if (position.jobDescription) {
      section('Job Description');
      doc.text(position.jobDescription, { lineGap: 3 });
      doc.moveDown();
    }

    if (Array.isArray(position.requiredQualifications) && position.requiredQualifications.length > 0) {
      section('Required Qualifications');
      position.requiredQualifications.forEach((q) => doc.text(`• ${q}`, { indent: 10 }));
      doc.moveDown();
    }

    // How to apply
    section('How to Apply');
    const applyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/en/apply?position=${position._id}`;
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

module.exports = router;
