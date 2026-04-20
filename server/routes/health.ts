import { Router, Request, Response } from 'express';
import { pool } from '../db';
import fs from 'fs';
import path from 'path';

const router = Router();

const startTime = Date.now();

function getVersion(): string {
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const version = getVersion();

// GET /api/health — no auth required
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const uptime_s = Math.floor((Date.now() - startTime) / 1000);
  let dbUp = false;
  let applied_count = 0;
  let latest: string | null = null;

  try {
    await pool.query('SELECT 1');
    dbUp = true;

    const migResult = await pool.query<{ count: string; max: string | null }>(
      'SELECT COUNT(*)::text AS count, MAX(name) AS max FROM migrations'
    );
    applied_count = parseInt(migResult.rows[0]?.count || '0', 10);
    latest = migResult.rows[0]?.max ?? null;
  } catch {
    // db or migrations query failed — leave defaults
  }

  const status = dbUp ? 'ok' : 'degraded';
  res.status(dbUp ? 200 : 503).json({
    status,
    db: dbUp ? 'up' : 'down',
    migrations: { applied_count, latest },
    uptime_s,
    version,
  });
});

export default router;
