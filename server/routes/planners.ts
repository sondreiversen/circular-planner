import { Router, Request, Response } from 'express';
import { query, pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { canAccess, sendError, handleRouteError } from '../middleware/access';

const router = Router();
router.use(requireAuth);

interface LaneRow { id: string; name: string; sort_order: number; color: string; }
interface ActivityRow { id: string; lane_id: string; title: string; description: string; start_date: Date; end_date: Date; color: string; label: string; }

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
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
    handleRouteError(res, err);
  }
});

// POST /api/planners — create
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { title, startDate, endDate } = req.body;
  if (!title || !startDate || !endDate) {
    sendError(res, 400, 'title, startDate and endDate are required');
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
    handleRouteError(res, err);
  }
});

// GET /api/planners/:id — full planner with lanes + activities
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.id, 10);
  if (isNaN(plannerId)) { sendError(res, 400, 'Invalid planner ID'); return; }
  const userId = req.user!.id;
  try {
    await canAccess(plannerId, userId, 'view');

    const { rows: [p] } = await query<{ id: number; owner_id: number; title: string; start_date: Date; end_date: Date }>(
      'SELECT id, owner_id, title, start_date, end_date FROM planners WHERE id=$1', [plannerId]
    );
    const { rows: lanes } = await query<LaneRow>(
      'SELECT id, name, sort_order, color FROM lanes WHERE planner_id=$1 ORDER BY sort_order', [plannerId]
    );
    const { rows: activities } = await query<ActivityRow>(
      'SELECT id, lane_id, title, description, start_date, end_date, color, label FROM activities WHERE planner_id=$1', [plannerId]
    );

    const laneMap = new Map(lanes.map(l => [l.id, { ...l, activities: [] as ActivityRow[] }]));
    activities.forEach(a => { laneMap.get(a.lane_id)?.activities.push(a); });

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
        lanes: [...laneMap.values()].map(l => ({
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
            label: a.label || '',
          })),
        })),
      },
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

type LaneInput = {
  id: string; name: string; order: number; color: string;
  activities: { id: string; laneId: string; title: string; description: string; startDate: string; endDate: string; color: string; label: string }[];
};

// PUT /api/planners/:id — update config + full data sync (batched)
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.id, 10);
  if (isNaN(plannerId)) { sendError(res, 400, 'Invalid planner ID'); return; }
  const userId = req.user!.id;
  try {
    await canAccess(plannerId, userId, 'edit');

    const { title, startDate, endDate, lanes } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

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

      if (Array.isArray(lanes)) {
        const laneList = lanes as LaneInput[];
        const incomingLaneIds = laneList.map(l => l.id);

        // Delete removed lanes (CASCADE removes their activities)
        if (incomingLaneIds.length > 0) {
          await client.query(
            'DELETE FROM lanes WHERE planner_id=$1 AND id != ALL($2::varchar[])',
            [plannerId, incomingLaneIds]
          );
        } else {
          await client.query('DELETE FROM lanes WHERE planner_id=$1', [plannerId]);
        }

        // Batch-upsert all lanes in one statement
        if (laneList.length > 0) {
          await client.query(
            `INSERT INTO lanes(id, planner_id, name, sort_order, color)
             SELECT unnest($1::varchar[]), $2, unnest($3::varchar[]), unnest($4::int[]), unnest($5::varchar[])
             ON CONFLICT (id, planner_id) DO UPDATE
               SET name=EXCLUDED.name, sort_order=EXCLUDED.sort_order, color=EXCLUDED.color`,
            [
              laneList.map(l => l.id),
              plannerId,
              laneList.map(l => l.name),
              laneList.map(l => l.order),
              laneList.map(l => l.color),
            ]
          );
        }

        // Collect all activities across all lanes
        const allActivities = laneList.flatMap(l => l.activities || []);
        const incomingActIds = allActivities.map(a => a.id);

        // Delete removed activities in one shot
        if (incomingActIds.length > 0) {
          await client.query(
            'DELETE FROM activities WHERE planner_id=$1 AND id != ALL($2::varchar[])',
            [plannerId, incomingActIds]
          );
        } else {
          await client.query('DELETE FROM activities WHERE planner_id=$1', [plannerId]);
        }

        // Batch-upsert all activities in one statement
        if (allActivities.length > 0) {
          await client.query(
            `INSERT INTO activities(id, lane_id, planner_id, title, description, start_date, end_date, color, label)
             SELECT unnest($1::varchar[]), unnest($2::varchar[]), $3,
                    unnest($4::varchar[]), unnest($5::text[]),
                    unnest($6::date[]), unnest($7::date[]), unnest($8::varchar[]), unnest($9::varchar[])
             ON CONFLICT (id, planner_id) DO UPDATE
               SET lane_id=EXCLUDED.lane_id, title=EXCLUDED.title, description=EXCLUDED.description,
                   start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date, color=EXCLUDED.color,
                   label=EXCLUDED.label`,
            [
              allActivities.map(a => a.id),
              allActivities.map(a => a.laneId),
              plannerId,
              allActivities.map(a => a.title),
              allActivities.map(a => a.description || ''),
              allActivities.map(a => a.startDate),
              allActivities.map(a => a.endDate),
              allActivities.map(a => a.color),
              allActivities.map(a => a.label || ''),
            ]
          );
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
  } catch (err) {
    handleRouteError(res, err);
  }
});

// DELETE /api/planners/:id
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const plannerId = parseInt(req.params.id, 10);
  if (isNaN(plannerId)) { sendError(res, 400, 'Invalid planner ID'); return; }
  const userId = req.user!.id;
  try {
    await canAccess(plannerId, userId, 'owner');
    await query('DELETE FROM planners WHERE id=$1', [plannerId]);
    res.json({ success: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

export default router;
