const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const CERT_DIR = path.join(
  process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', '..', '..', 'uploads'),
  'certificates'
);
if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

const INK   = '#0F172A';
const SLATE = '#64748B';
const FAINT = '#94A3B8';
const DEFAULT_BRAND = '#4F46E5';

// Draws a five-point star centered at (cx, cy) with given outer/inner radii.
function drawStar(doc, cx, cy, outerR, innerR, color) {
  const points = 5;
  const step = Math.PI / points;
  let path = '';
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = i * step - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    path += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
  }
  doc.path(path + 'Z').fill(color);
}

// One standard certificate template, reused for every course/training — only the
// employee name, course title, completion date, and certificate number vary. Brand
// color and logo come from company_settings so every org's certificates look like
// their own system rather than a generic stock template — see trainingFunctions.js's
// maybeGenerateCertificate, which loads those settings before calling this.
const generateCertificatePDF = ({
  employeeName, courseTitle, completedAt, certificateNumber,
  companyName = 'Bela ERP', brandColor, gradientEndColor, logoPath,
}) => {
  return new Promise((resolve, reject) => {
    const brand = /^#[0-9a-fA-F]{6}$/.test(brandColor || '') ? brandColor : DEFAULT_BRAND;
    const gradientEnd = /^#[0-9a-fA-F]{6}$/.test(gradientEndColor || '') ? gradientEndColor : brand;

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const filename = `certificate-${certificateNumber}.pdf`;
    const filePath = path.join(CERT_DIR, filename);
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const W = doc.page.width;
    const H = doc.page.height;
    const BAND_H = 96;

    doc.rect(0, 0, W, H).fill('#FFFFFF');

    // Subtle geometric corner accent (opposite corners) instead of a busy double frame —
    // a single low-opacity wedge in the brand color reads as modern rather than "templatey".
    doc.save();
    doc.fillOpacity(0.06);
    doc.polygon([0, 0], [190, 0], [0, 190]).fill(brand);
    doc.polygon([W, H], [W - 190, H], [W, H - 190]).fill(brand);
    doc.restore();

    // Single thin frame — one accent line beats the old gold+indigo double-frame combo.
    doc.rect(24, 24, W - 48, H - 48).lineWidth(1.25).strokeColor(brand).strokeOpacity(0.5).stroke();
    doc.strokeOpacity(1);

    // Header band — real gradient (brand → gradientEnd) if the org has one configured,
    // otherwise a solid brand-color fill.
    const gradient = doc.linearGradient(0, 0, W, BAND_H);
    gradient.stop(0, brand).stop(1, gradientEnd);
    doc.rect(0, 0, W, BAND_H).fill(gradient);

    const logoAbsPath = logoPath ? path.resolve(logoPath) : null;
    const hasLogo = logoAbsPath && fs.existsSync(logoAbsPath);
    let textStartX = 60;
    if (hasLogo) {
      try {
        doc.image(logoAbsPath, 56, BAND_H / 2 - 22, { fit: [44, 44] });
        textStartX = 112;
      } catch { /* corrupt/unsupported image — fall back to text-only header */ }
    }
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#FFFFFF')
      .text(companyName, textStartX, BAND_H / 2 - 13, { width: W - textStartX - 60 });

    let y = BAND_H + 56;
    doc.fontSize(34).font('Times-Bold').fillColor(INK)
      .text('Certificate of Completion', 0, y, { align: 'center' });

    const ruleW = 200;
    doc.moveTo(W / 2 - ruleW / 2, y + 48).lineTo(W / 2 + ruleW / 2, y + 48)
      .lineWidth(1.5).strokeColor(brand).stroke();

    y += 70;
    doc.fontSize(12).font('Helvetica').fillColor(SLATE)
      .text('This certificate is proudly presented to', 0, y, { align: 'center' });

    y += 30;
    doc.fontSize(30).font('Times-BoldItalic').fillColor(brand)
      .text(employeeName, 0, y, { align: 'center' });

    y += 48;
    doc.fontSize(12).font('Helvetica').fillColor(SLATE)
      .text('for successfully completing the course', 0, y, { align: 'center' });

    y += 26;
    doc.fontSize(20).font('Times-Bold').fillColor(INK)
      .text(courseTitle, 60, y, { align: 'center', width: W - 120 });

    // Footer — three columns: issue date · signature · seal + certificate number
    const footerY = H - 110;
    doc.moveTo(60, footerY).lineTo(W - 60, footerY).lineWidth(0.75).strokeColor('#E2E8F0').stroke();

    doc.fontSize(9).font('Helvetica-Bold').fillColor(FAINT).text('DATE ISSUED', 60, footerY + 18, { characterSpacing: 0.5 });
    doc.fontSize(11).font('Helvetica').fillColor(INK).text(
      new Date(completedAt).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' }),
      60, footerY + 32
    );

    const sigX = W / 2 - 100;
    doc.moveTo(sigX, footerY + 44).lineTo(sigX + 200, footerY + 44).lineWidth(1).strokeColor(SLATE).stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor(INK).text('Authorized Signature', sigX, footerY + 50, { width: 200, align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor(SLATE).text(companyName, sigX, footerY + 64, { width: 200, align: 'center' });

    // Certificate number sits well clear of the seal's bounding box (seal spans roughly
    // W-146 to W-18 horizontally) — a prior version had these overlapping.
    doc.fontSize(9).font('Helvetica-Bold').fillColor(FAINT).text('CERTIFICATE NO.', W - 340, footerY + 18, { width: 170, align: 'right', characterSpacing: 0.5 });
    doc.fontSize(11).font('Helvetica').fillColor(INK).text(certificateNumber, W - 340, footerY + 32, { width: 170, align: 'right' });

    // Seal — bottom right, star inside a ring, in the brand color
    const sealCx = W - 82;
    const sealCy = H - 60;
    doc.circle(sealCx, sealCy, 32).lineWidth(1.5).strokeColor(brand).strokeOpacity(0.6).stroke();
    doc.strokeOpacity(1);
    doc.circle(sealCx, sealCy, 27).fillColor(brand).fill();
    drawStar(doc, sealCx, sealCy, 15, 6, '#FFFFFF');

    doc.end();
    stream.on('finish', () => resolve(`/uploads/certificates/${filename}`));
    stream.on('error', reject);
  });
};

module.exports = { generateCertificatePDF };
