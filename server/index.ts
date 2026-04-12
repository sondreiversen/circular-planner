import express from 'express';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import fs from 'fs';
import { config } from './config';
import { pool } from './db';
import authRoutes from './routes/auth';
import plannerRoutes from './routes/planners';
import shareRoutes from './routes/share';

async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY, filename VARCHAR(255) UNIQUE NOT NULL, applied_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rows } = await client.query('SELECT 1 FROM migrations WHERE filename=$1', [file]);
      if (rows.length) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO migrations(filename) VALUES($1)', [file]);
      await client.query('COMMIT');
      console.log(`  [migrated] ${file}`);
    }
  } finally {
    client.release();
  }
}

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/planners', plannerRoutes);
app.use('/api/planners/:plannerId/shares', shareRoutes);

// Serve built frontend in production
const publicDir = path.join(__dirname, '../../public');
const distDir = path.join(__dirname, '../../dist/public');
app.use(express.static(publicDir));
app.use('/js', express.static(path.join(distDir, 'js')));

// SPA fallback for any unmatched GET
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

runMigrations()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`Circular Planner running at http://localhost:${config.port}`);
    });
  })
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });

export default app;
