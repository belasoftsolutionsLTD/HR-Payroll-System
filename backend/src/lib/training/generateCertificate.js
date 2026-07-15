const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const CERT_DIR = path.join(
  process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', '..', '..', 'uploads'),
  'certificates'
);
if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

// Brand palette — matches the frontend's brand-* design tokens (tailwind.config.ts) so
// certificates feel like part of the same system rather than a separate visual language.
const INDIGO      = '#4F46E5';
const INDIGO_SOFT = '#E0E7FF';
const INK         = '#0F172A';
const SLATE       = '#64748B';
const GOLD        = '#D4AF37';

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
// employee name, course title, completion date, and certificate number vary.
const generateCertificatePDF = ({ employeeName, courseTitle, completedAt, certificateNumber, companyName = 'Bella ERP' }) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const filename = `certificate-${certificateNumber}.pdf`;
    const filePath = path.join(CERT_DIR, filename);
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const W = doc.page.width;
    const H = doc.page.height;

    // Background + corner flourishes
    doc.rect(0, 0, W, H).fill('#FFFFFF');
    doc.circle(0, 0, 160).fill(INDIGO_SOFT);
    doc.circle(W, H, 160).fill(INDIGO_SOFT);
    doc.circle(0, 0, 100).fill('#FFFFFF').circle(0, 0, 100).lineWidth(0).fill('#FFFFFF');

    // Frame
    doc.rect(28, 28, W - 56, H - 56).lineWidth(2.5).strokeColor(INDIGO).stroke();
    doc.rect(36, 36, W - 72, H - 72).lineWidth(0.75).strokeColor(GOLD).stroke();

    let y = 78;
    doc.fontSize(13).font('Helvetica-Bold').fillColor(INDIGO)
      .text(companyName.toUpperCase(), 0, y, { align: 'center', characterSpacing: 3 });

    y += 34;
    doc.fontSize(38).font('Times-Bold').fillColor(INK)
      .text('Certificate of Completion', 0, y, { align: 'center' });

    // Decorative rule under the title
    const ruleW = 220;
    doc.moveTo(W / 2 - ruleW / 2, y + 54).lineTo(W / 2 + ruleW / 2, y + 54)
      .lineWidth(1.5).strokeColor(GOLD).stroke();

    y += 78;
    doc.fontSize(13).font('Helvetica').fillColor(SLATE)
      .text('This certificate is proudly presented to', 0, y, { align: 'center' });

    y += 30;
    doc.fontSize(32).font('Times-BoldItalic').fillColor(INDIGO)
      .text(employeeName, 0, y, { align: 'center' });

    y += 52;
    doc.fontSize(13).font('Helvetica').fillColor(SLATE)
      .text('for successfully completing the course', 0, y, { align: 'center' });

    y += 28;
    doc.fontSize(22).font('Times-Bold').fillColor(INK)
      .text(courseTitle, 60, y, { align: 'center', width: W - 120 });

    // Seal — bottom right, star inside a double ring
    const sealCx = W - 130;
    const sealCy = H - 110;
    doc.circle(sealCx, sealCy, 42).lineWidth(2).strokeColor(GOLD).stroke();
    doc.circle(sealCx, sealCy, 36).fillColor(INDIGO).fill();
    drawStar(doc, sealCx, sealCy, 20, 8, '#FFFFFF');
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(GOLD)
      .text('CERTIFIED', sealCx - 40, sealCy + 48, { width: 80, align: 'center', characterSpacing: 1 });

    // Signature line — bottom left
    const sigX = 90;
    const sigY = H - 96;
    doc.moveTo(sigX, sigY).lineTo(sigX + 200, sigY).lineWidth(1).strokeColor(SLATE).stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor(INK)
      .text('Authorized Signature', sigX, sigY + 6, { width: 200, align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor(SLATE)
      .text(companyName, sigX, sigY + 20, { width: 200, align: 'center' });

    // Footer meta
    doc.fontSize(10).font('Helvetica').fillColor(SLATE).text(
      `Completed on ${new Date(completedAt).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })}`,
      0, H - 60, { align: 'center' }
    );
    doc.fontSize(8).fillColor('#94A3B8').text(`Certificate No. ${certificateNumber}`, 0, H - 44, { align: 'center' });

    doc.end();
    stream.on('finish', () => resolve(`/uploads/certificates/${filename}`));
    stream.on('error', reject);
  });
};

module.exports = { generateCertificatePDF };
