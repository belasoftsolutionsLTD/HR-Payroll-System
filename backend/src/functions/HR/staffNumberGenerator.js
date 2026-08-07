// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md, Phase 1) —
// the plan's documented pattern for every Mongo `findOneAndUpdate($inc, upsert)` counter:
// an atomic `INSERT ... ON CONFLICT ... DO UPDATE SET seq = seq + 1 RETURNING *`. Same
// exact behavior as the old `counters` collection (composite string key -> integer seq),
// just expressed as a real upsert instead of a Mongo-specific findOneAndUpdate.
const knex = require('../../functions/Database/pgClient');

const generateStaffNumber = async (hireYear) => {
  const counterName = `staff_number_${hireYear}`;
  const [row] = await knex('counters')
    .insert({ id: counterName, seq: 1 })
    .onConflict('id')
    .merge({ seq: knex.raw('"counters"."seq" + 1') })
    .returning('*');
  return `STF-${hireYear}-${String(row.seq).padStart(4, '0')}`;
};

module.exports = { generateStaffNumber };
