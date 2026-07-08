const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');

async function createTicket(req, res) {
  const { subject, message } = req.body;
  if (!subject || !message) throw ApiError.badRequest('Subject and message are required.');
  const { rows } = await query(
    `INSERT INTO support_tickets (user_id, subject, message) VALUES ($1,$2,$3) RETURNING *`,
    [req.user?.id || null, subject, message]
  );
  res.status(201).json({ success: true, data: rows[0] });
}

async function myTickets(req, res) {
  const { rows } = await query(`SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC`, [req.user.id]);
  res.json({ success: true, data: rows });
}

// --- admin (support role) ---
async function listAllTickets(req, res) {
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE status = $1`; }
  const { rows } = await query(`SELECT * FROM support_tickets ${where} ORDER BY created_at DESC`, params);
  res.json({ success: true, data: rows });
}

async function replyTicket(req, res) {
  const { message, status } = req.body;
  if (!message) throw ApiError.badRequest('Reply message is required.');
  await query(`INSERT INTO support_replies (ticket_id, author_type, author_id, message) VALUES ($1,'admin',$2,$3)`, [req.params.id, req.admin.id, message]);
  await query(`UPDATE support_tickets SET status = COALESCE($1, status), assigned_to = $2, updated_at = now() WHERE id = $3`, [status, req.admin.id, req.params.id]);
  res.json({ success: true, message: 'Reply sent.' });
}

module.exports = { createTicket, myTickets, listAllTickets, replyTicket };
