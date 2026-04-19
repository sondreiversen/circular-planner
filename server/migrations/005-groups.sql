CREATE TABLE groups (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  description TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE group_members (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role      VARCHAR(10) NOT NULL CHECK (role IN ('admin','member')),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user_idx ON group_members(user_id);

CREATE TABLE planner_group_shares (
  planner_id         INTEGER NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  group_id           INTEGER NOT NULL REFERENCES groups(id)   ON DELETE CASCADE,
  default_permission VARCHAR(10) NOT NULL CHECK (default_permission IN ('view','edit')),
  PRIMARY KEY (planner_id, group_id)
);

CREATE TABLE planner_group_member_overrides (
  planner_id INTEGER NOT NULL,
  group_id   INTEGER NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(10) NOT NULL CHECK (permission IN ('view','edit')),
  PRIMARY KEY (planner_id, group_id, user_id),
  FOREIGN KEY (planner_id, group_id)
    REFERENCES planner_group_shares(planner_id, group_id) ON DELETE CASCADE
);
