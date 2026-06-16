const mainLocale = require('../locale/mainLocale');
const { defaultLocale } = require('../configs/constants');

/**
 * Reads the Accept-Language header (or x-locale custom header) and attaches
 * the matching locale strings to req.locale.
 * Falls back to the default locale when the requested one is unsupported.
 */
const LocaleMiddleware = (req, res, next) => {
  const requested =
    req.headers['x-locale'] ||
    (req.headers['accept-language'] || '').split(',')[0].split('-')[0].toLowerCase();

  const lang = mainLocale[requested] ? requested : defaultLocale;
  req.locale = mainLocale[lang];
  req.lang = lang;
  next();
};

module.exports = LocaleMiddleware;
