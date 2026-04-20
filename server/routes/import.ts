import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { canAccess, sendError, handleRouteError } from '../middleware/access';
import { fetchCalendarEvents, type EwsConfig, type EwsCalendarQuery, type ImportedEvent } from '../ews/client';
import { mutationLimiter } from '../middleware/rateLimit';
import { randomUUID } from 'crypto';

const router = Router();
router.use(requireAuth);
router.use(mutationLimiter);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── In-memory job store ───────────────────────────────────────────────────────
//
// Implementation choice: polling (GET .../status/:jobId) rather than SSE.
// The existing POST route returns synchronously after validation; making it
// return a jobId immediately and have the client poll is the smallest change
// that fits the current request/response shape without adding SSE infrastructure.
//
// Jobs are keyed by a random UUID returned from POST. Cleaned up after 10 min.

interface ImportJob {
  state: 'running' | 'done' | 'failed';
  completed_pages: number;
  total_pages: number;
  last_error?: string;
  result?: { events: ImportedEvent[]; totalFound: number; errors: string[] };
  createdAt: number;
}

const jobs = new Map<string, ImportJob>();

const JOB_TTL_MS = 10 * 60 * 1_000; // 10 minutes

function pruneJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

function classifyError(msg: string): number {
  if (msg.includes('authentication failed')) return 401;
  if (msg.includes('timed out')) return 504;
  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('certificate')) return 502;
  if (msg.includes('Exchange returned an error')) return 422;
  return 500;
}

// POST /api/planners/:id/import/outlook
// Starts an async import job. Returns { jobId } immediately so the client can poll.
router.post('/:id/import/outlook', async (req: Request, res: Response): Promise<void> => {
  try {
    const plannerId = Number(req.params.id);
    if (!Number.isFinite(plannerId)) { sendError(res, 400, 'Invalid planner ID'); return; }

    await canAccess(plannerId, req.user!.id, 'edit');

    const { serverUrl, username, password, authMethod, startDate, endDate, allowSelfSignedCert } = req.body;

    // Validate required fields
    if (!serverUrl || typeof serverUrl !== 'string') {
      sendError(res, 400, 'serverUrl is required'); return;
    }
    if (!username || typeof username !== 'string') {
      sendError(res, 400, 'username is required'); return;
    }
    if (!password || typeof password !== 'string') {
      sendError(res, 400, 'password is required'); return;
    }
    if (!startDate || !DATE_RE.test(startDate)) {
      sendError(res, 400, 'startDate must be YYYY-MM-DD'); return;
    }
    if (!endDate || !DATE_RE.test(endDate)) {
      sendError(res, 400, 'endDate must be YYYY-MM-DD'); return;
    }

    // SSRF protection: require HTTPS and /ews/ path
    let parsedUrl: URL;
    try { parsedUrl = new URL(serverUrl); } catch {
      sendError(res, 400, 'Invalid serverUrl'); return;
    }
    if (parsedUrl.protocol !== 'https:') {
      sendError(res, 400, 'serverUrl must use HTTPS'); return;
    }
    if (!parsedUrl.pathname.includes('/ews/')) {
      sendError(res, 400, 'serverUrl must contain /ews/ path'); return;
    }

    pruneJobs();

    const method = authMethod === 'basic' ? 'basic' : 'ntlm';
    const config: EwsConfig = {
      serverUrl,
      username,
      password,
      authMethod: method,
      allowSelfSignedCert: !!allowSelfSignedCert,
    };
    const query: EwsCalendarQuery = { startDate, endDate };

    const jobId = randomUUID();
    const job: ImportJob = {
      state: 'running',
      completed_pages: 0,
      total_pages: 0,
      createdAt: Date.now(),
    };
    jobs.set(jobId, job);

    // Fire and forget — update job state as pages complete via onProgress callback
    fetchCalendarEvents(config, query, (completed, total) => {
      job.completed_pages = completed;
      job.total_pages = total;
    }).then(result => {
      job.state = 'done';
      job.result = result;
    }).catch(err => {
      job.state = 'failed';
      job.last_error = (err as Error).message || 'Import failed';
    });

    res.json({ jobId });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// GET /api/planners/:id/import/status/:jobId
// Poll for job progress. When state === 'done', result is included and job is removed.
router.get('/:id/import/status/:jobId', async (req: Request, res: Response): Promise<void> => {
  try {
    const plannerId = Number(req.params.id);
    if (!Number.isFinite(plannerId)) { sendError(res, 400, 'Invalid planner ID'); return; }

    await canAccess(plannerId, req.user!.id, 'view');

    const job = jobs.get(req.params.jobId);
    if (!job) { sendError(res, 404, 'Job not found or expired'); return; }

    if (job.state === 'done') {
      jobs.delete(req.params.jobId);
      res.json({
        state: 'done',
        completed_pages: job.completed_pages,
        total_pages: job.total_pages,
        result: job.result,
      });
    } else if (job.state === 'failed') {
      jobs.delete(req.params.jobId);
      const msg = job.last_error || 'Import failed';
      sendError(res, classifyError(msg), msg);
    } else {
      res.json({
        state: 'running',
        completed_pages: job.completed_pages,
        total_pages: job.total_pages,
        last_error: job.last_error,
      });
    }
  } catch (err) {
    handleRouteError(res, err);
  }
});

export default router;
