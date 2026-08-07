// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md) — the
// Knex singleton for every table that's been migrated off Mongo so far. Mirrors
// configs/dbConfig.js's role for global.dbo: one shared connection, required wherever
// it's needed, never re-instantiated per call site.
//
// Both this and dbConfig.js's Mongo connection run side by side for the entire build —
// only the specific tables/handlers rewritten so far (Phase 1: users, employees, and
// their supporting lookups) go through this file; everything else still goes through
// global.dbo until its own phase is built.

const knexfile = require('../../../knexfile');

const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const knex = require('knex')(knexfile[environment]);

module.exports = knex;
