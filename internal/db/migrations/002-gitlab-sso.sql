ALTER TABLE users ADD COLUMN gitlab_id       INTEGER;
ALTER TABLE users ADD COLUMN gitlab_username TEXT;
ALTER TABLE users ADD COLUMN auth_provider   TEXT NOT NULL DEFAULT 'local';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_gitlab_id ON users(gitlab_id) WHERE gitlab_id IS NOT NULL;
