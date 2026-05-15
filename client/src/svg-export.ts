/**
 * svg-export.ts — PNG export helpers for the circular planner.
 *
 * All functions are framework-agnostic pure DOM/Canvas APIs.
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
 * Download the current disc as a PNG file.
 *
 * @param svg      The SVGSVGElement to export (from Renderer.getSVGNode()).
 * @param filename Suggested download filename, e.g. "my-planner-2026-05-12.png".
 * @param scale    Canvas multiplier for retina quality (default 2 → 1600×1600 for an 800×800 viewBox).
 */
export async function exportSVGToPNG(
  svg: SVGSVGElement,
  filename: string,
  scale = 2,
): Promise<void> {
  // Determine canvas size from the viewBox attribute.
  const vb = svg.viewBox.baseVal;
  const vbWidth  = vb && vb.width  > 0 ? vb.width  : 800;
  const vbHeight = vb && vb.height > 0 ? vb.height : 800;
  const canvasW = vbWidth  * scale;
  const canvasH = vbHeight * scale;

  // 1. Inline computed styles into a clone.
  const svgStr = serializeSVGWithStyles(svg);

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
          // 6. Release blob URLs.
          URL.revokeObjectURL(pngUrl);
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
