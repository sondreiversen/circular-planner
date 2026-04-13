ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS label VARCHAR(64) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_activities_label ON activities(planner_id, label);
