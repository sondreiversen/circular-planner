/**
 * availability.ts — who is free, and when.
 *
 * Pure and DOM-free on purpose. The People view answers "who is doing what";
 * this answers "when could these people all do something", which is the job that
 * currently leaves the application for Slack. The arithmetic is small but it is
 * the part a user cannot check by eye, so it lives here with its own tests
 * rather than inside a renderer.
 *
 * Three things about the model are load-bearing and easy to get wrong:
 *
 * 1. DATES ARE INCLUSIVE DAYS HERE, AND INSTANTS IN THE RENDERER.
 *    `Activity.endDate` is inclusive: an activity ending 2026-08-10 occupies the
 *    whole of the 10th. The People view draws a box from dateToX(start) to
 *    dateToX(end), which treats those dates as instants, so two activities that
 *    touch at a boundary abut on screen (measured: 0px overlap) while both owning
 *    that day here. Both models are right for their own job. Do NOT "unify" them:
 *    making the layout inclusive pushes the second activity onto another sub-row
 *    and grows every row height to fix a defect that does not exist.
 *
 * 2. THE COUNT IS THE ANSWER, NOT A BOOLEAN.
 *    An earlier design highlighted only stretches where EVERY selected person was
 *    free. Simulated on block-structured schedules over a 92-day window, that
 *    succeeds 2% of the time for four people at 60% occupancy and 0% for six — so
 *    an empty band would have been the normal outcome for the group sizes the
 *    feature exists for. It also discards what the real conversation runs on:
 *    "can we do it when five of the six are free and catch Bo up after?" So the
 *    output is a per-day count, and all-free is just the count at full height.
 *
 * 3. A TRUNCATED EXPANSION IS NOT AN ANSWER.
 *    expandOccurrences stops at a cap, and the occurrences it never emitted do
 *    not read as "unknown" downstream, they read as "nothing scheduled". Every
 *    function here propagates `truncated` so the caller can refuse to draw rather
 *    than show a confident wrong band.
 *
 * A note on filters, decided during review: availability is computed over ALL
 * activities, never the filtered set. `passesFilter` in the People view drops
 * activities by search term, label, hidden lane and tagged user, so honouring it
 * would mean typing "workshop" into the search box marks everyone free. A filter
 * is a viewing preference, not a statement about what exists. Callers pass the
 * unfiltered list and tell the user when the two disagree.
 */

import { Activity } from './types';
import { expandOccurrences, parseDate, addDays, daysBetween } from './utils';

/** A span of whole days. BOTH ends are inclusive. */
export interface Interval {
  start: Date;
  end: Date;
}

/** One person's commitments across a window. */
export interface PersonBusy {
  personId: number;
  /** Merged, sorted, clipped to the window. */
  intervals: Interval[];
  /** True when any of this person's activities hit the expansion cap. */
  truncated: boolean;
}

/** Per-day free counts across a window. */
export interface FreeCounts {
  /** `counts[i]` = how many people are free on `windowStart + i` days. */
  counts: number[];
  /** How many people were considered, i.e. the maximum a count can reach. */
  total: number;
  /**
   * True when at least one person's expansion was cut short. The counts are then
   * not trustworthy and the caller must not present them as availability.
   */
  truncated: boolean;
}

/**
 * Do two inclusive-day intervals share at least one day?
 *
 * Inclusive at both ends, so an interval ending on the 10th and one starting on
 * the 10th DO overlap — they both own that day.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** Strip time-of-day so comparisons are day-granular. */
function day(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Is this person actually blocked by this activity?
 *
 * Cancelled work is not happening, and a milestone is a marker rather than
 * occupied time; counting either would hide real windows and make the feature
 * look broken. A tag with no id is a pending invitation for someone who has not
 * registered — it cannot be matched to a person, so it cannot make one busy.
 */
function blocksPerson(activity: Activity, personId: number): boolean {
  if (activity.status === 'cancelled') return false;
  if (activity.isMilestone) return false;
  return (activity.taggedUsers ?? []).some(u => u.id != null && u.id === personId);
}

/**
 * Merge overlapping and ADJACENT intervals.
 *
 * Adjacency matters at day granularity: an activity ending on the 10th and one
 * starting on the 11th leave no free day between them, so they are one busy run.
 * Treating them as separate would report a zero-day gap that a caller could
 * mistake for availability.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals]
    .map(i => ({ start: day(i.start), end: day(i.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const out: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    // <= 1 rather than <= 0: touching AND adjacent both coalesce.
    if (daysBetween(last.end, cur.start) <= 1) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * Everything blocking one person inside `window`, merged and clipped.
 *
 * `activities` must be the UNFILTERED list — see the note at the top of this file.
 */
export function busyIntervals(
  activities: Activity[],
  personId: number,
  window: Interval,
): PersonBusy {
  const winStart = day(window.start);
  const winEnd = day(window.end);
  const raw: Interval[] = [];
  let truncated = false;

  for (const activity of activities) {
    if (!blocksPerson(activity, personId)) continue;

    const expansion = expandOccurrences(activity, winStart, winEnd);
    if (expansion.truncated) truncated = true;

    for (const occ of expansion.occurrences) {
      const s = day(occ.start);
      const e = day(occ.end);
      // expandOccurrences returns occurrences that OVERLAP the range, not ones
      // clipped to it, so a year-long activity comes back at full length.
      if (e < winStart || s > winEnd) continue;
      raw.push({
        start: s < winStart ? winStart : s,
        end: e > winEnd ? winEnd : e,
      });
    }
  }

  return { personId, intervals: mergeIntervals(raw), truncated };
}

/**
 * How many of these people are free on each day of the window.
 *
 * Index 0 is `window.start`; the last index is `window.end`, inclusive. An empty
 * people list yields all-zero counts with `total` 0 rather than an empty array,
 * so a caller can still render a row rather than special-casing the empty state.
 */
export function freeCounts(people: PersonBusy[], window: Interval): FreeCounts {
  const winStart = day(window.start);
  const dayCount = daysBetween(winStart, day(window.end)) + 1; // inclusive
  const n = Math.max(0, dayCount);

  const counts = new Array<number>(n).fill(people.length);
  let truncated = false;

  for (const person of people) {
    if (person.truncated) truncated = true;
    for (const iv of person.intervals) {
      const from = Math.max(0, daysBetween(winStart, day(iv.start)));
      const to = Math.min(n - 1, daysBetween(winStart, day(iv.end)));
      for (let i = from; i <= to; i++) counts[i] -= 1;
    }
  }

  return { counts, total: people.length, truncated };
}

/**
 * Runs of at least `minDays` where the free count reaches `threshold`.
 *
 * `threshold === total` gives the strict all-free answer; anything lower gives
 * the negotiable windows the count band exists to surface.
 *
 * Returns [] when the expansion was truncated. That is deliberate: the caller
 * must not be able to render windows from counts we know are wrong, and an empty
 * result plus the `truncated` flag on FreeCounts is a safer contract than
 * trusting every caller to check first.
 */
export function freeWindows(
  free: FreeCounts,
  window: Interval,
  threshold: number,
  minDays = 1,
): Interval[] {
  if (free.truncated) return [];

  const winStart = day(window.start);
  const out: Interval[] = [];
  let runStart = -1;

  const flush = (endIdx: number): void => {
    if (runStart < 0) return;
    if (endIdx - runStart + 1 >= minDays) {
      out.push({ start: addDays(winStart, runStart), end: addDays(winStart, endIdx) });
    }
    runStart = -1;
  };

  for (let i = 0; i < free.counts.length; i++) {
    if (free.counts[i] >= threshold) {
      if (runStart < 0) runStart = i;
    } else {
      flush(i - 1);
    }
  }
  flush(free.counts.length - 1);

  return out;
}

/**
 * Convenience: everything from a raw activity list to the free counts.
 *
 * `activities` must be unfiltered. `personIds` is the explicit selection — see
 * the design's open question about auto mode, where the implicit set is every
 * member plus every tagged user and the count's denominator stops meaning much.
 */
export function availabilityFor(
  activities: Activity[],
  personIds: number[],
  window: Interval,
): FreeCounts {
  return freeCounts(
    personIds.map(id => busyIntervals(activities, id, window)),
    window,
  );
}

/** Parse a YYYY-MM-DD pair into an inclusive-day Interval. */
export function intervalFromStrings(startYmd: string, endYmd: string): Interval {
  return { start: parseDate(startYmd), end: parseDate(endYmd) };
}
