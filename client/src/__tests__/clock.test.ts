import { now, setNow, isLive, resetClock, parseNowOverride } from '../clock';
import { navigateToToday, dateAtFraction, fractionOfDate } from '../viewport';
import { PlannerConfig, ZoomLevel } from '../types';
import { parseDate } from '../utils';

// These run under testEnvironment: "node", so there is no `window`. That is
// deliberate: clock.ts falls back to the wall clock when window is absent, and
// parseNowOverride is pure so the URL-parsing rules are testable without a DOM.

const config: PlannerConfig = {
  plannerId: 1,
  title: 'Test',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  isOwner: true,
  permission: 'owner',
  isPublic: false,
};

afterEach(() => {
  resetClock();
});

describe('parseNowOverride', () => {
  test('parses a full ISO timestamp', () => {
    const d = parseNowOverride('?now=2026-03-14T09:30:00Z');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-03-14T09:30:00.000Z');
  });

  test('parses a date-only value', () => {
    const d = parseNowOverride('?now=2026-03-14');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-03-14T00:00:00.000Z');
  });

  test('works without the leading question mark', () => {
    expect(parseNowOverride('now=2026-03-14')).not.toBeNull();
  });

  test('returns null when the param is absent', () => {
    expect(parseNowOverride('?id=7&zoom=year')).toBeNull();
  });

  test('returns null for an empty search string', () => {
    expect(parseNowOverride('')).toBeNull();
  });

  test('returns null for an empty value rather than defaulting to epoch', () => {
    expect(parseNowOverride('?now=')).toBeNull();
  });

  // A malformed URL should degrade to the real date, never throw and blank the page.
  test('returns null for an unparseable value instead of throwing', () => {
    expect(parseNowOverride('?now=not-a-date')).toBeNull();
    expect(parseNowOverride('?now=2026-13-45')).toBeNull();
  });

  test('ignores other params', () => {
    const d = parseNowOverride('?id=7&now=2026-03-14&zoom=week');
    expect(d!.toISOString()).toBe('2026-03-14T00:00:00.000Z');
  });
});

describe('now / setNow', () => {
  test('follows the wall clock by default', () => {
    const before = Date.now();
    const t = now().getTime();
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  test('returns the pinned date once set', () => {
    const pin = new Date('2026-03-14T09:30:00Z');
    setNow(pin);
    expect(now().toISOString()).toBe('2026-03-14T09:30:00.000Z');
  });

  test('setNow(null) resumes following the wall clock', () => {
    setNow(new Date('1998-07-02T00:00:00Z'));
    expect(now().getFullYear()).toBe(1998);
    setNow(null);
    expect(now().getFullYear()).toBe(new Date().getFullYear()); // clock-exempt: asserting we fell back to the real clock
  });

  // Date is mutable. Handing out a shared instance would let one caller's
  // setDate() silently corrupt the clock for every other reader.
  test('hands out a fresh Date each call', () => {
    setNow(new Date('2026-03-14T00:00:00Z'));
    const a = now();
    const b = now();
    expect(a).not.toBe(b);
    a.setFullYear(1900);
    expect(now().getFullYear()).toBe(2026);
  });

  test('copies the pinned date so later mutation of the caller\'s object is ignored', () => {
    const pin = new Date('2026-03-14T00:00:00Z');
    setNow(pin);
    pin.setFullYear(1900);
    expect(now().getFullYear()).toBe(2026);
  });

  test('isLive reflects whether the clock is pinned', () => {
    expect(isLive()).toBe(true);
    setNow(new Date('2026-03-14T00:00:00Z'));
    expect(isLive()).toBe(false);
    setNow(null);
    expect(isLive()).toBe(true);
  });
});

// The point of the whole abstraction: date-dependent rendering becomes
// reproducible. navigateToToday reads now() and is otherwise pure, so it is the
// cheapest end-to-end proof that pinning the clock pins the render.
describe('render determinism under a pinned clock', () => {
  test('navigateToToday is deterministic for a pinned date', () => {
    setNow(new Date('2026-03-14T12:00:00Z'));
    const a = navigateToToday(ZoomLevel.Year, config);
    const b = navigateToToday(ZoomLevel.Year, config);
    expect(a.windowStart.getTime()).toBe(b.windowStart.getTime());
    expect(a.windowEnd.getTime()).toBe(b.windowEnd.getTime());
    expect(a.windowStart.getFullYear()).toBe(2026);
  });

  test('a different pinned date produces a different viewport', () => {
    setNow(new Date('2026-03-14T12:00:00Z'));
    const then2026 = navigateToToday(ZoomLevel.Year, config);

    setNow(new Date('1998-07-02T12:00:00Z'));
    const then1998 = navigateToToday(ZoomLevel.Year, config);

    expect(then2026.windowStart.getFullYear()).toBe(2026);
    expect(then1998.windowStart.getFullYear()).toBe(1998);
    expect(then2026.windowStart.getTime()).not.toBe(then1998.windowStart.getTime());
  });

  test('Week zoom centres the pinned date rather than snapping to Monday', () => {
    // BEHAVIOUR CHANGE. This test previously asserted that Week zoom landed on
    // the Monday of the pinned date's week (2026-03-09 for a Saturday the 14th).
    // Snapping to Monday is precisely what put today at the very left edge of
    // the window — 0% of the span — which is the "Today doesn't centre"
    // complaint. Today is now placed in the middle of a still-7-day window.
    setNow(new Date(2026, 2, 14, 12, 0, 0)); // Saturday
    const vp = navigateToToday(ZoomLevel.Week, config);

    // 3 days before the 14th, so the 14th is the 4th of 7 days.
    expect(vp.windowStart.getFullYear()).toBe(2026);
    expect(vp.windowStart.getMonth()).toBe(2);
    expect(vp.windowStart.getDate()).toBe(11);

    const days = Math.round(
      (vp.windowEnd.getTime() - vp.windowStart.getTime()) / 86400000);
    expect(days).toBe(7);
  });
});

describe('scrubber mapping', () => {
  const vp = {
    windowStart: parseDate('2026-01-01'),
    windowEnd: parseDate('2026-12-31'),
    zoomLevel: ZoomLevel.Year,
  };

  test('0 is the window start and 1 is the window end', () => {
    expect(dateAtFraction(vp, 0).getTime()).toBe(vp.windowStart.getTime());
    expect(dateAtFraction(vp, 1).getTime()).toBe(vp.windowEnd.getTime());
  });

  test('0.5 lands mid-window', () => {
    const mid = dateAtFraction(vp, 0.5).getTime();
    expect(mid).toBe((vp.windowStart.getTime() + vp.windowEnd.getTime()) / 2);
  });

  // A pointer can leave the control mid-drag, and some platforms report range
  // values outside the declared bounds.
  test('clamps out-of-range fractions', () => {
    expect(dateAtFraction(vp, -5).getTime()).toBe(vp.windowStart.getTime());
    expect(dateAtFraction(vp, 99).getTime()).toBe(vp.windowEnd.getTime());
    expect(dateAtFraction(vp, NaN).getTime()).toBe(vp.windowStart.getTime());
  });

  test('fractionOfDate inverts dateAtFraction', () => {
    for (const f of [0, 0.125, 0.5, 0.77, 1]) {
      expect(fractionOfDate(vp, dateAtFraction(vp, f))).toBeCloseTo(f, 9);
    }
  });

  test('fractionOfDate clamps dates outside the window', () => {
    expect(fractionOfDate(vp, parseDate('2020-01-01'))).toBe(0);
    expect(fractionOfDate(vp, parseDate('2030-01-01'))).toBe(1);
  });

  test('a zero-span window does not divide by zero', () => {
    const flat = { windowStart: parseDate('2026-05-05'), windowEnd: parseDate('2026-05-05'), zoomLevel: ZoomLevel.Year };
    expect(fractionOfDate(flat, parseDate('2026-05-05'))).toBe(0);
    expect(Number.isNaN(dateAtFraction(flat, 0.5).getTime())).toBe(false);
  });
});
