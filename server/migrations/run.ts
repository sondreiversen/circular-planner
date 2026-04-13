import fs from 'fs';
import path from 'path';
import { pool } from '../db';

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
    console.log('Migrations complete.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
