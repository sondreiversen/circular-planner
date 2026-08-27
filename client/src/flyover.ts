/**
 * flyover.ts — turn a static disc SVG into a self-contained animated one.
 *
 * "The year in twenty seconds": the today-hand sweeps a full turn while a
 * readout under the hub counts through the months. One file, no encoder, no
 * runtime dependency, and it plays in any browser.
 *
 * The technique is declarative SMIL rather than frame capture, which is why it
 * costs nothing to produce. `MediaRecorder` cannot capture an SVG at all — there
 * is no `SVGSVGElement.captureStream()` — so a video route would mean
 * rasterizing every frame through the existing serializer, which spends
 * hundreds of milliseconds per frame walking `getComputedStyle` over every
 * descendant. Rotating a `<line>` costs nothing and never drops a frame.
 *
 * Two properties of the disc make this work:
 *
 *   - The today-hand is a center-origin `<line>` plus a tip `<circle>`, both
 *     inside `g.cp-main` which is translated to the disc centre. So a plain
 *     rotate transform about (0,0) reproduces the sweep exactly.
 *   - `angleScale` maps windowStart..windowEnd onto the full circle, so one
 *     360-degree turn always traverses exactly the visible window — a year at
 *     Year zoom, a week at Week zoom.
 *
 * Known limit: the viewport is fixed for the whole sweep. Year-zoom navigation
 * slides month by month, and if the window moved during the flyover then every
 * gridline and arc would have to move too, which SMIL cannot express. A moving
 * window needs the frame-capture route.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A readout step: the text to show, and when in the sweep it appears. */
export interface FlyoverLabel {
  text: string;
  /** Position in the sweep, 0..1, where this label takes over. */
  startFrac: number;
}

export interface FlyoverOptions {
  /** Length of one full turn. */
  durationSeconds?: number;
  /** Readout steps under the hub. Omit for no readout. */
  labels?: FlyoverLabel[];
  /** Colour for the readout text. */
  labelColor?: string;
}

export const DEFAULT_FLYOVER_SECONDS = 20;

/**
 * Degrees clockwise from 12 o'clock for a hand drawn to (x, y).
 *
 * The renderer places the tip at (sin(a)*R, -cos(a)*R), so this inverts that:
 * atan2(x, -y) recovers the angle, and the result is normalised to [0, 360) so
 * the generated `from`/`to` pair never contains a negative rotation that some
 * renderers handle inconsistently.
 */
export function handAngleDegrees(x: number, y: number): number {
  const deg = (Math.atan2(x, -y) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/**
 * SMIL keyTimes/values for a label that is visible from `startFrac` until
 * `endFrac`.
 *
 * calcMode="discrete" holds each value until the next keyTime, which is exactly
 * the on/off behaviour wanted here — a crossfade between month names would just
 * read as smear at this size. keyTimes must begin at 0 and never decrease.
 */
export function labelKeyframes(startFrac: number, endFrac: number): { values: string; keyTimes: string } {
  const a = clamp01(startFrac);
  const b = clamp01(endFrac);
  if (a <= 0 && b >= 1) return { values: '1', keyTimes: '0' };
  if (a <= 0) return { values: '1;0', keyTimes: `0;${round(b)}` };
  if (b >= 1) return { values: '0;1', keyTimes: `0;${round(a)}` };
  return { values: '0;1;0', keyTimes: `0;${round(a)};${round(b)}` };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

/**
 * Build an animated flyover SVG from a serialized static disc.
 *
 * Input must already be serialized with the palette baked in (see
 * Planner.withLightPalette) — this only adds animation, it never touches
 * colour.
 *
 * Returns the original string unchanged if the disc has no today-hand, which
 * happens when the current date falls outside the planner's range. Better a
 * still disc than a broken file.
 */
export function buildFlyoverSVG(svgString: string, opts: FlyoverOptions = {}): string {
  const duration = opts.durationSeconds ?? DEFAULT_FLYOVER_SECONDS;
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return svgString;

  const hands = Array.from(doc.querySelectorAll('.cp-today-hand'));
  if (hands.length === 0) return svgString;

  const line = hands.find(el => el.tagName.toLowerCase() === 'line');
  if (!line) return svgString;

  const startAngle = handAngleDegrees(
    parseFloat(line.getAttribute('x2') || '0'),
    parseFloat(line.getAttribute('y2') || '0'),
  );

  // Lift the hand into its own group so one transform drives every part of it.
  const parent = hands[0].parentNode;
  if (!parent) return svgString;
  const spinner = doc.createElementNS(SVG_NS, 'g');
  parent.insertBefore(spinner, hands[0]);
  for (const el of hands) spinner.appendChild(el);

  // Rotate by -startAngle first so the sweep begins at the top of the disc —
  // the start of the window — rather than wherever today happens to fall.
  const rotate = doc.createElementNS(SVG_NS, 'animateTransform');
  rotate.setAttribute('attributeName', 'transform');
  rotate.setAttribute('type', 'rotate');
  rotate.setAttribute('from', `${round(-startAngle)} 0 0`);
  rotate.setAttribute('to', `${round(360 - startAngle)} 0 0`);
  rotate.setAttribute('dur', `${duration}s`);
  rotate.setAttribute('repeatCount', 'indefinite');
  spinner.appendChild(rotate);

  const labels = opts.labels ?? [];
  if (labels.length > 0) {
    const readout = doc.createElementNS(SVG_NS, 'g');
    readout.setAttribute('class', 'cp-flyover-readout');
    for (let i = 0; i < labels.length; i++) {
      const startFrac = labels[i].startFrac;
      const endFrac = i + 1 < labels.length ? labels[i + 1].startFrac : 1;
      const { values, keyTimes } = labelKeyframes(startFrac, endFrac);

      const text = doc.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', '0');
      text.setAttribute('y', '30');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('font-size', '13');
      text.setAttribute('font-weight', '600');
      text.setAttribute('fill', opts.labelColor || '#f44336');
      text.setAttribute('opacity', '0');
      text.textContent = labels[i].text;

      const anim = doc.createElementNS(SVG_NS, 'animate');
      anim.setAttribute('attributeName', 'opacity');
      anim.setAttribute('values', values);
      anim.setAttribute('keyTimes', keyTimes);
      anim.setAttribute('calcMode', 'discrete');
      anim.setAttribute('dur', `${duration}s`);
      anim.setAttribute('repeatCount', 'indefinite');
      text.appendChild(anim);
      readout.appendChild(text);
    }
    // Into g.cp-main so the readout inherits the centre translation.
    const main = doc.querySelector('.cp-main') ?? doc.documentElement;
    main.appendChild(readout);
  }

  return new XMLSerializer().serializeToString(doc.documentElement);
}
