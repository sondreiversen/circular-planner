import { Router, Request, Response } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';

const router = Router({ mergeParams: true });
router.use(requireAuth);

async function requireOwner(plannerId: number, userId: number, res: Response): Promise<boolean> {
  const { rows } = await query<{ owner_id: number }>('SELECT owner_id FROM planners WHERE id=$1', [plannerId]);
  if (!rows.length) { res.status(404).json({ error: 'Planner not found' }); return false; }
  if (rows[0].owner_id !== userId) { res.status(403).json({ error: 'Only the owner can manage shares' }); return false; }
  return true;
}

// GET /api/planners/:plannerId/shares
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  if (!(await requireOwner(plannerId, req.user!.id, res))) return;
  const { rows } = await query<{ user_id: number; username: string; email: string; permission: string }>(
    `SELECT u.id AS user_id, u.username, u.email, ps.permission
     FROM planner_shares ps JOIN users u ON u.id = ps.user_id
     WHERE ps.planner_id = $1`, [plannerId]
  );
  res.json(rows);
});

// POST /api/planners/:plannerId/shares
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  if (!(await requireOwner(plannerId, req.user!.id, res))) return;

  const { email, permission = 'view' } = req.body;
  if (!email) { res.status(400).json({ error: 'email is required' }); return; }
  if (!['view', 'edit'].includes(permission)) { res.status(400).json({ error: 'permission must be view or edit' }); return; }

  const { rows: users } = await query<{ id: number }>('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
  if (!users.length) { res.status(404).json({ error: 'No user with that email address' }); return; }
  if (users[0].id === req.user!.id) { res.status(400).json({ error: 'Cannot share with yourself' }); return; }

  await query(
    `INSERT INTO planner_shares(planner_id, user_id, permission)
     VALUES($1,$2,$3)
     ON CONFLICT (planner_id, user_id) DO UPDATE SET permission=$3`,
    [plannerId, users[0].id, permission]
  );
  res.json({ success: true });
});

// DELETE /api/planners/:plannerId/shares/:userId
router.delete('/:userId', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.plannerId, 10);
  if (!(await requireOwner(plannerId, req.user!.id, res))) return;
  await query('DELETE FROM planner_shares WHERE planner_id=$1 AND user_id=$2', [plannerId, req.params.userId]);
  res.json({ success: true });
});

export default router;
