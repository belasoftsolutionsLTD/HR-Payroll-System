const { findOne, updateOne } = require('../Database/commonDBFunctions');

/**
 * Returns the next sequential integer for a given counter name.
 * The counters collection stores documents: { _id: <name>, seq: <number> }
 */
const getNextSequence = async (counterName) => {
  const result = await global.dbo.collection('counters').findOneAndUpdate(
    { _id: counterName },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return result.seq;
};

/**
 * Resets a counter to a given value (default 0).
 */
const resetCounter = async (counterName, value = 0) => {
  return updateOne('counters', { _id: counterName }, { $set: { seq: value } }, { upsert: true });
};

/**
 * Reads the current value of a counter without incrementing.
 */
const peekCounter = async (counterName) => {
  const doc = await findOne('counters', { _id: counterName });
  return doc ? doc.seq : 0;
};

module.exports = { getNextSequence, resetCounter, peekCounter };
