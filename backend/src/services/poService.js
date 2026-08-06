const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

function hline(doc) {
  doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#cbd5e1').stroke().moveDown(0.4);
}

// A fileable PDF for the supplier — the email body table alone isn't something they
// can save/print/attach to their own paperwork trail.
const generatePurchaseOrderPDF = (po, supplier, location, itemById, branding = {}) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers = [];
    doc.on('data', (c) => buffers.push(c));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const { companyName, logoPath } = branding;
    const logoAbsPath = logoPath ? path.resolve(logoPath) : null;
    let textX = 50;
    if (logoAbsPath && fs.existsSync(logoAbsPath)) {
      try { doc.image(logoAbsPath, 50, 40, { fit: [60, 60] }); textX = 120; } catch { /* fall through with no logo */ }
    }
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#0f172a').text(companyName || 'Workfola', textX, 45);
    doc.fontSize(10).font('Helvetica').fillColor('#64748b').text('Purchase Order', textX, 68);

    doc.moveDown(3);
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#0f172a').text(po.poNumber, 50, 120, { align: 'right' });
    doc.fontSize(9).font('Helvetica').fillColor('#64748b')
      .text(`Date: ${new Date(po.createdAt).toLocaleDateString()}`, 50, 145, { align: 'right' });
    if (po.expectedDeliveryDate) {
      doc.text(`Expected delivery: ${new Date(po.expectedDeliveryDate).toLocaleDateString()}`, 50, 158, { align: 'right' });
    }

    doc.y = 145;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#0f172a').text('Supplier', 50);
    doc.font('Helvetica').fillColor('#334155').text(supplier?.contactPerson || supplier?.name || '', 50);
    if (supplier?.name && supplier?.contactPerson) doc.text(supplier.name, 50);
    if (supplier?.email) doc.text(supplier.email, 50);
    if (supplier?.phone) doc.text(supplier.phone, 50);

    if (location?.name) {
      doc.moveUp(supplier?.phone ? 4 : supplier?.email ? 3 : 2);
      doc.font('Helvetica-Bold').fillColor('#0f172a').text('Deliver to', 350, doc.y);
      doc.font('Helvetica').fillColor('#334155').text(location.name, 350, doc.y, { width: 195 });
      // A location name alone ("Nairobi") isn't enough for a driver to actually find
      // it — the supplier needs the real address the same way they'd need one on any
      // delivery note.
      if (location.address) doc.text(location.address, 350, doc.y, { width: 195 });
    }

    doc.moveDown(2);
    doc.y = Math.max(doc.y, 210);
    hline(doc);

    // Table header — capture the y once and reuse it for all four columns; reading
    // doc.y fresh before each .text() call (the earlier bug here) reads an
    // already-advanced cursor after the previous column's text was written, staggering
    // the row downward one column at a time instead of keeping them level.
    const colX = { item: 50, qty: 300, cost: 380, total: 470 };
    const headerY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#64748b');
    doc.text('Item', colX.item, headerY, { width: 240 });
    doc.text('Qty', colX.qty, headerY, { width: 70, align: 'right' });
    doc.text('Unit Cost', colX.cost, headerY, { width: 80, align: 'right' });
    doc.text('Line Total', colX.total, headerY, { width: 80, align: 'right' });
    doc.y = headerY;
    doc.moveDown(0.9);
    hline(doc);

    let orderTotal = 0;
    for (const line of po.items) {
      const item = itemById[String(line.itemId)];
      const lineTotal = line.quantityOrdered * line.unitCost;
      orderTotal += lineTotal;
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#0f172a');
      doc.text(`${item?.name || 'Item'}${item?.sku ? ` (${item.sku})` : ''}`, colX.item, y, { width: 240 });
      doc.text(`${line.quantityOrdered} ${item?.unitOfMeasure || ''}`, colX.qty, y, { width: 70, align: 'right' });
      doc.text(line.unitCost.toLocaleString(), colX.cost, y, { width: 80, align: 'right' });
      doc.text(lineTotal.toLocaleString(), colX.total, y, { width: 80, align: 'right' });
      doc.moveDown(0.7);
    }

    hline(doc);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a')
      .text(`Order Total: ${(po.currency || 'KES')} ${orderTotal.toLocaleString()}`, colX.item, doc.y, { width: 500, align: 'right' });

    doc.moveDown(2);
    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
      .text('Please confirm receipt of this order and reference the PO number above on your invoice.', 50, doc.y, { width: 500 });

    doc.end();
  });
};

module.exports = { generatePurchaseOrderPDF };
