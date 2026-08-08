// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md) — the
// Knex singleton for every table that's been migrated off Mongo so far. Mirrors
// configs/dbConfig.js's role for global.dbo: one shared connection, required wherever
// it's needed, never re-instantiated per call site.
//
// Both this and dbConfig.js's Mongo connection run side by side for the entire build —
// only the specific tables/handlers rewritten so far (Phase 1: users, employees, and
// their supporting lookups) go through this file; everything else still goes through
// global.dbo until its own phase is built.

// node-postgres returns NUMERIC/DECIMAL columns as strings by default (it can't know
// whether a caller wants exact-decimal safety or a plain JS number) — every `t.decimal(...)`
// column in every phase's schema (quantities, money amounts, rates, ...) is affected.
// Found live during Phase 6 verification: getItemTotalStock's `sum + (l.quantity || 0)`
// silently string-concatenated ("0" + "50.0000" => "050.0000") instead of adding, because
// `l.quantity` came back as a string, not a number. Registering a global parser here (once,
// for every phase past/present/future, rather than Number()-wrapping every arithmetic call
// site across the whole codebase) converts NUMERIC (OID 1700) to a real JS float on the way
// out of every query. This trades a theoretical loss of exact-decimal precision beyond
// float64 for consistency with how this codebase already treats money everywhere else
// (plain JS numbers, rounded with round2() at write time) — matches the precision every
// other phase's decimal columns already assumed before this bug was caught.
const { types } = require('pg');
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const knexfile = require('../../../knexfile');

const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const knex = require('knex')(knexfile[environment]);

module.exports = knex;
