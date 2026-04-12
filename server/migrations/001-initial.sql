CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50)  UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planners (
  id         SERIAL PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      VARCHAR(255) NOT NULL DEFAULT 'Untitled Planner',
  start_date DATE         NOT NULL,
  end_date   DATE         NOT NULL,
  created_at TIMESTAMPTZ  DEFAULT NOW(),
  updated_at TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lanes (
  id         VARCHAR(20) NOT NULL,
  planner_id INTEGER     NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  name       VARCHAR(255) NOT NULL,
  sort_order INTEGER      NOT NULL DEFAULT 0,
  color      VARCHAR(50)  NOT NULL DEFAULT '#ccc',
  PRIMARY KEY (id, planner_id)
);

CREATE TABLE IF NOT EXISTS activities (
  id          VARCHAR(20)  NOT NULL,
  lane_id     VARCHAR(20)  NOT NULL,
  planner_id  INTEGER      NOT NULL,
  title       VARCHAR(255) NOT NULL,
  description TEXT         NOT NULL DEFAULT '',
  start_date  DATE         NOT NULL,
  end_date    DATE         NOT NULL,
  color       VARCHAR(50)  NOT NULL DEFAULT '#4a90e2',
  PRIMARY KEY (id, planner_id),
  FOREIGN KEY (lane_id, planner_id) REFERENCES lanes(id, planner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS planner_shares (
  planner_id INTEGER     NOT NULL REFERENCES planners(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  permission VARCHAR(20) NOT NULL DEFAULT 'view',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (planner_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_planners_owner      ON planners(owner_id);
CREATE INDEX IF NOT EXISTS idx_lanes_planner       ON lanes(planner_id);
CREATE INDEX IF NOT EXISTS idx_activities_planner  ON activities(planner_id);
CREATE INDEX IF NOT EXISTS idx_shares_user         ON planner_shares(user_id);
