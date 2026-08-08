// Postgres migration (Phase 10 cross-cutting sweep) — `users.unsubscribedFromEmails`
// was referenced by already-existing Postgres code (publicRoutes.js's unsubscribe-token
// GET/POST routes, added back in Phase 4) but the column was never actually added to
// Phase 1's original `users` table migration — a real, live schema gap (the unsubscribe
// write would throw "column does not exist"), found while fixing emailService.js's own
// stale-Mongo-read bug for the same field. Phase 1's migration file is already shipped/
// applied, so this is a small additive follow-up rather than an edit to that file.
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.boolean('unsubscribedFromEmails').defaultTo(false);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('unsubscribedFromEmails');
  });
};
