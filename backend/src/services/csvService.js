const fs = require('fs');

const VALID_STATUSES = ['present', 'absent', 'late', 'half_day', 'remote'];

const parseAttendanceCSV = (filePath) => {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return { validRows: [], invalidRows: [] };

  const rawHeaders = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, ''));
  const validRows = [];
  const invalidRows = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map((v) => v.trim());
    const row = {};
    rawHeaders.forEach((h, idx) => { row[h] = vals[idx] || ''; });

    const staffNumber = row.staffnumber || row.staff_number || '';
    const date = row.date || '';
    const status = (row.status || '').toLowerCase();
    const errors = [];

    if (!staffNumber) errors.push('Missing staffNumber');
    if (!date) errors.push('Missing date');
    if (!status) errors.push('Missing status');
    else if (!VALID_STATUSES.includes(status)) errors.push(`Invalid status: ${status}`);

    const normalized = {
      staffNumber,
      date,
      status,
      checkInTime: row.checkintime || row.check_in_time || null,
      checkOutTime: row.checkouttime || row.check_out_time || null,
      notes: row.notes || '',
    };

    if (errors.length) invalidRows.push({ row: i, data: normalized, reason: errors.join('; ') });
    else validRows.push(normalized);
  }

  return { validRows, invalidRows };
};

module.exports = { parseAttendanceCSV };
