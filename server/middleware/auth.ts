import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AuthUser {
  id: number;
  username: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Prefer HttpOnly cookie; fall back to Authorization: Bearer for API clients.
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.cp_token;
  const header = req.headers.authorization;
  const bearerToken = header && header.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = cookieToken || bearerToken;
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as AuthUser;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
