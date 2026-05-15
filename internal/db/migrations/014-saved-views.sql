CREATE TABLE IF NOT EXISTS saved_views (
  id          INTEGER PRIMARY KEY,
  planner_id  INTEGER NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  state       TEXT    NOT NULL,
  is_shared   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_saved_views_planner_user ON saved_views(planner_id, user_id);
