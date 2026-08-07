// Phase 0 sanity check — proves the Knex → Postgres pipeline actually works
// (connection, migration tracking, up/down) before any real schema gets built.
// Safe to leave in place; it's a real (tiny) migration like any other, not a
// throwaway to delete.

/** @param { import("knex").Knex } knex */
exports.up = async function (knex) {
  await knex.schema.createTable('_phase0_verify', (table) => {
    table.text('id').primary();
    table.text('note');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('_phase0_verify');
};
