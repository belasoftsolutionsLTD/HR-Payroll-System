const { MongoClient } = require('mongodb');

const connectDB = async () => {
  try {
    const client = new MongoClient(process.env.MONGO_DB_URI);
    await client.connect();

    const db = client.db('school-erp');

    global.dbo = db;
    global.mongoClient = client;

    console.log('MongoDB connected — school-erp');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
