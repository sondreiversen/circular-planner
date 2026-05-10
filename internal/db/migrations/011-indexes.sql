-- Indexes for foreign-key lookup columns that appear in hot query paths.
-- planner_group_shares(planner_id): serves the GROUP BY in the dashboard List
-- subquery and the NOT EXISTS in ListPublic.
-- planner_shares(planner_id): serves the NOT EXISTS in ListPublic and the
-- JOIN in Members.
-- activity_user_tags(planner_id): existing index leads on user_id so a
-- WHERE planner_id = ? is a full scan today.

CREATE INDEX IF NOT EXISTS idx_planner_group_shares_planner ON planner_group_shares(planner_id);
CREATE INDEX IF NOT EXISTS idx_planner_shares_planner ON planner_shares(planner_id);
CREATE INDEX IF NOT EXISTS idx_activity_user_tags_planner ON activity_user_tags(planner_id);
