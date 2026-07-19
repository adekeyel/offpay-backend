const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');

async function list(req, res) {
  const { rows } = await query(`SELECT * FROM ads ORDER BY created_at DESC`);
  res.json({ success: true, data: rows });
}

async function create(req, res) {
  const { title, targetPage, position, linkUrl, startsAt, endsAt } = req.body;
  if (!title || !targetPage || !position) throw ApiError.badRequest('title, targetPage, and position are required.');
  if (!req.file) throw ApiError.badRequest('An image or video file is required.');

  const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
  // storedUrl is a permanent Cloudinary URL when Cloudinary is configured;
  // otherwise falls back to the (non-persistent) local disk path — see
  // src/middleware/adUpload.js.
  const mediaUrl = req.file.storedUrl || `/uploads/ads/${req.file.filename}`;

  const { rows } = await query(
    `INSERT INTO ads (title, media_type, media_url, link_url, target_page, position, starts_at, ends_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [title, mediaType, mediaUrl, linkUrl || null, targetPage, position, startsAt || null, endsAt || null, req.admin.id]
  );
  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'AD_CREATED', targetType: 'ad', targetId: rows[0].id });
  res.status(201).json({ success: true, data: rows[0] });
}

async function update(req, res) {
  const { title, targetPage, position, linkUrl, active, startsAt, endsAt } = req.body;
  const { rows } = await query(
    `UPDATE ads SET
       title = COALESCE($1, title),
       target_page = COALESCE($2, target_page),
       position = COALESCE($3, position),
       link_url = COALESCE($4, link_url),
       active = COALESCE($5, active),
       starts_at = COALESCE($6, starts_at),
       ends_at = COALESCE($7, ends_at),
       updated_at = now()
     WHERE id = $8 RETURNING *`,
    [title, targetPage, position, linkUrl, active, startsAt, endsAt, req.params.id]
  );
  if (!rows.length) throw ApiError.notFound('Ad not found.');
  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'AD_UPDATED', targetType: 'ad', targetId: req.params.id });
  res.json({ success: true, data: rows[0] });
}

async function remove(req, res) {
  const { rows } = await query('DELETE FROM ads WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('Ad not found.');
  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'AD_DELETED', targetType: 'ad', targetId: req.params.id });
  res.json({ success: true, message: 'Ad deleted.' });
}

module.exports = { list, create, update, remove };
