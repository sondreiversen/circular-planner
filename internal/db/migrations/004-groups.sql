-- Groups, group membership, and group-based planner sharing.
-- Uses SQLite syntax. translateSQL() promotes types for Postgres.

CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role     TEXT    NOT NULL CHECK (role IN ('admin','member')),
  added_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members(user_id);

CREATE TABLE IF NOT EXISTS planner_group_shares (
  planner_id         INTEGER NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  group_id           INTEGER NOT NULL REFERENCES groups(id)   ON DELETE CASCADE,
  default_permission TEXT    NOT NULL CHECK (default_permission IN ('view','edit')),
  PRIMARY KEY (planner_id, group_id)
);

CREATE TABLE IF NOT EXISTS planner_group_member_overrides (
  planner_id INTEGER NOT NULL,
  group_id   INTEGER NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT    NOT NULL CHECK (permission IN ('view','edit')),
  PRIMARY KEY (planner_id, group_id, user_id),
  FOREIGN KEY (planner_id, group_id)
    REFERENCES planner_group_shares(planner_id, group_id) ON DELETE CASCADE
);
