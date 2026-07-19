const multer = require('multer');
const path = require('path');
const fs = require('fs');
const env = require('../config/env');
const storage = require('../services/storage.service');

const uploadDir = path.join(__dirname, '..', 'uploads', 'ads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Same reasoning as middleware/upload.js — hold ad media in memory and stream
// it to Cloudinary so it survives redeploys, falling back to local disk only
// when Cloudinary isn't configured.
const multerStorage = storage.isConfigured()
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `ad-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
      },
    });

function fileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error('Ads must be JPEG, PNG, WEBP, GIF images, or MP4/WEBM video.'));
  }
  cb(null, true);
}

const adUpload = multer({
  storage: multerStorage,
  fileFilter,
  limits: { fileSize: env.uploads.adMaxMb * 1024 * 1024 },
});

/** Chain after adUpload.single('media'). See middleware/upload.js persistUploads for details. */
async function persistAdUpload(req, res, next) {
  if (!storage.isConfigured()) return next();
  if (!req.file) return next();
  try {
    const resourceType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    const result = await storage.uploadBuffer(req.file.buffer, {
      folder: 'offpay/ads',
      resourceType,
      publicIdPrefix: 'ad',
    });
    req.file.storedUrl = result.secure_url;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { adUpload, persistAdUpload };
