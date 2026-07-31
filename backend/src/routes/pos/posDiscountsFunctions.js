const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');

// Promo codes are optional and configured per business (not every industry using Bella
// ERP needs them) — a plain admin-managed lookup, resolved at checkout time by code.

const listPromoCodes = async (req, res) => {
  // Plain listing (admin Settings panel) shows everything, including inactive/expired
  // codes, so they can still be managed/deleted. ?activeOnly=true is for the checkout
  // screen — a cashier should only ever be shown codes that would actually apply.
  const filter = req.query.activeOnly === 'true'
    ? { isActive: { $ne: false }, $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }] }
    : {};
  const codes = await findMany('pos_promo_codes', filter, { sort: { code: 1 } });
  return returnFunction(res, 200, true, req.locale.success, codes);
};

const createPromoCode = async (req, res) => {
  if (!validateRequiredFields(req, res, ['code', 'discountType', 'discountValue'])) return;
  if (!['percentage', 'fixed'].includes(req.body.discountType)) {
    return returnFunction(res, 400, false, "discountType must be 'percentage' or 'fixed'.");
  }
  const code = req.body.code.trim().toUpperCase();
  const existing = await findOne('pos_promo_codes', { code });
  if (existing) return returnFunction(res, 409, false, 'A promo code with this code already exists.');

  const doc = {
    code,
    discountType: req.body.discountType,
    discountValue: Number(req.body.discountValue),
    expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('pos_promo_codes', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updatePromoCode = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.discountType !== undefined) update.discountType = req.body.discountType;
  if (req.body.discountValue !== undefined) update.discountValue = Number(req.body.discountValue);
  if (req.body.expiresAt !== undefined) update.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await updateOne('pos_promo_codes', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deletePromoCode = async (req, res) => {
  await updateOne('pos_promo_codes', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// Used both by the checkout route (server-side, authoritative) and by a small
// "apply code" lookup the register screen can call for instant feedback.
const resolvePromoCode = async (rawCode) => {
  if (!rawCode) return null;
  const code = await findOne('pos_promo_codes', { code: String(rawCode).trim().toUpperCase(), isActive: { $ne: false } });
  if (!code) return null;
  if (code.expiresAt && code.expiresAt < new Date()) return null;
  return code;
};

const checkPromoCode = async (req, res) => {
  const code = await resolvePromoCode(req.params.code);
  if (!code) return returnFunction(res, 404, false, 'Invalid or expired promo code.');
  return returnFunction(res, 200, true, req.locale.success, code);
};

module.exports = { listPromoCodes, createPromoCode, updatePromoCode, deletePromoCode, resolvePromoCode, checkPromoCode };
