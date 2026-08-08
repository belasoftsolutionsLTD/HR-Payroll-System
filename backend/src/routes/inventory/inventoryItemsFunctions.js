const returnFunction = require('../../functions/returnFunction');
const { validateRequiredFields, getPagination, paginatedResponse } = require('../../functions/Route Fns/routeFns');
// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 6) — inventory_categories/brands/units_of_measure/custom_field_defs/items
// now live in Postgres.
const { knex, newId, insertOne } = require('../../functions/Database/pgDBFunctions');
const { getInventoryAccessLevel } = require('../../lib/inventory/inventoryAccess');

// ── Categories (simple, admin-managed) ──────────────────────────────────────────

const listCategories = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const categories = await knex('inventory_categories').whereNot({ isActive: false }).orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, categories);
};

const createCategory = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await knex('inventory_categories').where({ name: req.body.name.trim() }).first();
  if (existing) return returnFunction(res, 409, false, 'A category with this name already exists.');
  const doc = { id: newId(), name: req.body.name.trim(), isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne('inventory_categories', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id, ...doc });
};

const updateCategory = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await knex('inventory_categories').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteCategory = async (req, res) => {
  await knex('inventory_categories').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// ── Brands (same shape as Categories — admin-managed list, items store the name as a
// plain string, no FK/join needed) ───────────────────────────────────────────────

const listBrands = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const brands = await knex('inventory_brands').whereNot({ isActive: false }).orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, brands);
};

const createBrand = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await knex('inventory_brands').where({ name: req.body.name.trim() }).first();
  if (existing) return returnFunction(res, 409, false, 'A brand with this name already exists.');
  const doc = { id: newId(), name: req.body.name.trim(), isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne('inventory_brands', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id, ...doc });
};

const updateBrand = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await knex('inventory_brands').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteBrand = async (req, res) => {
  await knex('inventory_brands').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// ── Units of measure (same shape as Categories/Brands — admin-managed list, items
// store the name as a plain string, no FK/join needed) ──────────────────────────

const listUnitsOfMeasure = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const units = await knex('inventory_units_of_measure').whereNot({ isActive: false }).orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, units);
};

const createUnitOfMeasure = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (level !== 'admin') return returnFunction(res, 403, false, 'Not authorized.');
  if (!validateRequiredFields(req, res, ['name'])) return;
  const existing = await knex('inventory_units_of_measure').where({ name: req.body.name.trim() }).first();
  if (existing) return returnFunction(res, 409, false, 'A unit of measure with this name already exists.');
  const doc = { id: newId(), name: req.body.name.trim(), isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await insertOne('inventory_units_of_measure', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id, ...doc });
};

const updateUnitOfMeasure = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await knex('inventory_units_of_measure').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteUnitOfMeasure = async (req, res) => {
  await knex('inventory_units_of_measure').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Deleted successfully.');
};

// ── Custom field definitions (admin-managed, item docs store values keyed by id) ─

const listCustomFieldDefs = async (req, res) => {
  const defs = await knex('inventory_custom_field_defs').whereNot({ isActive: false }).orderBy('name');
  return returnFunction(res, 200, true, req.locale.success, defs);
};

const createCustomFieldDef = async (req, res) => {
  if (!validateRequiredFields(req, res, ['name', 'fieldType'])) return;
  if (!['text', 'number', 'date', 'select'].includes(req.body.fieldType)) {
    return returnFunction(res, 400, false, "fieldType must be 'text', 'number', 'date', or 'select'.");
  }
  const doc = {
    id: newId(),
    name: req.body.name.trim(),
    fieldType: req.body.fieldType,
    options: req.body.fieldType === 'select' ? (Array.isArray(req.body.options) ? req.body.options.map(String) : []) : [],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('inventory_custom_field_defs', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id, ...doc });
};

const updateCustomFieldDef = async (req, res) => {
  const update = { updatedAt: new Date() };
  if (req.body.name !== undefined) update.name = req.body.name.trim();
  if (Array.isArray(req.body.options)) update.options = req.body.options.map(String);
  if (req.body.isActive !== undefined) update.isActive = Boolean(req.body.isActive);
  await knex('inventory_custom_field_defs').where({ id: req.params.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const deleteCustomFieldDef = async (req, res) => {
  await knex('inventory_custom_field_defs').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
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
  const [{ count }] = await knex('inventory_items').where('sku', 'like', `${prefix}-%`).count('* as count');
  const sku = `${prefix}-${String(Number(count) + 1).padStart(4, '0')}`;
  return returnFunction(res, 200, true, req.locale.success, { sku });
};

// ── Items ─────────────────────────────────────────────────────────────────────

const listItems = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const { page, limit, skip } = getPagination(req.query);
  let query = knex('inventory_items').whereNot({ isActive: false });
  if (req.query.category) query = query.where({ category: req.query.category });
  if (req.query.isTracked !== undefined) query = query.where({ isTracked: req.query.isTracked === 'true' });
  if (req.query.search) {
    const q = `%${req.query.search.trim()}%`;
    query = query.where((qb) => qb.whereILike('name', q).orWhereILike('sku', q).orWhereILike('barcode', q));
  }
  const [{ count }] = await query.clone().count('* as count');
  const items = await query.orderBy('name').limit(limit).offset(skip);
  return returnFunction(res, 200, true, req.locale.success, paginatedResponse(items, Number(count), page, limit));
};

const getItem = async (req, res) => {
  const level = await getInventoryAccessLevel(req.user);
  if (!level) return returnFunction(res, 403, false, 'Not authorized.');
  const item = await knex('inventory_items').where({ id: req.params.id }).first();
  if (!item) return returnFunction(res, 404, false, req.locale.notFound);
  return returnFunction(res, 200, true, req.locale.success, item);
};

const createItem = async (req, res) => {
  if (!validateRequiredFields(req, res, ['sku', 'name', 'unitOfMeasure'])) return;
  const existing = await knex('inventory_items').where({ sku: req.body.sku.trim() }).first();
  if (existing) return returnFunction(res, 409, false, 'An item with this SKU already exists.');

  const isTracked = req.body.isTracked !== false; // default true — most items track stock
  const costPrice = Number(req.body.costPrice) || 0;
  const discountType = ['percentage', 'fixed'].includes(req.body.discountType) ? req.body.discountType : null;
  const taxCategory = ['standard', 'zero_rated', 'exempt'].includes(req.body.taxCategory) ? req.body.taxCategory : 'standard';
  const doc = {
    id: newId(),
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
    customFieldValues: JSON.stringify(req.body.customFieldValues && typeof req.body.customFieldValues === 'object' ? req.body.customFieldValues : {}),
    isActive: true,
    createdBy: req.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await insertOne('inventory_items', doc);
  return returnFunction(res, 201, true, req.locale.createdSuccessfully, { _id: result.id, ...result });
};

const updateItem = async (req, res) => {
  const existing = await knex('inventory_items').where({ id: req.params.id }).first();
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
  if (req.body.customFieldValues && typeof req.body.customFieldValues === 'object') update.customFieldValues = JSON.stringify(req.body.customFieldValues);
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

  await knex('inventory_items').where({ id: existing.id }).update(update);
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully);
};

const archiveItem = async (req, res) => {
  await knex('inventory_items').where({ id: req.params.id }).update({ isActive: false, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.deletedSuccessfully || 'Archived.');
};

const uploadItemImage = async (req, res) => {
  if (!req.file) return returnFunction(res, 400, false, 'No image uploaded.');
  const imageUrl = req.file.path;
  await knex('inventory_items').where({ id: req.params.id }).update({ imageUrl, updatedAt: new Date() });
  return returnFunction(res, 200, true, req.locale.updatedSuccessfully, { imageUrl });
};

module.exports = {
  listCategories, createCategory, updateCategory, deleteCategory,
  listBrands, createBrand, updateBrand, deleteBrand,
  listUnitsOfMeasure, createUnitOfMeasure, updateUnitOfMeasure, deleteUnitOfMeasure,
  listCustomFieldDefs, createCustomFieldDef, updateCustomFieldDef, deleteCustomFieldDef,
  listItems, getItem, createItem, updateItem, archiveItem, uploadItemImage, suggestSku,
};
