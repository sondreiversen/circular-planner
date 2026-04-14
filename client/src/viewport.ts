import { PlannerConfig, Viewport, ZoomLevel, GridSpec } from './types';
import { parseDate, addDays, addMonths, getMonday, getMonthStart } from './utils';

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
  const labels: Array<{ date: Date; text: string }> = [];
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
          labels.push({ date: mid, text });
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
      });
      // Labels: month name + year suffix when spanning years
      iterateMonths(windowStart, windowEnd, (d) => {
        const mid = new Date(d.getTime());
        mid.setDate(15);
        if (mid >= windowStart && mid <= windowEnd) {
          const text = spansYears
            ? `${MONTHS_SHORT[d.getMonth()]} ${yearSuffix(d)}`
            : MONTHS_SHORT[d.getMonth()];
          labels.push({ date: mid, text });
        }
      });
      break;

    case ZoomLevel.Month:
      iterateWeeks(windowStart, windowEnd, (d) => {
        majorTicks.push(d);
        const weekNum = getWeekNumber(d);
        labels.push({ date: addDays(d, 3), text: `W${weekNum}` });
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

/** Human-readable label for the current viewport */
export function viewportLabel(viewport: Viewport): string {
  const { windowStart, windowEnd, zoomLevel } = viewport;

  switch (zoomLevel) {
    case ZoomLevel.Year: {
      // Full calendar year (Jan–Dec same year): show just the year
      if (windowStart.getMonth() === 0 && windowEnd.getMonth() === 11 &&
          windowStart.getFullYear() === windowEnd.getFullYear()) {
        return String(windowStart.getFullYear());
      }
      // Sliding window spanning two years: show abbreviated range
      const endDisplay = addMonths(windowEnd, -1);
      return `${MONTHS_SHORT[windowStart.getMonth()]} ${yearSuffix(windowStart)}–${MONTHS_SHORT[endDisplay.getMonth()]} ${yearSuffix(endDisplay)}`;
    }
    case ZoomLevel.Quarter: {
      const m1 = MONTHS_SHORT[windowStart.getMonth()];
      const endMonth = addMonths(windowStart, 2);
      const m2 = MONTHS_SHORT[endMonth.getMonth()];
      if (windowStart.getFullYear() !== endMonth.getFullYear()) {
        return `${m1} ${yearSuffix(windowStart)}–${m2} ${yearSuffix(endMonth)}`;
      }
      return `${m1}–${m2} ${windowStart.getFullYear()}`;
    }
    case ZoomLevel.Month:
      return `${MONTHS_FULL[windowStart.getMonth()]} ${windowStart.getFullYear()}`;
    case ZoomLevel.Week: {
      const end = addDays(windowStart, 6);
      const m = MONTHS_SHORT[windowStart.getMonth()];
      return `${m} ${windowStart.getDate()}–${end.getDate()}, ${windowStart.getFullYear()}`;
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
