import { expandOccurrences, parseDate, formatDate, Occurrence } from '../utils';
import { Activity } from '../types';

/**
 * Coverage for expandOccurrences.
 *
 * This function had NO tests, and the availability work is built entirely on
 * top of it. Two of its features decide availability directly and are the least
 * obvious: an EXCEPTION means the occurrence does not happen, so the person is
 * free that day; an OVERRIDE can move an occurrence's dates, so the busy
 * interval is not where the base recurrence says it is.
 *
 * DST behaviour lives in occurrences-dst.test.ts.
 */

const act = (o: Partial<Activity>): Activity => ({
  id: 'a', laneId: 'L', title: 't',
  startDate: '2026-01-01', endDate: '2026-01-01',
  ...o,
} as Activity);

const expand = (a: Activity, from: string, to: string) =>
  expandOccurrences(a, parseDate(from), parseDate(to));

const starts = (occs: Occurrence[]) => occs.map(o => formatDate(o.start));

describe('non-recurring', () => {
  it('returns the activity itself when it overlaps the range', () => {
    const a = act({ startDate: '2026-03-10', endDate: '2026-03-14' });
    const { occurrences, truncated } = expand(a, '2026-03-01', '2026-03-31');
    expect(starts(occurrences)).toEqual(['2026-03-10']);
    expect(formatDate(occurrences[0].end)).toBe('2026-03-14');
    expect(truncated).toBe(false);
  });

  it('returns nothing when entirely before or after the range', () => {
    const a = act({ startDate: '2026-01-05', endDate: '2026-01-09' });
    expect(expand(a, '2026-03-01', '2026-03-31').occurrences).toEqual([]);
    expect(expand(a, '2025-01-01', '2025-12-31').occurrences).toEqual([]);
  });

  it('is included when it merely straddles a range edge', () => {
    // Spans the whole window: starts before, ends after.
    const a = act({ startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(expand(a, '2026-06-01', '2026-06-30').occurrences).toHaveLength(1);
    // Ends exactly on the first day of the range.
    const b = act({ startDate: '2026-05-25', endDate: '2026-06-01' });
    expect(expand(b, '2026-06-01', '2026-06-30').occurrences).toHaveLength(1);
  });
});

describe('daily', () => {
  it('steps by interval and preserves duration', () => {
    const a = act({
      startDate: '2026-01-01', endDate: '2026-01-02',
      recurrence: { type: 'daily', interval: 3 } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2026-01-12');
    expect(starts(occurrences)).toEqual(['2026-01-01', '2026-01-04', '2026-01-07', '2026-01-10']);
    // Every occurrence keeps the base activity's one-day span.
    expect(occurrences.map(o => formatDate(o.end)))
      .toEqual(['2026-01-02', '2026-01-05', '2026-01-08', '2026-01-11']);
  });

  it('stops at recurrence.until, even when the range extends further', () => {
    const a = act({
      startDate: '2026-01-01', endDate: '2026-01-01',
      recurrence: { type: 'daily', interval: 1, until: '2026-01-05' } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2026-12-31');
    expect(starts(occurrences)).toEqual(
      ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
  });
});

describe('weekly', () => {
  it('emits one occurrence per selected weekday', () => {
    // 2026-01-05 is a Monday. weekdays [1,3] = Mon, Wed.
    const a = act({
      startDate: '2026-01-05', endDate: '2026-01-05',
      recurrence: { type: 'weekly', interval: 1, weekdays: [1, 3] } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2026-01-18');
    expect(starts(occurrences)).toEqual(
      ['2026-01-05', '2026-01-07', '2026-01-12', '2026-01-14']);
  });

  it('handles Sunday, which is 0 in JS but last in a Monday-anchored week', () => {
    const a = act({
      startDate: '2026-01-05', endDate: '2026-01-05',
      recurrence: { type: 'weekly', interval: 1, weekdays: [0] } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2026-01-26');
    // Sundays following the Monday anchors.
    expect(starts(occurrences)).toEqual(['2026-01-11', '2026-01-18', '2026-01-25']);
  });

  it('returns nothing when no weekdays are selected', () => {
    const a = act({
      recurrence: { type: 'weekly', interval: 1, weekdays: [] } as never,
    });
    const { occurrences, truncated } = expand(a, '2026-01-01', '2026-12-31');
    expect(occurrences).toEqual([]);
    expect(truncated).toBe(false);
  });

  it('skips occurrences before the activity start', () => {
    // Anchor Monday is 2026-01-05, but the activity starts on the Wednesday.
    const a = act({
      startDate: '2026-01-07', endDate: '2026-01-07',
      recurrence: { type: 'weekly', interval: 1, weekdays: [1, 3] } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2026-01-15');
    expect(starts(occurrences)).toEqual(['2026-01-07', '2026-01-12', '2026-01-14']);
  });
});

describe('monthly', () => {
  it('day-of-month rule', () => {
    const a = act({
      startDate: '2026-01-15', endDate: '2026-01-15',
      recurrence: { type: 'monthly', interval: 1, monthlyRule: { kind: 'dom', day: 15 } } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2026-04-30');
    expect(starts(occurrences)).toEqual(
      ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
  });

  it('skips months that do not have the requested day', () => {
    // Feb has no 30th, so February is absent rather than clamped.
    const a = act({
      startDate: '2026-01-30', endDate: '2026-01-30',
      recurrence: { type: 'monthly', interval: 1, monthlyRule: { kind: 'dom', day: 30 } } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2026-04-30');
    expect(starts(occurrences)).toEqual(['2026-01-30', '2026-03-30', '2026-04-30']);
  });

  it('nth-weekday rule', () => {
    // 2nd Tuesday of each month.
    const a = act({
      startDate: '2026-01-01', endDate: '2026-01-01',
      recurrence: { type: 'monthly', interval: 1, monthlyRule: { kind: 'nthwd', week: 2, weekday: 2 } } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2026-03-31');
    expect(starts(occurrences)).toEqual(['2026-01-13', '2026-02-10', '2026-03-10']);
  });

  it('last-weekday rule (week = -1)', () => {
    const a = act({
      startDate: '2026-01-01', endDate: '2026-01-01',
      recurrence: { type: 'monthly', interval: 1, monthlyRule: { kind: 'nthwd', week: -1, weekday: 5 } } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2026-03-31');
    expect(starts(occurrences)).toEqual(['2026-01-30', '2026-02-27', '2026-03-27']);
  });

  it('returns nothing without a monthlyRule', () => {
    const a = act({ recurrence: { type: 'monthly', interval: 1 } as never });
    expect(expand(a, '2026-01-01', '2026-12-31').occurrences).toEqual([]);
  });
});

describe('yearly', () => {
  it('repeats on the same month and day', () => {
    const a = act({
      startDate: '2026-06-15', endDate: '2026-06-16',
      recurrence: { type: 'yearly', interval: 1 } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2029-12-31');
    expect(starts(occurrences)).toEqual(
      ['2026-06-15', '2027-06-15', '2028-06-15', '2029-06-15']);
  });

  it('falls back to Feb 28 in non-leap years', () => {
    const a = act({
      startDate: '2024-02-29', endDate: '2024-02-29',
      recurrence: { type: 'yearly', interval: 1 } as never,
    });
    const { occurrences } = expand(a, '2024-01-01', '2027-12-31');
    expect(starts(occurrences)).toEqual(
      ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28']);
  });
});

describe('exceptions — the day becomes FREE', () => {
  it('removes the excepted occurrence from a daily series', () => {
    const a = act({
      startDate: '2026-01-01', endDate: '2026-01-01',
      recurrence: { type: 'daily', interval: 1, exceptions: ['2026-01-03'] } as never,
    });
    const { occurrences } = expand(a, '2026-01-01', '2026-01-05');
    expect(starts(occurrences)).toEqual(
      ['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-05']);
  });

  it('applies to weekly, monthly and yearly too', () => {
    const weekly = act({
      startDate: '2026-01-05', endDate: '2026-01-05',
      recurrence: { type: 'weekly', interval: 1, weekdays: [1], exceptions: ['2026-01-12'] } as never,
    });
    expect(starts(expand(weekly, '2026-01-01', '2026-01-26').occurrences))
      .toEqual(['2026-01-05', '2026-01-19', '2026-01-26']);

    const monthly = act({
      startDate: '2026-01-15', endDate: '2026-01-15',
      recurrence: { type: 'monthly', interval: 1, monthlyRule: { kind: 'dom', day: 15 }, exceptions: ['2026-02-15'] } as never,
    });
    expect(starts(expand(monthly, '2026-01-01', '2026-03-31').occurrences))
      .toEqual(['2026-01-15', '2026-03-15']);

    const yearly = act({
      startDate: '2026-06-15', endDate: '2026-06-15',
      recurrence: { type: 'yearly', interval: 1, exceptions: ['2027-06-15'] } as never,
    });
    expect(starts(expand(yearly, '2026-01-01', '2028-12-31').occurrences))
      .toEqual(['2026-06-15', '2028-06-15']);
  });
});

describe('overrides — the busy interval moves', () => {
  it('shifts a single occurrence to different dates', () => {
    const a = act({
      startDate: '2026-01-05', endDate: '2026-01-05',
      recurrence: {
        type: 'daily', interval: 1,
        overrides: { '2026-01-07': { startDate: '2026-01-09', endDate: '2026-01-10' } },
      } as never,
    });
    const { occurrences } = expand(a, '2026-01-05', '2026-01-08');
    const moved = occurrences.find(o => formatDate(o.start) === '2026-01-09');
    expect(moved).toBeDefined();
    expect(formatDate(moved!.end)).toBe('2026-01-10');
    // The original date is gone: nothing is scheduled on the 7th any more.
    expect(starts(occurrences)).not.toContain('2026-01-07');
  });

  it('can override only the end date', () => {
    const a = act({
      startDate: '2026-01-05', endDate: '2026-01-05',
      recurrence: {
        type: 'daily', interval: 1,
        overrides: { '2026-01-06': { endDate: '2026-01-08' } },
      } as never,
    });
    const { occurrences } = expand(a, '2026-01-05', '2026-01-07');
    const o = occurrences.find(x => formatDate(x.start) === '2026-01-06');
    expect(o).toBeDefined();
    expect(formatDate(o!.end)).toBe('2026-01-08');
  });
});

describe('truncation — the flag that stops a wrong availability answer', () => {
  it('is false for an ordinary expansion', () => {
    const a = act({
      startDate: '2026-01-01', endDate: '2026-01-01',
      recurrence: { type: 'daily', interval: 1 } as never,
    });
    const { occurrences, truncated } = expand(a, '2026-01-01', '2026-12-31');
    expect(occurrences.length).toBe(365);
    expect(truncated).toBe(false);
  });

  it('is true when a daily series hits the cap', () => {
    const a = act({
      startDate: '2020-01-01', endDate: '2020-01-01',
      recurrence: { type: 'daily', interval: 1 } as never,
    });
    const { occurrences, truncated } = expand(a, '2020-01-01', '2030-12-31');
    expect(occurrences.length).toBe(1000);
    expect(truncated).toBe(true);
    // Without the flag, every day after this one reads as "nothing scheduled".
    // (2020-01-01 plus 999 days. An earlier probe reported 2022-09-25 because it
    // printed with toISOString, which renders a local midnight in UTC and lands
    // a day earlier east of Greenwich — the same trap formatDate exists to avoid.)
    expect(formatDate(occurrences[occurrences.length - 1].start)).toBe('2022-09-26');
  });

  it('is true when a weekly series hits the cap', () => {
    const a = act({
      startDate: '2000-01-03', endDate: '2000-01-03',
      recurrence: { type: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] } as never,
    });
    const { occurrences, truncated } = expand(a, '2000-01-01', '2030-12-31');
    expect(occurrences.length).toBe(1000);
    expect(truncated).toBe(true);
  });

  it('is true when a monthly series hits the cap', () => {
    const a = act({
      startDate: '1900-01-15', endDate: '1900-01-15',
      recurrence: { type: 'monthly', interval: 1, monthlyRule: { kind: 'dom', day: 15 } } as never,
    });
    const { occurrences, truncated } = expand(a, '1900-01-01', '2200-12-31');
    expect(occurrences.length).toBe(1000);
    expect(truncated).toBe(true);
  });

  it('is true when a yearly series hits the cap', () => {
    const a = act({
      startDate: '1000-01-15', endDate: '1000-01-15',
      recurrence: { type: 'yearly', interval: 1 } as never,
    });
    const { occurrences, truncated } = expand(a, '1000-01-01', '3000-12-31');
    expect(occurrences.length).toBe(1000);
    expect(truncated).toBe(true);
  });

  it('is false for an empty result, which is not the same as a cut-short one', () => {
    const a = act({ startDate: '2026-01-05', endDate: '2026-01-09' });
    const { occurrences, truncated } = expand(a, '2027-01-01', '2027-12-31');
    expect(occurrences).toEqual([]);
    expect(truncated).toBe(false);
  });
});
