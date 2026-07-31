const { ObjectId } = require('mongodb');
const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
const { findOne, findMany, insertOne, updateOne, countDocuments } = require('../../functions/Database/commonDBFunctions');
const { getInventoryAccessLevel } = require('../../lib/inventory/inventoryAccess');

// ── Categories (simple, admin-managed) ──────────────────────────────────────────

const listCategories = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const categories = await findMany('inventory_categories', { isActive: { $ne: false } }, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, categories);
};

const createCategory = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await findOne('inventory_categories', { name: req.body.name.trim() });
  if (existing) return returnFunction(res, 409, false, 'A category with this name already exists.');
  const doc = { name: req.body.name.trim(), isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne('inventory_categories', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateCategory = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await updateOne('inventory_categories', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteCategory = async (req, res) => {
  await updateOne('inventory_categories', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// ── Brands (same shape as Categories — admin-managed list, items store the name as a
// plain string, no FK/join needed) ───────────────────────────────────────────────

const listBrands = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const brands = await findMany('inventory_brands', { isActive: { $ne: false } }, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, brands);
};

const createBrand = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await findOne('inventory_brands', { name: req.body.name.trim() });
  if (existing) return returnFunction(res, 409, false, 'A brand with this name already exists.');
  const doc = { name: req.body.name.trim(), isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne('inventory_brands', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateBrand = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await updateOne('inventory_brands', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteBrand = async (req, res) => {
  await updateOne('inventory_brands', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// ── Units of measure (same shape as Categories/Brands — admin-managed list, items
// store the name as a plain string, no FK/join needed) ──────────────────────────

const listUnitsOfMeasure = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const units = await findMany('inventory_units_of_measure', { isActive: { $ne: false } }, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, units);
};

const createUnitOfMeasure = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await findOne('inventory_units_of_measure', { name: req.body.name.trim() });
  if (existing) return returnFunction(res, 409, false, 'A unit of measure with this name already exists.');
  const doc = { name: req.body.name.trim(), isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne('inventory_units_of_measure', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateUnitOfMeasure = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await updateOne('inventory_units_of_measure', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteUnitOfMeasure = async (req, res) => {
  await updateOne('inventory_units_of_measure', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// ── Custom field definitions (admin-managed, item docs store values keyed by _id) ─

const listCustomFieldDefs = async (req, res) => {
  const defs = await findMany('inventory_custom_field_defs', { isActive: { $ne: false } }, { sort: { name: 1 } });
  return returnFunction(res, 200, true, req.locale.success, defs);
};

const createCustomFieldDef = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'fieldType'])) return;
  if (!['text', 'number', 'date', 'select'].includes(req.body.fieldType)) {
    return returnFunction(res, 400, false, "fieldType must be 'text', 'number', 'date', or 'select'.");
  }
  const doc = {
    name: req.body.name.trim(),
    fieldType: req.body.fieldType,
    options: req.body.fieldType === 'select' ? (Array.isArray(req.body.options) ? req.body.options.map(String) : []) : [],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('inventory_custom_field_defs', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateCustomFieldDef = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (Array.isArray(req.body.options)) update.options = req.body.options.map(String);
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await updateOne('inventory_custom_field_defs', { _id: new ObjectId(req.params.id) }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteCustomFieldDef = async (req, res) => {
  await updateOne('inventory_custom_field_defs', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// Short initials from a category/brand name for a suggested SKU prefix — same
// word-initials idea as the PO invoice-numbering location code, kept local here
// since it's a tiny, single-use helper.
function skuPrefix(category, brand) {
  const source = category || brand || 'ITEM';
  const words = source.trim().split(/\s+/);
  return (words.length === 1 ? words[0].slice(0, 3) : words.map((w) => w[0]).join('').slice(0, 4)).toUpperCase();
}

// A suggestion only — never a uniqueness guarantee. createItem's own findOne check
// against sku is the real guard; the cashier/admin can still edit the field freely.
const suggestSku = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const prefix = skuPrefix(req.query.category, req.query.brand);
  const count = await countDocuments('inventory_items', { sku: { $regex: `^${prefix}-` } });
  const sku = `${prefix}-${String(count + 1).padStart(4, '0')}`;
  return returnFunction(res, 200, true, req.locale.success, { sku });
};

// ── Items ─────────────────────────────────────────────────────────────────────

const listItems = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const { page, limit, skip } = getPagination(req.query);
  const filter = { isActive: { $ne: false } };
  if (req.query.category) filter.category = req.query.category;
  if (req.query.isTracked !== undefined) filter.isTracked = req.query.isTracked === 'true';
  if (req.query.search) {
    const q = req.query.search.trim();
    filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { sku: { $regex: q, $options: 'i' } },
      { barcode: { $regex: q, $options: 'i' } },
    ];
  }
  const [total, items] = await Promise.all([
    countDocuments('inventory_items', filter),
    findMany('inventory_items', filter, { skip, limit, sort: { name: 1 } }),
  ]);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(items, total, page, limit));
};

const getItem = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const item = await findOne('inventory_items', { _id: new ObjectId(req.params.id) });
  if (!item) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, item);
};

const createItem = async (req, res) => {
  if (!validateRequiredFields(req, res, ['sku', 'name', 'unitOfMeasure'])) return;
  const existing = await findOne('inventory_items', { sku: req.body.sku.trim() });
  if (existing) return returnFunction(res, 409, false, 'An item with this SKU already exists.');

  const isTracked = req.body.isTracked !== false; // default true — most items track stock
  const costPrice = Number(req.body.costPrice) || 0;
  const discountType = ['percentage', 'fixed'].includes(req.body.discountType) ? req.body.discountType : null;
  const taxCategory = ['standard', 'zero_rated', 'exempt'].includes(req.body.taxCategory) ? req.body.taxCategory : 'standard';
  const doc = {
    sku: req.body.sku.trim(),
    name: req.body.name.trim(),
    description: req.body.description?.trim() || '',
    category: req.body.category || null,
    brand: req.body.brand || null,
    unitOfMeasure: req.body.unitOfMeasure.trim(),
    costPrice,
    salePrice: Number(req.body.salePrice) || 0,
    barcode: req.body.barcode?.trim() || null,
    isTracked,
    // Serial-tracked items always have qty 1 per record — lot/batch can carry any qty.
    trackingMode: isTracked && ['lot', 'serial', 'batch'].includes(req.body.trackingMode) ? req.body.trackingMode : 'none',
    expiryTrackingEnabled: Boolean(req.body.expiryTrackingEnabled),
    // Weighted Average is the only implemented method today; the field exists so a
    // future FIFO implementation can be added per-item without a schema migration.
    costingMethod: 'weighted_average',
    avgCost: costPrice,
    imageUrl: null,
    discountType,
    discountValue: discountType ? Number(req.body.discountValue) || 0 : null,
    taxCategory,
    // zero-rated and exempt are numerically the same (0%) but distinct legal categories
    // — Kenya VAT: 16% standard, 0% for zero-rated goods, exempt is separate from zero-rated.
    taxRate: taxCategory === 'standard' ? (Number(req.body.taxRate) || 16) : 0,
    customFieldValues: req.body.customFieldValues && typeof req.body.customFieldValues === 'object' ? req.body.customFieldValues : {},
    isActive: true,
    createdBy: req.user._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('inventory_items', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.insertedId, ...doc });
};

const updateItem = async (req, res) => {
  const existing = await findOne('inventory_items', { _id: new ObjectId(req.params.id) });
  if (!existing) return returnFunction(res, 404, false, req.locale.notFound);

  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.description !== undefined) update.description = req.body.description.trim();
  if (req.body.category !== undefined) update.category = req.body.category || null;
  if (req.body.brand !== undefined) update.brand = req.body.brand || null;
  if (req.body.unitOfMeasure !== undefined) update.unitOfMeasure = req.body.unitOfMeasure.trim();
  if (req.body.salePrice !== undefined) update.salePrice = Number(req.body.salePrice) || 0;
  if (req.body.barcode !== undefined) update.barcode = req.body.barcode?.trim() || null;
  if (req.body.expiryTrackingEnabled !== undefined) update.expiryTrackingEnabled = Boolean(req.body.expiryTrackingEnabled);
  if (req.body.customFieldValues && typeof req.body.customFieldValues === 'object') update.customFieldValues = req.body.customFieldValues;
  if (req.body.discountType !== undefined) {
    update.discountType = ['percentage', 'fixed'].includes(req.body.discountType) ? req.body.discountType : null;
    update.discountValue = update.discountType ? Number(req.body.discountValue) || 0 : null;
  }
  if (req.body.taxCategory !== undefined) {
    update.taxCategory = ['standard', 'zero_rated', 'exempt'].includes(req.body.taxCategory) ? req.body.taxCategory : 'standard';
    update.taxRate = update.taxCategory === 'standard' ? (Number(req.body.taxRate) || 16) : 0;
  }
  // costPrice/isTracked/trackingMode are deliberately NOT editable here once movements
  // exist for this item — costPrice only ever moves via a receipt's unitCost (see
  // inventoryMovementsFunctions.recordReceiptCost), and changing tracking mode after
  // stock/lots exist would silently orphan traceability data.

  await updateOne('inventory_items', { _id: existing._id }, { $set: update });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const archiveItem = async (req, res) => {
  await updateOne('inventory_items', { _id: new ObjectId(req.params.id) }, { $set: { isActive: false, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Archived.');
};

const uploadItemImage = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, 'No image uploaded.');
  const imageUrl = req.file.path;
  await updateOne('inventory_items', { _id: new ObjectId(req.params.id) }, { $set: { imageUrl, updatedAt: new Date() } });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, { imageUrl });
};

module.exports = {
  listCategories, createCategory, updateCategory, deleteCategory,
  listBrands, createBrand, updateBrand, deleteBrand,
  listUnitsOfMeasure, createUnitOfMeasure, updateUnitOfMeasure, deleteUnitOfMeasure,
  listCustomFieldDefs, createCustomFieldDef, updateCustomFieldDef, deleteCustomFieldDef,
  listItems, getItem, createItem, updateItem, archiveItem, uploadItemImage, suggestSku,
};
