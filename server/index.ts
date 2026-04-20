import express from 'express';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { pool } from './db';
import { runMigrations } from './migrations/run';
import { requestId } from './middleware/requestId';
import { requestLogger } from './middleware/logger';
import authRoutes from './routes/auth';
import plannerRoutes from './routes/planners';
import shareRoutes from './routes/share';
import importRoutes from './routes/import';
import groupRoutes from './routes/groups';
import userRoutes from './routes/users';
import healthRoutes from './routes/health';
import clientErrorRoutes from './routes/client-errors';

const app = express();

const isTls = !!(config.tlsCertFile && config.tlsKeyFile);

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Request ID — must be first so all downstream middleware can log it
app.use(requestId);

// JSON request logger
app.use(requestLogger);

// Helmet with working CSP for D3/inline SVG
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  hsts: isTls ? { maxAge: 31536000 } : false,
}));

app.use(cors({
  origin: config.allowedOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(config.jwtSecret)); // used for signed OAuth state cookie

// Health check — no auth required, mounted before API routes
app.use('/api/health', healthRoutes);

// Public branding endpoint — no auth required
app.get('/api/branding', (_req, res) => {
  res.json({ name: config.appName, logoUrl: config.appLogoUrl });
});

// API routes
app.use('/api/client-errors', clientErrorRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/planners', plannerRoutes);
app.use('/api/planners/:plannerId/shares', shareRoutes);
app.use('/api/planners', importRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/users', userRoutes);

// Serve built frontend
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

// SPA fallback for any unmatched GET
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// --- Graceful shutdown ---

const SHUTDOWN_TIMEOUT_MS = 10_000;

function gracefulShutdown(servers: (http.Server | https.Server)[], signal: string): void {
  console.log(`Received ${signal}. Starting graceful shutdown...`);

  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out after 10s. Forcing exit.');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  // Don't keep the process alive just for the timer
  if (forceExitTimer.unref) forceExitTimer.unref();

  let pending = servers.length;
  function onServerClosed(): void {
    pending -= 1;
    if (pending > 0) return;
    // All HTTP servers closed — drain the DB pool
    pool.end().then(() => {
      console.log('Database pool closed. Exiting cleanly.');
      clearTimeout(forceExitTimer);
      process.exit(0);
    }).catch(err => {
      console.error('Error closing database pool:', err);
      clearTimeout(forceExitTimer);
      process.exit(1);
    });
  }

  for (const server of servers) {
    server.close(onServerClosed);
  }
}

function startServers(): void {
  const servers: (http.Server | https.Server)[] = [];

  if (isTls) {
    const tlsOptions = {
      cert: fs.readFileSync(config.tlsCertFile!),
      key: fs.readFileSync(config.tlsKeyFile!),
    };

    const httpsServer = https.createServer(tlsOptions, app);
    httpsServer.listen(config.httpsPort, () => {
      console.log(`Circular Planner running at https://localhost:${config.httpsPort}`);
    });
    servers.push(httpsServer);

    // HTTP → HTTPS redirect (or plain HTTP when forceHttps is false)
    const httpApp = express();
    if (config.forceHttps) {
      httpApp.use((req, res) => {
        const host = (req.headers.host || '').replace(/:\d+$/, '');
        // Omit the port suffix when it's the default HTTPS port (e.g. behind a proxy on 443).
        const portSuffix = config.httpsPort === 443 ? '' : `:${config.httpsPort}`;
        res.redirect(301, `https://${host}${portSuffix}${req.url}`);
      });
    } else {
      httpApp.use(app);
    }
    const httpServer = http.createServer(httpApp);
    httpServer.listen(config.port, () => {
      console.log(`HTTP listener on port ${config.port}${config.forceHttps ? ' (→ HTTPS redirect)' : ''}`);
    });
    servers.push(httpServer);
  } else {
    console.warn('[WARNING] TLS_CERT_FILE / TLS_KEY_FILE not set — serving over HTTP only.');
    const httpServer = http.createServer(app);
    httpServer.listen(config.port, () => {
      console.log(`Circular Planner running at http://localhost:${config.port}`);
    });
    servers.push(httpServer);
  }

  process.on('SIGTERM', () => gracefulShutdown(servers, 'SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown(servers, 'SIGINT'));
}

runMigrations(path.join(__dirname, 'migrations'))
  .then(startServers)
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });

export default app;
