-- Add GitLab SSO columns to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS gitlab_id BIGINT UNIQUE,
  ADD COLUMN IF NOT EXISTS gitlab_username VARCHAR(255),
  ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(16) NOT NULL DEFAULT 'local';

-- Allow password_hash to be null for SSO-only users
ALTER TABLE users
  ALTER COLUMN password_hash DROP NOT NULL;
