import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';

export const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`,
  handler: (_req: Request, res: Response) => {
    const retryAfter = Math.ceil(
      (res.getHeader('Retry-After') as number | undefined ?? 60)
    );
    res.status(429).json({ error: 'rate_limited', retry_after_s: retryAfter });
  },
  skip: (req: Request) => req.method === 'GET',
});
