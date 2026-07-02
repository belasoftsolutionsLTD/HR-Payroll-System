const path = require('path');
const fs   = require('fs');
const returnFunction = require('../../functions/returnFunction');
const { findOne, insertOne, updateOne } = require('../../functions/Database/commonDBFunctions');

const getCompanySettings = async (req, res) => {
  const settings = await findOne('company_settings', {});
  return returnFunction(res, 200, true, 'OK', settings || {});
};

const updateCompanySettings = async (req, res) => {
  const ALLOWED = ['companyName', 'mission', 'vision', 'coreValues', 'address', 'phone', 'email', 'website', 'workStartTime', 'workEndTime', 'primaryColor', 'gradientEndColor', 'gradientEnabled', 'officeLatitude', 'officeLongitude', 'officeRadiusMeters', 'facebook', 'twitter', 'linkedin', 'instagram', 'youtube', 'tiktok', 'tagline', 'country', 'currency', 'timezone', 'fiscalYearStart'];
  const patch = { updatedAt: new Date() };
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  const existing = await findOne('company_settings', {});
  if (existing) {
    await updateOne('company_settings', { _id: existing._id }, { $set: patch });
  } else {
    await insertOne('company_settings', { ...patch, createdAt: new Date() });
  }
  return returnFunction(res, 200, true, 'Company settings updated.');
};

const uploadCompanyFile = async (req, res, field) => {
  if (!req.file) return returnFunction(res, 400, false, 'No file uploaded.');
  const patch = {
    [`${field}Path`]: req.file.path,
    [`${field}Filename`]: req.file.originalname,
    updatedAt: new Date(),
  };
  const existing = await findOne('company_settings', {});
  if (existing) {
    await updateOne('company_settings', { _id: existing._id }, { $set: patch });
  } else {
    await insertOne('company_settings', { ...patch, createdAt: new Date() });
  }
  return returnFunction(res, 200, true, `${field} uploaded successfully.`, { path: req.file.path });
};

const serveCompanyLogo = async (req, res) => {
  const settings = await findOne('company_settings', {});
  if (!settings?.logoPath) return returnFunction(res, 404, false, 'No logo uploaded.');
  const filePath = path.resolve(settings.logoPath);
  if (!fs.existsSync(filePath)) return returnFunction(res, 404, false, 'Logo file not found.');
  const ext = path.extname(filePath).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext] || 'image/png';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(filePath).pipe(res);
};

const serveTermsPdf = async (req, res) => {
  const settings = await findOne('company_settings', {});
  if (!settings?.termsPath) return returnFunction(res, 404, false, 'No terms PDF has been uploaded yet.');
  const filePath = path.resolve(settings.termsPath);
  if (!fs.existsSync(filePath)) return returnFunction(res, 404, false, 'Terms PDF file not found on server.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="Terms-and-Conditions.pdf"');
  fs.createReadStream(filePath).pipe(res);
};

module.exports = { getCompanySettings, updateCompanySettings, uploadCompanyFile, serveCompanyLogo, serveTermsPdf };
