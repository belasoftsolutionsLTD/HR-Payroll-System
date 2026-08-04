const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, updateOne, deleteOne } = require('../../functions/Database/commonDBFunctions');
const { getTriggerCatalog, getTriggerDefinition } = require('../../lib/email/emailTriggerCatalog');

// Merges the registered trigger's default copy with whatever override (if any) is
// saved in the emailTemplates collection — the UI always has something real to show,
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
  const overrides = await findMany('emailTemplates', { trigger: { $in: catalog.map((t) => t.id) } }, {});
  const overrideByTrigger = Object.fromEntries(overrides.map((o) => [o.trigger, o]));
  const merged = catalog.map((def) => mergeTemplate(def, overrideByTrigger[def.id]));
  return returnFunction(res, 200, true, req.locale.success, merged);
};

const getEmailTemplate = async (req, res) => {
  const def = getTriggerDefinition(req.params.trigger);
  if (!def) return returnFunction(res, 404, false, 'Unknown email trigger.');
  const override = await findOne('emailTemplates', { trigger: def.id });
  return returnFunction(res, 200, true, req.locale.success, mergeTemplate(def, override));
};

const upsertEmailTemplate = async (req, res) => {
  const def = getTriggerDefinition(req.params.trigger);
  if (!def) return returnFunction(res, 404, false, 'Unknown email trigger.');
  if (!validateRequiredFields(req, res, ['subject', 'body'])) return;

  await updateOne(
    'emailTemplates',
    { trigger: def.id },
    { $set: { trigger: def.id, subject: req.body.subject, body: req.body.body, updatedAt: new Date(), updatedBy: req.user._id } },
    { upsert: true }
  );
  const override = await findOne('emailTemplates', { trigger: def.id });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, mergeTemplate(def, override));
};

// Deletes the override so the trigger reverts to its registered default — not a
// destructive "delete the trigger," since triggers are code-registered, not DB rows.
const resetEmailTemplate = async (req, res) => {
  const def = getTriggerDefinition(req.params.trigger);
  if (!def) return returnFunction(res, 404, false, 'Unknown email trigger.');
  await deleteOne('emailTemplates', { trigger: def.id });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Reset to default.', mergeTemplate(def, null));
};

module.exports = { listEmailTemplates, getEmailTemplate, upsertEmailTemplate, resetEmailTemplate };
