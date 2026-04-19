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

  // Direct per-user share
  const { rows: shares } = await query<{ permission: string }>(
    'SELECT permission FROM planner_shares WHERE planner_id=$1 AND user_id=$2', [plannerId, userId]
  );
  if (shares.length) {
    const perm = shares[0].permission;
    if (perm !== 'view' && perm !== 'edit') throw { status: 500, message: 'Invalid permission value in database' };
    if (require === 'edit' && perm !== 'edit') throw { status: 403, message: 'Edit access required' };
    return perm;
  }

  // Group-based access: find best permission across all groups the user belongs to
  const { rows: groupPerms } = await query<{ permission: string }>(
    `SELECT COALESCE(pgmo.permission, pgs.default_permission) AS permission
     FROM planner_group_shares pgs
     JOIN group_members gm ON gm.group_id = pgs.group_id AND gm.user_id = $2
     LEFT JOIN planner_group_member_overrides pgmo
       ON pgmo.planner_id = pgs.planner_id
      AND pgmo.group_id   = pgs.group_id
      AND pgmo.user_id    = $2
     WHERE pgs.planner_id = $1`,
    [plannerId, userId]
  );

  if (groupPerms.length) {
    const perm = groupPerms.some(r => r.permission === 'edit') ? 'edit' : 'view';
    if (require === 'edit' && perm !== 'edit') throw { status: 403, message: 'Edit access required' };
    return perm;
  }

  throw { status: 403, message: 'Access denied' };
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
