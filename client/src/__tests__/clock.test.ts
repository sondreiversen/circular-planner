import { now, setNow, isLive, resetClock, parseNowOverride } from '../clock';
import { navigateToToday } from '../viewport';
import { PlannerConfig, ZoomLevel } from '../types';

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

  test('Week zoom lands on the Monday of the pinned date\'s week', () => {
    // 2026-03-14 is a Saturday; its Monday is 2026-03-09.
    setNow(new Date(2026, 2, 14, 12, 0, 0));
    const vp = navigateToToday(ZoomLevel.Week, config);
    expect(vp.windowStart.getFullYear()).toBe(2026);
    expect(vp.windowStart.getMonth()).toBe(2);
    expect(vp.windowStart.getDate()).toBe(9);
  });
});
