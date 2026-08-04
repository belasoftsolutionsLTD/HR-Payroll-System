const nodemailer = require('nodemailer');
const logger = require('../lib/logger');

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_SECURE === 'true',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
  });
  return transporter;
};

// Strips tags for a readable plain-text fallback when a caller doesn't supply one —
// every email needs a text part (some clients/spam filters penalize HTML-only mail),
// but most call sites only ever compose HTML, so this keeps that the common case.
const htmlToText = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/**
 * Send an email. Falls back to a warn log (never throws to the caller's core action)
 * if SMTP is not configured or the send itself fails.
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.text] - plain-text fallback; auto-derived from html if omitted
 * @param {Array}  [opts.attachments]
 */
const sendEmail = async ({ to, subject, html, text, attachments = [] }) => {
  const t = getTransporter();
  if (!t) {
    logger.warn('Email not sent — SMTP not configured', { to, subject });
    return;
  }
  try {
    await t.sendMail({
      from: `"${process.env.COMPANY_NAME || 'Bela ERP'}" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
      text: text || htmlToText(html),
      attachments,
    });
  } catch (err) {
    logger.error('Email send failed', { to, subject, error: err.message });
    throw err;
  }
};

module.exports = { sendEmail };
