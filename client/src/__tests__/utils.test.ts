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
