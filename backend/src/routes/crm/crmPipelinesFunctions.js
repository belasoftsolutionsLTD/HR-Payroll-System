// Postgres migration (Phase 7) — crm_pipelines/crm_deals are Postgres now. stages stays
// JSONB (whole-replaced) — see the migration file's header for why it isn't a child
// table despite each stage having its own stable id.
const { knex, newId } = require('../../functions/Database/pgDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { getCrmAccessLevel } = require('../../lib/crm/crmAccess');

// Pipeline stages are fully configurable per business (add/remove/reorder, rename) —
// nothing about stage names is hardcoded anywhere else in this module. A stage carries
// isWon/isLost flags so "what counts as won" is a per-business configuration choice too,
// not an assumption baked into the code (e.g. a business might name their final stage
// "Signed" or "Closed" instead of "Won").
const DEFAULT_STAGES = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'];

// Same 8-hex categorical palette validated this session (scripts/validate_palette.js,
// light-mode card surface, all checks passing) — reused here so a stage always gets a
// distinct, colorblind-checked color with zero required setup, assigned by fixed index
// order (never cycled/re-randomized) so a stage's color stays stable across saves.
const STAGE_COLOR_PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#84cc16'];

const normalizeStages = (stages) => stages.map((s, i) => ({
  id: s.id || newId(),
  name: String(s.name).trim(),
  order: i,
  isWon: Boolean(s.isWon),
  isLost: Boolean(s.isLost),
  color: s.color || STAGE_COLOR_PALETTE[i % STAGE_COLOR_PALETTE.length],
}));

const listPipelines = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const pipelines = await knex('crm_pipelines').whereNot({ isActive: false }).orderBy('isDefault', 'desc').orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, pipelines);
};

const createPipeline = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['name'])) return;

  const rawStages = Array.isArray(req.body.stages) && req.body.stages.length
    ? req.body.stages
    : DEFAULT_STAGES.map((name) => ({ name, isWon: name === 'Won', isLost: name === 'Lost' }));

  const [{ count: existingCount }] = await knex('crm_pipelines').whereNot({ isActive: false }).count('* as count');
  const doc = {
    id: newId(),
    name: req.body.name.trim(),
    stages: JSON.stringify(normalizeStages(rawStages)),
    isDefault: Number(existingCount) === 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const [saved] = await knex('crm_pipelines').insert(doc).returning('*');
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, saved);
};

const updatePipeline = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  const pipeline = await knex('crm_pipelines').where({ id: req.params.id }).first();
  if (!pipeline) return returnFunction(res, 404, false, req.locale.notFound);

  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (Array.isArray(req.body.stages) && req.body.stages.length) update.stages = JSON.stringify(normalizeStages(req.body.stages));
  await knex('crm_pipelines').where({ id: pipeline.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deletePipeline = async (req, res) => {
  const level = await getCrmAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  const [{ count: inUse }] = await knex('crm_deals').where({ pipelineId: req.params.id }).count('* as count');
  if (Number(inUse) > 0) return returnFunction(res, 400, false, `${inUse} deal(s) still use this pipeline — move or close them first.`);
  await knex('crm_pipelines').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

module.exports = { listPipelines, createPipeline, updatePipeline, deletePipeline, DEFAULT_STAGES };
