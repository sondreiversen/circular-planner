import { Router, Request, Response } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { sendError, handleRouteError } from '../middleware/access';

const router = Router();
router.use(requireAuth);

// GET /api/users?q=<search> — search users by username or email, limit 50
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const q = (req.query.q as string | undefined)?.trim() ?? '';
  if (!q) { res.json([]); return; }
  try {
    const { rows } = await query<{ id: number; username: string; email: string }>(
      `SELECT id, username, email FROM users
       WHERE username ILIKE $1 OR email ILIKE $1 OR gitlab_username ILIKE $1
       ORDER BY username
       LIMIT 50`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    handleRouteError(res, err);
  }
});

export default router;
