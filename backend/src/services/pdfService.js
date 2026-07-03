const PDFDocument = require('pdfkit');
const { companyName } = require('../configs/constants');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const generatePayslip = (employeeData, payrollData) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const buffers = [];
    doc.on('data', (c) => buffers.push(c));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const cur = payrollData.currency || 'KES';
    const labels = payrollData.taxLabels || { incomeTax: 'PAYE', pension: 'NSSF', health: 'SHA' };
    const fmt = (n) => `${cur} ${(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
    const line = () => doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown(0.5);

    doc.fontSize(18).font('Helvetica-Bold').text(companyName, { align: 'center' });
    doc.fontSize(13).font('Helvetica').text('EMPLOYEE PAYSLIP', { align: 'center' });
    doc.fontSize(11).text(`Pay Period: ${MONTHS[payrollData.month - 1]} ${payrollData.year}`, { align: 'center' });
    doc.moveDown(); line();

    doc.font('Helvetica-Bold').fontSize(10).text('EMPLOYEE DETAILS');
    doc.font('Helvetica');
    [
      ['Name',         employeeData.fullName],
      ['Staff Number', employeeData.staffNumber],
      ['Designation',  employeeData.designation],
      ['Department',   employeeData.department],
      ['Salary Grade', employeeData.salaryGrade],
      ['Job Group',    employeeData.jobGroupName],
    ].forEach(([k, v]) => { if (v) doc.text(`${k}: ${v}`); });
    doc.moveDown(); line();

    doc.font('Helvetica-Bold').text('EARNINGS');
    doc.font('Helvetica').text(`Gross Pay:  ${fmt(payrollData.grossPay)}`);

    const fixedAllowances = payrollData.allowances || [];
    const otherAllowances = payrollData.otherAllowances || [];
    fixedAllowances.forEach((a) => doc.text(`${a.name}:  ${fmt(a.amount)}`));
    otherAllowances.forEach((a) => doc.text(`${a.label || a.name}:  ${fmt(a.amount)}`));

    if (fixedAllowances.length > 0 || otherAllowances.length > 0) {
      doc.font('Helvetica-Bold').text(`Total Earnings:  ${fmt(payrollData.totalEarnings)}`);
      doc.font('Helvetica');
    }
    doc.moveDown(); line();

    const d = payrollData.deductions || {};
    doc.font('Helvetica-Bold').text('STATUTORY DEDUCTIONS');
    doc.font('Helvetica');
    doc.text(`${labels.incomeTax    || 'PAYE'}:                     ${fmt(d.paye)}`);
    doc.text(`${labels.health       || 'SHA'}:                      ${fmt(d.sha)}`);
    doc.text(`${labels.pension      || 'NSSF'}:                     ${fmt(d.nssf)}`);
    doc.text(`${labels.housingLevy  || 'Affordable Housing Levy'}:  ${fmt(d.ahl)}`);
    if ((d.otherDeductions || []).length > 0) {
      doc.moveDown(0.3).font('Helvetica-Bold').text('OTHER DEDUCTIONS');
      doc.font('Helvetica');
      (d.otherDeductions || []).forEach((od) => doc.text(`${od.label || od.name}:  ${fmt(od.amount)}`));
    }
    doc.moveDown(); line();

    const totalDed = (d.paye || 0) + (d.sha || 0) + (d.nssf || 0) + (d.ahl || 0) +
      (d.otherDeductions || []).reduce((s, x) => s + (x.amount || 0), 0);
    doc.font('Helvetica-Bold').fontSize(11)
      .text(`Total Deductions:  ${fmt(totalDed)}`, { align: 'right' });
    doc.text(`NET PAY:  ${fmt(payrollData.netPay)}`, { align: 'right' });

    doc.moveDown(2).fontSize(8).font('Helvetica').fillColor('grey')
      .text('Computer-generated payslip — no signature required.', { align: 'center' });
    doc.end();
  });
};

module.exports = { generatePayslip };
