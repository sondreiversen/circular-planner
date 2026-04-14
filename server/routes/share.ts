import { Router, Request, Response } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { canAccess, sendError, handleRouteError } from '../middleware/access';

const router = Router({ mergeParams: true });
router.use(requireAuth);

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
  try {
    await canAccess(plannerId, req.user!.id, 'owner');
    await query('DELETE FROM planner_shares WHERE planner_id=$1 AND user_id=$2', [plannerId, req.params.userId]);
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

export default router;
