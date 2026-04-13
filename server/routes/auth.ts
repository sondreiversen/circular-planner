import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';

const router = Router();

function makeToken(user: { id: number; username: string; email: string }): string {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    config.jwtSecret,
    { expiresIn: '30d' }
  );
}

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    res.status(400).json({ error: 'username, email and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query<{ id: number; username: string; email: string }>(
      'INSERT INTO users(username, email, password_hash) VALUES($1,$2,$3) RETURNING id, username, email',
      [username.trim(), email.trim().toLowerCase(), hash]
    );
    const user = rows[0];
    res.json({ token: makeToken(user), user: { id: user.id, username: user.username, email: user.email } });
  } catch (err: unknown) {
    const pg = err as { code?: string };
    if (pg.code === '23505') {
      res.status(409).json({ error: 'Username or email already in use' });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }
  try {
    const { rows } = await query<{ id: number; username: string; email: string; password_hash: string | null }>(
      'SELECT id, username, email, password_hash FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    res.json({ token: makeToken(user), user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req: Request, res: Response): void => {
  res.json({ user: req.user });
});

// GET /api/auth/gitlab/status — lets the frontend know if SSO is configured
router.get('/gitlab/status', (_req: Request, res: Response): void => {
  res.json({ enabled: config.gitlab.enabled });
});

// GET /api/auth/gitlab/authorize — start the OAuth2 flow
router.get('/gitlab/authorize', (req: Request, res: Response): void => {
  if (!config.gitlab.enabled) {
    res.status(503).json({ error: 'GitLab SSO is not enabled' });
    return;
  }

  const state = crypto.randomBytes(16).toString('hex');
  // Store state in a signed, HttpOnly cookie (10 min TTL)
  res.cookie('cp_oauth_state', state, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    secure: !!(config.tlsCertFile && config.tlsKeyFile),
  });

  const params = new URLSearchParams({
    client_id: config.gitlab.clientId,
    redirect_uri: config.gitlab.redirectUri,
    response_type: 'code',
    scope: config.gitlab.scopes,
    state,
  });

  res.redirect(`${config.gitlab.instanceUrl}/oauth/authorize?${params}`);
});

// GET /api/auth/gitlab/callback — handle OAuth2 callback
router.get('/gitlab/callback', async (req: Request, res: Response): Promise<void> => {
  if (!config.gitlab.enabled) {
    res.status(503).send('GitLab SSO is not enabled');
    return;
  }

  const { code, state } = req.query as { code?: string; state?: string };
  const storedState = (req as any).signedCookies?.cp_oauth_state;

  // Clear the state cookie
  res.clearCookie('cp_oauth_state');

  if (!code || !state || state !== storedState) {
    res.status(400).send('Invalid OAuth state. Please try signing in again.');
    return;
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch(`${config.gitlab.instanceUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.gitlab.clientId,
        client_secret: config.gitlab.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: config.gitlab.redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      console.error('GitLab token exchange failed:', await tokenRes.text());
      res.status(502).send('Failed to exchange GitLab token. Please try again.');
      return;
    }

    const tokenData = await tokenRes.json() as { access_token: string };

    // Fetch GitLab user profile
    const userRes = await fetch(`${config.gitlab.instanceUrl}/api/v4/user`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) {
      console.error('GitLab user fetch failed:', await userRes.text());
      res.status(502).send('Failed to fetch GitLab user profile. Please try again.');
      return;
    }

    const gitlabUser = await userRes.json() as {
      id: number;
      username: string;
      email: string;
      name: string;
    };

    // Upsert user by gitlab_id
    let user: { id: number; username: string; email: string } | undefined;

    const existing = await query<{ id: number; username: string; email: string }>(
      'SELECT id, username, email FROM users WHERE gitlab_id = $1',
      [gitlabUser.id]
    );

    if (existing.rows.length > 0) {
      // Known GitLab user — update email/username in case they changed on GitLab
      const updated = await query<{ id: number; username: string; email: string }>(
        `UPDATE users SET gitlab_username = $1, email = $2
         WHERE gitlab_id = $3 RETURNING id, username, email`,
        [gitlabUser.username, gitlabUser.email, gitlabUser.id]
      );
      user = updated.rows[0];
    } else {
      // New GitLab user — pick a unique username
      let username = gitlabUser.username;
      const nameCheck = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM users WHERE username = $1', [username]
      );
      if (parseInt(nameCheck.rows[0].count) > 0) {
        username = `${username}-gl`;
      }

      const inserted = await query<{ id: number; username: string; email: string }>(
        `INSERT INTO users(username, email, gitlab_id, gitlab_username, auth_provider)
         VALUES($1, $2, $3, $4, 'gitlab')
         ON CONFLICT (email) DO UPDATE
           SET gitlab_id = EXCLUDED.gitlab_id,
               gitlab_username = EXCLUDED.gitlab_username,
               auth_provider = 'gitlab'
         RETURNING id, username, email`,
        [username, gitlabUser.email, gitlabUser.id, gitlabUser.username]
      );
      user = inserted.rows[0];
    }

    if (!user) {
      res.status(500).send('Failed to create or find user account.');
      return;
    }

    const token = makeToken(user);

    // Return a tiny HTML page that stores the token and redirects
    res.send(`<!DOCTYPE html>
<html><head><title>Signing in…</title></head><body>
<script>
try { localStorage.setItem('cp_token', ${JSON.stringify(token)}); } catch(e) {}
location.replace('/dashboard.html');
</script>
<noscript>JavaScript is required to complete sign-in.</noscript>
</body></html>`);
  } catch (err) {
    console.error('GitLab SSO callback error:', err);
    res.status(500).send('An error occurred during sign-in. Please try again.');
  }
});

export default router;
