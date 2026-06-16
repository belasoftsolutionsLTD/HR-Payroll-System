const nodemailer = require('nodemailer');

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
};

/**
 * Send an email. Falls back to console.log if SMTP is not configured.
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {Array}  [opts.attachments]
 */
const sendEmail = async ({ to, subject, html, attachments = [] }) => {
  const t = getTransporter();
  if (!t) {
    console.log(`[EMAIL - not configured] To: ${to} | Subject: ${subject}`);
    return;
  }
  await t.sendMail({
    from: `"${process.env.COMPANY_NAME || 'School ERP'}" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    attachments,
  });
};

module.exports = { sendEmail };
