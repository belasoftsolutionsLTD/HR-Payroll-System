const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');

// Vouchers are company-funded (the business pays for them, e.g. a promotional giveaway
// or a goodwill gesture) — kept in a separate collection from pos_promo_codes so their
// redemption amount is never folded into ordinary margin-discount reporting. Unlike a
// promo code (reusable by anyone, any number of times until deactivated), a voucher is
// single-use: it's marked redeemed on the sale that consumes it and excluded from
// listings afterward.

const listVouchers = async (req, res) => {
  // Plain listing (admin Settings panel) shows everything, including redeemed/expired
  // vouchers, so they stay auditable. ?activeOnly=true is for the checkout screen — a
  // cashier should only ever be offered vouchers that can actually still be redeemed.
  const filter = req.query.activeOnly === 'true'
    ? { isActive: { $ne: false }, redeemedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }] }
    : {};
  const vouchers = await findMany('pos_vouchers', filter, { sort: { code: 1 } });
  return returnFunction(res, 200, true, req.locale.success, vouchers);
};

const createVoucher = async (req, res) => {
  if (!validateRequiredFields(req, res, ['code', 'value'])) return;
  if (!(Number(req.body.value) > 0)) return returnFunction(res, 400, false, 'value must be a positive number.');
  const code = req.body.code.trim().toUpperCase();
  const existing = await findOne('pos_vouchers', { code });
  if (existing) return returnFunction(res, 409, false, 'A voucher with this code already exists.');

  const doc = {
    code,
    value: Number(req.body.value),
    expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
    isActive: true,
    redeemedAt: null,
    redeemedSaleId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('pos_vouchers', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateVoucher = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.value !== undefined) update.value = Number(req.body.value);
  if (req.body.expiresAt !== undefined) update.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await updateOne('pos_vouchers', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteVoucher = async (req, res) => {
  await updateOne('pos_vouchers', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// Used both by createSale (authoritative) and checkVoucher (a cashier-facing pre-check).
const resolveVoucher = async (rawCode) => {
  if (!rawCode) return null;
  const voucher = await findOne('pos_vouchers', { code: String(rawCode).trim().toUpperCase(), isActive: { $ne: false }, redeemedAt: null });
  if (!voucher) return null;
  if (voucher.expiresAt && voucher.expiresAt < new Date()) return null;
  return voucher;
};

const checkVoucher = async (req, res) => {
  const voucher = await resolveVoucher(req.params.code);
  if (!voucher) return returnFunction(res, 404, false, 'Invalid, expired, or already-redeemed voucher code.');
  return returnFunction(res, 200, true, req.locale.success, voucher);
};

module.exports = { listVouchers, createVoucher, updateVoucher, deleteVoucher, resolveVoucher, checkVoucher };
