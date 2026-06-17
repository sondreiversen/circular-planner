/**
 * pointer-drag.ts — shared horizontal drag for activity bars in List and People views.
 *
 * Both renderers want the same behaviour: pointer-down captures, pointer-move
 * draws a ghost bar at the snapped-to-day target date, pointer-up commits the
 * new date range to the caller (who handles undo/redo + persistence) or
 * silently aborts if the user just clicked.
 */

import { formatDate, parseDate } from './utils';

const DAY_MS = 86_400_000;
/** Pixels the pointer must move before we treat it as a drag (vs. click). */
const MOVE_THRESHOLD_PX = 3;

export interface LinearDragOpts {
  /** The activity bar element receiving the drag. */
  box: HTMLElement;
  /** The bar's positioned parent — where the ghost is appended. */
  timeline: HTMLElement;
  /** Width of the timeline in CSS pixels (matches dateToX's output range). */
  timelineWidth: number;
  /** Current viewport window — used to clamp the ghost's visible span. */
  windowStart: Date;
  windowEnd: Date;
  /** Planner bounds — drags are clamped so the activity stays in range. */
  plannerStart: Date;
  plannerEnd: Date;
  /** Date → pixel-X (offset from timeline left). */
  dateToX: (d: Date) => number;
  /** Returns the activity's current (live) start/end so a re-drag picks them up. */
  getOriginalDates: () => { start: Date; end: Date };
  /** Fired once at pointer-up if the dates actually changed. */
  onCommit: (newStart: Date, newEnd: Date) => void;
}

/**
 * Wire pointer events on `box`. The returned predicate should be called at the
 * top of the caller's click handler:
 *
 *   const wasDragged = attachLinearDrag({...});
 *   box.addEventListener('click', e => {
 *     if (wasDragged()) return;     // suppress the synthetic click after a drag
 *     openDialog();
 *   });
 *
 * Each call to the predicate also clears the suppression flag, so it must be
 * called once per click event.
 */
export function attachLinearDrag(opts: LinearDragOpts): () => boolean {
  const { box, timeline, timelineWidth, windowStart, windowEnd,
          plannerStart, plannerEnd, dateToX, getOriginalDates, onCommit } = opts;

  let suppressNextClick = false;
  let startClientX = 0;
  let origStart = new Date();
  let origEnd = new Date();
  let ghost: HTMLElement | null = null;
  let movedMeaningfully = false;
  let currentNewStart = new Date();
  let currentNewEnd = new Date();

  const winSpan = Math.max(1, windowEnd.getTime() - windowStart.getTime());
  const pxPerDay = timelineWidth / (winSpan / DAY_MS);
  const plannerStartMs = plannerStart.getTime();
  const plannerEndMs = plannerEnd.getTime();

  const removeGhost = () => {
    if (ghost) { ghost.remove(); ghost = null; }
    box.style.opacity = '';
  };

  box.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    startClientX = e.clientX;
    const orig = getOriginalDates();
    origStart = orig.start;
    origEnd   = orig.end;
    currentNewStart = origStart;
    currentNewEnd   = origEnd;
    movedMeaningfully = false;
    box.setPointerCapture(e.pointerId);
  });

  box.addEventListener('pointermove', (e: PointerEvent) => {
    if (!box.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startClientX;
    if (!movedMeaningfully && Math.abs(dx) > MOVE_THRESHOLD_PX) movedMeaningfully = true;
    if (!movedMeaningfully) return;

    const dayDelta = Math.round(dx / pxPerDay);
    let ns = origStart.getTime() + dayDelta * DAY_MS;
    let ne = origEnd.getTime()   + dayDelta * DAY_MS;
    const dur = ne - ns;
    if (ns < plannerStartMs) { ns = plannerStartMs; ne = ns + dur; }
    if (ne > plannerEndMs)   { ne = plannerEndMs;   ns = ne - dur; }
    currentNewStart = new Date(ns);
    currentNewEnd   = new Date(ne);

    const ghostLeft = dateToX(currentNewStart < windowStart ? windowStart : currentNewStart);
    const ghostClampedEnd = currentNewEnd > windowEnd ? windowEnd : currentNewEnd;
    const ghostWidth = Math.max(4, dateToX(ghostClampedEnd) - ghostLeft);

    if (!ghost) {
      ghost = box.cloneNode(true) as HTMLElement;
      ghost.style.opacity = '0.55';
      ghost.style.pointerEvents = 'none';
      ghost.style.zIndex = '4';
      timeline.appendChild(ghost);
      box.style.opacity = '0.35';
    }
    ghost.style.left  = `${ghostLeft}px`;
    ghost.style.width = `${ghostWidth}px`;
  });

  box.addEventListener('pointerup', (e: PointerEvent) => {
    if (!box.hasPointerCapture(e.pointerId)) return;
    box.releasePointerCapture(e.pointerId);
    removeGhost();
    if (movedMeaningfully &&
        (formatDate(currentNewStart) !== formatDate(origStart) ||
         formatDate(currentNewEnd)   !== formatDate(origEnd))) {
      suppressNextClick = true;
      onCommit(currentNewStart, currentNewEnd);
    }
    movedMeaningfully = false;
  });

  box.addEventListener('pointercancel', (e: PointerEvent) => {
    try { box.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    removeGhost();
    movedMeaningfully = false;
  });

  return () => {
    if (suppressNextClick) { suppressNextClick = false; return true; }
    return false;
  };
}

/** Re-export so callers don't need to re-import parseDate just for the helper signature. */
export { parseDate };
