import {
  overlaps, mergeIntervals, busyIntervals, freeCounts, freeWindows,
  availabilityFor, intervalFromStrings, Interval, PersonBusy,
} from '../availability';
import { parseDate, formatDate } from '../utils';
import { Activity } from '../types';

/**
 * Availability arithmetic.
 *
 * The band is only worth having if it is trustworthy, so these tests care most
 * about the ways it could be confidently wrong: a boundary day counted free
 * while two activities sit on it, a truncated expansion presented as an answer,
 * a cancelled activity blocking a window it should not.
 */

const act = (o: Partial<Activity>): Activity => ({
  id: 'a', laneId: 'L', title: 't',
  startDate: '2026-01-01', endDate: '2026-01-01',
  ...o,
} as Activity);

/** Tag an activity to person ids. */
const tagged = (ids: number[], o: Partial<Activity>): Activity =>
  act({ ...o, taggedUsers: ids.map(id => ({ id, username: `u${id}` })) });

const iv = (s: string, e: string): Interval => intervalFromStrings(s, e);
const show = (list: Interval[]) => list.map(i => `${formatDate(i.start)}..${formatDate(i.end)}`);

const JAN = iv('2026-01-01', '2026-01-31');

describe('overlaps — inclusive at both ends', () => {
  it('counts a shared boundary day as an overlap', () => {
    // The case the People view's layout deliberately treats differently: both
    // of these own 2026-01-10.
    expect(overlaps(iv('2026-01-05', '2026-01-10'), iv('2026-01-10', '2026-01-15'))).toBe(true);
  });

  it('is false for a genuine gap, however small', () => {
    expect(overlaps(iv('2026-01-05', '2026-01-09'), iv('2026-01-11', '2026-01-15'))).toBe(false);
  });

  it('handles containment and identity', () => {
    expect(overlaps(iv('2026-01-01', '2026-01-31'), iv('2026-01-10', '2026-01-12'))).toBe(true);
    expect(overlaps(iv('2026-01-10', '2026-01-10'), iv('2026-01-10', '2026-01-10'))).toBe(true);
  });

  it('is symmetric', () => {
    const a = iv('2026-01-05', '2026-01-10');
    const b = iv('2026-01-08', '2026-01-20');
    expect(overlaps(a, b)).toBe(overlaps(b, a));
  });
});

describe('mergeIntervals', () => {
  it('coalesces overlapping runs', () => {
    expect(show(mergeIntervals([iv('2026-01-01', '2026-01-10'), iv('2026-01-05', '2026-01-15')])))
      .toEqual(['2026-01-01..2026-01-15']);
  });

  it('coalesces ADJACENT runs, because no free day separates them', () => {
    expect(show(mergeIntervals([iv('2026-01-01', '2026-01-10'), iv('2026-01-11', '2026-01-15')])))
      .toEqual(['2026-01-01..2026-01-15']);
  });

  it('keeps runs separated by even one free day', () => {
    expect(show(mergeIntervals([iv('2026-01-01', '2026-01-10'), iv('2026-01-12', '2026-01-15')])))
      .toEqual(['2026-01-01..2026-01-10', '2026-01-12..2026-01-15']);
  });

  it('sorts unsorted input and absorbs nested intervals', () => {
    expect(show(mergeIntervals([
      iv('2026-01-20', '2026-01-25'),
      iv('2026-01-01', '2026-01-10'),
      iv('2026-01-03', '2026-01-05'),
    ]))).toEqual(['2026-01-01..2026-01-10', '2026-01-20..2026-01-25']);
  });

  it('handles the empty and single cases', () => {
    expect(mergeIntervals([])).toEqual([]);
    expect(show(mergeIntervals([iv('2026-01-05', '2026-01-05')]))).toEqual(['2026-01-05..2026-01-05']);
  });

  it('does not mutate its input', () => {
    const input = [iv('2026-01-05', '2026-01-10'), iv('2026-01-01', '2026-01-03')];
    const before = show(input);
    mergeIntervals(input);
    expect(show(input)).toEqual(before);
  });
});

describe('busyIntervals', () => {
  it('collects only the activities the person is tagged on', () => {
    const acts = [
      tagged([1], { startDate: '2026-01-05', endDate: '2026-01-07' }),
      tagged([2], { startDate: '2026-01-10', endDate: '2026-01-12' }),
    ];
    expect(show(busyIntervals(acts, 1, JAN).intervals)).toEqual(['2026-01-05..2026-01-07']);
    expect(show(busyIntervals(acts, 2, JAN).intervals)).toEqual(['2026-01-10..2026-01-12']);
    expect(busyIntervals(acts, 3, JAN).intervals).toEqual([]);
  });

  it('ignores cancelled activities (premise 5)', () => {
    const acts = [tagged([1], { startDate: '2026-01-05', endDate: '2026-01-07', status: 'cancelled' })];
    expect(busyIntervals(acts, 1, JAN).intervals).toEqual([]);
  });

  it('ignores milestones (premise 5)', () => {
    const acts = [tagged([1], { startDate: '2026-01-05', endDate: '2026-01-05', isMilestone: true })];
    expect(busyIntervals(acts, 1, JAN).intervals).toEqual([]);
  });

  it('ignores pending tags, which have no id to match', () => {
    const acts = [act({
      startDate: '2026-01-05', endDate: '2026-01-07',
      taggedUsers: [{ id: null, username: 'invited', pending: true }],
    })];
    expect(busyIntervals(acts, 1, JAN).intervals).toEqual([]);
  });

  it('clips an activity that overruns the window', () => {
    const acts = [tagged([1], { startDate: '2025-06-01', endDate: '2027-06-01' })];
    expect(show(busyIntervals(acts, 1, JAN).intervals)).toEqual(['2026-01-01..2026-01-31']);
  });

  it('expands recurrences', () => {
    const acts = [tagged([1], {
      startDate: '2026-01-05', endDate: '2026-01-05',
      recurrence: { type: 'weekly', interval: 1, weekdays: [1] } as never,
    })];
    expect(show(busyIntervals(acts, 1, JAN).intervals))
      .toEqual(['2026-01-05..2026-01-05', '2026-01-12..2026-01-12',
                '2026-01-19..2026-01-19', '2026-01-26..2026-01-26']);
  });

  it('honours a recurrence exception, freeing that day', () => {
    const acts = [tagged([1], {
      startDate: '2026-01-05', endDate: '2026-01-05',
      recurrence: { type: 'weekly', interval: 1, weekdays: [1], exceptions: ['2026-01-12'] } as never,
    })];
    expect(show(busyIntervals(acts, 1, JAN).intervals))
      .toEqual(['2026-01-05..2026-01-05', '2026-01-19..2026-01-19', '2026-01-26..2026-01-26']);
  });

  it('propagates truncation from the expansion', () => {
    const acts = [tagged([1], {
      startDate: '2020-01-01', endDate: '2020-01-01',
      recurrence: { type: 'daily', interval: 1 } as never,
    })];
    const wide = iv('2020-01-01', '2030-12-31');
    expect(busyIntervals(acts, 1, wide).truncated).toBe(true);
    expect(busyIntervals(acts, 1, JAN).truncated).toBe(false);
  });

  it('drops an occurrence an override moved outside the window', () => {
    // expandOccurrences applies overrides AFTER its range check, so it can hand
    // back an occurrence far outside the requested window. Verified: a January
    // 2026 query on the activity below returns a 2027-06-01 occurrence. Without
    // the guard in busyIntervals that would be clamped to the window edge and
    // invent a busy day the person does not have.
    const acts = [tagged([1], {
      startDate: '2026-01-05', endDate: '2026-01-05',
      recurrence: {
        type: 'daily', interval: 1,
        overrides: { '2026-01-06': { startDate: '2027-06-01', endDate: '2027-06-05' } },
      } as never,
    })];
    const win = iv('2026-01-05', '2026-01-07');
    // The 6th moved away entirely, so only the 5th and 7th remain busy.
    expect(show(busyIntervals(acts, 1, win).intervals))
      .toEqual(['2026-01-05..2026-01-05', '2026-01-07..2026-01-07']);
  });

  it('merges two activities that touch at a boundary into one busy run', () => {
    const acts = [
      tagged([1], { id: 'x', startDate: '2026-01-05', endDate: '2026-01-10' }),
      tagged([1], { id: 'y', startDate: '2026-01-10', endDate: '2026-01-15' }),
    ];
    expect(show(busyIntervals(acts, 1, JAN).intervals)).toEqual(['2026-01-05..2026-01-15']);
  });
});

describe('freeCounts', () => {
  const win = iv('2026-01-01', '2026-01-10'); // 10 days

  it('is full height when nobody is busy', () => {
    const people: PersonBusy[] = [
      { personId: 1, intervals: [], truncated: false },
      { personId: 2, intervals: [], truncated: false },
    ];
    const f = freeCounts(people, win);
    expect(f.counts).toHaveLength(10);
    expect(f.counts).toEqual(new Array(10).fill(2));
    expect(f.total).toBe(2);
  });

  it('decrements only the days a person is busy, inclusive of both ends', () => {
    const people: PersonBusy[] = [
      { personId: 1, intervals: [iv('2026-01-03', '2026-01-05')], truncated: false },
    ];
    const f = freeCounts(people, win);
    //            Jan 1  2  3  4  5  6  7  8  9 10
    expect(f.counts).toEqual([1, 1, 0, 0, 0, 1, 1, 1, 1, 1]);
  });

  it('counts each person independently', () => {
    const people: PersonBusy[] = [
      { personId: 1, intervals: [iv('2026-01-01', '2026-01-03')], truncated: false },
      { personId: 2, intervals: [iv('2026-01-03', '2026-01-05')], truncated: false },
      { personId: 3, intervals: [], truncated: false },
    ];
    const f = freeCounts(people, win);
    expect(f.counts).toEqual([2, 2, 1, 2, 2, 3, 3, 3, 3, 3]);
    expect(f.total).toBe(3);
  });

  it('clamps intervals that extend past the window', () => {
    const people: PersonBusy[] = [
      { personId: 1, intervals: [iv('2025-12-01', '2027-01-01')], truncated: false },
    ];
    expect(freeCounts(people, win).counts).toEqual(new Array(10).fill(0));
  });

  it('returns all-zero counts with total 0 for an empty people list', () => {
    const f = freeCounts([], win);
    expect(f.counts).toEqual(new Array(10).fill(0));
    expect(f.total).toBe(0);
    expect(f.truncated).toBe(false);
  });

  it('propagates truncation from any person', () => {
    const people: PersonBusy[] = [
      { personId: 1, intervals: [], truncated: false },
      { personId: 2, intervals: [], truncated: true },
    ];
    expect(freeCounts(people, win).truncated).toBe(true);
  });

  it('handles a single-day window', () => {
    const f = freeCounts([{ personId: 1, intervals: [], truncated: false }],
                         iv('2026-01-01', '2026-01-01'));
    expect(f.counts).toEqual([1]);
  });
});

describe('freeWindows', () => {
  const win = iv('2026-01-01', '2026-01-10');
  const counts = (c: number[], total: number, truncated = false) => ({ counts: c, total, truncated });

  it('extracts runs meeting the threshold', () => {
    const f = counts([2, 2, 0, 0, 2, 2, 2, 0, 2, 2], 2);
    expect(show(freeWindows(f, win, 2)))
      .toEqual(['2026-01-01..2026-01-02', '2026-01-05..2026-01-07', '2026-01-09..2026-01-10']);
  });

  it('applies the minimum-duration filter', () => {
    const f = counts([2, 2, 0, 0, 2, 2, 2, 0, 2, 2], 2);
    expect(show(freeWindows(f, win, 2, 3))).toEqual(['2026-01-05..2026-01-07']);
  });

  it('a lower threshold surfaces the negotiable window a boolean would hide', () => {
    // Nobody is ever ALL free; 2-of-3 gives a usable five-day stretch.
    const f = counts([1, 1, 2, 2, 2, 2, 2, 1, 1, 1], 3);
    expect(freeWindows(f, win, 3)).toEqual([]);
    expect(show(freeWindows(f, win, 2, 3))).toEqual(['2026-01-03..2026-01-07']);
  });

  it('closes a run that reaches the end of the window', () => {
    const f = counts([0, 0, 0, 0, 0, 0, 0, 2, 2, 2], 2);
    expect(show(freeWindows(f, win, 2))).toEqual(['2026-01-08..2026-01-10']);
  });

  it('returns nothing when the counts came from a truncated expansion', () => {
    const f = counts([2, 2, 2, 2, 2, 2, 2, 2, 2, 2], 2, true);
    // Every day looks free, and that is exactly why it must refuse.
    expect(freeWindows(f, win, 2)).toEqual([]);
  });

  it('returns nothing when no day meets the threshold', () => {
    expect(freeWindows(counts([0, 0, 0], 2), iv('2026-01-01', '2026-01-03'), 2)).toEqual([]);
  });
});

describe('availabilityFor — end to end', () => {
  it('answers the question the feature exists for', () => {
    const win = iv('2026-01-01', '2026-01-14');
    const activities = [
      tagged([1], { id: 'a1', startDate: '2026-01-01', endDate: '2026-01-04' }),
      tagged([2], { id: 'a2', startDate: '2026-01-03', endDate: '2026-01-06' }),
      tagged([3], { id: 'a3', startDate: '2026-01-12', endDate: '2026-01-14' }),
      // Noise that must not affect the answer:
      tagged([1], { id: 'a4', startDate: '2026-01-08', endDate: '2026-01-09', status: 'cancelled' }),
      tagged([2], { id: 'a5', startDate: '2026-01-09', endDate: '2026-01-09', isMilestone: true }),
      tagged([9], { id: 'a6', startDate: '2026-01-07', endDate: '2026-01-11' }),
    ];

    const f = availabilityFor(activities, [1, 2, 3], win);
    expect(f.total).toBe(3);
    expect(f.truncated).toBe(false);

    // All three are free from the 7th to the 11th: the cancelled activity and the
    // milestone do not block, and person 9 is not in the selection.
    expect(show(freeWindows(f, win, 3, 3))).toEqual(['2026-01-07..2026-01-11']);
  });

  it('refuses to answer when any selected person has a truncated expansion', () => {
    const win = iv('2020-01-01', '2030-12-31');
    const activities = [
      tagged([1], {
        startDate: '2020-01-01', endDate: '2020-01-01',
        recurrence: { type: 'daily', interval: 1 } as never,
      }),
    ];
    const f = availabilityFor(activities, [1, 2], win);
    expect(f.truncated).toBe(true);
    // Person 2 has nothing scheduled, so every day would look free for them.
    expect(freeWindows(f, win, 1)).toEqual([]);
  });

  it('is unaffected by which activities a view would have filtered out', () => {
    // The caller passes the unfiltered list; availability does not know about
    // search terms, labels or hidden lanes, by design.
    const win = iv('2026-01-01', '2026-01-10');
    const activities = [
      tagged([1], { id: 'v', title: 'workshop', laneId: 'VISIBLE', startDate: '2026-01-02', endDate: '2026-01-03' }),
      tagged([1], { id: 'h', title: 'unrelated', laneId: 'HIDDEN', startDate: '2026-01-05', endDate: '2026-01-06' }),
    ];
    const f = availabilityFor(activities, [1], win);
    expect(f.counts).toEqual([1, 0, 0, 1, 0, 0, 1, 1, 1, 1]);
  });
});
