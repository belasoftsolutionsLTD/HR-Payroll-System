/**
 * P9A Form Generator — Kenya Revenue Authority Annual PAYE Deduction Card.
 * Produces a PDF showing monthly taxable pay and PAYE for each month of the
 * requested tax year. Employees use this when filing annual income tax returns.
 */

const PDFDocument = require('pdfkit');
const { buildCalculator, loadTaxConfig } = require('../functions/taxCalculator');

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmt(n) {
  return (n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Generate a P9A PDF for one employee for a given tax year.
 *
 * @param {object}   employee   - Employee document { fullName, staffNumber, kraPin, designation, department }
 * @param {number}   year       - Tax year (e.g. 2025)
 * @param {object[]} monthlyData - Array of up to 12 objects, one per month payroll was run:
 *   { month: 1–12, grossPay, paye, nssf, sha, ahl, netPay }
 * @returns {Promise<Buffer>}   - PDF buffer
 */
const generateP9Form = async (employee, year, monthlyData) => {
  const taxConfig = await loadTaxConfig();
  const taxCalc   = buildCalculator(taxConfig);
  const relief    = taxConfig?.incomeTax?.personalRelief ?? 2400;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const bufs = [];
    doc.on('data', c => bufs.push(c));
    doc.on('end',  () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);

    const pageW  = 595 - 80; // usable width (margin 40 each side)
    const LEFT   = 40;
    const colW   = [60, 85, 85, 80, 80, 80, 85]; // Month | TaxablePay | PAYE | Relief | NetPAYE | NSSF | AHL
    const heads  = ['Month', 'Taxable Pay', 'PAYE Charged', 'Personal Relief', 'Net PAYE', 'NSSF', 'Housing Levy'];

    // ── KRA header ────────────────────────────────────────────────────────────
    doc.rect(LEFT, 30, pageW, 50).fill('#1e293b');
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#f1f5f9')
       .text('KENYA REVENUE AUTHORITY', LEFT, 38, { width: pageW, align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#94a3b8')
       .text(`PAYE DEDUCTION CARD — P9A     Tax Year: ${year}`, LEFT, 57, { width: pageW, align: 'center' });

    // ── Employee details ──────────────────────────────────────────────────────
    doc.y = 95;
    doc.rect(LEFT, doc.y, pageW, 52).fill('#f8fafc').stroke('#e2e8f0');
    const detY = doc.y + 6;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#334155');

    const col1x = LEFT + 6;
    const col2x = LEFT + pageW / 2 + 4;

    doc.text('Employee Name:', col1x, detY).font('Helvetica').fillColor('#1e293b')
       .text(employee?.fullName ?? '—', col1x + 95, detY);
    doc.font('Helvetica-Bold').fillColor('#334155')
       .text('Staff Number:', col1x, detY + 14).font('Helvetica').fillColor('#1e293b')
       .text(employee?.staffNumber ?? '—', col1x + 95, detY + 14);
    doc.font('Helvetica-Bold').fillColor('#334155')
       .text('Designation:', col1x, detY + 28).font('Helvetica').fillColor('#1e293b')
       .text(`${employee?.designation ?? '—'} | ${employee?.department ?? '—'}`, col1x + 95, detY + 28);

    doc.font('Helvetica-Bold').fillColor('#334155')
       .text('KRA PIN:', col2x, detY).font('Helvetica').fillColor('#1e293b')
       .text(employee?.kraPin ?? 'Not on file', col2x + 65, detY);
    doc.font('Helvetica-Bold').fillColor('#334155')
       .text('Tax Year:', col2x, detY + 14).font('Helvetica').fillColor('#1e293b')
       .text(`1 January ${year} – 31 December ${year}`, col2x + 65, detY + 14);
    doc.font('Helvetica-Bold').fillColor('#334155')
       .text('Personal Relief:', col2x, detY + 28).font('Helvetica').fillColor('#1e293b')
       .text(`KES ${fmt(relief)} / month`, col2x + 95, detY + 28);

    doc.y += 58;

    // ── Column headers ────────────────────────────────────────────────────────
    doc.moveDown(0.5);
    let x = LEFT;
    doc.rect(LEFT, doc.y, pageW, 18).fill('#334155');
    const hdrY = doc.y + 4;
    heads.forEach((h, i) => {
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#f1f5f9')
         .text(h, x + 3, hdrY, { width: colW[i] - 4, align: i === 0 ? 'left' : 'right' });
      x += colW[i];
    });
    doc.y += 18;

    // ── Monthly rows ──────────────────────────────────────────────────────────
    let annualTaxable = 0, annualPAYE = 0, annualRelief = 0,
        annualNetPAYE = 0, annualNSSF = 0, annualAHL = 0;

    for (let m = 1; m <= 12; m++) {
      const data = monthlyData.find(d => d.month === m);
      const isShaded = m % 2 === 0;
      if (isShaded) doc.rect(LEFT, doc.y, pageW, 16).fill('#f8fafc');

      const taxable = data?.grossPay ?? 0;
      const paye    = data?.paye     ?? 0;
      const rl      = data ? relief  : 0;
      const netPAYE = Math.max(0, paye - rl);
      const nssf    = data?.nssf     ?? 0;
      const ahl     = data?.ahl      ?? 0;

      annualTaxable += taxable;
      annualPAYE    += paye;
      annualRelief  += rl;
      annualNetPAYE += netPAYE;
      annualNSSF    += nssf;
      annualAHL     += ahl;

      const rowY = doc.y + 4;
      x = LEFT;
      const cells = [MONTHS_SHORT[m - 1], fmt(taxable), fmt(paye), fmt(rl), fmt(netPAYE), fmt(nssf), fmt(ahl)];
      const noData = !data;

      cells.forEach((val, i) => {
        doc.fontSize(8).font('Helvetica')
           .fillColor(noData ? '#94a3b8' : (i === 0 ? '#334155' : '#1e293b'))
           .text(val, x + 3, rowY, { width: colW[i] - 4, align: i === 0 ? 'left' : 'right' });
        x += colW[i];
      });
      doc.y += 16;
    }

    // ── Totals row ────────────────────────────────────────────────────────────
    doc.rect(LEFT, doc.y, pageW, 20).fill('#1e293b');
    const totY = doc.y + 5;
    x = LEFT;
    const totals = ['ANNUAL TOTAL', fmt(annualTaxable), fmt(annualPAYE), fmt(annualRelief), fmt(annualNetPAYE), fmt(annualNSSF), fmt(annualAHL)];
    totals.forEach((val, i) => {
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#f1f5f9')
         .text(val, x + 3, totY, { width: colW[i] - 4, align: i === 0 ? 'left' : 'right' });
      x += colW[i];
    });
    doc.y += 24;

    // ── Employer certification ────────────────────────────────────────────────
    doc.moveDown(1);
    doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageW, doc.y).strokeColor('#e2e8f0').stroke();
    doc.moveDown(0.5);
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#334155')
       .text('EMPLOYER CERTIFICATION', LEFT);
    doc.moveDown(0.3);
    doc.font('Helvetica').fillColor('#64748b').fontSize(7.5)
       .text(
         'I certify that the above deductions of PAYE income tax have been made from the ' +
         'emoluments of the above-named employee and remitted to the Commissioner of Domestic Taxes ' +
         'in accordance with the provisions of the Income Tax Act.',
         LEFT, doc.y, { width: pageW },
       );

    doc.moveDown(1.5);
    const sigY = doc.y;
    doc.moveTo(LEFT, sigY + 20).lineTo(LEFT + 180, sigY + 20).strokeColor('#334155').stroke();
    doc.moveTo(LEFT + 220, sigY + 20).lineTo(LEFT + 380, sigY + 20).stroke();
    doc.fontSize(7.5).font('Helvetica').fillColor('#94a3b8')
       .text('Authorised Signature', LEFT, sigY + 24)
       .text('Date', LEFT + 220, sigY + 24);

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.moveDown(2);
    doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageW, doc.y).strokeColor('#e2e8f0').stroke();
    doc.moveDown(0.4);
    doc.fontSize(7).font('Helvetica').fillColor('#94a3b8')
       .text(
         `Computer-generated P9A form  •  Generated on ${new Date().toLocaleDateString('en-KE', { dateStyle: 'long' })}  •  Bella ERP`,
         LEFT, doc.y, { width: pageW, align: 'center' },
       );

    doc.end();
  });
};

module.exports = { generateP9Form };
