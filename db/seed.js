require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const FEES = [
  { code: 'DEPOSIT_EXTERNAL_BELOW_1000', label: 'Deposit from other bank — below ₦1,000', txn_type: 'deposit_external', min_amount: 0, max_amount: 999.99, fee_type: 'flat', fee_value: 10 },
  { code: 'DEPOSIT_EXTERNAL_1000_PLUS', label: 'Deposit from other bank — ₦1,000 and above', txn_type: 'deposit_external', min_amount: 1000, max_amount: null, fee_type: 'flat', fee_value: 50 },
  { code: 'WITHDRAWAL_INTERBANK_BELOW_10000', label: 'Interbank transfer — below ₦10,000', txn_type: 'withdrawal_interbank', min_amount: 0, max_amount: 9999.99, fee_type: 'flat', fee_value: 20 },
  { code: 'WITHDRAWAL_INTERBANK_ABOVE_10000', label: 'Interbank transfer — ₦10,000 and above', txn_type: 'withdrawal_interbank', min_amount: 10000, max_amount: null, fee_type: 'flat', fee_value: 60 },
  { code: 'WITHDRAWAL_INTRA_BANK', label: 'Intra-bank transfer (same bank as your virtual account)', txn_type: 'withdrawal_intra_bank', min_amount: 0, max_amount: null, fee_type: 'flat', fee_value: 10 },
  { code: 'TRANSFER_IN_APP', label: 'OffPay wallet-to-wallet transfer', txn_type: 'transfer_in_app', min_amount: 0, max_amount: null, fee_type: 'flat', fee_value: 10 },
  { code: 'TRANSFER_OFFLINE', label: 'Offline wallet-to-wallet transfer', txn_type: 'transfer_offline', min_amount: 0, max_amount: null, fee_type: 'flat', fee_value: 10 },
];

const BANKS = [
  ['Access Bank', '044'], ['Guaranty Trust Bank', '058'], ['Zenith Bank', '057'],
  ['United Bank for Africa', '033'], ['First Bank of Nigeria', '011'], ['Ecobank Nigeria', '050'],
  ['Fidelity Bank', '070'], ['Union Bank of Nigeria', '032'], ['Sterling Bank', '232'],
  ['Wema Bank', '035'], ['Polaris Bank', '076'], ['Stanbic IBTC Bank', '221'],
  ['Kuda Microfinance Bank', '50211'], ['Opay (Paycom)', '999992'], ['Palmpay', '999991'],
  ['Moniepoint MFB', '50515'], ['Providus Bank', '101'], ['Jaiz Bank', '301'],
  ['Citibank Nigeria', '023'], ['Standard Chartered Bank', '068'],
];

async function seed() {
  const client = await pool.connect();
  try {
    console.log('Seeding fee configuration...');
    for (const fee of FEES) {
      await client.query(
        `INSERT INTO fee_config (code, label, txn_type, min_amount, max_amount, fee_type, fee_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, fee_value = EXCLUDED.fee_value`,
        [fee.code, fee.label, fee.txn_type, fee.min_amount, fee.max_amount, fee.fee_type, fee.fee_value]
      );
    }

    console.log('Seeding bank directory...');
    for (const [name, code] of BANKS) {
      const exists = await client.query('SELECT 1 FROM banks WHERE code = $1', [code]);
      if (!exists.rows.length) {
        await client.query('INSERT INTO banks (name, code, country) VALUES ($1,$2,$3)', [name, code, 'Nigeria']);
      }
    }

    const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@offpay.app';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe!2026';
    const existingAdmin = await client.query('SELECT 1 FROM admin_users WHERE email = $1', [adminEmail]);
    if (!existingAdmin.rows.length) {
      console.log(`Creating first super-admin: ${adminEmail}`);
      const hash = await bcrypt.hash(adminPassword, 12);
      await client.query(
        `INSERT INTO admin_users (full_name, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
        ['Super Admin', adminEmail, hash, 'admin']
      );
    } else {
      console.log('Super-admin already exists, skipping.');
    }

    console.log('✅ Seed complete.');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
