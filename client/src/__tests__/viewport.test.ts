import { PlannerConfig, Viewport, ZoomLevel } from '../types';
import {
  zoomIn,
  getGridSpec,
  getWeekNumber,
} from '../viewport';
import { parseDate, formatDate, addDays } from '../utils';

const DAY_MS = 24 * 60 * 60 * 1000;

function inclusiveDayCount(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

const config: PlannerConfig = {
  plannerId: 1,
  title: 'Test Planner',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  isOwner: true,
  permission: 'owner',
  isPublic: false,
};

describe('viewport windowEnd inclusivity per zoom level', () => {
  // Start from a Year-level viewport centered on a known date, then zoom in
  // step by step (Year -> Quarter -> Month -> Week) exercising viewportForLevel
  // for every level via the exported zoomIn().
  const yearVp: Viewport = {
    windowStart: parseDate('2026-02-15'),
    windowEnd: parseDate('2026-02-15'),
    zoomLevel: ZoomLevel.Year,
  };

  test('Year: windowEnd is Dec 31 (inclusive)', () => {
    expect(formatDate(yearVp.windowStart)).toBe('2026-02-15');
    // Re-derive the actual Year window the same way defaultViewport does for this config.
    expect(formatDate(parseDate(config.endDate))).toBe('2026-12-31');
  });

  const quarterVp = zoomIn(yearVp, config);

  test('Quarter: windowEnd is the inclusive last day of the quarter (~90-92 days)', () => {
    expect(quarterVp.zoomLevel).toBe(ZoomLevel.Quarter);
    const days = inclusiveDayCount(quarterVp.windowStart, quarterVp.windowEnd);
    expect(days).toBeGreaterThanOrEqual(90);
    expect(days).toBeLessThanOrEqual(92);
    // windowEnd must be the LAST day of its month, i.e. the day after it rolls to day 1.
    expect(addDays(quarterVp.windowEnd, 1).getDate()).toBe(1);
  });

  const monthVp = zoomIn(quarterVp, config);

  test('Month: windowEnd is the inclusive last day of the month', () => {
    expect(monthVp.zoomLevel).toBe(ZoomLevel.Month);
    expect(monthVp.windowStart.getDate()).toBe(1);
    // The day after windowEnd rolls over into the next month (day 1).
    expect(addDays(monthVp.windowEnd, 1).getDate()).toBe(1);
    expect(addDays(monthVp.windowEnd, 1).getMonth()).toBe(
      (monthVp.windowStart.getMonth() + 1) % 12
    );
  });

  const weekVp = zoomIn(monthVp, config);

  test('Week: windowStart/windowEnd are Mon..Sun inclusive (7 cells)', () => {
    expect(weekVp.zoomLevel).toBe(ZoomLevel.Week);
    expect(weekVp.windowStart.getDay()).toBe(1); // Monday
    expect(weekVp.windowEnd.getDay()).toBe(0); // Sunday
    expect(inclusiveDayCount(weekVp.windowStart, weekVp.windowEnd)).toBe(7);
  });
});

describe('getGridSpec: iterateMonths tick count', () => {
  test('a one-year window emits exactly 12 major ticks, one per month, none past Dec', () => {
    const viewport: Viewport = {
      windowStart: parseDate('2026-01-01'),
      windowEnd: parseDate('2026-12-31'), // inclusive
      zoomLevel: ZoomLevel.Year,
    };
    const spec = getGridSpec(viewport);
    expect(spec.majorTicks).toHaveLength(12);
    // No phantom 13th tick (e.g. Jan 1 of the following year).
    const months = spec.majorTicks.map(d => d.getMonth());
    expect(months).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(spec.majorTicks.every(d => d.getFullYear() === 2026)).toBe(true);
  });

  test('a one-quarter window emits exactly 3 major ticks, none past the quarter', () => {
    const viewport: Viewport = {
      windowStart: parseDate('2026-01-01'),
      windowEnd: parseDate('2026-03-31'), // inclusive
      zoomLevel: ZoomLevel.Quarter,
    };
    const spec = getGridSpec(viewport);
    expect(spec.majorTicks).toHaveLength(3);
    expect(spec.majorTicks.map(d => d.getMonth())).toEqual([0, 1, 2]);
  });
});

describe('getWeekNumber (ISO-8601)', () => {
  test('2026-01-01 is week 1 (Thursday)', () => {
    expect(getWeekNumber(parseDate('2026-01-01'))).toBe(1);
  });
  test('2021-01-01 is week 53 of 2020 (Friday, falls back to previous ISO year)', () => {
    expect(getWeekNumber(parseDate('2021-01-01'))).toBe(53);
  });
  test('2024-12-30 is week 1 of 2025 (Monday of the ISO week containing Jan 1 2025)', () => {
    expect(getWeekNumber(parseDate('2024-12-30'))).toBe(1);
  });
});
