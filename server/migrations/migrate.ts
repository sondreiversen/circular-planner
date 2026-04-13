import { runMigrations } from './run';
import { pool } from '../db';

runMigrations()
  .then(() => pool.end())
  .catch(err => { console.error('Migration failed:', err); process.exit(1); });
