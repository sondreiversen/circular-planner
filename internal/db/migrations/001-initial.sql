CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    UNIQUE NOT NULL,
  email         TEXT    UNIQUE NOT NULL,
  password_hash TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS planners (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL DEFAULT 'Untitled Planner',
  start_date TEXT    NOT NULL,
  end_date   TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS lanes (
  id         TEXT    NOT NULL,
  planner_id INTEGER NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color      TEXT    NOT NULL DEFAULT '#ccc',
  PRIMARY KEY (id, planner_id)
);

CREATE TABLE IF NOT EXISTS activities (
  id          TEXT    NOT NULL,
  lane_id     TEXT    NOT NULL,
  planner_id  INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  start_date  TEXT    NOT NULL,
  end_date    TEXT    NOT NULL,
  color       TEXT    NOT NULL DEFAULT '#4a90e2',
  label       TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (id, planner_id),
  FOREIGN KEY (lane_id, planner_id) REFERENCES lanes(id, planner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS planner_shares (
  planner_id INTEGER NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  permission TEXT    NOT NULL DEFAULT 'view',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (planner_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_planners_owner     ON planners(owner_id);
CREATE INDEX IF NOT EXISTS idx_lanes_planner      ON lanes(planner_id);
CREATE INDEX IF NOT EXISTS idx_activities_planner ON activities(planner_id);
CREATE INDEX IF NOT EXISTS idx_shares_user        ON planner_shares(user_id);
