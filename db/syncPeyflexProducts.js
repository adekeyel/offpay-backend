/**
 * Pulls the REAL data-bundle and cable plan identifiers straight from
 * Peyflex's live API and upserts them into vtu_products, so purchases
 * actually use codes Peyflex recognizes instead of made-up/guessed ones.
 *
 * Run this:
 *   - once, right after setting PEYFLEX_API_KEY, to populate the catalog
 *   - again any time Peyflex changes their prices or plan list (their data
 *     bundle prices in particular can change without much notice)
 *
 * Usage:  npm run sync:peyflex
 * (needs DATABASE_URL and PEYFLEX_API_KEY set — same env vars as the app)
 *
 * What this intentionally does NOT touch:
 *   - Airtime: free-amount, no catalog rows needed (see schema.sql comment
 *     on vtu_products) — nothing to sync.
 *   - Electricity: also free-amount (customer enters how much to buy), but
 *     the exact DISCO identifiers Peyflex expects (e.g. 'ikeja-electric')
 *     differ from the abbreviations this app's UI currently hardcodes (e.g.
 *     'IKEDC') — this script prints Peyflex's real list at the end so you
 *     can update ELECTRICITY_PROVIDERS in src/controllers/vtu.controller.js
 *     to match exactly. Not auto-applied since that array is also used for
 *     display labels you may want to keep human-friendly.
 */
require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');

const BASE_URL = process.env.PEYFLEX_BASE_URL || 'https://client.peyflex.com.ng/api';
const API_KEY = process.env.PEYFLEX_API_KEY;

if (!API_KEY) {
  console.error('❌ PEYFLEX_API_KEY is not set. Set it (same env var the app uses), then re-run.');
  process.exit(1);
}

const peyflex = axios.create({
  baseURL: BASE_URL,
  headers: { Authorization: `Token ${API_KEY}`, 'Content-Type': 'application/json' },
  timeout: 20000,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000,
});

async function upsertProduct(client, { category, provider, name, code, amount }) {
  await client.query(
    `INSERT INTO vtu_products (category, provider, name, code, amount, active)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (category, provider, code) DO UPDATE
       SET name = EXCLUDED.name, amount = EXCLUDED.amount, active = true`,
    [category, provider, name, code, amount]
  );
}

async function syncData(client) {
  console.log('\n--- Data plans ---');
  const { data } = await peyflex.get('/data/networks/');
  const networks = data?.networks ?? [];
  let total = 0;
  for (const net of networks) {
    const identifier = net.identifier;
    try {
      const { data: plansRes } = await peyflex.get('/data/plans/', { params: { network: identifier } });
      const plans = plansRes?.plans ?? plansRes?.data ?? [];
      for (const plan of plans) {
        // Field names here follow the same shape as the confirmed cable
        // plans endpoint (plan_code/amount/description) — if Peyflex's
        // actual data-plans response differs, adjust the field lookups
        // below (run this script with DEBUG=1 to print the raw response).
        if (process.env.DEBUG) console.log(JSON.stringify(plan));
        const code = plan.plan_code ?? plan.code;
        const amount = parseFloat(plan.amount);
        const name = plan.description || plan.display || `${net.name} ${code}`;
        if (!code || !amount) continue;
        await upsertProduct(client, { category: 'data', provider: identifier, name, code, amount });
        total += 1;
      }
      console.log(`  ${net.name} (${identifier}): ${plans.length} plans`);
    } catch (err) {
      console.warn(`  ⚠️  Could not fetch plans for ${identifier}: ${err.response?.status || err.message}`);
    }
  }
  console.log(`Synced ${total} data plans.`);
}

async function syncCable(client) {
  console.log('\n--- Cable plans ---');
  const { data } = await peyflex.get('/cable/providers/');
  // CONFIRM: exact shape of /cable/providers/ wasn't in what was shared —
  // trying a couple of common shapes defensively.
  const providers = data?.providers ?? data?.data ?? (Array.isArray(data) ? data : []);
  let total = 0;
  for (const p of providers) {
    const identifier = p.identifier ?? p.code ?? p;
    const label = p.name ?? p.label ?? identifier;
    try {
      const { data: plansRes } = await peyflex.get(`/cable/plans/${identifier}/`);
      const plans = plansRes?.plans ?? [];
      for (const plan of plans) {
        const amount = parseFloat(plan.amount);
        if (!plan.plan_code || !amount) continue;
        await upsertProduct(client, {
          category: 'cable', provider: identifier, name: plan.description || plan.display, code: plan.plan_code, amount,
        });
        total += 1;
      }
      console.log(`  ${label} (${identifier}): ${plans.length} plans`);
    } catch (err) {
      console.warn(`  ⚠️  Could not fetch plans for ${identifier}: ${err.response?.status || err.message}`);
    }
  }
  console.log(`Synced ${total} cable plans.`);
}

async function printElectricityDiscos() {
  console.log('\n--- Electricity DISCOs (informational only — see header comment) ---');
  try {
    const { data } = await peyflex.get('/electricity/plans/', { params: { identifier: 'electricity' } });
    for (const plan of data?.plans ?? []) {
      console.log(`  ${plan.plan_name} -> plan code: "${plan.plan_code}"  (₦${plan.min_amount}–₦${plan.max_amount})`);
    }
    console.log('\nUpdate ELECTRICITY_PROVIDERS in src/controllers/vtu.controller.js to use these exact plan_code values.');
  } catch (err) {
    console.warn(`  ⚠️  Could not fetch electricity plans: ${err.response?.status || err.message}`);
  }
}

async function run() {
  const client = await pool.connect();
  try {
    await syncData(client);
    await syncCable(client);
    await printElectricityDiscos();
    console.log('\n✅ Peyflex catalog sync complete.');
  } catch (err) {
    console.error('❌ Sync failed:', err.response?.data || err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    process.exit(process.exitCode || 0);
  }
}

run();
