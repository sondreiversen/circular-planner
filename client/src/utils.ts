import { scaleTime } from 'd3-scale';
import { Activity, MonthlyRule } from './types';

export const FONT_FAMILY = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

export function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function displayName(user: { fullName?: string | null; username: string }): string {
  return user.fullName?.trim() || user.username;
}

/**
 * Returns a D3 time scale that maps dates to angles (radians).
 * Uses d3-shape arc convention: 0 = 12 o'clock, increasing clockwise.
 * Full circle = 2*PI.
 */
export function createAngleScale(startDate: Date, endDate: Date) {
  return scaleTime()
    .domain([startDate, endDate])
    .range([0, 2 * Math.PI]);
}

/** Parse an ISO date string "YYYY-MM-DD" into a local Date object. */
export function parseDate(s: string): Date {
  const [year, month, day] = s.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Format a Date to "YYYY-MM-DD" */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


/**
 * Convert an (x, y) position relative to the disc center to an angle in radians.
 * Returns a value in [0, 2*PI] matching the d3-arc angle convention (0 = 12 o'clock, clockwise).
 */
export function xyToAngle(dx: number, dy: number): number {
  // d3-arc: sin(a) = x/r, -cos(a) = y/r, so a = atan2(dx, -dy)
  let angle = Math.atan2(dx, -dy);
  if (angle < 0) angle += 2 * Math.PI;
  return angle;
}

/** Generate a short random ID */
export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Add n days to a date, returning a new Date */
export function addDays(d: Date, n: number): Date {
  const result = new Date(d.getTime());
  result.setDate(result.getDate() + n);
  return result;
}

/**
 * Whole calendar days from `a` to `b`. Negative when `b` precedes `a`.
 *
 * Do NOT compute this as (b - a) / 86400000. A span crossing a DST boundary is
 * 23 or 25 hours long on that day, so the division lands on x.96 or x.04 and
 * truncates to the wrong day count. Normalising both ends to a UTC-midnight
 * index removes local time from the arithmetic entirely.
 */
export function daysBetween(a: Date, b: Date): number {
  const DAY_MS = 86400000;
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / DAY_MS);
}

/** Add n months to a date, clamping to last day of month if needed */
export function addMonths(d: Date, n: number): Date {
  const result = new Date(d.getTime());
  const targetMonth = result.getMonth() + n;
  result.setMonth(targetMonth);
  // If day overflowed (e.g. Jan 31 + 1 month → Mar 3), clamp to last day
  if (result.getDate() !== d.getDate()) {
    result.setDate(0); // go to last day of previous month
  }
  return result;
}

/**
 * Given a year/month (0-indexed month), compute the Date matching a MonthlyRule.
 * Returns null if the rule produces a date that falls outside the given month
 * (e.g. dom:31 in February, or nthwd:5,0 when there is no 5th Sunday).
 */
export function applyMonthlyRule(rule: MonthlyRule, year: number, month: number): Date | null {
  if (rule.kind === 'dom') {
    const d = new Date(year, month, rule.day);
    // Overflow means the month doesn't have that day (e.g. Feb 30)
    if (d.getMonth() !== month) return null;
    return d;
  }
  // nthwd
  const { week, weekday } = rule;
  if (week === -1) {
    // Last occurrence of weekday in month: start from the last day and walk back.
    const lastDay = new Date(year, month + 1, 0); // last day of month
    let d = lastDay.getDate();
    while (new Date(year, month, d).getDay() !== weekday) {
      d--;
    }
    return new Date(year, month, d);
  }
  // Positive week (1..5): find the first occurrence, then jump forward (week-1) * 7 days.
  const firstOfMonth = new Date(year, month, 1);
  const firstWd = firstOfMonth.getDay();
  // Days until the first matching weekday (0..6)
  const daysUntil = (weekday - firstWd + 7) % 7;
  const dayNum = 1 + daysUntil + (week - 1) * 7;
  const result = new Date(year, month, dayNum);
  // If the computed date rolled into the next month, this Nth weekday doesn't exist.
  if (result.getMonth() !== month) return null;
  return result;
}

/** Snap a date to the previous Monday (or same day if already Monday) */
export function getMonday(d: Date): Date {
  const result = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = result.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? 6 : day - 1; // distance back to Monday
  result.setDate(result.getDate() - diff);
  return result;
}

/** Snap a date to the 1st of its month */
export function getMonthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Predefined color palette for activities */
export const COLOR_PALETTE: string[] = [
  // Original 12
  '#E53935', // red
  '#FB8C00', // orange
  '#FDD835', // yellow
  '#43A047', // green
  '#00ACC1', // cyan
  '#1E88E5', // blue
  '#8E24AA', // purple
  '#D81B60', // pink
  '#6D4C41', // brown
  '#546E7A', // blue-grey
  '#00897B', // teal
  '#C0CA33', // lime
  // Added 12 complementary tones
  '#FF6F61', // coral
  '#FFB300', // amber
  '#C6FF00', // acid lime
  '#76FF03', // light green
  '#1DE9B6', // teal accent
  '#00B8D4', // sky
  '#2962FF', // indigo
  '#651FFF', // deep violet
  '#AA00FF', // violet
  '#F50057', // hot pink / rose
  '#FF6D00', // deep orange
  '#37474F', // dark slate
];

// ===== Color-by utilities =====

export type ColorBy = 'activity' | 'lane' | 'label' | 'status' | 'owner';

/** Deterministic FNV-1a-style hash mapping a string to a COLOR_PALETTE index. */
export function colorForString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length];
}

/** Strip alpha from rgba(r,g,b,a) and return rgba with new alpha. Pass-through for hex/non-rgba. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color);
  if (!m) return color;
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
}

export const STATUS_COLORS: Record<string, string> = {
  planned: '#4a90e2',      // blue
  in_progress: '#fb8c00',  // amber
  done: '#43a047',         // green
  cancelled: '#9e9e9e',    // grey
};

/** Default lane background colors */
export const LANE_COLORS: string[] = [
  'rgba(66,133,244,0.25)',   // blue
  'rgba(52,168,83,0.25)',    // green
  'rgba(251,188,4,0.25)',    // amber
  'rgba(154,100,208,0.25)',  // purple
  'rgba(234,67,53,0.22)',    // red
  'rgba(0,172,193,0.25)',    // teal
  'rgba(255,112,67,0.25)',   // deep orange
  'rgba(124,179,66,0.25)',   // light green
];

export function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length];
}

const MAX_OCCURRENCES = 1000;

/** One expanded occurrence. Both ends are local midnights; `end` is INCLUSIVE. */
export interface Occurrence {
  start: Date;
  end: Date;
}

/**
 * The result of expanding an activity.
 *
 * `truncated` is the important half. The expansion stops at MAX_OCCURRENCES as a
 * safety guard, and for DRAWING that is harmless — you lose some boxes off the
 * end of a very long view. For anything that reasons about the gaps, it inverts
 * the answer: the occurrences that were never emitted do not read as "unknown",
 * they read as "nothing scheduled". A free/busy calculation over a truncated
 * expansion reports a busy person as available, confidently and silently.
 *
 * So the flag is part of the return type rather than an optional extra: a caller
 * has to look at it to get at the occurrences, and can then decide whether a
 * partial answer is acceptable for its purpose.
 */
export interface OccurrenceExpansion {
  occurrences: Occurrence[];
  /** True when the cap stopped the walk before the range was exhausted. */
  truncated: boolean;
}

/**
 * Expand an activity into concrete {start, end} occurrence pairs within [rangeStart, rangeEnd].
 *
 * Non-recurring: returns a single occurrence with the activity's own dates, provided it
 * overlaps the range. Returns [] if entirely outside.
 *
 * Daily: walks from the activity's startDate by interval days, emitting each occurrence
 * (preserving the original duration) until min(recurrence.until, rangeEnd).
 *
 * Weekly: for each week-anchor (every interval weeks from the week containing startDate),
 * emits one occurrence for each selected weekday that falls >= startDate and <= until/rangeEnd.
 *
 * Monthly / yearly: walk by interval months/years from the activity's start.
 *
 * Output is capped at MAX_OCCURRENCES; see OccurrenceExpansion.truncated.
 */
/** Apply any recurrence override for the given occurrence start date. */
function applyOverride(
  activity: Activity,
  occStart: Date,
  occEnd: Date
): { start: Date; end: Date } {
  const ovr = activity.recurrence?.overrides?.[formatDate(occStart)];
  if (!ovr) return { start: occStart, end: occEnd };
  const start = ovr.startDate ? parseDate(ovr.startDate) : occStart;
  const end   = ovr.endDate   ? parseDate(ovr.endDate)   : occEnd;
  return { start, end };
}

export function expandOccurrences(
  activity: Activity,
  rangeStart: Date,
  rangeEnd: Date
): OccurrenceExpansion {
  const actStart = parseDate(activity.startDate);
  const actEnd = parseDate(activity.endDate);
  // Duration in whole DAYS, not milliseconds.
  //
  // This used to be `actEnd.getTime() - actStart.getTime()`, added to every
  // occurrence start. When the base duration spans a DST change that count is
  // short by an hour, so every later occurrence landed at 23:00 the previous
  // day — permanently, not twice a year. A five-day activity created across the
  // spring change was drawn as four days for the rest of its life, everywhere
  // occurrences are rendered. addDays uses setDate, which is calendar-based and
  // keeps local midnight across a transition.
  const durationDays = daysBetween(actStart, actEnd);

  if (!activity.recurrence) {
    if (actEnd < rangeStart || actStart > rangeEnd) return { occurrences: [], truncated: false };
    return { occurrences: [{ start: actStart, end: actEnd }], truncated: false };
  }

  const rec = activity.recurrence;
  const until = rec.until ? parseDate(rec.until) : null;
  const hardEnd = until && until < rangeEnd ? until : rangeEnd;

  const results: Occurrence[] = [];
  let truncated = false;

  // Build a set of exception dates (YYYY-MM-DD) for O(1) lookup.
  const exceptionSet = new Set(rec.exceptions ?? []);

  if (rec.type === 'daily') {
    const step = rec.interval;
    let cur = new Date(actStart.getTime());
    while (cur <= hardEnd) {
      if (results.length >= MAX_OCCURRENCES) { truncated = true; break; }
      const occEnd = addDays(cur, durationDays);
      if (occEnd >= rangeStart && !exceptionSet.has(formatDate(cur))) {
        results.push(applyOverride(activity, new Date(cur.getTime()), occEnd));
      }
      cur = addDays(cur, step);
    }
    return { occurrences: results, truncated };
  }

  if (rec.type === 'weekly') {
    const weekdays = rec.weekdays ?? [];
    if (weekdays.length === 0) return { occurrences: [], truncated: false };

    const weekStepDays = rec.interval * 7;
    // Anchor to the Monday of the week containing actStart so that week-stepping is uniform.
    const anchorMonday = getMonday(actStart);
    let weekAnchor = new Date(anchorMonday.getTime());

    while (weekAnchor <= hardEnd) {
      if (results.length >= MAX_OCCURRENCES) { truncated = true; break; }
      for (const wd of weekdays) {
        // Sunday=0 in JS; anchor is Monday (day 1), so offset = wd === 0 ? 6 : wd - 1
        const dayOffset = wd === 0 ? 6 : wd - 1;
        const occStart = addDays(weekAnchor, dayOffset);
        if (occStart < actStart) continue;
        if (occStart > hardEnd) continue;
        if (occStart > rangeEnd) continue;
        const occEnd = addDays(occStart, durationDays);
        if (occEnd < rangeStart) continue;
        if (exceptionSet.has(formatDate(occStart))) continue;
        results.push(applyOverride(activity, new Date(occStart.getTime()), occEnd));
        if (results.length >= MAX_OCCURRENCES) { truncated = true; break; }
      }
      weekAnchor = addDays(weekAnchor, weekStepDays);
    }
    return { occurrences: results, truncated };
  }

  if (rec.type === 'monthly') {
    const rule = rec.monthlyRule;
    if (!rule) return { occurrences: [], truncated: false };

    // Walk month-by-month from actStart's month, stepping by rec.interval months.
    let year = actStart.getFullYear();
    let month = actStart.getMonth(); // 0-indexed

    for (;;) {
      if (results.length >= MAX_OCCURRENCES) { truncated = true; break; }
      const occStart = applyMonthlyRule(rule, year, month);
      if (occStart !== null) {
        // Enforce lower bound (actStart) and upper bound (hardEnd / rangeEnd).
        if (occStart > hardEnd) break;
        if (occStart >= actStart && occStart <= rangeEnd) {
          const occEnd = addDays(occStart, durationDays);
          if (occEnd >= rangeStart && !exceptionSet.has(formatDate(occStart))) {
            results.push(applyOverride(activity, new Date(occStart.getTime()), occEnd));
          }
        }
        // If we haven't yet reached rangeStart, keep walking forward.
      }
      // Advance by interval months.
      month += rec.interval;
      while (month >= 12) { month -= 12; year++; }
      // Safety: stop if we've gone far past hardEnd (handles months with no valid dom).
      if (new Date(year, month, 1) > hardEnd) break;
    }
    return { occurrences: results, truncated };
  }

  if (rec.type === 'yearly') {
    // Anchor to the same month+day as actStart; step by rec.interval years.
    const anchorMonth = actStart.getMonth();
    const anchorDay   = actStart.getDate();

    for (let y = actStart.getFullYear(); ; y += rec.interval) {
      if (results.length >= MAX_OCCURRENCES) { truncated = true; break; }
      // Handle Feb 29 → fall back to Feb 28 in non-leap years.
      let d = new Date(y, anchorMonth, anchorDay);
      if (d.getMonth() !== anchorMonth) {
        // Overflow: go to last day of the intended month.
        d = new Date(y, anchorMonth + 1, 0);
      }

      if (d > hardEnd) break;
      if (d < actStart) continue;

      if (d <= rangeEnd) {
        const occEnd = addDays(d, durationDays);
        if (occEnd >= rangeStart && !exceptionSet.has(formatDate(d))) {
          results.push(applyOverride(activity, new Date(d.getTime()), occEnd));
        }
      }
    }
    return { occurrences: results, truncated };
  }

  // Unknown recurrence type: no occurrences, and nothing was cut short.
  return { occurrences: [], truncated: false };
}
