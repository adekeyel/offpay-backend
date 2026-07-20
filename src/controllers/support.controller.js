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
  // Include each ticket's most recent reply so the list can show a preview
  // and, more importantly, so a NEW admin reply is visible to the user
  // without them having to open every ticket to check — this is what was
  // missing before: replyTicket() wrote into support_replies, but nothing
  // on the client side ever read from that table.
  const { rows } = await query(
    `SELECT t.*,
            lr.message AS last_reply_message, lr.author_type AS last_reply_author_type, lr.created_at AS last_reply_at
     FROM support_tickets t
     LEFT JOIN LATERAL (
       SELECT message, author_type, created_at FROM support_replies
       WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1
     ) lr ON true
     WHERE t.user_id = $1 ORDER BY t.updated_at DESC`,
    [req.user.id]
  );
  res.json({ success: true, data: rows });
}

/** Full conversation thread for one ticket — the original message plus every reply, in order. */
async function getTicketThread(req, res) {
  const { rows: tickets } = await query(
    `SELECT * FROM support_tickets WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!tickets.length) throw ApiError.notFound('Ticket not found.');

  const { rows: replies } = await query(
    `SELECT id, author_type, message, created_at FROM support_replies WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [req.params.id]
  );
  res.json({ success: true, data: { ticket: tickets[0], replies } });
}

/** Lets the user reply back on their own ticket — reopens it if it had been marked resolved/closed. */
async function userReply(req, res) {
  const { message } = req.body;
  if (!message) throw ApiError.badRequest('Message is required.');

  const { rows } = await query(`SELECT id, status FROM support_tickets WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!rows.length) throw ApiError.notFound('Ticket not found.');

  await query(`INSERT INTO support_replies (ticket_id, author_type, author_id, message) VALUES ($1,'user',$2,$3)`, [req.params.id, req.user.id, message]);
  await query(
    `UPDATE support_tickets SET status = CASE WHEN status IN ('resolved','closed') THEN 'open' ELSE status END, updated_at = now() WHERE id = $1`,
    [req.params.id]
  );
  res.status(201).json({ success: true, message: 'Reply sent.' });
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

module.exports = { createTicket, myTickets, getTicketThread, userReply, listAllTickets, replyTicket };
