import { viewportLabel, navigateToYear, defaultViewport, navigateToRange, navigate } from '../viewport';
import { PlannerConfig, ZoomLevel } from '../types';
import { parseDate } from '../utils';

/**
 * The toolbar label must describe the window that is actually on screen.
 *
 * At Year zoom `windowEnd` is INCLUSIVE — every constructor produces one:
 * viewportForLevel gives Dec 31, navigateToYear gives Dec 31, defaultViewport
 * uses the planner's own end date, and navigateToRange takes whatever the date
 * pickers returned. The other three levels are exclusive (Month runs Aug 1 to
 * Sep 1), and the Year branch used to subtract a month as if it were exclusive
 * too. That produced a label a month short on a slid window, and a BACKWARDS
 * range on any window under two months long.
 */

const config: PlannerConfig = {
  plannerId: 1, title: 'T',
  startDate: '2026-04-01', endDate: '2026-04-30',
  isOwner: true, permission: 'owner', isPublic: false,
};

const yearVp = (startYmd: string, endYmd: string) =>
  navigateToRange(parseDate(startYmd), parseDate(endYmd), ZoomLevel.Year);

describe('Year label', () => {
  it('says just the year for a full calendar year', () => {
    expect(viewportLabel(navigateToYear(2026))).toBe('2026');
  });

  it('never renders a backwards range for a short window', () => {
    // A planner configured for a single month. This printed "2026-04 – 2026-03".
    const vp = defaultViewport(config);
    expect(vp.zoomLevel).toBe(ZoomLevel.Year);
    expect(viewportLabel(vp)).toBe('2026-04');
  });

  it('covers the real last month of a slid window', () => {
    // One step forward from a calendar year: Feb 1 2026 .. Jan 31 2027, which is
    // twelve months ending in January. The old label stopped at 2026-12.
    const slid = navigate(navigateToYear(2026), 1, config);
    expect(viewportLabel(slid)).toBe('2026-02 – 2027-01');
  });

  it('handles an arbitrary custom range', () => {
    expect(viewportLabel(yearVp('2026-03-15', '2026-06-20'))).toBe('2026-03 – 2026-06');
  });

  it('collapses to a single month when start and end share one', () => {
    expect(viewportLabel(yearVp('2026-04-05', '2026-04-25'))).toBe('2026-04');
  });

  it('keeps the year on both sides when the window spans a year boundary', () => {
    expect(viewportLabel(yearVp('2025-11-01', '2026-02-28'))).toBe('2025-11 – 2026-02');
  });
});
