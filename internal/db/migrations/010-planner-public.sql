-- Allow planners to be made publicly visible to any logged-in user.
-- Uses INTEGER (0/1) for SQLite/Postgres compatibility.

ALTER TABLE planners ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_planners_is_public ON planners(is_public);
