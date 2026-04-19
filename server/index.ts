import express from 'express';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { runMigrations } from './migrations/run';
import authRoutes from './routes/auth';
import plannerRoutes from './routes/planners';
import shareRoutes from './routes/share';
import importRoutes from './routes/import';
import groupRoutes from './routes/groups';
import userRoutes from './routes/users';

const app = express();

const isTls = !!(config.tlsCertFile && config.tlsKeyFile);

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// TODO: tune helmet CSP to allow D3/inline SVG; disabled for now to avoid breakage.
app.use(helmet({
  contentSecurityPolicy: false,
  hsts: isTls ? { maxAge: 31536000 } : false,
}));
app.use(cors({
  origin: config.allowedOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(config.jwtSecret)); // used for signed OAuth state cookie

// API routes
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

function startServers(): void {
  if (isTls) {
    const tlsOptions = {
      cert: fs.readFileSync(config.tlsCertFile!),
      key: fs.readFileSync(config.tlsKeyFile!),
    };

    https.createServer(tlsOptions, app).listen(config.httpsPort, () => {
      console.log(`Circular Planner running at https://localhost:${config.httpsPort}`);
    });

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
    http.createServer(httpApp).listen(config.port, () => {
      console.log(`HTTP listener on port ${config.port}${config.forceHttps ? ' (→ HTTPS redirect)' : ''}`);
    });
  } else {
    console.warn('[WARNING] TLS_CERT_FILE / TLS_KEY_FILE not set — serving over HTTP only.');
    http.createServer(app).listen(config.port, () => {
      console.log(`Circular Planner running at http://localhost:${config.port}`);
    });
  }
}

runMigrations(path.join(__dirname, 'migrations'))
  .then(startServers)
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });

export default app;
