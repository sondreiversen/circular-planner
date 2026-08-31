import { fitLabel, MIN_LABEL_CHARS, ELLIPSIS, MAX_FIT_MEASUREMENTS } from '../label-fit';

/**
 * A proportional-ish measurer. Advance width is not exactly linear in character
 * count in a real font, so the tests use a width table with per-character
 * variation — a purely linear stub would make the estimator look perfect and
 * hide the correction step this code exists to perform.
 */
function makeMeasurer(widths: Record<string, number>, fallback = 6) {
  const calls: string[] = [];
  const fn = (s: string): number => {
    calls.push(s);
    return [...s].reduce((sum, ch) => sum + (widths[ch] ?? fallback), 0);
  };
  return { fn, calls };
}

const WIDTHS: Record<string, number> = {
  i: 2, l: 2, t: 3, r: 3, f: 3, ' ': 3,
  m: 10, w: 9, M: 11, W: 12,
  [ELLIPSIS]: 8,
};

describe('fitLabel', () => {
  it('returns the title untouched when it already fits', () => {
    const m = makeMeasurer(WIDTHS);
    expect(fitLabel('Design review', 80, 120, m.fn)).toBe('Design review');
    expect(m.calls).toHaveLength(0); // no measurement spent
  });

  it('spends at most one measurement', () => {
    const m = makeMeasurer(WIDTHS);
    const title = 'Quarterly planning workshop with the whole team';
    fitLabel(title, m.fn(title), 100, m.fn);
    // First call is the caller's own full measurement, which we made above.
    expect(m.calls.length).toBeLessThanOrEqual(2);
  });

  it('actually fits inside the arc, across many widths', () => {
    const title = 'Migrate the reporting warehouse to the new cluster';
    const m = makeMeasurer(WIDTHS);
    const fullLen = m.fn(title);

    for (let arcLen = 12; arcLen < fullLen; arcLen += 3) {
      const measurer = makeMeasurer(WIDTHS);
      const out = fitLabel(title, fullLen, arcLen, measurer.fn);
      if (out === null) continue;
      // The whole point: whatever comes back must physically fit.
      expect(measurer.fn(out)).toBeLessThanOrEqual(arcLen);
    }
  });

  it('drops only when the arc cannot hold a useful label', () => {
    const m = makeMeasurer(WIDTHS);
    const title = 'Retrospective';
    expect(fitLabel(title, 100, 1, m.fn)).toBeNull();
    expect(fitLabel(title, 100, 0, m.fn)).toBeNull();
    expect(fitLabel(title, 100, -5, m.fn)).toBeNull();
  });

  it('never returns a stub shorter than MIN_LABEL_CHARS plus the ellipsis', () => {
    const title = 'Infrastructure migration planning';
    for (let arcLen = 1; arcLen < 60; arcLen++) {
      const m = makeMeasurer(WIDTHS);
      const out = fitLabel(title, m.fn(title), arcLen, m.fn);
      if (out === null) continue;
      if (out !== title) {
        expect(out.endsWith(ELLIPSIS)).toBe(true);
        expect(out.length - 1).toBeGreaterThanOrEqual(MIN_LABEL_CHARS);
      }
    }
  });

  it('handles a title at or below the minimum length', () => {
    const m = makeMeasurer(WIDTHS);
    expect(fitLabel('ab', 40, 5, m.fn)).toBeNull();
    expect(fitLabel('abc', 40, 5, m.fn)).toBeNull();
  });

  it('does not leave a dangling space before the ellipsis', () => {
    const m = makeMeasurer(WIDTHS);
    const title = 'Alpha beta gamma delta epsilon';
    for (let arcLen = 10; arcLen < 100; arcLen += 2) {
      const out = fitLabel(title, m.fn(title), arcLen, makeMeasurer(WIDTHS).fn);
      if (out && out !== title) expect(out).not.toMatch(/ …$/);
    }
  });

  it('still fits when the estimate overshoots badly', () => {
    // Trailing characters far narrower than average is exactly what makes an
    // average-width correction under-remove. fullLen is truthful here; the
    // function is entitled to trust it.
    const widths: Record<string, number> = { W: 30, i: 1, [ELLIPSIS]: 8 };
    const title = 'WWWWWWWWiiiiiiiiiiiiiiiiiiii';
    const m = makeMeasurer(widths, 1);
    const full = m.fn(title);

    for (let arcLen = 12; arcLen < full; arcLen += 5) {
      const inner = makeMeasurer(widths, 1);
      const out = fitLabel(title, full, arcLen, inner.fn);
      if (out === null) continue;
      expect(inner.fn(out)).toBeLessThanOrEqual(arcLen);
      expect(inner.calls.length).toBeLessThanOrEqual(MAX_FIT_MEASUREMENTS + 1);
    }
  });

  it('only ever returns a string it measured, or the untruncated title', () => {
    const widths: Record<string, number> = { m: 20, i: 1, [ELLIPSIS]: 9 };
    const title = 'mmmmmmmmmmiiiiiiiiiimmmmm';
    const m = makeMeasurer(widths, 1);
    const full = m.fn(title);
    const inner = makeMeasurer(widths, 1);
    const out = fitLabel(title, full, 60, inner.fn);
    if (out !== null && out !== title) {
      expect(inner.calls).toContain(out);
    }
  });

});
