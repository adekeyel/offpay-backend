const { query } = require('../config/db');

/**
 * Calculates the fee for a transaction based on the admin-configurable
 * fee_config table. Falls back to the documented default schedule if a
 * matching row isn't found (should not normally happen once seeded).
 *
 * txnType one of: 'deposit_external' | 'withdrawal_interbank' | 'withdrawal_intra_bank'
 *                | 'transfer_in_app' | 'transfer_offline'
 */
async function calculateFee(txnType, amount) {
  const { rows } = await query(
    `SELECT * FROM fee_config
     WHERE txn_type = $1 AND active = true
       AND min_amount <= $2
       AND (max_amount IS NULL OR max_amount >= $2)
     ORDER BY min_amount DESC
     LIMIT 1`,
    [txnType, amount]
  );

  if (!rows.length) {
    // Safe defaults matching the original business specification
    const defaults = {
      deposit_external: amount < 1000 ? 10 : 50,
      withdrawal_interbank: amount >= 10000 ? 60 : 20,
      withdrawal_intra_bank: 10,
      transfer_in_app: 10,
      transfer_offline: 10,
    };
    return defaults[txnType] ?? 0;
  }

  const config = rows[0];
  if (config.fee_type === 'percentage') {
    return Math.round((amount * parseFloat(config.fee_value)) / 100 * 100) / 100;
  }
  return parseFloat(config.fee_value);
}

async function listFeeConfig() {
  const { rows } = await query('SELECT * FROM fee_config ORDER BY txn_type, min_amount');
  return rows;
}

async function updateFeeConfig(id, { feeValue, feeType, minAmount, maxAmount, active }, adminId) {
  const { rows } = await query(
    `UPDATE fee_config SET
       fee_value = COALESCE($1, fee_value),
       fee_type = COALESCE($2, fee_type),
       min_amount = COALESCE($3, min_amount),
       max_amount = COALESCE($4, max_amount),
       active = COALESCE($5, active),
       updated_by = $6,
       updated_at = now()
     WHERE id = $7
     RETURNING *`,
    [feeValue, feeType, minAmount, maxAmount, active, adminId, id]
  );
  return rows[0];
}

module.exports = { calculateFee, listFeeConfig, updateFeeConfig };
