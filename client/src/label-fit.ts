/**
 * label-fit.ts — fit a label to the arc it is drawn on.
 *
 * Split out from renderer.ts so the arithmetic is testable without a DOM. The
 * renderer supplies the measurement closure; everything decided here is pure.
 *
 * Why not a binary search: each measurement appends a hidden <text>, forces a
 * synchronous layout via getComputedTextLength(), and removes it. That cost is
 * paid per *occurrence*, not per activity, and a Year view with recurrence
 * expansion can carry several hundred. A six-pass binary search per label is
 * real work on the render path, so this spends exactly one measurement beyond
 * the full-string measurement the caller already has.
 */

/** Shortest label worth drawing. Below this an ellipsis identifies nothing. */
export const MIN_LABEL_CHARS = 3;

export const ELLIPSIS = '…';

/**
 * Hard cap on measurements past the caller's own full-string measurement.
 * One is the normal case; the cap bounds the tail without ever letting an
 * unmeasured string reach the screen.
 */
export const MAX_FIT_MEASUREMENTS = 3;

/**
 * @param title    the full label
 * @param fullLen  measured advance width of `title` (the caller already has it)
 * @param arcLen   space available along the arc
 * @param measure  measures a candidate string, one call at most
 * @returns the string to draw, or null when the arc cannot hold a useful label
 */
export function fitLabel(
  title: string,
  fullLen: number,
  arcLen: number,
  measure: (s: string) => number,
): string | null {
  if (arcLen <= 0) return null;
  if (fullLen <= arcLen) return title;
  if (title.length <= MIN_LABEL_CHARS) return null;

  // Advance width is close enough to linear in character count for a first
  // guess. -1 leaves room for the ellipsis, which is narrower than an
  // average glyph.
  let n = Math.floor(title.length * (arcLen / fullLen)) - 1;
  if (n < MIN_LABEL_CHARS) return null;

  // A pure estimate cannot guarantee a fit. Correcting by the AVERAGE advance
  // under-removes whenever the trailing characters are narrower than average
  // ("...ill", "...tit"), which measurably overflows — caught by the width
  // sweep in the tests, which produced a 164-unit label for a 162-unit arc.
  //
  // So: only ever return a string that has been MEASURED to fit, and cap the
  // number of measurements. In practice the first estimate lands, and the cap
  // keeps the worst case well under a binary search's six layout passes.
  let best: string | null = null;

  for (let attempt = 0; attempt < MAX_FIT_MEASUREMENTS; attempt++) {
    const candidate = title.slice(0, n).trimEnd() + ELLIPSIS;
    const len = measure(candidate);

    if (len <= arcLen) {
      best = candidate;
      break;
    }

    const perChar = len / Math.max(1, candidate.length);
    const over = Math.ceil((len - arcLen) / Math.max(perChar, 1e-4));
    // Always drop at least one character so the loop cannot stall.
    n -= Math.max(1, over);
    if (n < MIN_LABEL_CHARS) return null;
  }

  return best;
}
