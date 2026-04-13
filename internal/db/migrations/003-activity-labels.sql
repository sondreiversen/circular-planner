-- label column already included in 001-initial.sql for fresh installs;
-- this migration is a no-op on Go-bootstrapped DBs but adds the column to
-- any existing DB that was created by the Node server's schema.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
