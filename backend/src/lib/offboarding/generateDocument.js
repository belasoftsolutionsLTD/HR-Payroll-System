const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const DOC_DIR = path.join(
  process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', '..', '..', 'uploads'),
  'offboarding-documents'
);
if (!fs.existsSync(DOC_DIR)) fs.mkdirSync(DOC_DIR, { recursive: true });

const COMPANY_NAME = () => process.env.COMPANY_NAME || 'Bella ERP';
const fmtDate = (d) => new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });

const header = (doc) => {
  doc.fontSize(16).font('Helvetica-Bold').fillColor('#0A1931').text(COMPANY_NAME(), { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor('#888888').text(fmtDate(new Date()), { align: 'center' });
  doc.moveDown(2);
};

const footer = (doc, signatoryTitle = 'HR Manager') => {
  doc.moveDown(3);
  doc.fontSize(11).font('Helvetica').fillColor('#333333').text('_____________________________');
  doc.text(signatoryTitle);
  doc.text(COMPANY_NAME());
};

const renderToFile = (recordId, type, renderFn) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 60 });
  const filename = `${type}-${recordId}-${Date.now()}.pdf`;
  const filePath = path.join(DOC_DIR, filename);
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  renderFn(doc);
  doc.end();
  stream.on('finish', () => resolve(`/uploads/offboarding-documents/${filename}`));
  stream.on('error', reject);
});

const generateExperienceLetter = (recordId, { fullName, designation, department, dateOfHire, lastWorkingDay }) =>
  renderToFile(recordId, 'experienceLetter', (doc) => {
    header(doc);
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#0A1931').text('EXPERIENCE LETTER', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(11).font('Helvetica').fillColor('#333333').text(
      `This is to certify that ${fullName}${designation ? `, ${designation}` : ''}${department ? ` in the ${department} department` : ''}, was employed with ${COMPANY_NAME()} from ${fmtDate(dateOfHire)} to ${fmtDate(lastWorkingDay)}.`,
      { lineGap: 6 }
    );
    doc.moveDown(1);
    doc.text(`During this period, ${fullName} performed their duties in a satisfactory manner. We wish them every success in their future endeavors.`, { lineGap: 6 });
    footer(doc);
  });

const generateRelievingLetter = (recordId, { fullName, designation, lastWorkingDay }) =>
  renderToFile(recordId, 'relievingLetter', (doc) => {
    header(doc);
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#0A1931').text('RELIEVING LETTER', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(11).font('Helvetica').fillColor('#333333').text(
      `This is to confirm that ${fullName}${designation ? `, ${designation}` : ''}, has been relieved of their duties at ${COMPANY_NAME()} effective ${fmtDate(lastWorkingDay)}.`,
      { lineGap: 6 }
    );
    doc.moveDown(1);
    doc.text('There are no dues outstanding against the employee as of the date of this letter.', { lineGap: 6 });
    footer(doc);
  });

const generateClearanceCertificate = (recordId, { fullName, assetChecklist = [], accessRevocationList = [] }) =>
  renderToFile(recordId, 'clearanceCertificate', (doc) => {
    header(doc);
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#0A1931').text('CLEARANCE CERTIFICATE', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(11).font('Helvetica').fillColor('#333333').text(`This certifies that ${fullName} has cleared the following items:`, { lineGap: 6 });
    doc.moveDown(1);

    doc.fontSize(11).font('Helvetica-Bold').text('Assets');
    doc.font('Helvetica');
    if (!assetChecklist.length) doc.fontSize(10).text('  No assets recorded.');
    assetChecklist.forEach((a) => doc.fontSize(10).text(`  ${a.returned ? '[x]' : '[ ]'} ${a.item}${a.returned ? ` — returned ${a.returnedAt ? fmtDate(a.returnedAt) : ''}` : ' — outstanding'}`));

    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').text('Access & Systems');
    doc.font('Helvetica');
    if (!accessRevocationList.length) doc.fontSize(10).text('  No access items recorded.');
    accessRevocationList.forEach((a) => doc.fontSize(10).text(`  ${a.revoked ? '[x]' : '[ ]'} ${a.system}${a.revoked ? ' — revoked' : ' — outstanding'}`));

    footer(doc);
  });

module.exports = { generateExperienceLetter, generateRelievingLetter, generateClearanceCertificate };
