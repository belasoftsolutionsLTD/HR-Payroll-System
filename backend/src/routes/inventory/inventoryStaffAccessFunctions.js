const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { findMany, updateOne } = require('../../functions/Database/commonDBFunctions');
const { STAFF } = require('../../constants/roles');
const { getInventoryAccessLevel } = require('../../lib/inventory/inventoryAccess');

// Lists plain "staff"-role users so an inventory admin can grant/revoke the
// isInventoryClerk flag — the module's one persisted boolean permission, since staff
// otherwise has no access to Inventory at all (see lib/inventory/inventoryAccess.js).
const listStaffAccess = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');

  const users = await findMany('users', { role: STAFF }, { projection: { name: 1, email: 1, employeeId: 1, isInventoryClerk: 1 } });
  return returnFunction(res, 200, true, req.locale.success, users.map((u) => ({ ...u, isInventoryClerk: u.isInventoryClerk === true })));
};

const setInventoryClerkFlag = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');

  await updateOne('users', { _id: new ObjectId(req.params.userId) }, { $set: { isInventoryClerk: Boolean(req.body.isInventoryClerk), updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

// Lets the frontend ask "what can I do here" once, instead of every component guessing
// from req.user.role client-side (which wouldn't know about the isInventoryClerk flag).
// Unlike POS/CRM, Inventory already returns null for a plain staff account with no real
// standing (no isInventoryClerk, not a manager) — so `relevant` is just `level !== null`
// here, kept only so callers like the nav sidebar can use one consistent field name
// across all three modules.
const getMyAccessLevel = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  return returnFunction(res, 200, true, req.locale.success, { level, relevant: level !== null });
};

module.exports = { listStaffAccess, setInventoryClerkFlag, getMyAccessLevel };
