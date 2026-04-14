-- No-op on Go-bootstrapped DBs: the label column is already defined in 001-initial.sql.
-- Kept as a tracked migration so schema_migrations matches across deployments.
SELECT 1;
