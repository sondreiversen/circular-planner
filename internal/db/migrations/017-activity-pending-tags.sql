CREATE TABLE IF NOT EXISTS activity_pending_tags (
  activity_id TEXT    NOT NULL,
  planner_id  INTEGER NOT NULL,
  username    TEXT    NOT NULL,
  PRIMARY KEY (activity_id, planner_id, username),
  FOREIGN KEY (activity_id, planner_id) REFERENCES activities(id, planner_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activity_pending_tags_username
  ON activity_pending_tags(username);
