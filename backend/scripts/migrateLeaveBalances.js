/**
 * One-shot migration: add missing compassionate (3d) and study (5d) leave
 * types to every leave_balances document that lacks them.
 *
 * Run once: node backend/scripts/migrateLeaveBalances.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.MONGO_URI || process.env.MONGO_DB_URI);
  await client.connect();
  const db = client.db(process.env.MONGO_DB_NAME || 'school-erp');

  const collection = db.collection('leave_balances');
  const cursor = collection.find({});

  let updated = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const patch = {};

    if (!doc.balances?.compassionate) {
      patch['balances.compassionate'] = { allocated: 3, used: 0, remaining: 3 };
    }
    if (!doc.balances?.study) {
      patch['balances.study'] = { allocated: 5, used: 0, remaining: 5 };
    }

    if (Object.keys(patch).length) {
      await collection.updateOne({ _id: doc._id }, { $set: patch });
      updated++;
    }
  }

  console.log(`Migration complete. Updated ${updated} leave_balances document(s).`);
  await client.close();
})().catch(err => { console.error(err); process.exit(1); });
