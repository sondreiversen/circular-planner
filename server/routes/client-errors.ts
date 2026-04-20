import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';

const router = Router();

// 4 KB body parser applied only to this route
const jsonSmall = express.json({ limit: '4kb' });

// Rate limit: 30 reports/min per IP — no auth required
const clientErrorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `ip:${req.ip}`,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({ error: 'rate_limited' });
  },
});

interface ClientErrorBody {
  message?: unknown;
  stack?: unknown;
  url?: unknown;
  line?: unknown;
  col?: unknown;
  ua?: unknown;
  ts?: unknown;
}

router.post('/', clientErrorLimiter, jsonSmall, (req: Request, res: Response) => {
  const b = (req.body ?? {}) as ClientErrorBody;
  console.error(JSON.stringify({
    level: 'client-error',
    message: String(b.message ?? ''),
    stack: b.stack ?? null,
    url: b.url ?? null,
    line: b.line ?? null,
    col: b.col ?? null,
    ua: b.ua ?? null,
    ts: b.ts ?? new Date().toISOString(),
  }));
  res.status(204).end();
});

export default router;
