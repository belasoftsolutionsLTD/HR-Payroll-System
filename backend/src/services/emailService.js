const nodemailer = require('nodemailer');
const logger = require('../lib/logger');
// Postgres migration (Phase 10 cross-cutting sweep) — users has been Postgres since
// Phase 1; this file's own unsubscribe check was still reading it off the Mongo helper,
// silently serving stale/frozen data (new users, and any unsubscribe-preference change,
// would never be seen) since that phase — same class of bug as reportFunctions.js's
// `feedback` staleness finding earlier this phase.
const { knex } = require('../functions/Database/pgDBFunctions');
const { generateUnsubscribeToken } = require('../lib/email/unsubscribeToken');

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

const unsubscribeFooter = (userId) => {
  const token = generateUnsubscribeToken(userId);
  const url = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/en/unsubscribe?uid=${userId}&token=${token}`;
  return `<p style="margin-top:24px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">
    You're receiving this because it's tied to your account. <a href="${url}" style="color:#94a3b8;">Unsubscribe from these emails</a>.
  </p>`;
};

/**
 * Send an email. Falls back to a warn log (never throws to the caller's core action)
 * if SMTP is not configured or the send itself fails.
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.text] - plain-text fallback; auto-derived from html if omitted
 * @param {Array}  [opts.attachments]
 * @param {boolean} [opts.bypassUnsubscribe] - account-critical mail (password reset,
 *   new-account credentials) that must always reach the recipient regardless of their
 *   notification preference — opting out of "Leave Approved" emails shouldn't cost
 *   someone the ability to recover a forgotten password.
 */
const sendEmail = async ({ to, subject, html, text, attachments = [], bypassUnsubscribe = false }) => {
  const t = getTransporter();
  if (!t) {
    logger.warn('Email not sent — SMTP not configured', { to, subject });
    return;
  }

  // Unsubscribe only applies to recipients who are actual system users (employees/HR) —
  // a supplier receiving a PO or a candidate receiving an application confirmation isn't
  // "subscribed" to anything, those are one-off transactional documents tied to an
  // action they themselves triggered, not a marketing/notification stream.
  let finalHtml = html;
  if (!bypassUnsubscribe) {
    const user = await knex('users').where({ email: String(to).toLowerCase().trim() }).select('id', 'unsubscribedFromEmails').first().catch(() => null);
    if (user) {
      if (user.unsubscribedFromEmails === true) {
        logger.info('Email skipped — recipient unsubscribed', { to, subject });
        return;
      }
      finalHtml = html + unsubscribeFooter(user.id);
    }
  }

  try {
    await t.sendMail({
      from: `"${process.env.COMPANY_NAME || 'Workfola'}" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html: finalHtml,
      text: text || htmlToText(finalHtml),
      attachments,
    });
  } catch (err) {
    logger.error('Email send failed', { to, subject, error: err.message });
    throw err;
  }
};

module.exports = { sendEmail };
