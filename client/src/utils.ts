import { scaleTime } from 'd3-scale';

export const FONT_FAMILY = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

export function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Returns a D3 time scale that maps dates to angles (radians).
 * Uses d3-shape arc convention: 0 = 12 o'clock, increasing clockwise.
 * Full circle = 2*PI.
 */
export function createAngleScale(startDate: Date, endDate: Date) {
  return scaleTime()
    .domain([startDate, endDate])
    .range([0, 2 * Math.PI]);
}

/** Parse an ISO date string "YYYY-MM-DD" into a local Date object. */
export function parseDate(s: string): Date {
  const [year, month, day] = s.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Format a Date to "YYYY-MM-DD" */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Convert "YYYY-MM-DD" to "DD/MM/YYYY". Returns input unchanged on mismatch. */
export function ymdToDmy(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}

/** Parse "DD/MM/YYYY" (or D/M/YYYY, with / - or . separators) to "YYYY-MM-DD", or null if invalid. */
export function dmyToYmd(dmy: string): string | null {
  const m = /^\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\s*$/.exec(dmy);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Convert an (x, y) position relative to the disc center to an angle in radians.
 * Returns a value in [0, 2*PI] matching the d3-arc angle convention (0 = 12 o'clock, clockwise).
 */
export function xyToAngle(dx: number, dy: number): number {
  // d3-arc: sin(a) = x/r, -cos(a) = y/r, so a = atan2(dx, -dy)
  let angle = Math.atan2(dx, -dy);
  if (angle < 0) angle += 2 * Math.PI;
  return angle;
}

/** Generate a short random ID */
export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Add n days to a date, returning a new Date */
export function addDays(d: Date, n: number): Date {
  const result = new Date(d.getTime());
  result.setDate(result.getDate() + n);
  return result;
}

/** Add n months to a date, clamping to last day of month if needed */
export function addMonths(d: Date, n: number): Date {
  const result = new Date(d.getTime());
  const targetMonth = result.getMonth() + n;
  result.setMonth(targetMonth);
  // If day overflowed (e.g. Jan 31 + 1 month → Mar 3), clamp to last day
  if (result.getDate() !== d.getDate()) {
    result.setDate(0); // go to last day of previous month
  }
  return result;
}

/** Snap a date to the previous Monday (or same day if already Monday) */
export function getMonday(d: Date): Date {
  const result = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = result.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? 6 : day - 1; // distance back to Monday
  result.setDate(result.getDate() - diff);
  return result;
}

/** Snap a date to the 1st of its month */
export function getMonthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Predefined color palette for activities */
export const COLOR_PALETTE: string[] = [
  '#E53935', // red
  '#FB8C00', // orange
  '#FDD835', // yellow
  '#43A047', // green
  '#00ACC1', // cyan
  '#1E88E5', // blue
  '#8E24AA', // purple
  '#D81B60', // pink
  '#6D4C41', // brown
  '#546E7A', // blue-grey
  '#00897B', // teal
  '#C0CA33', // lime
];

/** Default lane background colors */
export const LANE_COLORS: string[] = [
  'rgba(66,133,244,0.25)',   // blue
  'rgba(52,168,83,0.25)',    // green
  'rgba(251,188,4,0.25)',    // amber
  'rgba(154,100,208,0.25)',  // purple
  'rgba(234,67,53,0.22)',    // red
  'rgba(0,172,193,0.25)',    // teal
  'rgba(255,112,67,0.25)',   // deep orange
  'rgba(124,179,66,0.25)',   // light green
];

export function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length];
}
