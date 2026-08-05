const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Generated fresh from the immutable sale record on every request — unlike payslips
// (which store base64 bytes at cycle-close, since a cycle takes real work to regenerate),
// a POS receipt is cheap and deterministic to rebuild, so there's nothing to store.

function fmt(n, cur = 'KES') {
  return `${cur} ${(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
}

function hline(doc) {
  doc.moveTo(50, doc.y).lineTo(300, doc.y).strokeColor('#cbd5e1').stroke().moveDown(0.3);
}

function row(doc, left, right, bold = false) {
  const y = doc.y;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#1e293b').text(left, 50, y, { width: 160 });
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#1e293b').text(right, 210, y, { width: 90, align: 'right' });
  doc.moveDown(0.3);
}

const generateReceiptPDF = (sale, { companyName, location, logoPath } = {}) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: [300, 700] });
    const buffers = [];
    doc.on('data', (c) => buffers.push(c));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
    const cur = sale.currency || 'KES';

    let textX = 50;
    const logoAbsPath = logoPath ? path.resolve(logoPath) : null;
    if (logoAbsPath && fs.existsSync(logoAbsPath)) {
      try {
        doc.image(logoAbsPath, 50, 48, { fit: [28, 28] });
        textX = 86;
      } catch { /* corrupt/unsupported image — fall back to text-only header */ }
    }
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e293b').text(companyName || 'Workfola', textX, 50, { width: textX === 86 ? 164 : 200 });
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(location?.name || '', { width: textX === 86 ? 164 : 200 });
    doc.moveDown(0.5);
    hline(doc);

    doc.font('Helvetica').fontSize(8).fillColor('#64748b');
    doc.text(`Receipt: ${sale.saleNumber}`);
    doc.text(`Date: ${new Date(sale.createdAt).toLocaleString()}`);
    doc.text(`Cashier: ${sale.staffName || ''}`);
    doc.moveDown(0.5);
    hline(doc);

    for (const line of sale.items) {
      row(doc, `${line.name} x${line.quantity}`, fmt(line.lineTotal, cur));
      if (line.discountAmount > 0) row(doc, '  discount', `-${fmt(line.discountAmount, cur)}`);
    }
    hline(doc);

    row(doc, 'Subtotal', fmt(sale.subtotal, cur));
    if (sale.autoDiscountTotal > 0) row(doc, 'Item discounts', `-${fmt(sale.autoDiscountTotal, cur)}`);
    if (sale.lineDiscountTotal > 0) row(doc, 'Line discounts', `-${fmt(sale.lineDiscountTotal, cur)}`);
    if (sale.cartDiscountAmount > 0) row(doc, `Discount${sale.promoCode ? ` (${sale.promoCode})` : ''}`, `-${fmt(sale.cartDiscountAmount, cur)}`);
    if (sale.taxTotal > 0) row(doc, 'Tax (VAT)', fmt(sale.taxTotal, cur));
    if (sale.voucherAmount > 0) row(doc, `Voucher${sale.voucherCode ? ` (${sale.voucherCode})` : ''}`, `-${fmt(sale.voucherAmount, cur)}`);
    hline(doc);
    row(doc, 'TOTAL', fmt(sale.total, cur), true);
    doc.moveDown(0.3);

    for (const p of sale.payments) {
      row(doc, p.method.toUpperCase(), fmt(p.amount, cur));
      if (p.cashTendered) row(doc, '  cash tendered', fmt(p.cashTendered, cur));
      if (p.changeDue) row(doc, '  change given', fmt(p.changeDue, cur));
      if (p.reference) row(doc, '  ref', p.reference);
    }

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8').text('Thank you!', 50, doc.y, { width: 200, align: 'center' });

    doc.end();
  });
};

module.exports = { generateReceiptPDF };
