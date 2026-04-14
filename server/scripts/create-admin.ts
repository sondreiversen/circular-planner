/**
 * create-admin.ts — bootstrap an admin user.
 *
 * Usage:
 *   node dist/server/scripts/create-admin.js --username=admin --email=a@b.c --password=...
 *
 * Missing args are prompted via readline (called once at install, so visible
 * password input is fine).
 *
 * Idempotent: if a user with the given email OR username already exists, its
 * password is updated and is_admin is set to TRUE.
 */
import path from 'path';
import readline from 'readline';
import bcrypt from 'bcryptjs';
import { pool } from '../db';
import { runMigrations } from '../migrations/run';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const eqMatch = /^--([^=]+)=(.*)$/.exec(args[i]);
    if (eqMatch) { out[eqMatch[1]] = eqMatch[2]; continue; }
    const keyMatch = /^--([^=]+)$/.exec(args[i]);
    if (keyMatch && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      out[keyMatch[1]] = args[++i];
    }
  }
  return out;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const isTty = !!(process.stdout.isTTY ?? process.stdin.isTTY);

  let username = args.username || '';
  let email = args.email || '';
  let password = args.password || '';

  if (!username) {
    if (!isTty) throw new Error('--username is required (stdin is not a TTY)');
    username = (await prompt('Admin username: ')).trim();
  }
  if (!email) {
    if (!isTty) throw new Error('--email is required (stdin is not a TTY)');
    email = (await prompt('Admin email: ')).trim();
  }
  if (!password) {
    if (!isTty) throw new Error('--password is required (stdin is not a TTY)');
    // Visible input — this tool is called once at install.
    password = await prompt('Admin password (min 8 chars, visible): ');
  }

  username = username.trim();
  email = email.trim().toLowerCase();

  if (!username) throw new Error('username must not be empty');
  if (!email.includes('@')) throw new Error('email must contain @');
  if (password.length < 8) throw new Error('password must be at least 8 characters');

  // Run migrations first so is_admin column exists.
  await runMigrations(path.join(__dirname, '..', 'migrations'));

  const hash = await bcrypt.hash(password, 10);

  const existing = await pool.query<{ id: number; username: string }>(
    'SELECT id, username FROM users WHERE email = $1 OR username = $2',
    [email, username]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    await pool.query(
      `UPDATE users
         SET password_hash = $1,
             is_admin = TRUE,
             auth_provider = 'local'
       WHERE id = $2`,
      [hash, row.id]
    );
    console.log(`Admin user ${row.username} created/updated.`);
  } else {
    await pool.query(
      `INSERT INTO users(username, email, password_hash, auth_provider, is_admin)
       VALUES($1, $2, $3, 'local', TRUE)`,
      [username, email, hash]
    );
    console.log(`Admin user ${username} created/updated.`);
  }
}

main()
  .then(() => pool.end().then(() => process.exit(0)))
  .catch(err => {
    console.error('create-admin failed:', err.message || err);
    pool.end().finally(() => process.exit(1));
  });
