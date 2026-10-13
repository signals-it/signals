import { readdir, readFile } from 'node:fs/promises';
import { pool } from './db.js';
const root = new URL('../../../database/migrations/', import.meta.url);
const db = await pool.connect();
try {
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(714826)');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for (const name of (await readdir(root)).filter(n => n.endsWith('.sql')).sort()) {
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
    await db.query(await readFile(new URL(name, root), 'utf8'));
    await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    console.log(`Applied ${name}`);
  }
  await db.query('COMMIT');
} catch (error) { await db.query('ROLLBACK'); throw error; }
finally { db.release(); await pool.end(); }
