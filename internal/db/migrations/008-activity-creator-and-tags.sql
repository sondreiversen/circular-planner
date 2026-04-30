-- Track who created each activity. NULL for pre-existing rows (no backfill).
-- Uses SQLite syntax - db.Rebind() handles Postgres placeholder translation.

ALTER TABLE activities ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Many-to-many tagging of users on activities.
CREATE TABLE IF NOT EXISTS activity_user_tags (
  activity_id TEXT    NOT NULL,
  planner_id  INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  PRIMARY KEY (activity_id, planner_id, user_id),
  FOREIGN KEY (activity_id, planner_id) REFERENCES activities(id, planner_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activity_user_tags_user
  ON activity_user_tags(user_id, planner_id);
