const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const CERT_DIR = path.join(
  process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', '..', '..', 'uploads'),
  'certificates'
);
if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

// Renders a landscape A4 certificate PDF to disk and returns its servable /uploads URL.
const generateCertificatePDF = ({ employeeName, courseTitle, completedAt, certificateNumber, companyName = 'Bella ERP' }) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50 });
    const filename = `certificate-${certificateNumber}.pdf`;
    const filePath = path.join(CERT_DIR, filename);
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const W = doc.page.width;
    const H = doc.page.height;
    doc.rect(20, 20, W - 40, H - 40).lineWidth(3).strokeColor('#0A1931').stroke();
    doc.rect(28, 28, W - 56, H - 56).lineWidth(1).strokeColor('#C9A84C').stroke();

    doc.moveDown(3);
    doc.fontSize(14).font('Helvetica').fillColor('#555555').text(companyName.toUpperCase(), { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(34).font('Helvetica-Bold').fillColor('#0A1931').text('CERTIFICATE OF COMPLETION', { align: 'center' });
    doc.moveDown(1.5);
    doc.fontSize(13).font('Helvetica').fillColor('#555555').text('This is to certify that', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(28).font('Helvetica-Bold').fillColor('#C9A84C').text(employeeName, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(13).font('Helvetica').fillColor('#555555').text('has successfully completed', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#0A1931').text(courseTitle, { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(11).font('Helvetica').fillColor('#333333').text(
      `Completed on ${new Date(completedAt).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })}`,
      { align: 'center' }
    );
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#888888').text(`Certificate No. ${certificateNumber}`, { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(10).fillColor('#555555').text(`Issued by ${companyName}`, { align: 'center' });

    doc.end();
    stream.on('finish', () => resolve(`/uploads/certificates/${filename}`));
    stream.on('error', reject);
  });
};

module.exports = { generateCertificatePDF };
