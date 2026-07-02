const PDFDocument = require('pdfkit');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmt(n, cur = 'KES') {
  return `${cur} ${(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
}

function line(doc) {
  doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#334155').stroke().moveDown(0.4);
}

function row(doc, left, right, bold = false) {
  const y = doc.y;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#94a3b8').text(left, 50, y, { width: 320 });
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(bold ? '#f1f5f9' : '#cbd5e1').text(right, 370, y, { width: 180, align: 'right' });
  doc.moveDown(0.35);
}

const generatePayslipFromResult = (employee, result, cycle) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers = [];
    doc.on('data', c => buffers.push(c));
    doc.on('end',  () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const cur = cycle.currency || 'KES';

    // Background
    doc.rect(0, 0, 595, 842).fill('#0f172a');

    // Header band
    doc.rect(0, 0, 595, 90).fill('#1e293b');
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#f1f5f9').text('BELA ERP', 50, 25, { align: 'left' });
    doc.fontSize(11).font('Helvetica').fillColor('#94a3b8').text('PAYSLIP', 50, 50);
    doc.fontSize(9).fillColor('#64748b').text(`${MONTHS[cycle.period.month - 1]} ${cycle.period.year}  •  Pay Date: ${cycle.payDate ? new Date(cycle.payDate).toLocaleDateString('en-KE') : '—'}`, 50, 65);

    // Employee info
    doc.y = 110;
    doc.rect(50, doc.y, 495, 60).fill('#1e293b').stroke('#334155');
    const infoY = doc.y + 8;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#f1f5f9').text(employee?.fullName ?? 'Employee', 65, infoY);
    doc.fontSize(8).font('Helvetica').fillColor('#94a3b8');
    doc.text(`${employee?.designation ?? ''}  |  ${employee?.department ?? ''}  |  ID: ${employee?.staffNumber ?? '—'}`, 65, infoY + 16);
    doc.text(`Bank: ${employee?.bankAccount ? `****${String(employee.bankAccount).slice(-4)}` : 'Not on file'}`, 65, infoY + 30);
    doc.y += 75;

    // Earnings
    doc.moveDown(0.5);
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#22c55e').text('EARNINGS', 50);
    doc.moveDown(0.25); line(doc);
    for (const e of (result.earnings ?? [])) {
      row(doc, e.conceptName, fmt(e.amount, cur));
    }
    for (const b of (result.benefits ?? [])) {
      row(doc, b.conceptName, fmt(b.amount, cur));
    }
    if (result.expenseReimbursements > 0) {
      row(doc, 'Expense Reimbursements', fmt(result.expenseReimbursements, cur));
    }
    line(doc);
    row(doc, 'GROSS PAY', fmt(result.grossPay, cur), true);
    doc.moveDown(0.5);

    // Deductions
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#ef4444').text('DEDUCTIONS', 50);
    doc.moveDown(0.25); line(doc);
    for (const d of (result.deductions ?? [])) {
      row(doc, d.conceptName, fmt(d.amount, cur));
    }
    line(doc);
    row(doc, 'TOTAL DEDUCTIONS', fmt(result.totalDeductions, cur), true);
    doc.moveDown(0.75);

    // Net pay highlight
    doc.rect(50, doc.y, 495, 36).fill('#6366f1');
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#ffffff')
       .text('NET PAY (TAKE HOME)', 65, doc.y + 8, { width: 250 });
    doc.text(fmt(result.netPay, cur), 315, doc.y - 13, { width: 220, align: 'right' });
    doc.y += 50;

    // Employer contributions (info only)
    if ((result.employerContributions ?? []).length > 0) {
      doc.moveDown(0.5);
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#8b5cf6').text('EMPLOYER CONTRIBUTIONS (info only)', 50);
      doc.moveDown(0.25); line(doc);
      for (const ec of result.employerContributions) {
        row(doc, ec.conceptName, fmt(ec.amount, cur));
      }
      line(doc);
      row(doc, 'TOTAL EMPLOYER COST', fmt(result.totalEmployerCost, cur), true);
    }

    // Footer
    doc.moveDown(1.5);
    line(doc);
    doc.fontSize(7).font('Helvetica').fillColor('#475569').text('This is a computer-generated payslip and does not require a signature.', 50, doc.y, { align: 'center', width: 495 });

    doc.end();
  });
};

module.exports = { generatePayslipFromResult };
