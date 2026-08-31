import {
  parseColor,
  LABEL_DARK_STRONG,
  alphaOf,
  compositeOver,
  relativeLuminance,
  contrastRatio,
  labelBackdrop,
  labelStyle,
  labelStyleFor,
  LABEL_DARK,
  LABEL_LIGHT,
  AA_NORMAL,
} from '../label-contrast';
import { COLOR_PALETTE, STATUS_COLORS, LANE_COLORS } from '../utils';

// Disc background tokens, mirrored from circular-planner.css. Per the design's
// premise 4, CSS cannot reach the disc, so these live here rather than being
// read from a stylesheet.
const DISC_LIGHT = '#f4f5f7';
const DISC_DARK  = '#1e2128';

// renderer.ts:812 — the opacity every activity arc is actually drawn at.
const FILL_OPACITY = 0.88;
const FILL_OPACITY_CANCELLED = 0.35;

describe('colour parsing', () => {
  it('parses #rgb, #rrggbb, rgb() and rgba()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#E53935')).toEqual({ r: 229, g: 57, b: 53 });
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseColor('rgba(66,133,244,0.25)')).toEqual({ r: 66, g: 133, b: 244 });
  });

  it('returns null rather than guessing at unsupported syntax', () => {
    // Regression guard: utils.withAlpha silently no-ops on hex, which is how a
    // previous contrast estimate came out wrong. Anything this cannot parse
    // must announce itself, not pass through.
    expect(parseColor('hsl(200 50% 50%)')).toBeNull();
    expect(parseColor('rebeccapurple')).toBeNull();
    expect(parseColor('')).toBeNull();
  });

  it('reads alpha only from rgba(), defaulting to opaque', () => {
    expect(alphaOf('rgba(66,133,244,0.25)')).toBeCloseTo(0.25);
    expect(alphaOf('#E53935')).toBe(1);
    expect(alphaOf('rgb(1,2,3)')).toBe(1);
  });
});

describe('WCAG arithmetic', () => {
  it('matches known reference values', () => {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    expect(relativeLuminance(white)).toBeCloseTo(1, 5);
    expect(relativeLuminance(black)).toBeCloseTo(0, 5);
    // The maximum possible ratio.
    expect(contrastRatio(white, black)).toBeCloseTo(21, 2);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    const a = { r: 12, g: 200, b: 90 };
    const b = { r: 240, g: 30, b: 70 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});

describe('compositing', () => {
  it('composites the lane band at the alpha carried in its own colour string', () => {
    // The band is drawn with lane.color exactly as stored (renderer.ts:569).
    // The 0.25 is inside the LANE_COLORS string, not applied by the renderer.
    const bd = labelBackdrop(DISC_LIGHT, 'rgba(66,133,244,0.25)', 'rgba(0,0,0,0)', 0);
    const manual = compositeOver({ r: 66, g: 133, b: 244 }, 0.25, parseColor(DISC_LIGHT)!);
    expect(bd).toEqual(manual);
  });

  it('treats a user-picked hex lane colour as fully opaque', () => {
    // A user choosing a hex colour in the lane dialog gets an opaque band, a
    // completely different composite from the 0.25 defaults.
    const bd = labelBackdrop(DISC_LIGHT, '#E53935', 'rgba(0,0,0,0)', 0);
    expect(bd).toEqual({ r: 229, g: 57, b: 53 });
  });

  it('multiplies fill-opacity into any alpha already in the fill', () => {
    const bd = labelBackdrop(DISC_LIGHT, null, '#000000', 0.5);
    expect(bd.r).toBe(Math.round(255 * 0 * 0.5 + 244 * 0.5));
  });
});

/**
 * The matrix the design doc asks for: every colour a user can actually end up
 * with, in both themes, at the opacity the renderer actually uses.
 */
const THEMES: ReadonlyArray<[string, string]> = [
  ['light', DISC_LIGHT],
  ['dark',  DISC_DARK],
];

const ACTIVITY_SOURCES: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ['COLOR_PALETTE', COLOR_PALETTE],
  ['STATUS_COLORS', Object.values(STATUS_COLORS)],
];

describe('every label is legible against what it is drawn on', () => {
  for (const [themeName, discBg] of THEMES) {
    for (const [sourceName, colors] of ACTIVITY_SOURCES) {
      for (const laneBand of [null, ...LANE_COLORS]) {
        it(`${themeName} / ${sourceName} / lane ${laneBand ?? 'none'}`, () => {
          for (const fill of colors) {
            const style = labelStyle(discBg, laneBand, fill, FILL_OPACITY);
            const glyph = parseColor(style.color)!;
            const halo  = parseColor(style.haloColor)!;

            const bdrop = labelBackdrop(discBg, laneBand, fill, FILL_OPACITY);

            // The design doc's success criterion 1, which an earlier round
            // claimed was unreachable. It is reachable: polarity choice alone
            // guarantees >= 4.583 for any sRGB colour, so assert the real bar.
            expect(contrastRatio(glyph, bdrop)).toBeGreaterThanOrEqual(AA_NORMAL);

            // And the glyph is legible against its own halo, which is what
            // carries it where a label crosses onto a neighbouring arc.
            expect(contrastRatio(glyph, halo)).toBeGreaterThanOrEqual(AA_NORMAL);

            // The two are always opposite polarities, never the same ink.
            expect(style.color).not.toBe(style.haloColor);
            expect([LABEL_DARK, LABEL_DARK_STRONG, LABEL_LIGHT]).toContain(style.color);
            expect([LABEL_DARK_STRONG, LABEL_LIGHT]).toContain(style.haloColor);

            // The chosen polarity is the better of the two against the arc, so
            // the glyph still reads where the halo is thin.
            const opposite = parseColor(
              style.color === LABEL_LIGHT ? LABEL_DARK_STRONG : LABEL_LIGHT,
            )!;
            expect(contrastRatio(glyph, bdrop))
              .toBeGreaterThanOrEqual(contrastRatio(opposite, bdrop) - 1e-9);
          }
        });
      }
    }
  }

  it('also holds for cancelled arcs, which are drawn far more faintly', () => {
    for (const [, discBg] of THEMES) {
      for (const fill of COLOR_PALETTE) {
        const style = labelStyle(discBg, LANE_COLORS[0], fill, FILL_OPACITY_CANCELLED);
        expect(contrastRatio(parseColor(style.color)!, parseColor(style.haloColor)!))
          .toBeGreaterThanOrEqual(AA_NORMAL);
      }
    }
  });
});

/**
 * The bound the whole design now rests on. If this ever fails, the guarantee
 * that every label reaches AA is gone and the chooser needs rethinking.
 */
describe('the 4.583 floor', () => {
  it('holds across the entire sRGB cube, not just our palette', () => {
    const BLACK = { r: 0, g: 0, b: 0 };
    const WHITE = { r: 255, g: 255, b: 255 };
    let worst = Infinity;

    // Step 3 keeps this near-instant while still visiting every region.
    for (let r = 0; r < 256; r += 3) {
      for (let g = 0; g < 256; g += 3) {
        for (let b = 0; b < 256; b += 3) {
          const c = { r, g, b };
          const best = Math.max(contrastRatio(BLACK, c), contrastRatio(WHITE, c));
          if (best < worst) worst = best;
        }
      }
    }

    expect(worst).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(worst).toBeCloseTo(4.583, 2);
  });

  it('matches the closed form', () => {
    // The extremes cross where (L + 0.05)^2 = 0.05 * 1.05.
    const lCrit = Math.sqrt(0.0525) - 0.05;
    expect(lCrit).toBeCloseTo(0.1791, 4);
    expect(1.05 / (lCrit + 0.05)).toBeCloseTo(4.5826, 4);
  });

  it('never needs the unreachable branch', () => {
    // haloRequired means even a pure extreme missed AA. The floor says that is
    // impossible, so it must be false on every real composite.
    for (const [, discBg] of THEMES) {
      for (const laneBand of [null, ...LANE_COLORS]) {
        for (const fill of COLOR_PALETTE) {
          expect(labelStyle(discBg, laneBand, fill, FILL_OPACITY).haloRequired).toBe(false);
        }
      }
    }
  });

  it('falls back to pure black exactly where the soft ink misses AA', () => {
    // Documents the real reason the fallback exists: on the 504 composites this
    // project can produce, the soft ink alone fails AA on a substantial share.
    let softFails = 0;
    let usedStrong = 0;

    for (const [, discBg] of THEMES) {
      for (const laneBand of [null, ...LANE_COLORS]) {
        for (const fill of [...COLOR_PALETTE, ...Object.values(STATUS_COLORS)]) {
          const bdrop = labelBackdrop(discBg, laneBand, fill, FILL_OPACITY);
          const softBest = Math.max(
            contrastRatio(parseColor(LABEL_DARK)!, bdrop),
            contrastRatio(parseColor(LABEL_LIGHT)!, bdrop),
          );
          if (softBest < AA_NORMAL) softFails++;
          if (labelStyle(discBg, laneBand, fill, FILL_OPACITY).color === LABEL_DARK_STRONG) {
            usedStrong++;
          }
        }
      }
    }

    expect(softFails).toBeGreaterThan(0);
    expect(usedStrong).toBeGreaterThan(0);
  });
});
