/**
 * svg-export.ts — export helpers for the circular planner disc.
 *
 * Two outputs from one serializer:
 *
 *   serializeSVGWithStyles(node)  ->  standalone SVG string
 *          |                          (CSS custom properties resolved to
 *          |                           literal colours, namespaces added)
 *          |
 *          ├──> rasterizeSVGString()  ->  .png   fixed pixel size
 *          └──> downloadSVGString()   ->  .svg   vector, prints at any size
 *
 * Colours are baked into attributes at serialization time, so callers must
 * serialize inside a forced-light-palette window — see Planner.withLightPalette.
 *
 * All functions are framework-agnostic DOM/Canvas APIs.
 *
 * Note: on Safari, SVG embedded fonts may render differently than in
 * Chrome/Firefox because Safari's canvas drawImage treats cross-origin
 * SVG resources conservatively — acceptable here since we only use
 * system fonts (no @font-face).
 */

/** CSS properties to inline from computed styles so the canvas render
 *  receives real colours rather than CSS variable references. */
const STYLE_WHITELIST: ReadonlyArray<string> = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-opacity',
  'fill-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
];

/**
 * Serialize an SVGSVGElement to a string with computed styles inlined on
 * every descendant element so that the result renders correctly when
 * loaded into an Image / drawn on a Canvas (where CSS custom properties
 * are not available).
 */
export function serializeSVGWithStyles(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;

  // Ensure required XML namespaces are present.
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // Firefox refuses to render an SVG loaded via <img> without explicit
  // width/height — viewBox alone is not enough. Derive them from viewBox.
  const vb = svg.viewBox.baseVal;
  const w = vb && vb.width  > 0 ? vb.width  : 800;
  const h = vb && vb.height > 0 ? vb.height : 800;
  clone.setAttribute('width',  String(w));
  clone.setAttribute('height', String(h));

  // Add a solid background rect so the PNG is not transparent.
  const bgColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--cp-disc-bg-outer').trim() || '#ffffff';
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bgRect.setAttribute('width', '100%');
  bgRect.setAttribute('height', '100%');
  bgRect.setAttribute('fill', bgColor || '#ffffff');
  clone.insertBefore(bgRect, clone.firstChild);

  // Walk the ORIGINAL elements and apply computed styles to the
  // corresponding CLONE elements.  getElementsByTagName('*') returns
  // elements in document order, so the indices are identical for both
  // NodeLists.
  const origs = svg.getElementsByTagName('*');
  // +1 offset because we prepended the bgRect to the clone.
  const clones = clone.getElementsByTagName('*');

  for (let i = 0; i < origs.length; i++) {
    const orig = origs[i] as Element;
    // Clone index is i+1 because index 0 is the bgRect we just inserted.
    const cloneEl = clones[i + 1] as HTMLElement | SVGElement;
    if (!cloneEl) continue;

    const cs = getComputedStyle(orig);

    // Skip elements that are not rendered.
    if (cs.display === 'none') {
      (cloneEl as HTMLElement).style.display = 'none';
      continue;
    }

    for (const prop of STYLE_WHITELIST) {
      const value = cs.getPropertyValue(prop);
      if (value) {
        (cloneEl as HTMLElement).style.setProperty(prop, value);
      }
    }
  }

  return new XMLSerializer().serializeToString(clone);
}

/**
 * Rasterize an already-serialized SVG string to a PNG download.
 *
 * Split out from exportSVGToPNG so the caller can perform serialization inside
 * a synchronous forced-light-palette window (see Planner.withLightPalette).
 * The disc's colours are baked into SVG attributes at render time, so the
 * palette must be correct *before* serialization — it cannot be corrected here.
 */
export async function rasterizeSVGString(
  svgStr: string,
  vbWidth: number,
  vbHeight: number,
  filename: string,
  scale = 2,
): Promise<void> {
  const canvasW = vbWidth  * scale;
  const canvasH = vbHeight * scale;

  // 2. Build a blob URL from the serialized SVG.
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);

  try {
    // 3. Load the SVG blob into an Image element.
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        // 4. Draw onto an offscreen canvas at scale× for retina quality.
        const canvas = document.createElement('canvas');
        canvas.width  = canvasW;
        canvas.height = canvasH;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas 2D context unavailable')); return; }
        ctx.drawImage(img, 0, 0, canvasW, canvasH);

        // 5. Convert canvas to PNG blob and trigger download.
        canvas.toBlob((pngBlob) => {
          if (!pngBlob) { reject(new Error('canvas.toBlob returned null')); return; }
          const pngUrl = URL.createObjectURL(pngBlob);
          const a = document.createElement('a');
          a.href = pngUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          // Defer revoke so the browser has time to start the download.
          setTimeout(() => URL.revokeObjectURL(pngUrl), 5000);
          resolve();
        }, 'image/png');
      };
      img.onerror = () => reject(new Error('Failed to load SVG into Image element'));
      img.src = blobUrl;
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Download an already-serialized SVG string as a .svg file.
 *
 * This is the vector counterpart to rasterizeSVGString, and the reason the
 * serializer was split out: serializeSVGWithStyles already produces a
 * standalone, print-ready SVG with every CSS custom property resolved to a
 * literal colour. Until now that string was built, rasterized to a fixed-size
 * PNG, and thrown away — so a 2x export of an 800x800 viewBox capped out at
 * 1600x1600, about a five-inch square at 300 DPI. The vector version has no
 * such ceiling and prints at any size.
 *
 * Caveat worth knowing before treating the output as a print master: no
 * @font-face is embedded, because the disc uses system fonts only (see the
 * note at the top of this file). Text will re-flow on a machine that lacks the
 * same fonts. Fine for internal use and for handing to a plotter; not a
 * portable artifact.
 *
 * As with PNG, the caller must serialize inside a forced-light-palette window
 * — the colours are baked into attributes at render time.
 */
export function downloadSVGString(svgStr: string, filename: string): void {
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Defer revoke so the browser has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
