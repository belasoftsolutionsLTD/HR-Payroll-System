// Reusable tax calculator driven by a config document from `tax_config` collection.
// Rates in config are stored as PERCENTAGES (e.g. 10 = 10%), converted to decimals here.

const { calcBracketAmount } = require('./bracketCalculator');

const KENYA_DEFAULT = {
  currency: 'KES',
  currencySymbol: 'KES',
  incomeTax: {
    name: 'PAYE',
    enabled: true,
    deductPensionFirst: true,
    personalRelief: 2400,
    brackets: [
      { limit: 24000,  rate: 10   },
      { limit: 8333,   rate: 25   },
      { limit: 467667, rate: 30   },
      { limit: 300000, rate: 32.5 },
      { limit: null,   rate: 35   },
    ],
  },
  statutoryDeductions: [
    {
      key: 'pension',
      name: 'NSSF',
      enabled: true,
      type: 'tiered_cap',
      // Tier I / Tier II limits per the NSSF Act 2013 phased schedule — last confirmed
      // step is the Feb 2025 revision (LEL 8,000 / UEL 72,000). Verify against current
      // NSSF/KRA guidance before relying on this for a real payroll run; these limits
      // are legislated to step up further and this default won't auto-update.
      tiers: [
        { limit: 8000,  rate: 6 },
        { limit: 64000, rate: 6 },
      ],
      cap: null,
    },
    {
      key: 'health',
      name: 'SHA',
      enabled: true,
      type: 'flat_rate',
      rate: 2.75,
      cap: null,
      minAmount: 300,
    },
    {
      key: 'housing_levy',
      name: 'Affordable Housing Levy',
      enabled: true,
      type: 'flat_rate',
      rate: 1.5,
      cap: null,
    },
  ],
};

const calcStatutory = (gross, cfg) => {
  if (!cfg || !cfg.enabled) return 0;

  if (cfg.type === 'flat_rate') {
    let amount = gross * (cfg.rate / 100);
    if (cfg.cap) amount = Math.min(amount, cfg.cap);
    // A statutory minimum (e.g. SHA's KES 300/month floor) applies even to employees
    // whose percentage-calculated amount would fall below it — but never to someone
    // with zero gross pay, since there's nothing to withhold from in that cycle.
    if (cfg.minAmount && gross > 0) amount = Math.max(amount, cfg.minAmount);
    return Math.round(amount * 100) / 100;
  }

  if (cfg.type === 'tiered_cap') {
    let total = 0;
    let rem   = gross;
    for (const tier of (cfg.tiers || [])) {
      if (rem <= 0) break;
      const t = Math.min(rem, tier.limit);
      total  += t * (tier.rate / 100);
      rem    -= t;
    }
    return Math.round((cfg.cap ? Math.min(total, cfg.cap) : total) * 100) / 100;
  }

  if (cfg.type === 'fixed_amount') {
    return Math.round((cfg.amount || 0) * 100) / 100;
  }

  return 0;
};

/**
 * Build a set of calculator functions from a tax config object.
 * Falls back to Kenya defaults if config is null/undefined.
 */
const buildCalculator = (config) => {
  const cfg = config || KENYA_DEFAULT;

  const pensionCfg     = (cfg.statutoryDeductions || []).find(d => d.key === 'pension');
  const healthCfg      = (cfg.statutoryDeductions || []).find(d => d.key === 'health');
  const housingLevyCfg = (cfg.statutoryDeductions || []).find(d => d.key === 'housing_levy')
    // Always default to 1.5% — statutory requirement in Kenya (Affordable Housing Act)
    ?? { key: 'housing_levy', name: 'Affordable Housing Levy', enabled: true, type: 'flat_rate', rate: 1.5, cap: null };

  const calcPension     = (gross) => calcStatutory(gross, pensionCfg);
  const calcHealth      = (gross) => calcStatutory(gross, healthCfg);
  const calcHousingLevy = (gross) => calcStatutory(gross, housingLevyCfg);

  const calcIncomeTax = (gross) => {
    const itCfg = cfg.incomeTax;
    if (!itCfg?.enabled) return 0;

    let taxable = gross;
    if (itCfg.deductPensionFirst) {
      taxable = Math.max(0, gross - calcPension(gross));
    }

    const tax = calcBracketAmount(taxable, itCfg.brackets || []);
    return Math.round(Math.max(0, tax - (itCfg.personalRelief || 0)) * 100) / 100;
  };

  // Additional statutory deductions beyond the three named ones
  const calcExtraStatutory = (gross) =>
    (cfg.statutoryDeductions || [])
      .filter(d => !['pension', 'health', 'housing_levy'].includes(d.key))
      .map(d => ({ key: d.key, name: d.name, amount: calcStatutory(gross, d) }));

  return {
    calcPension,
    calcHealth,
    calcHousingLevy,
    calcIncomeTax,
    calcExtraStatutory,
    currency:         cfg.currency || 'KES',
    currencySymbol:   cfg.currencySymbol || 'KES',
    incomeTaxName:    cfg.incomeTax?.name || 'PAYE',
    pensionName:      pensionCfg?.name     || 'NSSF',
    healthName:       healthCfg?.name      || 'SHA',
    housingLevyName:  housingLevyCfg.name  || 'Affordable Housing Levy',
  };
};

/**
 * Load tax config from DB, fall back to Kenya defaults.
 */
const loadTaxConfig = async () => {
  try {
    const cfg = await global.dbo.collection('tax_config').findOne({});
    return cfg || KENYA_DEFAULT;
  } catch {
    return KENYA_DEFAULT;
  }
};

module.exports = { buildCalculator, loadTaxConfig, KENYA_DEFAULT };
