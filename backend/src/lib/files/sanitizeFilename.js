const path = require('path');

// `file.originalname` in every multer config is attacker-controlled — it's whatever
// filename the client puts in the multipart/form-data request, completely independent
// of the file's actual content. Several upload routes across this codebase built the
// saved-to-disk name as `${Date.now()}-${file.originalname}` with no sanitization —
// if originalname contains `../../../etc/cron.d/x` (or similar), Node's fs calls
// resolve those `..` segments and can write outside the intended uploads/ directory,
// even though a timestamp is prepended (the prefix doesn't stop `/`/`..` mid-string
// from working). This is a real path-traversal → arbitrary file write, and one call
// site (the public careers résumé upload) needs no login at all to reach it.
//
// path.basename() alone closes the traversal (it discards everything up to the last
// separator, so any number of "../" collapses to nothing) — the character whitelist
// below is defense in depth against null bytes, control characters, and anything else
// that might behave oddly on a given filesystem.
const sanitizeFilename = (originalname) => {
  const base = path.basename(String(originalname || 'file'));
  const cleaned = base.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
  // '.' and '..' both survive the character whitelist above (dots are allowed, for
  // legitimate extensions) but are exactly the two filesystem-special values that
  // still let path.join() escape the destination directory on their own — e.g. an
  // originalname of "../" reduces to just ".." after path.basename(), and
  // path.join(uploadsDir, '..') resolves to uploadsDir's *parent*. An empty result
  // (input was all separators/symbols) needs a real name too.
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
};

module.exports = { sanitizeFilename };
