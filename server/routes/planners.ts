import { Router, Request, Response } from 'express';
import { query, pool } from '../db';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

interface LaneRow { id: string; name: string; sort_order: number; color: string; }
interface ActivityRow { id: string; lane_id: string; title: string; description: string; start_date: Date; end_date: Date; color: string; }

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Check if user has access; returns permission level or throws 403/404 */
async function checkAccess(
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
  const perm = shares[0].permission as 'view' | 'edit';
  if (require === 'edit' && perm !== 'edit') throw { status: 403, message: 'Edit access required' };
  return perm;
}

// GET /api/planners — list owned + shared
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  try {
    const { rows } = await query<{
      id: number; title: string; start_date: Date; end_date: Date;
      owner_id: number; owner_username: string; permission: string;
    }>(`
      SELECT p.id, p.title, p.start_date, p.end_date, p.owner_id,
             u.username AS owner_username,
             CASE WHEN p.owner_id = $1 THEN 'owner' ELSE ps.permission END AS permission
      FROM planners p
      JOIN users u ON u.id = p.owner_id
      LEFT JOIN planner_shares ps ON ps.planner_id = p.id AND ps.user_id = $1
      WHERE p.owner_id = $1 OR ps.user_id = $1
      ORDER BY p.updated_at DESC
    `, [userId]);

    res.json(rows.map(r => ({
      id: r.id,
      title: r.title,
      startDate: fmt(r.start_date),
      endDate: fmt(r.end_date),
      isOwner: r.owner_id === userId,
      permission: r.permission,
      ownerName: r.owner_username,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list planners' });
  }
});

// POST /api/planners — create
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { title, startDate, endDate } = req.body;
  if (!title || !startDate || !endDate) {
    res.status(400).json({ error: 'title, startDate and endDate are required' });
    return;
  }
  try {
    const { rows } = await query<{ id: number; title: string; start_date: Date; end_date: Date }>(
      'INSERT INTO planners(owner_id,title,start_date,end_date) VALUES($1,$2,$3,$4) RETURNING id,title,start_date,end_date',
      [userId, title, startDate, endDate]
    );
    const p = rows[0];
    res.status(201).json({ id: p.id, title: p.title, startDate: fmt(p.start_date), endDate: fmt(p.end_date) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create planner' });
  }
});

// GET /api/planners/:id — full planner with lanes + activities
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.id, 10);
  const userId = req.user!.id;
  try {
    await checkAccess(plannerId, userId, 'view');

    const { rows: [p] } = await query<{ id: number; owner_id: number; title: string; start_date: Date; end_date: Date }>(
      'SELECT id, owner_id, title, start_date, end_date FROM planners WHERE id=$1', [plannerId]
    );
    const { rows: lanes } = await query<LaneRow>(
      'SELECT id, name, sort_order, color FROM lanes WHERE planner_id=$1 ORDER BY sort_order', [plannerId]
    );
    const { rows: activities } = await query<ActivityRow>(
      'SELECT id, lane_id, title, description, start_date, end_date, color FROM activities WHERE planner_id=$1', [plannerId]
    );

    const laneMap = Object.fromEntries(lanes.map(l => [l.id, { ...l, activities: [] as ActivityRow[] }]));
    activities.forEach(a => { if (laneMap[a.lane_id]) laneMap[a.lane_id].activities.push(a); });

    res.json({
      config: {
        plannerId: p.id,
        title: p.title,
        startDate: fmt(p.start_date),
        endDate: fmt(p.end_date),
        isOwner: p.owner_id === userId,
        permission: p.owner_id === userId ? 'owner' : 'edit',
      },
      data: {
        lanes: Object.values(laneMap).map(l => ({
          id: l.id,
          name: l.name,
          order: l.sort_order,
          color: l.color,
          activities: l.activities.map(a => ({
            id: a.id,
            laneId: a.lane_id,
            title: a.title,
            description: a.description,
            startDate: fmt(a.start_date),
            endDate: fmt(a.end_date),
            color: a.color,
          })),
        })),
      },
    });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ error: e.message }); return; }
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch planner' });
  }
});

// PUT /api/planners/:id — update config + full data sync
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.id, 10);
  const userId = req.user!.id;
  try {
    await checkAccess(plannerId, userId, 'edit');

    const { title, startDate, endDate, lanes } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update planner metadata
      if (title || startDate || endDate) {
        await client.query(
          `UPDATE planners SET
            title      = COALESCE($1, title),
            start_date = COALESCE($2, start_date),
            end_date   = COALESCE($3, end_date),
            updated_at = NOW()
           WHERE id = $4`,
          [title ?? null, startDate ?? null, endDate ?? null, plannerId]
        );
      }

      // Sync lanes + activities
      if (Array.isArray(lanes)) {
        const incomingLaneIds = lanes.map((l: { id: string }) => l.id);
        // Delete removed lanes (cascade deletes their activities)
        if (incomingLaneIds.length > 0) {
          await client.query(
            `DELETE FROM lanes WHERE planner_id=$1 AND id != ALL($2::varchar[])`,
            [plannerId, incomingLaneIds]
          );
        } else {
          await client.query('DELETE FROM lanes WHERE planner_id=$1', [plannerId]);
        }

        for (const lane of lanes as { id: string; name: string; order: number; color: string; activities: { id: string; laneId: string; title: string; description: string; startDate: string; endDate: string; color: string }[] }[]) {
          await client.query(
            `INSERT INTO lanes(id, planner_id, name, sort_order, color)
             VALUES($1,$2,$3,$4,$5)
             ON CONFLICT (id, planner_id) DO UPDATE SET name=$3, sort_order=$4, color=$5`,
            [lane.id, plannerId, lane.name, lane.order, lane.color]
          );

          const incomingActIds = (lane.activities || []).map((a: { id: string }) => a.id);
          if (incomingActIds.length > 0) {
            await client.query(
              `DELETE FROM activities WHERE planner_id=$1 AND lane_id=$2 AND id != ALL($3::varchar[])`,
              [plannerId, lane.id, incomingActIds]
            );
          } else {
            await client.query('DELETE FROM activities WHERE planner_id=$1 AND lane_id=$2', [plannerId, lane.id]);
          }

          for (const act of (lane.activities || [])) {
            await client.query(
              `INSERT INTO activities(id, lane_id, planner_id, title, description, start_date, end_date, color)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (id, planner_id) DO UPDATE SET lane_id=$2, title=$4, description=$5, start_date=$6, end_date=$7, color=$8`,
              [act.id, act.laneId, plannerId, act.title, act.description || '', act.startDate, act.endDate, act.color]
            );
          }
        }
      }

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ error: e.message }); return; }
    console.error(err);
    res.status(500).json({ error: 'Failed to save planner' });
  }
});

// DELETE /api/planners/:id
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.id, 10);
  const userId = req.user!.id;
  try {
    await checkAccess(plannerId, userId, 'owner');
    await query('DELETE FROM planners WHERE id=$1', [plannerId]);
    res.json({ success: true });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    if (e.status) { res.status(e.status).json({ error: e.message }); return; }
    console.error(err);
    res.status(500).json({ error: 'Failed to delete planner' });
  }
});

export default router;
