/**
 * label-contrast.ts — pick a legible colour for text drawn on the disc.
 *
 * Why this is not a two-line `readableOn(fill)`:
 *
 * The label is never drawn on the arc's fill colour. It is drawn on a composite:
 * the disc radial gradient, then the lane band at 0.25 alpha (renderer.ts:568),
 * then the activity fill, then `fill-opacity` (0.88, or 0.35 when cancelled,
 * renderer.ts:812). A helper that only sees the fill string computes contrast
 * against a background that is not on screen.
 *
 * And there is a bound worth stating, because two earlier drafts of this design
 * got it backwards in opposite directions:
 *
 *   For ANY colour in sRGB, the better of pure black and pure white always
 *   reaches at least 4.583:1. Verified three ways — a sweep of the whole cube,
 *   the 504 real composites this project can produce, and the closed form
 *   (the extremes cross at L = sqrt(0.0525) - 0.05 = 0.1791, giving 4.5826).
 *
 * So AA for normal text is ALWAYS reachable by choosing polarity. There is no
 * unrescuable colour. An earlier note in this design claimed the opposite; it
 * was wrong, and the 4.583 floor is why.
 *
 * What that changes: the ink must be allowed to go to a true extreme when the
 * backdrop demands it. Measured on the 504 real composites, the soft ink
 * #16202e alone fails AA on 83 of them, while pure black/white fails on none.
 * So we prefer the soft ink for its looks and fall back to the pure extreme
 * exactly where the soft one misses — which is what keeps the guarantee total.
 *
 * The halo then is NOT what rescues contrast, since polarity already does.
 * It earns its place for the things a single ratio cannot express: curved
 * labels run along an arc and can cross into a neighbouring activity of a
 * different colour, the disc sits under a radial gradient rather than a flat
 * fill, and thin glyphs on a 800-unit viewBox lose strokes to antialiasing.
 * The halo makes the glyph independent of all three.
 *
 * That is why this returns a pair, and why the thing worth testing is
 * contrast(text, halo) rather than contrast(text, arc).
 */

export interface RGB { r: number; g: number; b: number; }

export interface LabelStyle {
  /** Glyph fill. */
  color: string;
  /** Outline drawn behind the glyph, always the opposite polarity. */
  haloColor: string;
  /** Outline width in SVG user units. */
  haloWidth: number;
  /**
   * True when the text alone would fail AA against the composite, so the halo
   * is doing the work rather than merely tidying edges. Surfaced for tests and
   * for anyone tempted to drop the halo later.
   */
  haloRequired: boolean;
}

/**
 * Preferred ink. Softer than pure black, which on a mid tone reads as a hole
 * punched in the disc. Used whenever it clears AA on its own.
 */
export const LABEL_DARK = '#16202e';
export const LABEL_LIGHT = '#ffffff';

/**
 * Fallback ink, used only where the soft ink misses AA. These are the luminance
 * extremes, so between them they always clear 4.5:1 — see the 4.583 floor above.
 */
export const LABEL_DARK_STRONG = '#000000';
export const LABEL_LIGHT_STRONG = '#ffffff';

/** WCAG AA for normal-size text. */
export const AA_NORMAL = 4.5;

/** Parse #rgb, #rrggbb, rgb(...) and rgba(...). Returns null for anything else. */
export function parseColor(input: string): RGB | null {
  if (!input) return null;
  const s = input.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
      };
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (rgb) {
    return { r: Math.round(+rgb[1]), g: Math.round(+rgb[2]), b: Math.round(+rgb[3]) };
  }
  return null;
}

/** Alpha carried inside an rgba() string, or 1 for anything without one. */
export function alphaOf(input: string): number {
  const m = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/i.exec((input || '').trim());
  if (!m) return 1;
  const a = parseFloat(m[1]);
  return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1;
}

/** Source-over composite of fg at `alpha` onto bg. */
export function compositeOver(fg: RGB, alpha: number, bg: RGB): RGB {
  const a = Math.min(1, Math.max(0, alpha));
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
  };
}

/** WCAG relative luminance. */
export function relativeLuminance({ r, g, b }: RGB): number {
  const chan = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Build the composite an activity label is actually drawn on.
 *
 * Layers, bottom to top, matching renderer.ts:
 *   disc background  ->  lane band (lane.color, 0.25)  ->  arc fill (fillOpacity)
 *
 * `laneBand` may be omitted for surfaces that do not draw one, such as lane
 * border labels, which sit on the band itself rather than on an arc above it.
 */
export function labelBackdrop(
  discBg: string,
  laneBand: string | null,
  fill: string,
  fillOpacity: number,
): RGB {
  const base = parseColor(discBg) ?? { r: 255, g: 255, b: 255 };

  let bg = base;
  if (laneBand) {
    const band = parseColor(laneBand);
    // The band is drawn with lane.color exactly as stored (renderer.ts:569) — no
    // extra multiplier. The 0.25 lives INSIDE the default LANE_COLORS strings,
    // so a user-picked hex lane colour produces a fully opaque band and a
    // completely different composite.
    if (band) bg = compositeOver(band, alphaOf(laneBand), bg);
  }

  const f = parseColor(fill);
  if (!f) return bg;
  // fill-opacity multiplies any alpha already inside the colour string.
  return compositeOver(f, alphaOf(fill) * fillOpacity, bg);
}

/**
 * Choose glyph and halo colours for text drawn on `backdrop`.
 *
 * Picks whichever polarity contrasts better with the backdrop, so the glyph
 * still reads where the halo is thin, and returns the opposite as the halo so
 * the glyph is legible even when neither polarity clears AA against the arc.
 */
export function labelStyleFor(backdrop: RGB, haloWidth = 2): LabelStyle {
  const softDark  = parseColor(LABEL_DARK)!;
  const pureDark  = parseColor(LABEL_DARK_STRONG)!;
  const pureLight = parseColor(LABEL_LIGHT_STRONG)!;

  // Decide polarity on the extremes, since they define the available headroom.
  const useDark = contrastRatio(pureDark, backdrop) >= contrastRatio(pureLight, backdrop);

  let color: string;
  if (useDark) {
    // Prefer the soft ink; drop to pure black only where soft misses AA.
    color = contrastRatio(softDark, backdrop) >= AA_NORMAL ? LABEL_DARK : LABEL_DARK_STRONG;
  } else {
    // The light ink is already pure white, so there is nothing softer to try.
    color = LABEL_LIGHT;
  }

  return {
    color,
    haloColor: useDark ? LABEL_LIGHT : LABEL_DARK_STRONG,
    haloWidth,
    // True only if even the pure extreme misses, which the 4.583 floor says
    // cannot happen for any sRGB colour. Kept as an assertion that the model
    // still holds rather than as a branch anyone expects to take.
    haloRequired: Math.max(
      contrastRatio(pureDark, backdrop),
      contrastRatio(pureLight, backdrop),
    ) < AA_NORMAL,
  };
}

/** Convenience: composite the layers, then choose. */
export function labelStyle(
  discBg: string,
  laneBand: string | null,
  fill: string,
  fillOpacity: number,
  haloWidth = 2,
): LabelStyle {
  return labelStyleFor(labelBackdrop(discBg, laneBand, fill, fillOpacity), haloWidth);
}
