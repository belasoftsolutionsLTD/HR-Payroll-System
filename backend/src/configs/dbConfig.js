const { MongoClient } = require('mongodb');

// Postgres migration — as of Phase 11, every live collection has a Postgres
// equivalent and no route handler touches `global.dbo` for real functionality
// anymore (only initIndexes.js's index setup on now-dead legacy collections,
// which already no-ops if `global.dbo` is unset). Mongo stays reachable here
// as a deliberate fallback through cutover (Phase 12) and for ~30 days after,
// per the migration plan — but a missing/unreachable Mongo connection should
// no longer be fatal to booting the app, since nothing left actually needs it.
const connectDB = async () => {
  try {
    const client = new MongoClient(process.env.MONGO_DB_URI);
    await client.connect();

    const db = client.db('school-erp');

    global.dbo = db;
    global.mongoClient = client;

    console.log('MongoDB connected — school-erp');
  } catch (err) {
    console.warn('MongoDB connection failed — continuing without it (Postgres is the live datastore now):', err.message);
  }
};

module.exports = connectDB;
