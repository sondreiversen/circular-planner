import fs from 'fs';
import path from 'path';
import { pool } from '../db';

export interface AppliedMigration {
  filename: string;
  applied_at: Date;
}

export interface PendingMigration {
  filename: string;
  bytes: number;
}

/** Returns all migrations recorded in the migrations table, sorted by filename. */
export async function listApplied(migrationsDir?: string): Promise<AppliedMigration[]> {
  const client = await pool.connect();
  try {
    // Ensure the table exists so this is safe to call on a fresh DB.
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id         SERIAL PRIMARY KEY,
        filename   VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const { rows } = await client.query<AppliedMigration>(
      'SELECT filename, applied_at FROM migrations ORDER BY filename'
    );
    return rows;
  } finally {
    client.release();
  }
}

/** Returns SQL files in migrationsDir that have not yet been applied. */
export async function listPending(migrationsDir?: string): Promise<PendingMigration[]> {
  const dir = migrationsDir ?? __dirname;
  const applied = await listApplied(migrationsDir);
  const appliedSet = new Set(applied.map(r => r.filename));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  return files
    .filter(f => !appliedSet.has(f))
    .map(f => ({
      filename: f,
      bytes: fs.statSync(path.join(dir, f)).size,
    }));
}

/** Returns the first non-comment, non-blank SQL statement from a SQL string (truncated to 80 chars). */
export function firstStatement(sql: string): string {
  const lines = sql.split('\n');
  const meaningful: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;
    meaningful.push(trimmed);
    // Stop once we have a complete statement or a reasonable chunk.
    if (meaningful.join(' ').includes(';') || meaningful.length >= 5) break;
  }
  const stmt = meaningful.join(' ').replace(/\s+/g, ' ').trim();
  return stmt.length > 80 ? stmt.slice(0, 77) + '...' : stmt;
}

export async function runMigrations(migrationsDir?: string): Promise<void> {
  const dir = migrationsDir ?? __dirname;
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id         SERIAL PRIMARY KEY,
        filename   VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Advisory lock prevents concurrent migration runs (e.g. duplicate server startups).
    await client.query('SELECT pg_advisory_lock($1)', [727274]);
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
      for (const file of files) {
        const { rows } = await client.query('SELECT 1 FROM migrations WHERE filename=$1', [file]);
        if (rows.length) { console.log(`  [skip] ${file}`); continue; }
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO migrations(filename) VALUES($1)', [file]);
        await client.query('COMMIT');
        console.log(`  [done] ${file}`);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(rbErr => console.error('Migration rollback error:', rbErr));
      throw err;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [727274]).catch(e => console.error('Advisory unlock error:', e));
    }
    console.log('Migrations complete.');
  } finally {
    client.release();
  }
}
