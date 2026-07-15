const returnFunction = require('../../functions/returnFunction');

// No hardcoded defaults on purpose — HR sets every multiplier themselves (per explicit
// request). Until configured, overtime falls back to a flat 1x (i.e. no premium applied)
// rather than silently assuming a rate nobody chose.
const DEFAULT_OVERTIME_CONFIG = {
  nightStart: '22:00',
  nightEnd: '06:00',
  weekdayDayRate: 1,
  weekdayNightRate: 1,
  weekendDayRate: 1,
  weekendNightRate: 1,
};

const getOvertimeConfig = async (req, res) => {
  const cfg = await global.dbo.collection('overtime_config').findOne({});
  return returnFunction(res, 200, true, 'OK', cfg || DEFAULT_OVERTIME_CONFIG);
};

const updateOvertimeConfig = async (req, res) => {
  const { nightStart, nightEnd, weekdayDayRate, weekdayNightRate, weekendDayRate, weekendNightRate } = req.body;

  const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!timePattern.test(nightStart) || !timePattern.test(nightEnd)) {
    return returnFunction(res, 400, false, 'nightStart and nightEnd must be HH:MM.');
  }
  const rates = { weekdayDayRate, weekdayNightRate, weekendDayRate, weekendNightRate };
  for (const [key, val] of Object.entries(rates)) {
    if (val == null || isNaN(parseFloat(val)) || parseFloat(val) < 0) {
      return returnFunction(res, 400, false, `${key} must be a non-negative number.`);
    }
  }

  const doc = {
    nightStart, nightEnd,
    weekdayDayRate: parseFloat(weekdayDayRate),
    weekdayNightRate: parseFloat(weekdayNightRate),
    weekendDayRate: parseFloat(weekendDayRate),
    weekendNightRate: parseFloat(weekendNightRate),
    updatedAt: new Date(),
  };

  const existing = await global.dbo.collection('overtime_config').findOne({});
  if (existing) {
    await global.dbo.collection('overtime_config').replaceOne({}, doc);
  } else {
    await global.dbo.collection('overtime_config').insertOne(doc);
  }

  return returnFunction(res, 200, true, 'Overtime rate configuration saved.', doc);
};

module.exports = { getOvertimeConfig, updateOvertimeConfig, DEFAULT_OVERTIME_CONFIG };
