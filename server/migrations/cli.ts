/**
 * Migration CLI — invoked via npm scripts:
 *   npm run migrate:status   → list applied (with timestamps) + pending (with byte sizes)
 *   npm run migrate:dry-run  → show pending filenames, sizes, and first SQL statement
 */
import fs from 'fs';
import path from 'path';
import { listApplied, listPending, firstStatement } from './run';
import { pool } from '../db';

const command = process.argv[2];

/** Resolve the migrations directory whether running via ts-node or compiled JS. */
function resolveDir(): string {
  // When compiled: __dirname = dist/server/migrations (SQL files copied there by build:server).
  // When ts-node:  __dirname = server/migrations.
  // In both cases __dirname itself is correct — SQL files live alongside the runner.
  return __dirname;
}

async function status(): Promise<void> {
  const dir = resolveDir();
  const applied = await listApplied(dir);
  const pending = await listPending(dir);

  if (applied.length === 0) {
    console.log('Applied migrations: (none)');
  } else {
    console.log('Applied migrations:');
    for (const m of applied) {
      const ts = new Date(m.applied_at).toISOString();
      console.log(`  [applied] ${m.filename}  (applied_at: ${ts})`);
    }
  }

  console.log('');

  if (pending.length === 0) {
    console.log('Pending migrations: (none)');
  } else {
    console.log('Pending migrations:');
    for (const m of pending) {
      console.log(`  [pending] ${m.filename}  (${m.bytes} bytes)`);
    }
  }
}

async function dryRun(): Promise<void> {
  const dir = resolveDir();
  const pending = await listPending(dir);

  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  console.log('Pending migrations (dry-run — no changes applied):');
  for (const m of pending) {
    const filePath = path.join(dir, m.filename);
    const sql = fs.readFileSync(filePath, 'utf8');
    const summary = firstStatement(sql);
    console.log(`  ${m.filename}  (${m.bytes} bytes)`);
    console.log(`    first statement: ${summary}`);
  }
}

async function main(): Promise<void> {
  if (command === 'status') {
    await status();
  } else if (command === 'dry-run') {
    await dryRun();
  } else {
    console.error(`Unknown command: ${command ?? '(none)'}`);
    console.error('Usage: ts-node server/migrations/cli.ts status|dry-run');
    process.exit(1);
  }
}

main()
  .then(() => pool.end())
  .catch(err => { console.error(err); process.exit(1); });
