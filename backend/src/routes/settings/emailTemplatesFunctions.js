const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 4) — email_templates now lives in Postgres, shared with recruitment's own
// direct _id-keyed CRUD (recruitmentFunctions.js) on the same table.
const { findOne, findMany, insertOne, updateOne, deleteOne, newId } = require('../../functions/Database/pgDBFunctions');
const { getTriggerCatalog, getTriggerDefinition } = require('../../lib/email/emailTriggerCatalog');

// Merges the registered trigger's default copy with whatever override (if any) is
// saved in the email_templates table — the UI always has something real to show,
// and can tell the difference between "default" and "customized" via isCustomized.
const mergeTemplate = (def, override) => ({
  trigger: def.id,
  label: def.label,
  description: def.description,
  module: def.module,
  tokens: def.tokens,
  subject: override?.subject ?? def.defaultSubject,
  body: override?.body ?? def.defaultBody,
  defaultSubject: def.defaultSubject,
  defaultBody: def.defaultBody,
  isCustomized: Boolean(override),
  updatedAt: override?.updatedAt ?? null,
});

const listEmailTemplates = async (req, res) => {
  const catalog = getTriggerCatalog();
  const overrides = await findMany('email_templates', {});
  const overrideByTrigger = Object.fromEntries(overrides.map((o) => [o.trigger, o]));
  const merged = catalog.map((def) => mergeTemplate(def, overrideByTrigger[def.id]));
  return returnFunction(res, 200, true, req.locale.success, merged);
};

const getEmailTemplate = async (req, res) => {
  const def = getTriggerDefinition(req.params.trigger);
  if (!def) return returnFunction(res, 404, false, 'Unknown email trigger.');
  const override = await findOne('email_templates', { trigger: def.id });
  return returnFunction(res, 200, true, req.locale.success, mergeTemplate(def, override));
};

// No UNIQUE(trigger) constraint on email_templates (see the migration file's own
// comment — Mongo never enforced one either, and recruitment's own createEmailTemplate
// has no such check), so this is a manual findOne-then-insert/update rather than a
// DB-level ON CONFLICT, same idiom as attendance_settings' saveSettings in Phase 3b.
const upsertEmailTemplate = async (req, res) => {
  const def = getTriggerDefinition(req.params.trigger);
  if (!def) return returnFunction(res, 404, false, 'Unknown email trigger.');
  if (!validateRequiredFields(req, res, ['subject', 'body'])) return;

  const existing = await findOne('email_templates', { trigger: def.id });
  const now = new Date();
  if (existing) {
    await updateOne('email_templates', { id: existing.id }, { subject: req.body.subject, body: req.body.body, updatedAt: now, updatedBy: req.user.id });
  } else {
    await insertOne('email_templates', { id: newId(), trigger: def.id, subject: req.body.subject, body: req.body.body, updatedAt: now, updatedBy: req.user.id, createdAt: now });
  }
  const override = await findOne('email_templates', { trigger: def.id });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, mergeTemplate(def, override));
};

// Deletes the override so the trigger reverts to its registered default — not a
// destructive "delete the trigger," since triggers are code-registered, not DB rows.
const resetEmailTemplate = async (req, res) => {
  const def = getTriggerDefinition(req.params.trigger);
  if (!def) return returnFunction(res, 404, false, 'Unknown email trigger.');
  await deleteOne('email_templates', { trigger: def.id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Reset to default.', mergeTemplate(def, null));
};

module.exports = { listEmailTemplates, getEmailTemplate, upsertEmailTemplate, resetEmailTemplate };
