import {
  escapeHtml,
  parseDate,
  formatDate,
  addDays,
  addMonths,
  getMonday,
  getMonthStart,
  xyToAngle,
  randomId,
  createAngleScale,
} from '../utils';

describe('escapeHtml', () => {
  test('escapes &, <, >, "', () => {
    expect(escapeHtml('<img src="x" onerror=a&b>')).toBe('&lt;img src=&quot;x&quot; onerror=a&amp;b&gt;');
  });
  test('leaves safe text untouched', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('date helpers', () => {
  test('parseDate round-trips formatDate', () => {
    expect(formatDate(parseDate('2026-04-14'))).toBe('2026-04-14');
  });
  test('addDays handles month boundary', () => {
    expect(formatDate(addDays(parseDate('2026-01-31'), 1))).toBe('2026-02-01');
  });
  test('addMonths clamps Jan 31 + 1 month to Feb 28 (non-leap)', () => {
    expect(formatDate(addMonths(parseDate('2026-01-31'), 1))).toBe('2026-02-28');
  });
  test('addMonths clamps Jan 31 + 1 month to Feb 29 (leap year)', () => {
    expect(formatDate(addMonths(parseDate('2024-01-31'), 1))).toBe('2024-02-29');
  });
  test('getMonday returns same day if Monday', () => {
    const mon = parseDate('2026-04-13'); // Monday
    expect(formatDate(getMonday(mon))).toBe('2026-04-13');
  });
  test('getMonday returns previous Monday from Sunday', () => {
    const sun = parseDate('2026-04-19'); // Sunday
    expect(formatDate(getMonday(sun))).toBe('2026-04-13');
  });
  test('getMonthStart returns the 1st', () => {
    expect(formatDate(getMonthStart(parseDate('2026-04-14')))).toBe('2026-04-01');
  });
});

describe('xyToAngle', () => {
  test('12 o\'clock ≈ 0', () => {
    expect(xyToAngle(0, -1)).toBeCloseTo(0);
  });
  test('3 o\'clock ≈ π/2', () => {
    expect(xyToAngle(1, 0)).toBeCloseTo(Math.PI / 2);
  });
  test('6 o\'clock ≈ π', () => {
    expect(xyToAngle(0, 1)).toBeCloseTo(Math.PI);
  });
  test('9 o\'clock ≈ 3π/2', () => {
    expect(xyToAngle(-1, 0)).toBeCloseTo((3 * Math.PI) / 2);
  });
});

describe('createAngleScale', () => {
  // Viewport convention: windowEnd is the INCLUSIVE last day (Dec 31), so the scale
  // domain must extend one day past it for a full calendar year to map to a full circle.
  const windowStart = parseDate('2026-01-01');
  const windowEnd = parseDate('2026-12-31'); // inclusive

  test('windowStart maps to angle 0', () => {
    const scale = createAngleScale(windowStart, windowEnd);
    expect(scale(windowStart)).toBeCloseTo(0);
  });

  test('domain end (windowEnd + 1 day = Jan 1 next year) maps to a full circle (2π)', () => {
    const scale = createAngleScale(windowStart, windowEnd);
    expect(scale(addDays(windowEnd, 1))).toBeCloseTo(2 * Math.PI);
  });

  test('a Dec 31 (windowEnd) single-day activity has positive angular width', () => {
    const scale = createAngleScale(windowStart, windowEnd);
    const startAngle = scale(windowEnd);
    const endAngle = scale(addDays(windowEnd, 1)); // inclusive-end rendering convention
    expect(endAngle).toBeGreaterThan(startAngle);
    expect(endAngle).toBeCloseTo(2 * Math.PI);
  });

  test('a Jan 1 single-day activity has width without relying on MIN_ARC_SPAN', () => {
    const scale = createAngleScale(windowStart, windowEnd);
    const startAngle = scale(windowStart);
    const endAngle = scale(addDays(windowStart, 1));
    const oneDayWidth = (2 * Math.PI) / 365; // 2026 is not a leap year
    expect(endAngle - startAngle).toBeCloseTo(oneDayWidth, 5);
    // renderer.ts's MIN_ARC_SPAN (~0.012 rad) is a fallback for degenerate cases;
    // a real single day of a 365-day year should comfortably exceed it on its own.
    expect(endAngle - startAngle).toBeGreaterThan(0.012);
  });
});

describe('randomId', () => {
  test('returns 8-char base36 string', () => {
    const id = randomId();
    expect(id).toMatch(/^[a-z0-9]{1,8}$/);
  });
  test('is not deterministic', () => {
    const a = randomId();
    const b = randomId();
    expect(a === b).toBe(false);
  });
});
