import { navigateToToday, viewportLabel, fractionOfDate } from '../viewport';
import { setNow, resetClock } from '../clock';
import { PlannerConfig, ZoomLevel } from '../types';

const config: PlannerConfig = {
  plannerId: 1,
  title: 'T',
  startDate: '2020-01-01',
  endDate: '2030-12-31',
  isOwner: true,
  permission: 'owner',
  isPublic: false,
};

afterEach(() => resetClock());

/** Where today's DAY sits in the window, as a fraction of the span. */
function todayFraction(v: { windowStart: Date; windowEnd: Date }, today: Date): number {
  const mid = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  return fractionOfDate({ ...v, zoomLevel: ZoomLevel.Month } as never, mid);
}

const CENTRED = [ZoomLevel.Quarter, ZoomLevel.Month, ZoomLevel.Week];

describe('Today centres the window', () => {
  // The exact date from the design doc, so the doc's table stays checkable.
  it.each(CENTRED)('puts today near the middle at zoom %s', (zoom) => {
    const today = new Date(2026, 7, 31); // 2026-08-31, a Monday
    setNow(today);
    const v = navigateToToday(zoom, config);
    const f = todayFraction(v, today);
    // Before the fix these were 0.66, 0.97 and 0.00 respectively.
    expect(f).toBeGreaterThan(0.4);
    expect(f).toBeLessThan(0.6);
  });

  it('leaves the calendar year intact at Year zoom', () => {
    const today = new Date(2026, 7, 31);
    setNow(today);
    const v = navigateToToday(ZoomLevel.Year, config);
    // January at 12 o'clock is what the disc-as-clock design depends on.
    expect(v.windowStart.getMonth()).toBe(0);
    expect(v.windowStart.getDate()).toBe(1);
    expect(v.windowEnd.getMonth()).toBe(11);
    expect(v.windowStart.getFullYear()).toBe(2026);
  });

  it('centres on the first and last day of a month too', () => {
    for (const day of [1, 15, 28, 31]) {
      const today = new Date(2026, 0, day); // January, 31 days
      setNow(today);
      const v = navigateToToday(ZoomLevel.Month, config);
      const f = todayFraction(v, today);
      expect(f).toBeGreaterThan(0.4);
      expect(f).toBeLessThan(0.6);
    }
  });

  it('keeps the span equal to the calendar level it replaces', () => {
    setNow(new Date(2026, 1, 14)); // February — 28 days in 2026
    const feb = navigateToToday(ZoomLevel.Month, config);
    const febDays = Math.round(
      (feb.windowEnd.getTime() - feb.windowStart.getTime()) / 86400000);
    expect(febDays).toBe(28);

    setNow(new Date(2026, 0, 14)); // January — 31 days
    const jan = navigateToToday(ZoomLevel.Month, config);
    const janDays = Math.round(
      (jan.windowEnd.getTime() - jan.windowStart.getTime()) / 86400000);
    expect(janDays).toBe(31);
  });

  it('survives a DST boundary', () => {
    // Late March and late October are where a naive ms/86400000 span
    // calculation lands on x.96 or x.04 and floors to the wrong day count.
    for (const today of [new Date(2026, 2, 29), new Date(2026, 9, 25)]) {
      setNow(today);
      for (const zoom of CENTRED) {
        const v = navigateToToday(zoom, config);
        const f = todayFraction(v, today);
        expect(f).toBeGreaterThan(0.4);
        expect(f).toBeLessThan(0.6);
      }
    }
  });
});

describe('the window label describes what is actually shown', () => {
  it('does not claim a single month for a centred month window', () => {
    setNow(new Date(2026, 7, 31));
    const v = navigateToToday(ZoomLevel.Month, config);
    const label = viewportLabel(v);
    // Aug 16 -> Sep 16 is not the month of August. The aligned label is ISO
    // ("2026-08"); a centred window falls back to the "MMM d – MMM d" style
    // the Week level already uses.
    expect(label).not.toBe('2026-08');
    expect(label).toBe('Aug 16 – Sep 15');
  });

  it('still says the plain month for a calendar-aligned window', () => {
    const aligned = {
      windowStart: new Date(2026, 7, 1),
      windowEnd: new Date(2026, 8, 1),
      zoomLevel: ZoomLevel.Month,
    };
    expect(viewportLabel(aligned)).toBe('2026-08');
  });

  it('gives a day range for a centred quarter', () => {
    setNow(new Date(2026, 7, 31));
    const v = navigateToToday(ZoomLevel.Quarter, config);
    expect(viewportLabel(v)).toContain('–');
  });
});
