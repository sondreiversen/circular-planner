import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { requestContext } from '../context';

declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id = (Array.isArray(incoming) ? incoming[0] : incoming) || crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  requestContext.run({ requestId: id }, next);
}
