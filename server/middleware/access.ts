import { Response } from 'express';
import { query } from '../db';

/** Resolve the calling user's access level to a planner, or throw a {status, message} error. */
export async function canAccess(
  plannerId: number,
  userId: number,
  require: 'view' | 'edit' | 'owner'
): Promise<'owner' | 'edit' | 'view'> {
  const { rows } = await query<{ owner_id: number }>(
    'SELECT owner_id FROM planners WHERE id = $1', [plannerId]
  );
  if (!rows.length) throw { status: 404, message: 'Planner not found' };

  if (rows[0].owner_id === userId) return 'owner';
  if (require === 'owner') throw { status: 403, message: 'Only the owner can do this' };

  const { rows: shares } = await query<{ permission: string }>(
    'SELECT permission FROM planner_shares WHERE planner_id=$1 AND user_id=$2', [plannerId, userId]
  );
  if (!shares.length) throw { status: 403, message: 'Access denied' };
  const perm = shares[0].permission;
  if (perm !== 'view' && perm !== 'edit') throw { status: 500, message: 'Invalid permission value in database' };
  if (require === 'edit' && perm !== 'edit') throw { status: 403, message: 'Edit access required' };
  return perm;
}

export function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

export function handleRouteError(res: Response, err: unknown): void {
  const e = err as { status?: number; message?: string };
  if (e.status) { sendError(res, e.status, e.message || 'Error'); return; }
  console.error(err);
  sendError(res, 500, 'Internal server error');
}
