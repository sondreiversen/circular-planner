import { Router, Request, Response } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { canAccess, sendError, handleRouteError } from '../middleware/access';
import { mutationLimiter } from '../middleware/rateLimit';

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(mutationLimiter);

// GET /api/planners/:plannerId/shares
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  if (isNaN(plannerId)) { sendError(res, 400, 'Invalid planner ID'); return; }
  try {
    await canAccess(plannerId, req.user!.id, 'owner');
    const { rows } = await query<{ user_id: number; username: string; email: string; permission: string }>(
      `SELECT u.id AS user_id, u.username, u.email, ps.permission
       FROM planner_shares ps JOIN users u ON u.id = ps.user_id
       WHERE ps.planner_id = $1`, [plannerId]
    );
    res.json(rows);
  } catch (err) {
    handleRouteError(res, err);
  }
});

// POST /api/planners/:plannerId/shares
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  if (isNaN(plannerId)) { sendError(res, 400, 'Invalid planner ID'); return; }
  try {
    await canAccess(plannerId, req.user!.id, 'owner');

    const { email, permission = 'view' } = req.body;
    if (!email) { sendError(res, 400, 'email is required'); return; }
    if (!['view', 'edit'].includes(permission)) { sendError(res, 400, 'permission must be view or edit'); return; }

    const { rows: users } = await query<{ id: number }>('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!users.length) { sendError(res, 404, 'No user with that email address'); return; }
    if (users[0].id === req.user!.id) { sendError(res, 400, 'Cannot share with yourself'); return; }

    await query(
      `INSERT INTO planner_shares(planner_id, user_id, permission)
       VALUES($1,$2,$3)
       ON CONFLICT (planner_id, user_id) DO UPDATE SET permission=$3`,
      [plannerId, users[0].id, permission]
    );
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// DELETE /api/planners/:plannerId/shares/:userId
router.delete('/:userId', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  if (isNaN(plannerId)) { sendError(res, 400, 'Invalid planner ID'); return; }
  const targetUserId = parseInt(req.params.userId, 10);
  if (isNaN(targetUserId)) { sendError(res, 400, 'Invalid user ID'); return; }
  try {
    await canAccess(plannerId, req.user!.id, 'owner');
    await query('DELETE FROM planner_shares WHERE planner_id=$1 AND user_id=$2', [plannerId, targetUserId]);
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// GET /api/planners/:plannerId/group-shares
router.get('/group-shares', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  if (isNaN(plannerId)) { sendError(res, 400, 'Invalid planner ID'); return; }
  try {
    await canAccess(plannerId, req.user!.id, 'owner');
    const { rows: groups } = await query<{
      group_id: number; name: string; default_permission: string; member_count: number;
    }>(
      `SELECT g.id AS group_id, g.name, pgs.default_permission,
              (SELECT COUNT(*) FROM group_members WHERE group_id = g.id)::int AS member_count
       FROM planner_group_shares pgs
       JOIN groups g ON g.id = pgs.group_id
       WHERE pgs.planner_id = $1
       ORDER BY g.name`,
      [plannerId]
    );
    const { rows: overrides } = await query<{
      group_id: number; user_id: number; username: string; permission: string;
    }>(
      `SELECT pgmo.group_id, pgmo.user_id, u.username, pgmo.permission
       FROM planner_group_member_overrides pgmo
       JOIN users u ON u.id = pgmo.user_id
       WHERE pgmo.planner_id = $1`,
      [plannerId]
    );
    const result = groups.map(g => ({
      ...g,
      overrides: overrides.filter(o => o.group_id === g.group_id),
    }));
    res.json(result);
  } catch (err) {
    handleRouteError(res, err);
  }
});

// POST /api/planners/:plannerId/group-shares — attach a group
router.post('/group-shares', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  if (isNaN(plannerId)) { sendError(res, 400, 'Invalid planner ID'); return; }
  try {
    await canAccess(plannerId, req.user!.id, 'owner');
    const { group_id, default_permission = 'view' } = req.body;
    if (!group_id) { sendError(res, 400, 'group_id is required'); return; }
    if (!['view', 'edit'].includes(default_permission)) { sendError(res, 400, 'default_permission must be view or edit'); return; }
    const gid = parseInt(group_id, 10);
    if (isNaN(gid)) { sendError(res, 400, 'Invalid group_id'); return; }
    const { rows: gcheck } = await query('SELECT id FROM groups WHERE id=$1', [gid]);
    if (!gcheck.length) { sendError(res, 404, 'Group not found'); return; }
    await query(
      `INSERT INTO planner_group_shares(planner_id, group_id, default_permission)
       VALUES($1,$2,$3)
       ON CONFLICT (planner_id, group_id) DO UPDATE SET default_permission=$3`,
      [plannerId, gid, default_permission]
    );
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// DELETE /api/planners/:plannerId/group-shares/:groupId
router.delete('/group-shares/:groupId', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  const groupId   = parseInt(req.params.groupId, 10);
  if (isNaN(plannerId) || isNaN(groupId)) { sendError(res, 400, 'Invalid ID'); return; }
  try {
    await canAccess(plannerId, req.user!.id, 'owner');
    await query('DELETE FROM planner_group_shares WHERE planner_id=$1 AND group_id=$2', [plannerId, groupId]);
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// PUT /api/planners/:plannerId/group-shares/:groupId/overrides/:userId
router.put('/group-shares/:groupId/overrides/:userId', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  const groupId   = parseInt(req.params.groupId, 10);
  const targetId  = parseInt(req.params.userId, 10);
  if (isNaN(plannerId) || isNaN(groupId) || isNaN(targetId)) { sendError(res, 400, 'Invalid ID'); return; }
  try {
    await canAccess(plannerId, req.user!.id, 'owner');
    const { permission } = req.body;
    if (!['view', 'edit'].includes(permission)) { sendError(res, 400, 'permission must be view or edit'); return; }
    const { rows: shareCheck } = await query(
      'SELECT 1 FROM planner_group_shares WHERE planner_id=$1 AND group_id=$2', [plannerId, groupId]
    );
    if (!shareCheck.length) { sendError(res, 404, 'Group share not found'); return; }
    await query(
      `INSERT INTO planner_group_member_overrides(planner_id, group_id, user_id, permission)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (planner_id, group_id, user_id) DO UPDATE SET permission=$4`,
      [plannerId, groupId, targetId, permission]
    );
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// DELETE /api/planners/:plannerId/group-shares/:groupId/overrides/:userId
router.delete('/group-shares/:groupId/overrides/:userId', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  const groupId   = parseInt(req.params.groupId, 10);
  const targetId  = parseInt(req.params.userId, 10);
  if (isNaN(plannerId) || isNaN(groupId) || isNaN(targetId)) { sendError(res, 400, 'Invalid ID'); return; }
  try {
    await canAccess(plannerId, req.user!.id, 'owner');
    await query(
      'DELETE FROM planner_group_member_overrides WHERE planner_id=$1 AND group_id=$2 AND user_id=$3',
      [plannerId, groupId, targetId]
    );
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

export default router;
