require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000, // fail loudly instead of hanging forever if the DB isn't reachable yet
});

// Percentage-based fees, replacing the old flat-per-amount-range schedule.
// Your provider charges ~3% on deposits and ~10% on transfers — these are
// set at cost + a small margin so OffPay is never taking a loss on a
// transaction. Tune the fee_value any time from Admin > Fees (no redeploy
// needed — fee.service.js reads this table live on every transaction).
const FEES = [
  { code: 'DEPOSIT_EXTERNAL', label: 'Deposit from other bank', txn_type: 'deposit_external', min_amount: 0, max_amount: null, fee_type: 'percentage', fee_value: 3.5 },
  { code: 'WITHDRAWAL_INTERBANK', label: 'Interbank transfer to another bank', txn_type: 'withdrawal_interbank', min_amount: 0, max_amount: null, fee_type: 'percentage', fee_value: 10.5 },
  { code: 'WITHDRAWAL_INTRA_BANK', label: 'Intra-bank transfer (same bank as your virtual account)', txn_type: 'withdrawal_intra_bank', min_amount: 0, max_amount: null, fee_type: 'percentage', fee_value: 10.5 },
  { code: 'TRANSFER_IN_APP', label: 'OffPay wallet-to-wallet transfer', txn_type: 'transfer_in_app', min_amount: 0, max_amount: null, fee_type: 'flat', fee_value: 10 },
  { code: 'TRANSFER_OFFLINE', label: 'Offline wallet-to-wallet transfer', txn_type: 'transfer_offline', min_amount: 0, max_amount: null, fee_type: 'flat', fee_value: 10 },
];


const VTU_PRODUCTS = [
  // Data bundles
  { category: 'data', provider: 'MTN', name: '1GB - 30 days', amount: 350 },
  { category: 'data', provider: 'MTN', name: '2GB - 30 days', amount: 650 },
  { category: 'data', provider: 'MTN', name: '5GB - 30 days', amount: 1500 },
  { category: 'data', provider: 'Glo', name: '1GB - 30 days', amount: 300 },
  { category: 'data', provider: 'Glo', name: '2.5GB - 30 days', amount: 700 },
  { category: 'data', provider: 'Glo', name: '5GB - 30 days', amount: 1400 },
  { category: 'data', provider: 'Airtel', name: '1GB - 30 days', amount: 350 },
  { category: 'data', provider: 'Airtel', name: '3GB - 30 days', amount: 900 },
  { category: 'data', provider: '9mobile', name: '1GB - 30 days', amount: 300 },
  { category: 'data', provider: '9mobile', name: '2GB - 30 days', amount: 600 },
  // Cable subscriptions
  { category: 'cable', provider: 'DStv', name: 'DStv Padi', amount: 4400 },
  { category: 'cable', provider: 'DStv', name: 'DStv Yanga', amount: 6200 },
  { category: 'cable', provider: 'DStv', name: 'DStv Compact', amount: 15700 },
  { category: 'cable', provider: 'GOtv', name: 'GOtv Smallie', amount: 1900 },
  { category: 'cable', provider: 'GOtv', name: 'GOtv Jinja', amount: 3900 },
  { category: 'cable', provider: 'GOtv', name: 'GOtv Max', amount: 6300 },
  { category: 'cable', provider: 'Startimes', name: 'Nova', amount: 1900 },
  { category: 'cable', provider: 'Startimes', name: 'Basic', amount: 4200 },
];

const LOAN_PRODUCTS = [
  { name: 'QuickCash 5K', min_amount: 1000, max_amount: 5000, interest_rate: 5, tenor_days: 14, min_kyc_tier: 3, min_account_age_days: 14 },
  { name: 'QuickCash 20K', min_amount: 5000, max_amount: 20000, interest_rate: 8, tenor_days: 30, min_kyc_tier: 3, min_account_age_days: 30 },
  { name: 'QuickCash 100K', min_amount: 20000, max_amount: 100000, interest_rate: 12, tenor_days: 60, min_kyc_tier: 3, min_account_age_days: 60 },
];

// Reduced ~3 points across the board from the original rates as a starting
// cut (CashBox 10→7, SmartEarn 15→12, SafeBox 12→9, Target 13→10, Fixed
// 18→15, Mutual Fund 16→13). Adjust any time from Admin > Wealth Products —
// no redeploy needed.
const WEALTH_PRODUCTS = [
  { type: 'cashbox', name: 'CashBox', description: 'Save a little every day, starting from ₦1.', interest_rate: 7, min_amount: 1, lock_days: 0 },
  { type: 'smartearn', name: 'SmartEarn', description: 'Flexible savings that earns daily.', interest_rate: 12, min_amount: 500, lock_days: 0 },
  { type: 'safebox', name: 'SafeBox', description: 'A locked-away spot for money you don\u2019t want to touch.', interest_rate: 9, min_amount: 500, lock_days: 0 },
  { type: 'target', name: 'Target Savings', description: 'Save toward a specific goal and date.', interest_rate: 10, min_amount: 500, lock_days: 0 },
  { type: 'fixed', name: 'Fixed Savings', description: 'Lock funds for a fixed term at a higher rate.', interest_rate: 15, min_amount: 5000, lock_days: 90 },
  { type: 'mutual_fund', name: 'Mutual Funds', description: 'Professionally managed investment fund.', interest_rate: 13, min_amount: 5000, lock_days: 30 },
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
  let client;
  try {
    client = await pool.connect();
    console.log('Seeding fee configuration...');
    for (const fee of FEES) {
      await client.query(
        `INSERT INTO fee_config (code, label, txn_type, min_amount, max_amount, fee_type, fee_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (code) DO NOTHING`,
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
    const hash = await bcrypt.hash(adminPassword, 12);
    if (!existingAdmin.rows.length) {
      console.log(`Creating first super-admin: ${adminEmail}`);
      await client.query(
        `INSERT INTO admin_users (full_name, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
        ['Super Admin', adminEmail, hash, 'admin']
      );
    } else {
      // Keeps the super-admin's password in sync with SEED_ADMIN_PASSWORD on every
      // deploy — otherwise, changing that Railway variable after the first deploy
      // silently has no effect, since the account already exists and would
      // otherwise just be skipped.
      console.log('Super-admin already exists — syncing password to current SEED_ADMIN_PASSWORD.');
      await client.query('UPDATE admin_users SET password_hash = $1, updated_at = now() WHERE email = $2', [hash, adminEmail]);
    }

    console.log('Seeding VTU products...');
    for (const p of VTU_PRODUCTS) {
      const exists = await client.query(
        'SELECT 1 FROM vtu_products WHERE category = $1 AND provider = $2 AND name = $3',
        [p.category, p.provider, p.name]
      );
      if (!exists.rows.length) {
        await client.query(
          'INSERT INTO vtu_products (category, provider, name, amount) VALUES ($1,$2,$3,$4)',
          [p.category, p.provider, p.name, p.amount]
        );
      }
    }

    console.log('Seeding loan products...');
    for (const p of LOAN_PRODUCTS) {
      const exists = await client.query('SELECT 1 FROM loan_products WHERE name = $1', [p.name]);
      if (!exists.rows.length) {
        await client.query(
          `INSERT INTO loan_products (name, min_amount, max_amount, interest_rate, tenor_days, min_kyc_tier, min_account_age_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [p.name, p.min_amount, p.max_amount, p.interest_rate, p.tenor_days, p.min_kyc_tier, p.min_account_age_days]
        );
      }
    }

    console.log('Seeding wealth products...');
    for (const p of WEALTH_PRODUCTS) {
      const exists = await client.query('SELECT 1 FROM wealth_products WHERE name = $1', [p.name]);
      if (!exists.rows.length) {
        await client.query(
          `INSERT INTO wealth_products (type, name, description, interest_rate, min_amount, lock_days)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [p.type, p.name, p.description, p.interest_rate, p.min_amount, p.lock_days]
        );
      }
    }

    console.log('✅ Seed complete.');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    await pool.end();
    // Belt-and-suspenders: force-exit so a dangling handle can never silently
    // stall the deploy chain (migrate && seed && start) the way it just did.
    process.exit(process.exitCode || 0);
  }
}

seed();
