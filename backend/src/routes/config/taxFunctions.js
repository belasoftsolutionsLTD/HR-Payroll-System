const returnFunction = require('../../functions/returnFunction');
const { KENYA_DEFAULT } = require('../../functions/taxCalculator');

const getTaxConfig = async (req, res) => {
  const cfg = await global.dbo.collection('tax_config').findOne({});
  return returnFunction(res, 200, true, 'OK', cfg || KENYA_DEFAULT);
};

const updateTaxConfig = async (req, res) => {
  const { currency, currencySymbol, incomeTax, statutoryDeductions } = req.body;

  if (!currency) return returnFunction(res, 400, false, 'currency is required.');
  if (!incomeTax || !Array.isArray(incomeTax.brackets))
    return returnFunction(res, 400, false, 'incomeTax.brackets array is required.');

  const doc = {
    currency:              currency.trim(),
    currencySymbol:        (currencySymbol || currency).trim(),
    incomeTax: {
      name:              (incomeTax.name || 'Income Tax').trim(),
      enabled:           incomeTax.enabled !== false,
      deductPensionFirst: incomeTax.deductPensionFirst !== false,
      personalRelief:    parseFloat(incomeTax.personalRelief) || 0,
      brackets:          (incomeTax.brackets || []).map(b => ({
        limit: b.limit ? parseFloat(b.limit) : null,
        rate:  parseFloat(b.rate),
      })),
    },
    statutoryDeductions: (statutoryDeductions || []).map(d => {
      const base = {
        key:     d.key?.trim() || 'custom_' + Date.now(),
        name:    (d.name || 'Deduction').trim(),
        enabled: d.enabled !== false,
        type:    d.type || 'flat_rate',
        cap:     d.cap ? parseFloat(d.cap) : null,
      };
      if (d.type === 'flat_rate') base.rate = parseFloat(d.rate) || 0;
      if (d.type === 'tiered_cap') base.tiers = (d.tiers || []).map(t => ({ limit: parseFloat(t.limit), rate: parseFloat(t.rate) }));
      if (d.type === 'fixed_amount') base.amount = parseFloat(d.amount) || 0;
      return base;
    }),
    updatedAt: new Date(),
  };

  const existing = await global.dbo.collection('tax_config').findOne({});
  if (existing) {
    await global.dbo.collection('tax_config').replaceOne({}, doc);
  } else {
    await global.dbo.collection('tax_config').insertOne(doc);
  }

  return returnFunction(res, 200, true, 'Tax configuration saved.', doc);
};

module.exports = { getTaxConfig, updateTaxConfig };
