#!/usr/bin/env ts-node
/**
 * doctor.ts — preflight check for Circular Planner (Node/Postgres backend)
 *
 * Run via:  npm run doctor
 *
 * Exit codes:
 *   0  all checks PASS or WARN
 *   1  one or more checks FAIL
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
type Status = 'PASS' | 'WARN' | 'FAIL';

interface CheckResult {
  label: string;
  status: Status;
  detail: string;
  remediation?: string;
}

const results: CheckResult[] = [];

function record(
  label: string,
  status: Status,
  detail: string,
  remediation?: string,
): void {
  results.push({ label, status, detail, remediation });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function freeDiskBytes(dir: string): number {
  try {
    // fs.statfsSync is available in Node ≥ 19; fall back to statvfs-style
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stat = (fs as any).statfsSync(dir);
    return stat.bfree * stat.bsize;
  } catch {
    return -1;
  }
}

function fmtBytes(b: number): string {
  if (b < 0) return 'unknown';
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`;
}

// ---------------------------------------------------------------------------
// Check 1 — Node version
// ---------------------------------------------------------------------------
function checkNodeVersion(): void {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 20) {
    record('Node version', 'PASS', `Node ${process.versions.node}`);
  } else {
    record(
      'Node version',
      'FAIL',
      `Node ${process.versions.node} (need ≥ 20)`,
      'Install Node 20 LTS from https://nodejs.org or via nvm: nvm install 20',
    );
  }
}

// ---------------------------------------------------------------------------
// Check 2 — JWT_SECRET
// ---------------------------------------------------------------------------
function checkJwtSecret(): void {
  const secret = process.env.JWT_SECRET ?? '';
  if (!secret) {
    record(
      'JWT_SECRET',
      'FAIL',
      'Not set',
      'Generate one: openssl rand -hex 32  and set JWT_SECRET in .env',
    );
  } else if (secret.length < 32) {
    record(
      'JWT_SECRET',
      'FAIL',
      `Set but only ${secret.length} chars (need ≥ 32)`,
      'Generate one: openssl rand -hex 32  and set JWT_SECRET in .env',
    );
  } else {
    record('JWT_SECRET', 'PASS', `Set (${secret.length} chars)`);
  }
}

// ---------------------------------------------------------------------------
// Check 3 — Postgres reachable
// Check 4 — Migration state
// Check 6 — Postgres connection count vs max_connections
// (all share one pool)
// ---------------------------------------------------------------------------
async function checkPostgres(): Promise<void> {
  const dbUrl =
    process.env.DATABASE_URL ?? 'postgresql://localhost:5432/circular_planner';

  const pool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });

  try {
    // ---- reachability ----
    const { rows: vRows } = await pool.query<{ version: string }>(
      'SELECT version()',
    );
    record('Postgres reachable', 'PASS', vRows[0].version.split(',')[0]);

    // ---- migration state ----
    await checkMigrationState(pool);

    // ---- connection count ----
    await checkConnectionCount(pool);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    record(
      'Postgres reachable',
      'FAIL',
      `Cannot connect: ${msg}`,
      `Check DATABASE_URL (currently: ${dbUrl.replace(/:\/\/[^@]+@/, '://<credentials>@')}) and ensure Postgres is running`,
    );
    // Skip dependent checks
    record('Migration state', 'FAIL', 'Skipped — Postgres unreachable');
    record('Postgres connections', 'FAIL', 'Skipped — Postgres unreachable');
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function checkMigrationState(pool: Pool): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '../server/migrations');

  let appliedFiles: Set<string>;
  try {
    const { rows } = await pool.query<{ filename: string }>(
      'SELECT filename FROM migrations ORDER BY filename',
    );
    appliedFiles = new Set(rows.map((r) => r.filename));
  } catch {
    // migrations table may not exist yet
    appliedFiles = new Set();
  }

  let sqlFiles: string[] = [];
  try {
    sqlFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    record(
      'Migration state',
      'WARN',
      `Could not read migrations dir: ${migrationsDir}`,
    );
    return;
  }

  const pending = sqlFiles.filter((f) => !appliedFiles.has(f));

  if (pending.length === 0) {
    record(
      'Migration state',
      'PASS',
      `All ${sqlFiles.length} migration(s) applied`,
    );
  } else {
    record(
      'Migration state',
      'WARN',
      `${pending.length} pending migration(s): ${pending.join(', ')}`,
      'Run:  npm run migrate',
    );
  }
}

async function checkConnectionCount(pool: Pool): Promise<void> {
  try {
    const { rows } = await pool.query<{
      current_connections: string;
      max_connections: string;
    }>(`
      SELECT
        (SELECT count(*) FROM pg_stat_activity) AS current_connections,
        current_setting('max_connections')       AS max_connections
    `);

    const current = parseInt(rows[0].current_connections, 10);
    const max = parseInt(rows[0].max_connections, 10);
    const pct = max > 0 ? Math.round((current / max) * 100) : 0;
    const detail = `${current} / ${max} connections used (${pct}%)`;

    if (pct > 80) {
      record(
        'Postgres connections',
        'WARN',
        detail,
        'Consider increasing max_connections in postgresql.conf or reducing pool size',
      );
    } else {
      record('Postgres connections', 'PASS', detail);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    record('Postgres connections', 'WARN', `Could not check: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Check 5 — Free disk in DATA_DIR
// ---------------------------------------------------------------------------
function checkDataDirDisk(): void {
  const dir = process.env.DATA_DIR ?? './data';
  const abs = path.resolve(dir);

  // Ensure the directory exists before statfsSync
  if (!fs.existsSync(abs)) {
    record('Disk (DATA_DIR)', 'WARN', `${abs} does not exist yet`);
    return;
  }

  const free = freeDiskBytes(abs);
  const GB = 1024 ** 3;

  if (free < 0) {
    record('Disk (DATA_DIR)', 'WARN', `${abs} — could not determine free space`);
  } else if (free < GB) {
    record(
      'Disk (DATA_DIR)',
      'WARN',
      `${fmtBytes(free)} free in ${abs}`,
      'Free up disk space or mount a larger volume',
    );
  } else {
    record('Disk (DATA_DIR)', 'PASS', `${fmtBytes(free)} free in ${abs}`);
  }
}

// ---------------------------------------------------------------------------
// Check 6 — Free disk in BACKUP_DIR (if set)
// ---------------------------------------------------------------------------
function checkBackupDirDisk(): void {
  const dir = process.env.BACKUP_DIR;
  if (!dir) {
    // Not configured — skip silently
    return;
  }

  const abs = path.resolve(dir);
  const GB = 1024 ** 3;

  if (!fs.existsSync(abs)) {
    record(
      'Disk (BACKUP_DIR)',
      'WARN',
      `${abs} does not exist — backups will fail`,
      `Create the directory: mkdir -p ${abs}`,
    );
    return;
  }

  const free = freeDiskBytes(abs);

  if (free < 0) {
    record('Disk (BACKUP_DIR)', 'WARN', `${abs} — could not determine free space`);
  } else if (free < GB) {
    record(
      'Disk (BACKUP_DIR)',
      'WARN',
      `${fmtBytes(free)} free in ${abs}`,
      'Free up disk space — backups may fail when disk is full',
    );
  } else {
    record('Disk (BACKUP_DIR)', 'PASS', `${fmtBytes(free)} free in ${abs}`);
  }
}

// ---------------------------------------------------------------------------
// Print results + exit
// ---------------------------------------------------------------------------
function printResults(): void {
  const width = Math.max(...results.map((r) => r.label.length)) + 2;

  console.log('\nCircular Planner — preflight check\n');

  for (const r of results) {
    const badge =
      r.status === 'PASS' ? '✓ PASS' : r.status === 'WARN' ? '⚠ WARN' : '✗ FAIL';
    const label = r.label.padEnd(width);
    console.log(`  ${badge}  ${label} ${r.detail}`);
    if (r.remediation && r.status !== 'PASS') {
      console.log(`         ${''.padEnd(width)} → ${r.remediation}`);
    }
  }

  const fails = results.filter((r) => r.status === 'FAIL').length;
  const warns = results.filter((r) => r.status === 'WARN').length;

  console.log(
    `\n  ${results.length} check(s): ${results.length - fails - warns} passed, ${warns} warned, ${fails} failed\n`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  checkNodeVersion();
  checkJwtSecret();
  await checkPostgres();
  checkDataDirDisk();
  checkBackupDirDisk();

  printResults();

  const anyFail = results.some((r) => r.status === 'FAIL');
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error('Doctor crashed:', err);
  process.exit(1);
});
