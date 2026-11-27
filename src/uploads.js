const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Only raster formats; SVG is excluded because it can carry scripts.
const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const MAX_FILES = 8;

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    // Never trust the client's filename: random name, extension from the MIME type.
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + TYPES[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => cb(null, !!TYPES[file.mimetype]),
});

// Check magic bytes so a renamed non-image is rejected even if the MIME type lies.
function looksLikeImage(file) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  const hex = buf.toString('hex');
  return (
    hex.startsWith('ffd8ff') || // jpeg
    hex.startsWith('89504e47') || // png
    hex.startsWith('47494638') || // gif
    (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
  );
}

const isImageUrl = (u) => typeof u === 'string' && (/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|gif)$/.test(u) || /^https?:\/\/\S+$/i.test(u));

module.exports = { upload, uploadsDir, looksLikeImage, isImageUrl, MAX_FILES };
