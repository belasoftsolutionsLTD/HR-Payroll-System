// Reusable tax calculator driven by a config document from `tax_config` collection.
// Rates in config are stored as PERCENTAGES (e.g. 10 = 10%), converted to decimals here.

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
      tiers: [
        { limit: 7000,  rate: 6 },
        { limit: 29000, rate: 6 },
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
    },
  ],
};

const calcStatutory = (gross, cfg) => {
  if (!cfg || !cfg.enabled) return 0;

  if (cfg.type === 'flat_rate') {
    const amount = gross * (cfg.rate / 100);
    return Math.round((cfg.cap ? Math.min(amount, cfg.cap) : amount) * 100) / 100;
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

  const pensionCfg = (cfg.statutoryDeductions || []).find(d => d.key === 'pension');
  const healthCfg  = (cfg.statutoryDeductions || []).find(d => d.key === 'health');

  const calcPension = (gross) => calcStatutory(gross, pensionCfg);
  const calcHealth  = (gross) => calcStatutory(gross, healthCfg);

  const calcIncomeTax = (gross) => {
    const itCfg = cfg.incomeTax;
    if (!itCfg?.enabled) return 0;

    let taxable = gross;
    if (itCfg.deductPensionFirst) {
      taxable = Math.max(0, gross - calcPension(gross));
    }

    let tax = 0;
    let rem = taxable;
    for (const b of (itCfg.brackets || [])) {
      if (rem <= 0) break;
      const r = b.rate / 100;
      if (b.limit) {
        const t = Math.min(rem, b.limit);
        tax += t * r;
        rem -= t;
      } else {
        tax += rem * r;
        rem  = 0;
      }
    }
    return Math.round(Math.max(0, tax - (itCfg.personalRelief || 0)) * 100) / 100;
  };

  // Any additional statutory deductions beyond pension & health
  const calcExtraStatutory = (gross) =>
    (cfg.statutoryDeductions || [])
      .filter(d => d.key !== 'pension' && d.key !== 'health')
      .map(d => ({ key: d.key, name: d.name, amount: calcStatutory(gross, d) }));

  return {
    calcPension,
    calcHealth,
    calcIncomeTax,
    calcExtraStatutory,
    currency: cfg.currency || 'KES',
    currencySymbol: cfg.currencySymbol || 'KES',
    incomeTaxName: cfg.incomeTax?.name || 'PAYE',
    pensionName:   pensionCfg?.name || 'NSSF',
    healthName:    healthCfg?.name  || 'SHA',
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
