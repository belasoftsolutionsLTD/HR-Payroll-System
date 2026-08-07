// Postgres migration tooling (see /home/carole/.claude/plans/abundant-dreaming-flurry.md
// for the full strategy). This file configures Knex for both local dev and production —
// production only ever gets pointed at real data at the final cutover (Phase 12); until
// then this connects to a local/dev Postgres instance loaded from a copy of real data,
// never the live app's actual database.
require('dotenv').config();

const base = {
  client: 'pg',
  migrations: {
    directory: './migrations',
    tableName: 'knex_migrations',
  },
};

module.exports = {
  development: {
    ...base,
    // Port 5433, not 5432 — see DATABASE_URL's comment in .env.example.
    connection: process.env.DATABASE_URL || 'postgres://localhost:5433/workfola_dev',
  },
  production: {
    ...base,
    connection: process.env.DATABASE_URL,
    pool: { min: 2, max: 10 },
  },
};
