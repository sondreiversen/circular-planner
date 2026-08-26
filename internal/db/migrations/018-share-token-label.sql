-- Give share tokens an optional human-readable label.
--
-- A planner can already hold several tokens: `token` is the primary key,
-- `planner_id` is only a foreign key, and `revoked_at` is per-row. What was
-- missing is any way to tell two tokens apart, so the share UI could only show
-- opaque random strings and revoking the right one was guesswork.
--
-- That matters for the wall display in the disc-as-clock design: the screen
-- gets its own token so revoking the link you emailed a colleague does not
-- silently blank the display in the room days later.
--
-- Nullable with no default: existing tokens stay unlabelled, which is exactly
-- how the single anonymous public link should keep behaving.

ALTER TABLE share_tokens ADD COLUMN label TEXT;
