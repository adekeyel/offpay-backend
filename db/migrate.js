/**
 * Simple, dependency-light migration runner.
 * Applies db/schema.sql in full. Safe to re-run (uses IF NOT EXISTS / DO blocks).
 * For a growing app, add numbered files to db/migrations/ and this script will
 * run them in order after the base schema, tracking applied ones in a table.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { encrypt, blindIndex } = require('../src/utils/encryption');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000, // fail loudly instead of hanging forever if the DB isn't reachable yet
});

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/**
 * One-time upgrade: encrypts any BVN still sitting in the old plaintext `bvn`
 * column into bvn_encrypted/bvn_hash, then drops the old column. Safe to run
 * on every deploy — it's a no-op the moment the `bvn` column no longer exists
 * (which is true for every fresh install, since schema.sql never creates it).
 */
async function migrateBvnEncryption(client) {
  const { rows: cols } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'bvn'`
  );
  if (!cols.length) return; // already migrated (or a fresh install that never had it)

  const { rows: pending } = await client.query(
    `SELECT id, bvn FROM users WHERE bvn IS NOT NULL AND bvn_encrypted IS NULL`
  );
  if (pending.length) {
    console.log(`Encrypting ${pending.length} existing BVN value(s)...`);
    for (const row of pending) {
      await client.query(
        'UPDATE users SET bvn_encrypted = $1, bvn_hash = $2 WHERE id = $3',
        [encrypt(row.bvn), blindIndex(row.bvn), row.id]
      );
    }
  }

  console.log('Dropping legacy plaintext bvn column...');
  await client.query('ALTER TABLE users ALTER COLUMN bvn_encrypted SET NOT NULL');
  await client.query('ALTER TABLE users ALTER COLUMN bvn_hash SET NOT NULL');
  await client.query('ALTER TABLE users DROP COLUMN bvn');
}

/**
 * Same upgrade as migrateBvnEncryption, for the nin column. No blind index
 * needed here (NIN isn't used as a uniqueness/lookup key anywhere today),
 * so this is a straight encrypt-and-drop.
 */
async function migrateNinEncryption(client) {
  const { rows: cols } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'nin'`
  );
  if (!cols.length) return;

  const { rows: pending } = await client.query(
    `SELECT id, nin FROM users WHERE nin IS NOT NULL AND nin_encrypted IS NULL`
  );
  if (pending.length) {
    console.log(`Encrypting ${pending.length} existing NIN value(s)...`);
    for (const row of pending) {
      await client.query('UPDATE users SET nin_encrypted = $1 WHERE id = $2', [encrypt(row.nin), row.id]);
    }
  }

  console.log('Dropping legacy plaintext nin column...');
  await client.query('ALTER TABLE users DROP COLUMN nin');
}

async function run() {
  let client;
  try {
    console.log('Connecting to database and applying base schema...');
    client = await pool.connect();
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schemaSql);
    await ensureMigrationsTable(client);
    await migrateBvnEncryption(client);
    await migrateNinEncryption(client);

    const migrationsDir = path.join(__dirname, 'migrations');
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
      for (const file of files) {
        const { rows } = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
        if (rows.length) {
          console.log(`Skipping already-applied migration: ${file}`);
          continue;
        }
        console.log(`Applying migration: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    }

    console.log('✅ Database schema is up to date.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    await pool.end();
    // Belt-and-suspenders: force-exit even if something (a dangling handle,
    // a slow driver internal) would otherwise keep the event loop alive and
    // silently stall the deploy chain (migrate && seed && start).
    process.exit(process.exitCode || 0);
  }
}

run();
