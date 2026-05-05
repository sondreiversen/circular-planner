-- App-level settings stored in the database so they can be changed at runtime
-- without a server restart. The migration runner splits on semicolons, so no
-- semicolons appear inside comment lines.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
