import { handAngleDegrees, labelKeyframes, DEFAULT_FLYOVER_SECONDS } from '../flyover';

// buildFlyoverSVG itself needs DOMParser, which testEnvironment: "node" lacks.
// It is verified in a real browser; the geometry and keyframe maths, which are
// where the bugs would hide, are pure and covered here.

describe('handAngleDegrees', () => {
  // The renderer draws the tip at (sin(a)*R, -cos(a)*R), so straight up is 0.
  test('straight up is 0 degrees', () => {
    expect(handAngleDegrees(0, -350)).toBeCloseTo(0, 6);
  });

  test('right is 90 degrees', () => {
    expect(handAngleDegrees(350, 0)).toBeCloseTo(90, 6);
  });

  test('down is 180 degrees', () => {
    expect(handAngleDegrees(0, 350)).toBeCloseTo(180, 6);
  });

  // Normalised to [0,360) so the generated from/to never goes negative.
  test('left is 270, not -90', () => {
    expect(handAngleDegrees(-350, 0)).toBeCloseTo(270, 6);
  });

  test('is scale invariant', () => {
    expect(handAngleDegrees(1, -1)).toBeCloseTo(handAngleDegrees(100, -100), 6);
  });

  test('never returns a negative angle', () => {
    for (let deg = 0; deg < 360; deg += 7) {
      const rad = (deg * Math.PI) / 180;
      const got = handAngleDegrees(Math.sin(rad) * 350, -Math.cos(rad) * 350);
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBeLessThan(360);
    }
  });
});

describe('labelKeyframes', () => {
  test('a middle slice turns on then off', () => {
    expect(labelKeyframes(0.25, 0.5)).toEqual({ values: '0;1;0', keyTimes: '0;0.25;0.5' });
  });

  // The first label is already visible at t=0, so it must not start hidden.
  test('the first slice starts visible', () => {
    expect(labelKeyframes(0, 0.0833)).toEqual({ values: '1;0', keyTimes: '0;0.0833' });
  });

  // The last label runs to the end, so it must not switch off early.
  test('the last slice never turns off', () => {
    expect(labelKeyframes(0.9166, 1)).toEqual({ values: '0;1', keyTimes: '0;0.9166' });
  });

  test('a full-span label is simply always on', () => {
    expect(labelKeyframes(0, 1)).toEqual({ values: '1', keyTimes: '0' });
  });

  test('clamps out-of-range fractions instead of emitting invalid keyTimes', () => {
    expect(labelKeyframes(-0.5, 0.5)).toEqual({ values: '1;0', keyTimes: '0;0.5' });
    expect(labelKeyframes(0.5, 2)).toEqual({ values: '0;1', keyTimes: '0;0.5' });
  });

  test('survives NaN without producing NaN in the output', () => {
    const out = labelKeyframes(NaN, NaN);
    expect(out.values).not.toContain('NaN');
    expect(out.keyTimes).not.toContain('NaN');
  });

  // SMIL requires keyTimes to start at 0 and never decrease.
  test('keyTimes always start at 0 and are non-decreasing', () => {
    const cases: Array<[number, number]> = [[0, 0.1], [0.1, 0.2], [0.9, 1], [0.3, 0.3]];
    for (const [a, b] of cases) {
      const { values, keyTimes } = labelKeyframes(a, b);
      const ks = keyTimes.split(';').map(Number);
      expect(ks[0]).toBe(0);
      for (let i = 1; i < ks.length; i++) expect(ks[i]).toBeGreaterThanOrEqual(ks[i - 1]);
      expect(values.split(';').length).toBe(ks.length);
    }
  });
});

describe('constants', () => {
  test('a year in twenty seconds', () => {
    expect(DEFAULT_FLYOVER_SECONDS).toBe(20);
  });
});
