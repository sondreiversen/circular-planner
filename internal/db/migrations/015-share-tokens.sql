CREATE TABLE IF NOT EXISTS share_tokens (
  token       TEXT    PRIMARY KEY,
  planner_id  INTEGER NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_planner ON share_tokens(planner_id);
