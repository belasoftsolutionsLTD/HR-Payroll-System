const { findOne } = require('../functions/Database/commonDBFunctions');
const { sendEmail } = require('./emailService');

const renderTemplate = (body, tokens) => body.replace(/\{\{(\w+)\}\}/g, (_, key) => tokens[key] ?? '');

// Looks up the saved emailTemplate for a given trigger (see emailTriggerCatalog.js for
// the full registered list) and sends it with token substitution. Falls back to the
// given subject/html if no template has been configured for that trigger yet — every
// call site works out of the box even before an admin customizes anything in Settings.
const sendTemplatedEmail = async ({ trigger, to, tokens, fallbackSubject, fallbackHtml, attachments }) => {
  if (!to) return;
  const template = await findOne('emailTemplates', { trigger });
  return sendEmail({
    to,
    subject: template ? renderTemplate(template.subject, tokens) : fallbackSubject,
    html: template ? renderTemplate(template.body, tokens) : fallbackHtml,
    ...(attachments ? { attachments } : {}),
  });
};

module.exports = { renderTemplate, sendTemplatedEmail };
