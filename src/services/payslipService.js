const PDFDocument = require('pdfkit');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmt(n, cur = 'KES') {
  return `${cur} ${(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
}

function hline(doc) {
  doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#334155').stroke().moveDown(0.4);
}

function row(doc, left, right, bold = false, color = null) {
  const y = doc.y;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
     .fillColor(color || (bold ? '#f1f5f9' : '#94a3b8'))
     .text(left, 50, y, { width: 320 });
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
     .fillColor(color || (bold ? '#f1f5f9' : '#cbd5e1'))
     .text(right, 370, y, { width: 180, align: 'right' });
  doc.moveDown(0.35);
}

function sectionHeader(doc, label, color) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor(color).text(label, 50);
  doc.moveDown(0.25);
  hline(doc);
}

const generatePayslipFromResult = (employee, result, cycle) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers = [];
    doc.on('data', c => buffers.push(c));
    doc.on('end',  () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const cur = cycle.currency || 'KES';

    // ── Background ────────────────────────────────────────────────────────────
    doc.rect(0, 0, 595, 842).fill('#0f172a');

    // ── Header band ───────────────────────────────────────────────────────────
    doc.rect(0, 0, 595, 90).fill('#1e293b');
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#f1f5f9').text('BELLA ERP', 50, 25, { align: 'left' });
    doc.fontSize(11).font('Helvetica').fillColor('#94a3b8').text('PAYSLIP', 50, 50);
    doc.fontSize(9).fillColor('#64748b')
       .text(
         `${MONTHS[cycle.period.month - 1]} ${cycle.period.year}  •  Pay Date: ${cycle.payDate ? new Date(cycle.payDate).toLocaleDateString('en-KE') : '—'}`,
         50, 65,
       );

    // ── Employee info block ───────────────────────────────────────────────────
    doc.y = 110;
    doc.rect(50, doc.y, 495, 60).fill('#1e293b').stroke('#334155');
    const infoY = doc.y + 8;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#f1f5f9')
       .text(employee?.fullName ?? 'Employee', 65, infoY);
    doc.fontSize(8).font('Helvetica').fillColor('#94a3b8');
    doc.text(
      `${employee?.designation ?? ''}  |  ${employee?.department ?? ''}  |  ID: ${employee?.staffNumber ?? '—'}`,
      65, infoY + 16,
    );
    doc.text(
      `Bank: ${employee?.bankAccount ? `****${String(employee.bankAccount).slice(-4)}` : 'Not on file'}`,
      65, infoY + 30,
    );
    doc.y += 75;

    // ── Earnings ──────────────────────────────────────────────────────────────
    doc.moveDown(0.5);
    sectionHeader(doc, 'EARNINGS', '#22c55e');
    for (const e of (result.earnings ?? [])) {
      row(doc, e.conceptName, fmt(e.amount, cur));
    }
    for (const b of (result.benefits ?? [])) {
      row(doc, b.conceptName, fmt(b.amount, cur));
    }
    if ((result.overtimeAmount ?? 0) > 0) {
      row(doc, `Overtime (${result.overtimeHours ?? 0} hrs)`, fmt(result.overtimeAmount, cur));
    }
    if ((result.expenseReimbursements ?? 0) > 0) {
      row(doc, 'Expense Reimbursements', fmt(result.expenseReimbursements, cur));
    }
    hline(doc);
    row(doc, 'GROSS PAY', fmt(result.grossPay, cur), true);
    doc.moveDown(0.5);

    // ── Statutory deductions ──────────────────────────────────────────────────
    // Support both the cycle result format (result.statutoryDeductions) and
    // the legacy payroll_summaries format (result.deductions object with paye/nssf/sha/ahl)
    const sd = result.statutoryDeductions;
    const legacyDed = (!sd && result.deductions && !Array.isArray(result.deductions))
      ? result.deductions : null;
    const sdLabels = sd?.labels || result.taxLabels || {};

    const statutory = [];
    if (sd) {
      if (sd.paye) statutory.push({ name: sdLabels.paye || 'PAYE',                     amount: sd.paye });
      if (sd.nssf) statutory.push({ name: sdLabels.nssf || 'NSSF',                     amount: sd.nssf });
      if (sd.sha)  statutory.push({ name: sdLabels.sha  || 'SHA',                      amount: sd.sha  });
      if (sd.ahl)  statutory.push({ name: sdLabels.ahl  || 'Affordable Housing Levy',  amount: sd.ahl  });
    } else if (legacyDed) {
      if (legacyDed.paye) statutory.push({ name: sdLabels.incomeTax   || 'PAYE',                    amount: legacyDed.paye });
      if (legacyDed.nssf) statutory.push({ name: sdLabels.pension     || 'NSSF',                    amount: legacyDed.nssf });
      if (legacyDed.sha)  statutory.push({ name: sdLabels.health      || 'SHA',                     amount: legacyDed.sha  });
      if (legacyDed.ahl)  statutory.push({ name: sdLabels.housingLevy || 'Affordable Housing Levy', amount: legacyDed.ahl  });
    }

    if (statutory.length > 0) {
      sectionHeader(doc, 'STATUTORY DEDUCTIONS', '#f59e0b');
      for (const s of statutory) {
        row(doc, s.name, fmt(s.amount, cur));
      }
      const statTotal = statutory.reduce((sum, s) => sum + (s.amount || 0), 0);
      hline(doc);
      row(doc, 'TOTAL STATUTORY', fmt(statTotal, cur), true);
      doc.moveDown(0.5);
    }

    // ── Other deductions (loans, advances, voluntary) ─────────────────────────
    const otherDeds = [];
    if (sd && Array.isArray(result.deductions)) {
      // Cycle format: deductions array = compensations deductions (loans etc.)
      for (const d of result.deductions) {
        otherDeds.push({ name: d.conceptName, amount: d.amount });
      }
    } else if (legacyDed) {
      for (const d of (legacyDed.otherDeductions || [])) {
        otherDeds.push({ name: d.label || d.name, amount: d.amount });
      }
    }

    if (otherDeds.length > 0) {
      sectionHeader(doc, 'OTHER DEDUCTIONS', '#ef4444');
      for (const d of otherDeds) {
        row(doc, d.name, fmt(d.amount, cur));
      }
      const otherTotal = otherDeds.reduce((sum, d) => sum + (d.amount || 0), 0);
      hline(doc);
      row(doc, 'TOTAL OTHER DEDUCTIONS', fmt(otherTotal, cur), true);
      doc.moveDown(0.5);
    }

    // ── Net pay highlight ──────────────────────────────────────────────────────
    doc.rect(50, doc.y, 495, 36).fill('#6366f1');
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#ffffff')
       .text('NET PAY (TAKE HOME)', 65, doc.y + 8, { width: 250 });
    doc.text(fmt(result.netPay, cur), 315, doc.y - 13, { width: 220, align: 'right' });
    doc.y += 50;

    // ── Employer contributions (info only) ─────────────────────────────────────
    const empContribs = result.employerContributions ?? [];
    if (empContribs.length > 0) {
      doc.moveDown(0.5);
      sectionHeader(doc, 'EMPLOYER CONTRIBUTIONS (for your information only)', '#8b5cf6');
      for (const ec of empContribs) {
        row(doc, ec.conceptName, fmt(ec.amount, cur));
      }
      hline(doc);
      row(doc, 'TOTAL EMPLOYER COST', fmt(result.totalEmployerCost, cur), true);
    }

    // ── Footer ─────────────────────────────────────────────────────────────────
    doc.moveDown(1.5);
    hline(doc);
    doc.fontSize(7).font('Helvetica').fillColor('#475569')
       .text(
         'This is a computer-generated payslip and does not require a signature.',
         50, doc.y,
         { align: 'center', width: 495 },
       );

    doc.end();
  });
};

module.exports = { generatePayslipFromResult };
