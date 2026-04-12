import { scaleTime } from 'd3-scale';

/**
 * Returns a D3 time scale that maps dates to angles (radians).
 * 0 radians = top (12 o'clock), increasing clockwise.
 * Full circle = 2*PI.
 */
export function createAngleScale(startDate: Date, endDate: Date) {
  // d3 arc convention: 0 = top, PI/2 = right, PI = bottom, 3PI/2 = left
  // We offset by -PI/2 so that our 0-angle maps to the top
  return scaleTime()
    .domain([startDate, endDate])
    .range([-(Math.PI / 2), (3 * Math.PI) / 2]);
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

/**
 * Convert an (x, y) position relative to the disc center to an angle in radians.
 * Returns a value in [-PI/2, 3*PI/2] matching the angle scale convention.
 */
export function xyToAngle(dx: number, dy: number): number {
  // atan2 returns [-PI, PI]; dy is inverted in SVG (y grows downward)
  const raw = Math.atan2(dy, dx);
  // Shift so 0 = top (12 o'clock)
  let angle = raw + Math.PI / 2;
  if (angle > (3 * Math.PI) / 2) angle -= 2 * Math.PI;
  return angle;
}

/** Snap a date to the nearest whole day */
export function snapToDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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

/** Number of days in the month containing date d */
export function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
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
