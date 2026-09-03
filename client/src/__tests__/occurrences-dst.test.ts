import { expandOccurrences, parseDate, formatDate, daysBetween } from '../utils';
import { Activity } from '../types';

/**
 * DST regression suite.
 *
 * expandOccurrences used to compute the activity's duration ONCE in milliseconds
 * and add that number to every occurrence start. When the base duration spans a
 * DST change, that millisecond count is short by an hour, so every later
 * occurrence landed at 23:00 on the previous day — permanently, not twice a
 * year. A five-day activity created across the spring change was drawn as four
 * days for the rest of its life, in the disc, list and people views.
 *
 * WHY THE npm SCRIPT PINS TZ=Europe/Oslo, and why removing it silently guts
 * this file: UTC has no DST, so under TZ=UTC the ORIGINAL BUGGY CODE PASSES ALL
 * OF THESE TESTS. Measured, buggy code, same suite:
 *
 *     TZ=Europe/Oslo       5 failed, 3 passed
 *     TZ=America/New_York  1 failed, 7 passed
 *     TZ=Australia/Sydney  2 failed, 6 passed
 *     TZ=UTC               8 passed      <-- proves nothing
 *
 * GitHub runners are UTC, so without the pin this regression test would sit in
 * CI looking green while protecting nothing. The dates below are chosen against
 * Europe/Oslo transitions (2026-03-29 forward, 2026-10-25 back), which is also
 * where this planner is actually deployed.
 *
 * The assertions use formatDate, because that is what the renderers and any
 * availability calculation key on — an end at 23:00 the previous day formats as
 * the wrong date, which is the user-visible symptom.
 */

const act = (o: Partial<Activity>): Activity => ({
  id: 'a', laneId: 'L', title: 't',
  startDate: '2026-01-01', endDate: '2026-01-01',
  ...o,
} as Activity);

/** Every occurrence must keep the same duration in whole days. */
function durationsInDays(occs: Array<{ start: Date; end: Date }>): number[] {
  return occs.map(o => daysBetween(o.start, o.end));
}

describe('daysBetween', () => {
  it('counts whole days across a DST boundary', () => {
    // Europe/Oslo springs forward 2026-03-29 and falls back 2026-10-25.
    expect(daysBetween(parseDate('2026-03-27'), parseDate('2026-03-31'))).toBe(4);
    expect(daysBetween(parseDate('2026-10-23'), parseDate('2026-10-27'))).toBe(4);
    expect(daysBetween(parseDate('2026-01-01'), parseDate('2026-01-01'))).toBe(0);
    expect(daysBetween(parseDate('2026-03-31'), parseDate('2026-03-27'))).toBe(-4);
  });
});

describe('expandOccurrences keeps its duration across DST', () => {
  it('weekly: a base duration spanning the spring change', () => {
    // 2026-03-27 .. 2026-03-31 contains the 29th, so durationMs is 4d minus 1h.
    const a = act({
      startDate: '2026-03-27', endDate: '2026-03-31',
      recurrence: { type: 'weekly', interval: 1, weekdays: [5] } as never,
    });
    const occs = expandOccurrences(a, parseDate('2026-03-01'), parseDate('2026-05-10'));

    expect(occs.length).toBeGreaterThan(3);
    // Every occurrence keeps the full four-day span...
    expect(durationsInDays(occs)).toEqual(occs.map(() => 4));
    // ...and every end lands on local midnight, not 23:00 the day before.
    occs.forEach(o => expect(o.end.getHours()).toBe(0));
    // The specific occurrence that used to be wrong.
    const apr3 = occs.find(o => formatDate(o.start) === '2026-04-03');
    expect(apr3).toBeDefined();
    expect(formatDate(apr3!.end)).toBe('2026-04-07');
  });

  it('weekly: a base duration spanning the autumn change', () => {
    const a = act({
      startDate: '2026-10-23', endDate: '2026-10-27',
      recurrence: { type: 'weekly', interval: 1, weekdays: [5] } as never,
    });
    const occs = expandOccurrences(a, parseDate('2026-10-01'), parseDate('2026-12-10'));
    expect(occs.length).toBeGreaterThan(3);
    expect(durationsInDays(occs)).toEqual(occs.map(() => 4));
    occs.forEach(o => expect(o.end.getHours()).toBe(0));
  });

  it('daily: duration survives crossing the boundary', () => {
    const a = act({
      startDate: '2026-03-25', endDate: '2026-03-27',
      recurrence: { type: 'daily', interval: 1 } as never,
    });
    const occs = expandOccurrences(a, parseDate('2026-03-20'), parseDate('2026-04-10'));
    expect(durationsInDays(occs)).toEqual(occs.map(() => 2));
    occs.forEach(o => expect(o.end.getHours()).toBe(0));
  });

  it('monthly: duration survives crossing the boundary', () => {
    const a = act({
      startDate: '2026-03-27', endDate: '2026-03-31',
      recurrence: { type: 'monthly', interval: 1, monthlyRule: { kind: 'dom', day: 27 } } as never,
    });
    const occs = expandOccurrences(a, parseDate('2026-03-01'), parseDate('2026-07-01'));
    expect(occs.length).toBeGreaterThan(1);
    expect(durationsInDays(occs)).toEqual(occs.map(() => 4));
    occs.forEach(o => expect(o.end.getHours()).toBe(0));
  });

  it('yearly: duration survives crossing the boundary', () => {
    const a = act({
      startDate: '2026-03-27', endDate: '2026-03-31',
      recurrence: { type: 'yearly', interval: 1 } as never,
    });
    const occs = expandOccurrences(a, parseDate('2026-01-01'), parseDate('2029-12-31'));
    expect(occs.length).toBeGreaterThan(1);
    expect(durationsInDays(occs)).toEqual(occs.map(() => 4));
    occs.forEach(o => expect(o.end.getHours()).toBe(0));
  });

  it('non-recurring activities are returned untouched', () => {
    const a = act({ startDate: '2026-03-27', endDate: '2026-03-31' });
    const occs = expandOccurrences(a, parseDate('2026-01-01'), parseDate('2026-12-31'));
    expect(occs).toHaveLength(1);
    expect(formatDate(occs[0].start)).toBe('2026-03-27');
    expect(formatDate(occs[0].end)).toBe('2026-03-31');
  });

  it('single-day activities stay single-day everywhere', () => {
    const a = act({
      startDate: '2026-03-29', endDate: '2026-03-29', // the change day itself
      recurrence: { type: 'weekly', interval: 1, weekdays: [0] } as never,
    });
    const occs = expandOccurrences(a, parseDate('2026-03-01'), parseDate('2026-05-01'));
    expect(durationsInDays(occs)).toEqual(occs.map(() => 0));
    occs.forEach(o => expect(formatDate(o.start)).toBe(formatDate(o.end)));
  });
});
