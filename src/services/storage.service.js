const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Persistent file storage for KYC documents (passport photos, NIN slips,
 * utility bills) and ad media.
 *
 * WHY THIS EXISTS: Railway's filesystem is ephemeral — anything written to
 * local disk is wiped on every redeploy/restart. Storing uploads on local
 * disk (the old behaviour) is why images used to appear "broken" in the
 * admin dashboard shortly after any new deployment: the database still had
 * a `/uploads/xyz.jpg` URL on record, but the underlying file was gone.
 *
 * Cloudinary keeps the file forever (until explicitly deleted) and hands
 * back a permanent HTTPS URL that's safe to store in Postgres. If the three
 * CLOUDINARY_* env vars are not set, this module quietly reports itself as
 * "not configured" and the upload middleware falls back to local disk —
 * which is fine for local development, but must never be relied on in
 * production on Railway.
 */
let cloudinary = null;
if (env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  });
} else {
  logger.warn(
    'CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not set. ' +
    'Uploaded files (passport photos, NIN slips, utility bills, ad media) will be saved to LOCAL DISK, ' +
    'which Railway wipes on every redeploy — those files and images WILL disappear and show as broken ' +
    'in the admin dashboard again. Set the three CLOUDINARY_* variables in Railway to fix this permanently. ' +
    'See .env.example.'
  );
}

function isConfigured() {
  return !!cloudinary;
}

/**
 * Uploads a Buffer (from multer's memoryStorage) to Cloudinary and resolves
 * with the API result, most importantly `secure_url` — the permanent HTTPS
 * link to save in the database.
 */
function uploadBuffer(buffer, { folder, resourceType = 'image', publicIdPrefix = 'file' }) {
  if (!cloudinary) {
    return Promise.reject(new Error('Cloudinary is not configured — call isConfigured() before uploadBuffer().'));
  }
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        public_id: `${publicIdPrefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
        overwrite: false,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    uploadStream.end(buffer);
  });
}

module.exports = { isConfigured, uploadBuffer };
