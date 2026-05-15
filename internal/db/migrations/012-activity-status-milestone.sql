ALTER TABLE activities ADD COLUMN status TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE activities ADD COLUMN is_milestone INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_activities_status ON activities(planner_id, status);
