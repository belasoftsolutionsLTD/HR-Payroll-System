/**
 * Common MongoDB helper functions operating on global.dbo.
 */

const findOne = async (collection, query, options = {}) => {
  return global.dbo.collection(collection).findOne(query, options);
};

const findMany = async (collection, query, options = {}) => {
  return global.dbo.collection(collection).find(query, options).toArray();
};

const insertOne = async (collection, document) => {
  return global.dbo.collection(collection).insertOne(document);
};

const insertMany = async (collection, documents) => {
  return global.dbo.collection(collection).insertMany(documents);
};

const updateOne = async (collection, filter, update, options = {}) => {
  return global.dbo.collection(collection).updateOne(filter, update, options);
};

const updateMany = async (collection, filter, update, options = {}) => {
  return global.dbo.collection(collection).updateMany(filter, update, options);
};

const deleteOne = async (collection, filter) => {
  return global.dbo.collection(collection).deleteOne(filter);
};

const deleteMany = async (collection, filter) => {
  return global.dbo.collection(collection).deleteMany(filter);
};

const countDocuments = async (collection, query = {}) => {
  return global.dbo.collection(collection).countDocuments(query);
};

const aggregate = async (collection, pipeline) => {
  return global.dbo.collection(collection).aggregate(pipeline).toArray();
};

module.exports = {
  findOne,
  findMany,
  insertOne,
  insertMany,
  updateOne,
  updateMany,
  deleteOne,
  deleteMany,
  countDocuments,
  aggregate,
};
