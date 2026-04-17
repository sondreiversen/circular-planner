import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { canAccess, sendError, handleRouteError } from '../middleware/access';
import { fetchCalendarEvents, type EwsConfig, type EwsCalendarQuery } from '../ews/client';

const router = Router();
router.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/planners/:id/import/outlook
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

    const method = authMethod === 'basic' ? 'basic' : 'ntlm';

    const config: EwsConfig = {
      serverUrl,
      username,
      password,
      authMethod: method,
      allowSelfSignedCert: !!allowSelfSignedCert,
    };
    const query: EwsCalendarQuery = { startDate, endDate };

    const result = await fetchCalendarEvents(config, query);
    res.json(result);
  } catch (err) {
    const msg = (err as Error).message || 'Import failed';
    // Distinguish auth errors from server errors
    if (msg.includes('authentication failed')) {
      sendError(res, 401, msg);
    } else if (msg.includes('timed out')) {
      sendError(res, 504, msg);
    } else if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('certificate')) {
      sendError(res, 502, `Cannot reach Exchange server: ${msg}`);
    } else if (msg.includes('Exchange returned an error')) {
      sendError(res, 422, msg);
    } else {
      handleRouteError(res, err);
    }
  }
});

export default router;
