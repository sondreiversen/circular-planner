-- Extend recurrence support: monthly (dom or nthwd rule) and yearly types,
-- plus per-occurrence exception dates to skip specific instances.
--
-- recurrence_monthly_rule stores the monthly repeat rule as compact text:
--   "dom:15"     = day-of-month 15
--   "nthwd:2,3"  = 2nd Wednesday (week=2 weekday=3 where 0=Sun through 6=Sat)
--   "nthwd:-1,5" = last Friday
ALTER TABLE activities ADD COLUMN recurrence_monthly_rule TEXT;

-- recurrence_exceptions stores a JSON array of YYYY-MM-DD strings.
-- Occurrences whose computed start date matches an entry are skipped.
-- Example: '["2026-03-14","2026-08-22"]'
ALTER TABLE activities ADD COLUMN recurrence_exceptions TEXT;
