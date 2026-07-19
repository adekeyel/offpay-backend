const { query } = require('../config/db');

async function listBanks(req, res) {
  const { rows } = await query('SELECT id, name, code, country FROM banks ORDER BY name ASC');
  res.json({ success: true, data: rows });
}

module.exports = { listBanks };
