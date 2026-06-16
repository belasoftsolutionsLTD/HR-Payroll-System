const generateStaffNumber = async (hireYear) => {
  const counterName = `staff_number_${hireYear}`;
  const result = await global.dbo.collection('counters').findOneAndUpdate(
    { _id: counterName },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return `STF-${hireYear}-${String(result.seq).padStart(4, '0')}`;
};

module.exports = { generateStaffNumber };
