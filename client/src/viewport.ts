import { PlannerConfig, Viewport, ZoomLevel, GridSpec } from './types';
import { parseDate, addDays, addMonths, getMonday, getMonthStart, formatDate, daysBetween } from './utils';
import { now } from './clock';

const MONTHS_FULL = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_SHORT = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

/** Abbreviated year suffix, e.g. "'26" */
function yearSuffix(d: Date): string {
  return `'${String(d.getFullYear()).slice(-2)}`;
}

/** Default viewport: full year at Year zoom level */
export function defaultViewport(config: PlannerConfig): Viewport {
  return {
    windowStart: parseDate(config.startDate),
    windowEnd: parseDate(config.endDate),
    zoomLevel: ZoomLevel.Year,
  };
}

/** Center date of a viewport window */
function midpoint(v: Viewport): Date {
  return new Date((v.windowStart.getTime() + v.windowEnd.getTime()) / 2);
}

/** Build a viewport centered on a date for a given zoom level */
function viewportForLevel(center: Date, level: ZoomLevel, _config: PlannerConfig): Viewport {
  let start: Date;
  let end: Date;

  switch (level) {
    case ZoomLevel.Year:
      // Full calendar year containing the center date
      start = new Date(center.getFullYear(), 0, 1);
      end = new Date(center.getFullYear(), 11, 31);
      break;
    case ZoomLevel.Quarter:
      start = addMonths(getMonthStart(center), -1);
      end = addMonths(start, 3);
      break;
    case ZoomLevel.Month:
      start = getMonthStart(center);
      end = addMonths(start, 1);
      break;
    case ZoomLevel.Week:
      start = getMonday(center);
      end = addDays(start, 7);
      break;
  }

  return { windowStart: start, windowEnd: end, zoomLevel: level };
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * A window of the same length as `level`'s window, centred on `center`.
 *
 * viewportForLevel takes a parameter named `center` and never centres — it
 * snaps to calendar boundaries. Measured for 2026-08-31 that put today at 97%
 * of a Month window (hard against the right edge) and 0% of a Week window (the
 * very first day), which is what "Today doesn't centre" actually is.
 *
 * This keeps the level's span in whole days and places today's day in the
 * middle of it. The span is taken FROM the snapped window so a centred month
 * stays month-length (28-31 days) rather than becoming a fixed 30.
 */
function centerWindowOn(center: Date, level: ZoomLevel, config: PlannerConfig): Viewport {
  const snapped = viewportForLevel(center, level, config);
  const span = daysBetween(snapped.windowStart, snapped.windowEnd);
  const before = Math.floor((span - 1) / 2);
  const start = addDays(startOfDay(center), -before);
  return { windowStart: start, windowEnd: addDays(start, span), zoomLevel: level };
}

/**
 * Is this window flush with calendar month boundaries?
 *
 * Decides how the window is labelled. A snapped month window is "August 2026";
 * a centred one spans two months and must say so.
 */
function isMonthAligned(windowStart: Date, windowEnd: Date): boolean {
  return windowStart.getDate() === 1 && windowEnd.getDate() === 1;
}

const ZOOM_ORDER: ZoomLevel[] = [ZoomLevel.Year, ZoomLevel.Quarter, ZoomLevel.Month, ZoomLevel.Week];

/** Zoom in to the next finer level, centered on the current window midpoint */
export function zoomIn(current: Viewport, config: PlannerConfig): Viewport {
  const idx = ZOOM_ORDER.indexOf(current.zoomLevel);
  if (idx >= ZOOM_ORDER.length - 1) return current;
  const nextLevel = ZOOM_ORDER[idx + 1];
  return viewportForLevel(midpoint(current), nextLevel, config);
}

/** Zoom out to the next coarser level, centered on the current window midpoint */
export function zoomOut(current: Viewport, config: PlannerConfig): Viewport {
  const idx = ZOOM_ORDER.indexOf(current.zoomLevel);
  if (idx <= 0) return current;
  const prevLevel = ZOOM_ORDER[idx - 1];
  return viewportForLevel(midpoint(current), prevLevel, config);
}

/** Navigate forward (direction=1) or backward (direction=-1) */
export function navigate(current: Viewport, direction: -1 | 1, config: PlannerConfig): Viewport {
  let newStart: Date;
  let newEnd: Date;

  switch (current.zoomLevel) {
    case ZoomLevel.Year:
    case ZoomLevel.Quarter:
    case ZoomLevel.Month:
      newStart = addMonths(current.windowStart, direction);
      newEnd = addMonths(current.windowEnd, direction);
      break;
    case ZoomLevel.Week:
      newStart = addDays(current.windowStart, direction * 7);
      newEnd = addDays(current.windowEnd, direction * 7);
      break;
  }

  // Allow navigation up to 2 years before config start and 2 years after config end
  const configStart = parseDate(config.startDate);
  const configEnd = parseDate(config.endDate);
  const minStart = new Date(configStart.getFullYear() - 2, configStart.getMonth(), configStart.getDate());
  const maxEnd = new Date(configEnd.getFullYear() + 2, configEnd.getMonth(), configEnd.getDate());

  const span = newEnd.getTime() - newStart.getTime();
  if (newStart < minStart) {
    newStart = minStart;
    newEnd = new Date(minStart.getTime() + span);
  }
  if (newEnd > maxEnd) {
    newEnd = maxEnd;
    newStart = new Date(maxEnd.getTime() - span);
  }

  return { windowStart: newStart, windowEnd: newEnd, zoomLevel: current.zoomLevel };
}

/** Can we zoom in further? */
export function canZoomIn(viewport: Viewport): boolean {
  return ZOOM_ORDER.indexOf(viewport.zoomLevel) < ZOOM_ORDER.length - 1;
}

/** Can we zoom out further? */
export function canZoomOut(viewport: Viewport): boolean {
  return ZOOM_ORDER.indexOf(viewport.zoomLevel) > 0;
}

/** Generate gridlines and labels for the current viewport */
export function getGridSpec(viewport: Viewport): GridSpec {
  const { windowStart, windowEnd, zoomLevel } = viewport;
  const majorTicks: Date[] = [];
  const minorTicks: Date[] = [];
  const labels: Array<{ date: Date; text: string; anchor?: boolean }> = [];
  const subLabels: Array<{ date: Date; text: string }> = [];

  // Does the viewport span multiple calendar years?
  const spansYears = windowStart.getFullYear() !== windowEnd.getFullYear();

  switch (zoomLevel) {
    case ZoomLevel.Year:
      iterateMonths(windowStart, windowEnd, (d) => {
        majorTicks.push(d);
      });
      // Month labels: just the abbreviated month name (day sub-labels provide scale)
      iterateMonths(windowStart, windowEnd, (d) => {
        const mid = new Date(d.getTime());
        mid.setDate(15);
        if (mid >= windowStart && mid <= windowEnd) {
          const text = spansYears
            ? `${MONTHS_SHORT[d.getMonth()]} ${yearSuffix(d)}`
            : MONTHS_SHORT[d.getMonth()];
          labels.push({ date: mid, text, anchor: true });
        }
      });
      // Day sub-labels: days 1, 8, 15, 22 as minor ticks + inner numeric labels
      {
        const DAY_MARKERS = [1, 8, 15, 22];
        iterateMonths(windowStart, windowEnd, (d) => {
          DAY_MARKERS.forEach(day => {
            const markerDate = new Date(d.getFullYear(), d.getMonth(), day);
            if (markerDate >= windowStart && markerDate <= windowEnd) {
              // Skip day 1 — it coincides with the month major tick
              if (day !== 1) minorTicks.push(markerDate);
              subLabels.push({ date: markerDate, text: String(day) });
            }
          });
        });
      }
      break;

    case ZoomLevel.Quarter:
      iterateMonths(windowStart, windowEnd, (d) => {
        majorTicks.push(d);
      });
      iterateWeeks(windowStart, windowEnd, (d) => {
        minorTicks.push(d);
        const weekNum = getWeekNumber(d);
        // Week-number labels sit in subLabels: rendered in the disc inner ring
        // and in the list/people two-tier header above the month labels.
        subLabels.push({ date: addDays(d, 3), text: `W${weekNum}` });
      });
      // Labels: month name + year suffix when spanning years
      iterateMonths(windowStart, windowEnd, (d) => {
        const mid = new Date(d.getTime());
        mid.setDate(15);
        if (mid >= windowStart && mid <= windowEnd) {
          const text = spansYears
            ? `${MONTHS_SHORT[d.getMonth()]} ${yearSuffix(d)}`
            : MONTHS_SHORT[d.getMonth()];
          labels.push({ date: mid, text, anchor: true });
        }
      });
      break;

    case ZoomLevel.Month:
      iterateWeeks(windowStart, windowEnd, (d) => {
        majorTicks.push(d);
        const weekNum = getWeekNumber(d);
        // Week labels go into subLabels so list/people views can render a dedicated
        // second header row and the disc renders them in the inner sub-label ring,
        // preventing overlap with day-of-month labels on the disc perimeter.
        subLabels.push({ date: addDays(d, 3), text: `W${weekNum}` });
      });
      iterateDays(windowStart, windowEnd, (d) => {
        minorTicks.push(d);
        labels.push({ date: d, text: String(d.getDate()) });
      });
      break;

    case ZoomLevel.Week:
      iterateDays(windowStart, windowEnd, (d) => {
        majorTicks.push(d);
        const dayIdx = (d.getDay() + 6) % 7; // 0=Mon
        labels.push({ date: d, text: `${DAYS_SHORT[dayIdx]} ${d.getDate()}` });
      });
      break;
  }

  return { majorTicks, minorTicks, labels, subLabels: subLabels.length ? subLabels : undefined };
}

/** ISO YYYY-MM */
function formatYearMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Compact "MMM d" format, e.g. "Jun 15" */
function formatMonthDay(d: Date): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

/** ISO-formatted label for the current viewport */
export function viewportLabel(viewport: Viewport): string {
  const { windowStart, windowEnd, zoomLevel } = viewport;

  switch (zoomLevel) {
    case ZoomLevel.Year: {
      // Full calendar year (Jan–Dec same year): show just the year
      if (windowStart.getMonth() === 0 && windowEnd.getMonth() === 11 &&
          windowStart.getFullYear() === windowEnd.getFullYear()) {
        return String(windowStart.getFullYear());
      }
      // Anything else: the ISO month range the window actually covers.
      //
      // windowEnd is INCLUSIVE at this zoom level, unlike Month, Quarter and
      // Week, whose windows run to the first day of the following period. Every
      // Year constructor produces an inclusive end: viewportForLevel and
      // navigateToYear give Dec 31, defaultViewport uses the planner's own end
      // date, and navigateToRange takes whatever the date pickers returned.
      //
      // This used to subtract a month here, as if the end were exclusive. That
      // understated every slid window by a month (Feb 1 2026 – Jan 31 2027 was
      // labelled "2026-02 – 2026-12"), and on any window shorter than two
      // months it ran off the front and printed a BACKWARDS range: a planner
      // configured 2026-04-01 to 2026-04-30 showed "2026-04 – 2026-03".
      const startLabel = formatYearMonth(windowStart);
      const endLabel = formatYearMonth(windowEnd);
      return startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
    }
    case ZoomLevel.Quarter: {
      // Both labels below are derived from windowStart alone, which is only
      // right for a calendar-snapped window. A centred window spans parts of
      // four months, so it gets an explicit day range instead.
      if (!isMonthAligned(windowStart, windowEnd)) {
        return `${formatMonthDay(windowStart)} – ${formatMonthDay(addDays(windowEnd, -1))}`;
      }
      const endMonth = addMonths(windowStart, 2);
      return `${formatYearMonth(windowStart)} – ${formatYearMonth(endMonth)}`;
    }
    case ZoomLevel.Month:
      if (!isMonthAligned(windowStart, windowEnd)) {
        return `${formatMonthDay(windowStart)} – ${formatMonthDay(addDays(windowEnd, -1))}`;
      }
      return formatYearMonth(windowStart);
    case ZoomLevel.Week: {
      const end = addDays(windowStart, 6);
      return `${formatMonthDay(windowStart)} – ${formatMonthDay(end)}`;
    }
  }
}

/** Jump directly to a specific calendar year */
export function navigateToYear(year: number): Viewport {
  return {
    windowStart: new Date(year, 0, 1),
    windowEnd: new Date(year, 11, 31),
    zoomLevel: ZoomLevel.Year,
  };
}

/** Set a fully custom date range, preserving zoom level */
export function navigateToRange(start: Date, end: Date, zoomLevel: ZoomLevel): Viewport {
  return { windowStart: start, windowEnd: end, zoomLevel };
}

/** Jump to a viewport that includes today, preserving the current zoom level */
export function navigateToToday(zoomLevel: ZoomLevel, config: PlannerConfig): Viewport {
  const today = now();

  // Year deliberately keeps the calendar year rather than centring. The disc is
  // a year clock: January sits at 12 o'clock and the today hand points at the
  // real position in the year. A rolling twelve months centred on today would
  // put January at an arbitrary angle and break the thing the disc is for.
  // Today at 66% of a calendar year is correct; today at 97% of a month is not.
  if (zoomLevel === ZoomLevel.Year) {
    return viewportForLevel(today, zoomLevel, config);
  }

  return centerWindowOn(today, zoomLevel, config);
}

/**
 * Date at a position through the current window, 0..1.
 *
 * The scrubber's whole model: the visible window maps onto the full circle, so
 * a fraction of the window is a fraction of the disc. Clamped, because a
 * pointer can leave the control while dragging and a range input can report
 * values outside its own bounds on some platforms.
 */
export function dateAtFraction(viewport: Viewport, frac: number): Date {
  const start = viewport.windowStart.getTime();
  const span = viewport.windowEnd.getTime() - start;
  const f = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0;
  return new Date(start + span * f);
}

/**
 * Where a date sits in the current window, 0..1.
 *
 * Inverse of dateAtFraction. Used to seat the scrubber at today when it first
 * appears, so grabbing it does not jump the disc.
 */
export function fractionOfDate(viewport: Viewport, date: Date): number {
  const start = viewport.windowStart.getTime();
  const span = viewport.windowEnd.getTime() - start;
  if (span <= 0) return 0;
  const f = (date.getTime() - start) / span;
  return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
}

// ==================== Iteration helpers ====================

function iterateMonths(start: Date, end: Date, cb: (d: Date) => void): void {
  const d = getMonthStart(start);
  const cursor = new Date(d.getTime());
  while (cursor <= end) {
    if (cursor >= start) cb(new Date(cursor.getTime()));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  if (cursor <= addMonths(end, 1)) cb(new Date(cursor.getTime()));
}

function iterateWeeks(start: Date, end: Date, cb: (d: Date) => void): void {
  let cursor = getMonday(start);
  while (cursor <= end) {
    if (cursor >= start) cb(new Date(cursor.getTime()));
    cursor = addDays(cursor, 7);
  }
}

function iterateDays(start: Date, end: Date, cb: (d: Date) => void): void {
  let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (cursor < end) {
    cb(new Date(cursor.getTime()));
    cursor = addDays(cursor, 1);
  }
}

function getWeekNumber(d: Date): number {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const diffMs = d.getTime() - jan1.getTime();
  const dayOfYear = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return Math.ceil((dayOfYear + jan1.getDay() + 1) / 7);
}
