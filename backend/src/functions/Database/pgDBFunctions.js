// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md) — the
// Postgres-backed equivalent of commonDBFunctions.js, for tables that have been
// migrated off Mongo so far (Phase 1: users, employees, and their supporting lookups).
//
// This deliberately keeps the same function NAMES as commonDBFunctions.js so the two
// read the same way at a call site — but NOT the same call signature. Mongo's version
// is a razor-thin passthrough that accepts raw Mongo filter/update syntax ($set, $inc,
// $push, $gt, ...); there is no way to shim that onto SQL. Here `where` is always a
// plain equality object (Knex's own `.where({...})` shorthand — covers every simple
// lookup this codebase actually does, e.g. findOne('users', { email })), and `set` is
// a plain column/value object for the row's new values. Anything beyond plain equality
// (a $gt on an expiry date, an $nin on status, a JSONB containment check) is written
// directly against the exported `knex` instance in the handler — there's no shim for
// that either, by design (see the plan's investigation notes on why one wasn't built).

const { ObjectId } = require('mongodb');
const knex = require('./pgClient');

// Generates a Mongo-ObjectId-shaped id (24 hex chars), not a native Postgres
// UUID/serial — every id in this migration is deliberately kept in the same format
// Mongo already used (see the plan's "IDs stay as-is" decision), so a Postgres
// employees.id can still be written into a not-yet-migrated Mongo collection's
// employeeId field (e.g. leave_balances) during the straddling period without any
// format mismatch.
const newId = () => new ObjectId().toString();

// Every row this file hands back gets a `_id` alias added on top of Postgres' own
// `id` column — a real Mongo ObjectId instance wrapping that same hex string, not
// just a copy of the string. This exists purely for the ~50 not-yet-migrated files
// across the rest of the app that still read `.−_id`/`row._id` habitually (Mongo's
// own convention) off whatever a shared DB helper hands them, sometimes passing it
// straight into a Mongo filter or document field that expects a real ObjectId — see
// AuthMiddleware.js's req.user._id for the fuller explanation of why this is safe
// (ids were deliberately kept as unchanged ObjectId-hex strings across the whole
// migration). New, Postgres-aware code should prefer `.id` (the plain string); `._id`
// is a compatibility bridge for the straddling period, not the long-term API.
// Most ids are Mongo-ObjectId-hex strings and this aliasing "just works" — but a
// handful of deliberately hand-picked singleton keys (e.g. attendance_settings' own
// id, always the literal 'singleton') aren't ObjectId-shaped at all. Skip the alias
// rather than throw for those; nothing that reads a singleton row needs a Mongo `_id`
// on it anyway (no not-yet-migrated collection cross-references a settings row by id).
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const withMongoId = (row) => (row && row.id !== undefined && OBJECT_ID_RE.test(row.id) ? { ...row, _id: new ObjectId(row.id) } : row);
const withMongoIdMany = (rows) => rows.map(withMongoId);

const findOne = async (table, where = {}) => {
  const row = await knex(table).where(where).first();
  return withMongoId(row);
};

const findMany = async (table, where = {}, options = {}) => {
  let q = knex(table).where(where);
  if (options.orderBy) {
    const orderBy = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy];
    orderBy.forEach((o) => {
      if (typeof o === 'string') q = q.orderBy(o);
      else q = q.orderBy(o.column, o.order || 'asc');
    });
  }
  if (options.limit) q = q.limit(options.limit);
  if (options.offset) q = q.offset(options.offset);
  return withMongoIdMany(await q);
};

const insertOne = async (table, doc) => {
  const row = { id: doc.id || newId(), ...doc };
  const [inserted] = await knex(table).insert(row).returning('*');
  return withMongoId(inserted);
};

const insertMany = async (table, docs) => {
  if (!docs.length) return [];
  const rows = docs.map((d) => ({ id: d.id || newId(), ...d }));
  return withMongoIdMany(await knex(table).insert(rows).returning('*'));
};

const updateOne = async (table, where, set) => {
  const [updated] = await knex(table).where(where).update(set).returning('*');
  return withMongoId(updated);
};

const updateMany = async (table, where, set) => {
  return withMongoIdMany(await knex(table).where(where).update(set).returning('*'));
};

const deleteOne = async (table, where) => {
  return knex(table).where(where).del();
};

const deleteMany = async (table, where) => {
  return knex(table).where(where).del();
};

const countDocuments = async (table, where = {}) => {
  const [{ count }] = await knex(table).where(where).count('* as count');
  return Number(count);
};

// ── Child-table helpers ───────────────────────────────────────────────────────
// The Postgres equivalent of Mongo's $set-a-whole-embedded-array pattern
// (updateSkills, updateEmergencyContacts, etc.) — wholesale-replaces every row
// belonging to one parent inside a transaction, so a partial write never leaves a
// half-updated list visible to a concurrent read.
const replaceChildRows = async (table, foreignKeyColumn, foreignKeyValue, rows) => {
  return knex.transaction(async (trx) => {
    await trx(table).where({ [foreignKeyColumn]: foreignKeyValue }).del();
    if (rows.length) await trx(table).insert(rows);
  });
};

// The Postgres equivalent of Mongo's $push-onto-an-embedded-array (addCertification,
// addEducation, uploadDocument) — appends one child row and returns it.
const addChildRow = async (table, row) => {
  const withId = { id: row.id || newId(), ...row };
  const [inserted] = await knex(table).insert(withId).returning('*');
  return withMongoId(inserted);
};

// The Postgres equivalent of Mongo's $pull-from-an-embedded-array (deleteCertification,
// deleteEducation) — removes one child row by its own id, scoped to the parent so one
// employee can never delete another's row by guessing an id.
const deleteChildRow = async (table, foreignKeyColumn, foreignKeyValue, id) => {
  return knex(table).where({ [foreignKeyColumn]: foreignKeyValue, id }).del();
};

module.exports = {
  knex,
  newId,
  findOne,
  findMany,
  insertOne,
  insertMany,
  updateOne,
  updateMany,
  deleteOne,
  deleteMany,
  countDocuments,
  replaceChildRows,
  addChildRow,
  deleteChildRow,
};
