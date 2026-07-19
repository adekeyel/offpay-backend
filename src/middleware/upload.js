const multer = require('multer');
const path = require('path');
const fs = require('fs');
const env = require('../config/env');
const storage = require('../services/storage.service');

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// When Cloudinary is configured, files are held in memory just long enough to
// stream them up to Cloudinary (see persistUploads below) — nothing touches
// local disk, so nothing is lost on redeploy. Only falls back to disk when
// Cloudinary isn't configured (local dev without cloud credentials).
const multerStorage = storage.isConfigured()
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
      },
    });

function fileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error('Only JPEG, PNG, or WEBP images are allowed for passport photos.'));
  }
  cb(null, true);
}

const upload = multer({
  storage: multerStorage,
  fileFilter,
  limits: { fileSize: env.uploads.maxMb * 1024 * 1024 },
});

/**
 * Chain this AFTER upload.single()/.fields() on any route that accepts KYC
 * documents (passport photo, NIN slip, utility bill). When Cloudinary is
 * configured it pushes every uploaded file's buffer up to Cloudinary and
 * attaches `file.storedUrl` — the permanent HTTPS URL controllers should
 * save to the database. When Cloudinary isn't configured, this is a no-op
 * and controllers fall back to the local `/uploads/<filename>` path.
 */
async function persistUploads(req, res, next) {
  if (!storage.isConfigured()) return next();
  try {
    const files = req.file ? [req.file] : Object.values(req.files || {}).flat();
    for (const file of files) {
      const result = await storage.uploadBuffer(file.buffer, {
        folder: 'offpay/kyc',
        resourceType: 'image',
        publicIdPrefix: 'kyc',
      });
      file.storedUrl = result.secure_url;
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { upload, persistUploads };
