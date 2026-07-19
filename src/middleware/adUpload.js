const multer = require('multer');
const path = require('path');
const fs = require('fs');
const env = require('../config/env');

const uploadDir = path.join(__dirname, '..', 'uploads', 'ads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
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
  storage,
  fileFilter,
  limits: { fileSize: env.uploads.adMaxMb * 1024 * 1024 },
});

module.exports = adUpload;
