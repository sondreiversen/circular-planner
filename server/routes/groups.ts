import { Router, Request, Response } from 'express';
import { query, pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { sendError, handleRouteError } from '../middleware/access';

const router = Router();
router.use(requireAuth);

// GET /api/groups — list groups the current user is a member of
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  try {
    const { rows } = await query<{
      id: number; name: string; description: string | null;
      role: string; member_count: number;
    }>(
      `SELECT g.id, g.name, g.description, gm.role,
              (SELECT COUNT(*) FROM group_members WHERE group_id = g.id)::int AS member_count
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
       ORDER BY g.name`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    handleRouteError(res, err);
  }
});

// POST /api/groups — create a group; creator becomes admin
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { name, description } = req.body;
  if (!name?.trim()) { sendError(res, 400, 'name is required'); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number; name: string }>(
      'INSERT INTO groups(name, description, created_by) VALUES($1,$2,$3) RETURNING id, name',
      [name.trim(), description?.trim() || null, userId]
    );
    const groupId = rows[0].id;
    await client.query(
      'INSERT INTO group_members(group_id, user_id, role) VALUES($1,$2,$3)',
      [groupId, userId, 'admin']
    );
    await client.query('COMMIT');
    res.status(201).json({ id: groupId, name: rows[0].name, role: 'admin', member_count: 1 });
  } catch (err) {
    await client.query('ROLLBACK');
    handleRouteError(res, err);
  } finally {
    client.release();
  }
});

// GET /api/groups/:id — group detail with members
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId)) { sendError(res, 400, 'Invalid group ID'); return; }
  try {
    const { rows: [group] } = await query<{ id: number; name: string; description: string | null; role: string }>(
      `SELECT g.id, g.name, g.description, gm.role
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $2
       WHERE g.id = $1`,
      [groupId, userId]
    );
    if (!group) { sendError(res, 403, 'Access denied'); return; }

    const { rows: members } = await query<{
      user_id: number; username: string; email: string; role: string;
    }>(
      `SELECT u.id AS user_id, u.username, u.email, gm.role
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY u.username`,
      [groupId]
    );
    res.json({ ...group, members });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// PATCH /api/groups/:id — rename or update description (admin only)
router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId)) { sendError(res, 400, 'Invalid group ID'); return; }
  try {
    await requireGroupRole(groupId, userId, 'admin');
    const { name, description } = req.body;
    if (name !== undefined && !name?.trim()) { sendError(res, 400, 'name cannot be empty'); return; }
    await query(
      `UPDATE groups SET
         name        = COALESCE($2, name),
         description = CASE WHEN $3::text IS NULL THEN description ELSE $3 END
       WHERE id = $1`,
      [groupId, name?.trim() ?? null, description !== undefined ? (description?.trim() || null) : null]
    );
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// DELETE /api/groups/:id (admin only)
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId)) { sendError(res, 400, 'Invalid group ID'); return; }
  try {
    await requireGroupRole(groupId, userId, 'admin');
    await query('DELETE FROM groups WHERE id=$1', [groupId]);
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// POST /api/groups/:id/members — add a member (admin only)
router.post('/:id/members', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId)) { sendError(res, 400, 'Invalid group ID'); return; }
  const { user_id, role = 'member' } = req.body;
  if (!user_id) { sendError(res, 400, 'user_id is required'); return; }
  if (!['admin', 'member'].includes(role)) { sendError(res, 400, 'role must be admin or member'); return; }
  try {
    await requireGroupRole(groupId, userId, 'admin');
    const targetId = parseInt(user_id, 10);
    if (isNaN(targetId)) { sendError(res, 400, 'Invalid user_id'); return; }

    const { rows: userCheck } = await query('SELECT id FROM users WHERE id=$1', [targetId]);
    if (!userCheck.length) { sendError(res, 404, 'User not found'); return; }

    await query(
      `INSERT INTO group_members(group_id, user_id, role) VALUES($1,$2,$3)
       ON CONFLICT (group_id, user_id) DO UPDATE SET role=$3`,
      [groupId, targetId, role]
    );
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// PATCH /api/groups/:id/members/:userId — change role (admin only)
router.patch('/:id/members/:userId', async (req: Request, res: Response): Promise<void> => {
  const callerId = req.user!.id;
  const groupId = parseInt(req.params.id, 10);
  const targetId = parseInt(req.params.userId, 10);
  if (isNaN(groupId) || isNaN(targetId)) { sendError(res, 400, 'Invalid ID'); return; }
  const { role } = req.body;
  if (!['admin', 'member'].includes(role)) { sendError(res, 400, 'role must be admin or member'); return; }
  try {
    await requireGroupRole(groupId, callerId, 'admin');
    if (role === 'member') {
      await guardLastAdmin(groupId, targetId);
    }
    await query(
      'UPDATE group_members SET role=$3 WHERE group_id=$1 AND user_id=$2',
      [groupId, targetId, role]
    );
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// DELETE /api/groups/:id/members/:userId — remove member (admin, or self to leave)
router.delete('/:id/members/:userId', async (req: Request, res: Response): Promise<void> => {
  const callerId = req.user!.id;
  const groupId = parseInt(req.params.id, 10);
  const targetId = parseInt(req.params.userId, 10);
  if (isNaN(groupId) || isNaN(targetId)) { sendError(res, 400, 'Invalid ID'); return; }
  try {
    if (callerId !== targetId) {
      await requireGroupRole(groupId, callerId, 'admin');
    } else {
      // self-leave: verify caller is actually a member
      const { rows } = await query('SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2', [groupId, callerId]);
      if (!rows.length) { sendError(res, 403, 'Not a member'); return; }
    }
    await guardLastAdmin(groupId, targetId);
    await query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [groupId, targetId]);
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// --- helpers ---

async function requireGroupRole(groupId: number, userId: number, required: 'admin' | 'member'): Promise<void> {
  const { rows } = await query<{ role: string }>(
    'SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2', [groupId, userId]
  );
  if (!rows.length) throw { status: 403, message: 'Access denied' };
  if (required === 'admin' && rows[0].role !== 'admin') throw { status: 403, message: 'Admin access required' };
}

async function guardLastAdmin(groupId: number, targetUserId: number): Promise<void> {
  const { rows } = await query<{ role: string }>(
    'SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2', [groupId, targetUserId]
  );
  if (!rows.length || rows[0].role !== 'admin') return;
  const { rows: adminCount } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM group_members WHERE group_id=$1 AND role='admin'`, [groupId]
  );
  if (parseInt(adminCount[0].count, 10) <= 1) {
    throw { status: 400, message: 'Cannot remove or demote the last admin' };
  }
}

export default router;
