import { select, Selection } from 'd3-selection';
import 'd3-transition'; // extends Selection with .transition()
import { arc as d3Arc } from 'd3-shape';
import { createAngleScale, parseDate, formatDate, xyToAngle, FONT_FAMILY, expandOccurrences, ColorBy, colorForString, withAlpha, STATUS_COLORS } from './utils';
import { PlannerConfig, PlannerData, Lane, Activity, DiscGeometry, Viewport, ZoomLevel, GridSpec, FilterState } from './types';
import { getGridSpec, viewportLabel } from './viewport';
import { now } from './clock';

const VIEWBOX_SIZE = 800;
const CX = 400;
const CY = 400;
const OUTER_RADIUS = 350;
const CORE_RADIUS = 55;
const MIN_ANGLE = 0;
const MAX_ANGLE = 2 * Math.PI;
const MIN_ARC_SPAN = 0.012; // ~0.7° — minimum visible arc for single-day events

export type ClickLaneHandler = (laneId: string, date: Date) => void;
export type ClickActivityHandler = (activity: Activity) => void;
export type DragCommitHandler = (activity: Activity, newStart: Date, newEnd: Date, newLaneId: string) => void;

interface DragState {
  activity: Activity;
  lane: Lane;
  mode: 'move' | 'resize-start' | 'resize-end';
  originalStart: Date;
  originalEnd: Date;
  arcStartAngle: number;
  arcEndAngle: number;
  pointerStartAngle: number;
  lastPointerAngle: number;
  accumulatedAngle: number;
  laneInnerR: number;
  laneOuterR: number;
  hoveredLane: Lane | null;
  ghost: SVGPathElement | null;
  ghostGroup: SVGGElement | null;
  movedMeaningfully: boolean;
  pointerId: number;
  currentNewStart: Date;
  currentNewEnd: Date;
}

export class Renderer {
  private svg: Selection<SVGSVGElement, unknown, null, undefined>;
  private config: PlannerConfig;
  private data: PlannerData;
  private viewport: Viewport;
  private filterState: FilterState;
  private angleScale!: ReturnType<typeof createAngleScale>;
  private geometry!: DiscGeometry;
  private showBorder = true;
  private colorBy: ColorBy = 'activity';

  private onClickLane: ClickLaneHandler = () => {};
  private onClickActivity: ClickActivityHandler = () => {};
  private onDragCommit: DragCommitHandler | null = null;
  private onZoomIn: (() => void) | null = null;
  private onZoomOut: (() => void) | null = null;
  private readonly arcGen = d3Arc<unknown>();

  // Pinch-to-zoom state
  private _pinchPointers = new Map<number, { x: number; y: number }>();
  private _pinchStartDist = 0;

  // In-flight drag state
  private dragState: DragState | null = null;

  // Per-render counter to make activity-text path IDs unique within the SVG.
  private textPathSeq = 0;

  // Timer to re-render at local midnight so the today indicator advances automatically.
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;

  // Milestones collected during renderLanes() and drawn last so they paint above all arcs.
  private pendingMilestones: Array<{
    activity: Activity;
    lane: Lane;
    startDate: Date;
    innerR: number;
    outerR: number;
  }> = [];

  constructor(container: HTMLElement, config: PlannerConfig, data: PlannerData, viewport: Viewport) {
    this.config = config;
    this.data = data;
    this.viewport = viewport;
    this.filterState = { hiddenLaneIds: new Set(), searchTerm: '', activeLabels: new Set(), activeTaggedUserIds: new Set(), selectedPeopleIds: new Set() };

    this.svg = select(container)
      .append('svg')
      .attr('viewBox', `0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('class', 'circular-planner-svg')
      .attr('role', 'img')
      .attr('aria-label', 'Circular planner');

    // Cancel drag on Escape
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.dragState) {
        this._cancelDrag();
      }
    });

    // Shared SVG-level drag move/up/cancel — wired once, dispatch via dragState
    const svgEl = this.svg.node() as SVGSVGElement;
    svgEl.addEventListener('pointermove', (e: PointerEvent) => this._onDragPointerMove(e));
    svgEl.addEventListener('pointerup', (e: PointerEvent) => this._onDragPointerUp(e));
    svgEl.addEventListener('pointercancel', (e: PointerEvent) => {
      if (this.dragState && this.dragState.pointerId === e.pointerId) this._cancelDrag();
    });

    this.renderDefs(); // static — created once
    this.rebuildGeometry();
    this.render();
  }

  setHandlers(onClickLane: ClickLaneHandler, onClickActivity: ClickActivityHandler): void {
    this.onClickLane = onClickLane;
    this.onClickActivity = onClickActivity;
  }

  setDragCommitHandler(fn: DragCommitHandler): void {
    this.onDragCommit = fn;
  }

  /** Returns the underlying SVGSVGElement. Used by export. */
  public getSVGNode(): SVGSVGElement {
    return this.svg.node() as SVGSVGElement;
  }

  /**
   * Wire up pinch-to-zoom using Pointer Events.
   * Call this once after construction, passing the same zoom handlers used by the wheel listener.
   * Single-finger pan is not intercepted — touch-action CSS keeps native scroll alive.
   */
  setPinchZoomHandlers(onZoomIn: () => void, onZoomOut: () => void): void {
    this.onZoomIn = onZoomIn;
    this.onZoomOut = onZoomOut;

    const svgEl = this.svg.node() as SVGSVGElement;

    svgEl.addEventListener('pointerdown', (e: PointerEvent) => {
      this._pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinchPointers.size === 2) {
        // Capture both pointers so we receive move/up even outside the element
        svgEl.setPointerCapture(e.pointerId);
        this._pinchStartDist = this._getPinchDist();
      }
    });

    svgEl.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this._pinchPointers.has(e.pointerId)) return;
      this._pinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pinchPointers.size === 2 && this._pinchStartDist > 0) {
        const currentDist = this._getPinchDist();
        const ratio = currentDist / this._pinchStartDist;

        // Threshold: require a 25% change before firing zoom to avoid jitter
        if (ratio > 1.25) {
          this._pinchStartDist = currentDist;
          if (this.onZoomIn) this.onZoomIn();
        } else if (ratio < 0.75) {
          this._pinchStartDist = currentDist;
          if (this.onZoomOut) this.onZoomOut();
        }
      }
    });

    const endHandler = (e: PointerEvent) => {
      this._pinchPointers.delete(e.pointerId);
      this._pinchStartDist = 0;
    };
    svgEl.addEventListener('pointerup', endHandler);
    svgEl.addEventListener('pointercancel', endHandler);
  }

  private _getPinchDist(): number {
    const pts = [...this._pinchPointers.values()];
    if (pts.length < 2) return 0;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  setBorderOptions(showBorder: boolean): void {
    this.showBorder = showBorder;
  }

  setColorBy(mode: ColorBy): void {
    this.colorBy = mode;
  }

  /** Full re-render with new data (lanes/activities changed) */
  update(data: PlannerData, filterState?: FilterState): void {
    this.data = data;
    if (filterState) this.filterState = filterState;
    this.rebuildGeometry();
    this.fullRender();
  }

  /** Re-render with a new viewport (zoom/navigation changed) */
  updateViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.rebuildGeometry();
    this.crossFadeRender();
  }

  private rebuildGeometry(): void {
    this.angleScale = createAngleScale(this.viewport.windowStart, this.viewport.windowEnd);

    // Only visible lanes occupy radial slots — hidden lanes release their space
    const visibleLanes = this.data.lanes
      .filter(l => !this.filterState.hiddenLaneIds.has(l.id))
      .sort((a, b) => a.order - b.order);
    const numLanes = Math.max(visibleLanes.length, 1);
    const laneWidth = (OUTER_RADIUS - CORE_RADIUS) / numLanes;

    const slotByLaneId = new Map<string, number>();
    visibleLanes.forEach((l, i) => slotByLaneId.set(l.id, i));

    this.geometry = {
      cx: CX,
      cy: CY,
      coreRadius: CORE_RADIUS,
      outerRadius: OUTER_RADIUS,
      laneWidth,
      slotByLaneId,
      innerRadiusFn: (slot: number) => CORE_RADIUS + slot * laneWidth,
      outerRadiusFn: (slot: number) => CORE_RADIUS + (slot + 1) * laneWidth,
    };
  }

  private fullRender(): void {
    this.svg.selectAll('g').remove(); // keep <defs>
    this.render();
  }

  private crossFadeRender(): void {
    const oldGroup = this.svg.select<SVGGElement>('g.cp-main');
    if (oldGroup.empty()) {
      this.fullRender();
      return;
    }

    oldGroup
      .attr('class', 'cp-old')
      .transition()
      .duration(200)
      .style('opacity', '0')
      .remove();

    this.render();
    this.svg.select<SVGGElement>('g.cp-main')
      .style('opacity', '0')
      .transition()
      .duration(200)
      .style('opacity', '1');
  }

  /** Re-render when theme switches — defs carry color values */
  setTheme(): void {
    this.svg.select('defs').remove();
    this.renderDefs();
    this.fullRender();
  }

  private cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  private renderDefs(): void {
    const defs = this.svg.insert('defs', ':first-child');

    const discBgInner = this.cssVar('--cp-disc-bg-inner', '#ffffff');
    const discBgOuter = this.cssVar('--cp-disc-bg-outer', '#f4f5f7');
    const seamShadow  = this.cssVar('--cp-seam-shadow', 'rgba(0,0,0,0.32)');

    // Disc background: subtle radial gradient
    const bgGrad = defs.append('radialGradient')
      .attr('id', 'cp-bg-grad')
      .attr('cx', '50%').attr('cy', '50%').attr('r', '50%');
    bgGrad.append('stop').attr('offset', '0%').attr('stop-color', discBgInner);
    bgGrad.append('stop').attr('offset', '100%').attr('stop-color', discBgOuter);

    // Disc drop shadow
    const discShadow = defs.append('filter')
      .attr('id', 'cp-disc-shadow')
      .attr('x', '-8%').attr('y', '-8%')
      .attr('width', '116%').attr('height', '116%');
    discShadow.append('feDropShadow')
      .attr('dx', 0).attr('dy', 3).attr('stdDeviation', 6)
      .attr('flood-color', 'rgba(0,0,0,0.12)');

    // Center hub shadow
    const hubShadow = defs.append('filter')
      .attr('id', 'cp-hub-shadow')
      .attr('x', '-20%').attr('y', '-20%')
      .attr('width', '140%').attr('height', '140%');
    hubShadow.append('feDropShadow')
      .attr('dx', 0).attr('dy', 1).attr('stdDeviation', 3)
      .attr('flood-color', 'rgba(0,0,0,0.10)');

    // Seam shadow gradient
    const seamGrad = defs.append('linearGradient')
      .attr('id', 'cp-seam-shadow')
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', CX).attr('y1', CY - OUTER_RADIUS)
      .attr('x2', CX + 55).attr('y2', CY - OUTER_RADIUS);
    seamGrad.append('stop').attr('offset', '0%').attr('stop-color', seamShadow);
    seamGrad.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(0,0,0,0)');

    // Cancelled-state diagonal stripe pattern (6×6, one diagonal line)
    const stripePattern = defs.append('pattern')
      .attr('id', 'cp-cancelled-stripes')
      .attr('patternUnits', 'userSpaceOnUse')
      .attr('width', 6).attr('height', 6)
      .attr('patternTransform', 'rotate(45)');
    stripePattern.append('line')
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', 0).attr('y2', 6)
      .attr('stroke', 'rgba(0,0,0,0.35)')
      .attr('stroke-width', 2);
  }

  private render(): void {
    // Clear any previous midnight timer before setting a new one below.
    if (this.midnightTimer !== null) {
      clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    this.textPathSeq = 0;
    this.pendingMilestones = [];
    const visibleLanes = this.data.lanes.filter(l => !this.filterState.hiddenLaneIds.has(l.id));
    const activityCount = visibleLanes.reduce((sum, l) => sum + l.activities.length, 0);
    this.svg.attr('aria-label',
      `Circular planner showing ${visibleLanes.length} lane${visibleLanes.length !== 1 ? 's' : ''} and ${activityCount} activit${activityCount !== 1 ? 'ies' : 'y'}`
    );

    const g = this.svg
      .append('g')
      .attr('class', 'cp-main')
      .attr('transform', `translate(${CX},${CY})`);

    this.renderBackground(g);
    this.renderGrid(g);
    this.renderLanes(g);
    this.renderMilestonesTopPass(g);
    this.renderSeamShadow(g);
    this.renderTodayIndicator(g);
    this.renderCenterLabel(g);

    // Schedule a re-render at the next local midnight (+1 s slack) so the
    // today indicator advances without requiring a page reload.
    //
    // Deliberately reads the WALL CLOCK, not clock.ts now(). This is
    // scheduling, not rendering: a pinned or swept clock in the past would
    // produce a negative delay, so the timeout would fire immediately,
    // re-render, re-arm itself, and spin. See the exceptions list in clock.ts.
    const wallNow = new Date(); // clock-exempt: scheduling, not rendering
    const nextMidnight = new Date(wallNow.getFullYear(), wallNow.getMonth(), wallNow.getDate() + 1);
    const msUntilMidnight = nextMidnight.getTime() - wallNow.getTime() + 1000;
    this.midnightTimer = setTimeout(() => this.fullRender(), msUntilMidnight);
  }

  private renderBackground(g: Selection<SVGGElement, unknown, null, undefined>): void {
    const stroke = this.cssVar('--cp-disc-stroke', '#d0d4db');
    g.append('circle')
      .attr('r', OUTER_RADIUS)
      .attr('fill', 'url(#cp-bg-grad)')
      .attr('filter', 'url(#cp-disc-shadow)')
      .attr('stroke', stroke)
      .attr('stroke-width', 1);
  }

  private renderGrid(g: Selection<SVGGElement, unknown, null, undefined>): void {
    const gridSpec = getGridSpec(this.viewport);
    const gridGroup = g.append('g').attr('class', 'gridlines');

    const gridMinor   = this.cssVar('--cp-grid-minor', '#e8eaed');
    const gridMajor   = this.cssVar('--cp-grid-major', '#d5d9e0');
    const gridBorder  = this.cssVar('--cp-disc-stroke', '#b0b7c3');
    const labelColor  = this.cssVar('--cp-text-muted', '#5f6b7a');

    // Start-of-window line
    const startAngle = MIN_ANGLE;
    gridGroup.append('line')
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', Math.sin(startAngle) * OUTER_RADIUS)
      .attr('y2', -Math.cos(startAngle) * OUTER_RADIUS)
      .attr('stroke', gridBorder)
      .attr('stroke-width', 1.5);

    // Minor ticks (week lines at Quarter, day lines at Month)
    gridSpec.minorTicks.forEach(d => {
      const angle = this.angleScale(d);
      if (angle <= MIN_ANGLE || angle >= MAX_ANGLE) return;
      gridGroup.append('line')
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', Math.sin(angle) * OUTER_RADIUS)
        .attr('y2', -Math.cos(angle) * OUTER_RADIUS)
        .attr('stroke', gridMinor)
        .attr('stroke-width', 1);
    });

    // Major ticks
    gridSpec.majorTicks.forEach(d => {
      const angle = this.angleScale(d);
      if (angle <= MIN_ANGLE || angle >= MAX_ANGLE) return;
      gridGroup.append('line')
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', Math.sin(angle) * OUTER_RADIUS)
        .attr('y2', -Math.cos(angle) * OUTER_RADIUS)
        .attr('stroke', gridMajor)
        .attr('stroke-width', 1);
    });

    // Outer labels around the perimeter (outside the disc, in a dedicated ring)
    const labelRadius = OUTER_RADIUS + 24;
    const labelsGroup = g.append('g').attr('class', 'grid-labels');

    // Compute minimum angular gap between labels to avoid overlap.
    // Approximate label width: charCount * fontSize * 0.6 pixels; minAngle = width / labelRadius.
    const zl = this.viewport.zoomLevel;
    const labelFontSize = (zl === ZoomLevel.Month)
      ? 8
      : (zl === ZoomLevel.Year || zl === ZoomLevel.Quarter)
        ? 9
        : 11;
    // Typical label: 3 chars (e.g. "Jan", "W12"). Use 3 chars as baseline.
    const approxLabelPx = 3 * labelFontSize * 0.6;
    const minAngleGap = approxLabelPx / labelRadius; // radians

    let lastDrawnAngle = -Infinity;

    gridSpec.labels.forEach(({ date, text, anchor }) => {
      const angle = this.angleScale(date);
      if (angle < MIN_ANGLE || angle > MAX_ANGLE) return;

      // Skip overlapping labels unless they are anchor labels (month starts, week 1).
      if (!anchor && (angle - lastDrawnAngle) < minAngleGap) return;

      lastDrawnAngle = angle;

      const lx = Math.sin(angle) * labelRadius;
      const ly = -Math.cos(angle) * labelRadius;
      const rotateDeg = (angle * 180 / Math.PI);

      const fontSize = zl === ZoomLevel.Month && text.length <= 2
        ? '8'
        : (zl === ZoomLevel.Year || zl === ZoomLevel.Quarter)
          ? '9'
          : '11';

      labelsGroup.append('text')
        .attr('x', lx).attr('y', ly)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('transform', `rotate(${rotateDeg},${lx},${ly})`)
        .attr('font-size', fontSize).attr('font-family', FONT_FAMILY)
        .attr('fill', labelColor)
        .text(text);
    });

    // Day-number sub-labels (Year zoom only) — ring just outside the disc,
    // between the disc edge and the main month labels.
    if (gridSpec.subLabels && gridSpec.subLabels.length > 0) {
      const subLabelRadius = OUTER_RADIUS + 8;
      const subLabelsGroup = g.append('g').attr('class', 'grid-sublabels');
      const subLabelColor = this.cssVar('--cp-text-muted', '#8896a5');

      gridSpec.subLabels.forEach(({ date, text }) => {
        const angle = this.angleScale(date);
        if (angle < MIN_ANGLE || angle > MAX_ANGLE) return;
        const lx = Math.sin(angle) * subLabelRadius;
        const ly = -Math.cos(angle) * subLabelRadius;
        const rotateDeg = angle * 180 / Math.PI;

        subLabelsGroup.append('text')
          .attr('x', lx).attr('y', ly)
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
          .attr('transform', `rotate(${rotateDeg},${lx},${ly})`)
          .attr('font-size', '7').attr('font-family', FONT_FAMILY)
          .attr('fill', subLabelColor).attr('opacity', '0.7')
          .text(text);
      });
    }
  }

  private renderLanes(g: Selection<SVGGElement, unknown, null, undefined>): void {
    const sorted = [...this.data.lanes].sort((a, b) => a.order - b.order);
    const defaultBorder = this.cssVar('--cp-lane-border', '#ffffff');
    const labelColor = this.cssVar('--cp-lane-border-text', '#1a2332');

    sorted.forEach((lane) => {
      const isHidden = this.filterState.hiddenLaneIds.has(lane.id);
      // Hidden lanes are entirely absent from the disc — no dim placeholder
      if (isHidden) return;

      const slot = this.geometry.slotByLaneId.get(lane.id);
      if (slot === undefined) return;

      const innerR = this.geometry.innerRadiusFn(slot);
      const outerR = this.geometry.outerRadiusFn(slot);

      // Reserve the outermost slice of the lane for a thick labelled border band.
      const laneW = outerR - innerR;
      const borderT = Math.max(10, Math.min(18, laneW * 0.28));
      const borderInner = this.showBorder ? outerR - borderT : outerR;
      const bandMid = (borderInner + outerR) / 2;
      const fontSize = Math.max(8, Math.min(12, borderT - 4));

      const laneGroup = g.append('g')
        .attr('class', 'lane')
        .attr('data-lane-id', lane.id);

      // Lane background fill (within the drawable area, not under the border band)
      const bgPathData = (this.arcGen as any)
        .innerRadius(innerR).outerRadius(borderInner)
        .startAngle(MIN_ANGLE).endAngle(MAX_ANGLE)();
      laneGroup.append('path')
        .attr('d', bgPathData)
        .attr('fill', lane.color || 'rgba(200,200,200,0.1)')
        .style('cursor', 'pointer')
        .on('click', (event: MouseEvent) => {
          const rect = (event.target as Element).closest('svg')?.getBoundingClientRect();
          if (!rect) return;
          const svgX = (event.clientX - rect.left) / rect.width * VIEWBOX_SIZE;
          const svgY = (event.clientY - rect.top) / rect.height * VIEWBOX_SIZE;
          const angle = xyToAngle(svgX - CX, svgY - CY);
          const clickedDate = (this.angleScale as any).invert(angle) as Date;
          this.onClickLane(lane.id, clickedDate);
        });

      // Thick border band at the outer edge of the lane
      if (this.showBorder) {
        const borderPathData = (this.arcGen as any)
          .innerRadius(borderInner).outerRadius(outerR)
          .startAngle(MIN_ANGLE).endAngle(MAX_ANGLE)();
        laneGroup.append('path')
          .attr('d', borderPathData)
          .attr('fill', defaultBorder)
          .style('pointer-events', 'none');
      }

      // Repeat the lane name at 6 clock positions (1, 3, 5, 7, 9, 11) along the border band.
      // Angle convention: 0 = 12 o'clock, increasing clockwise.
      if (this.showBorder) {
        const sx = (a: number, r: number) => Math.sin(a) * r;
        const sy = (a: number, r: number) => -Math.cos(a) * r;
        const clockHours = [1, 3, 5, 7, 9, 11];
        const labelSpan = Math.PI / 3 - 0.2;

        clockHours.forEach((h) => {
          const center = (h / 12) * 2 * Math.PI;
          const isBottom = Math.cos(center) < -0.1;
          // Offset the path radius so the text's visual centre lands on bandMid.
          // Top-half text extends outward from its path → path sits inside bandMid.
          // Bottom-flipped text extends inward from its path → path sits outside bandMid.
          const pathRadius = isBottom ? bandMid + fontSize * 0.35 : bandMid - fontSize * 0.35;
          const a0 = center - labelSpan / 2;
          const a1 = center + labelSpan / 2;
          const d = isBottom
            ? `M ${sx(a1, pathRadius)} ${sy(a1, pathRadius)} A ${pathRadius} ${pathRadius} 0 0 0 ${sx(a0, pathRadius)} ${sy(a0, pathRadius)}`
            : `M ${sx(a0, pathRadius)} ${sy(a0, pathRadius)} A ${pathRadius} ${pathRadius} 0 0 1 ${sx(a1, pathRadius)} ${sy(a1, pathRadius)}`;
          const pathId = `lane-label-${lane.id}-${slot}-${h}`;

          laneGroup.append('path')
            .attr('id', pathId)
            .attr('d', d)
            .attr('fill', 'none')
            .attr('stroke', 'none');

          const text = laneGroup.append('text')
            .attr('font-size', fontSize)
            .attr('font-family', FONT_FAMILY)
            .attr('font-weight', '600')
            .attr('fill', labelColor)
            .attr('dominant-baseline', 'central')
            .style('pointer-events', 'none');

          text.append('textPath')
            .attr('href', `#${pathId}`)
            .attr('startOffset', '50%')
            .attr('text-anchor', 'middle')
            .text(lane.name);
        });
      }

      // Filter activities by search term, active labels, and active tagged users
      const visibleActivities = lane.activities.filter(a => {
        if (this.filterState.searchTerm &&
            !a.title.toLowerCase().includes(this.filterState.searchTerm)) return false;
        if (this.filterState.activeLabels.size > 0 &&
            !this.filterState.activeLabels.has(a.label)) return false;
        if (this.filterState.activeTaggedUserIds.size > 0) {
          const tagged = a.taggedUsers ?? [];
          if (!tagged.some(u => u.id != null && this.filterState.activeTaggedUserIds.has(u.id))) return false;
        }
        return true;
      });

      // Expand recurring activities into per-viewport occurrences.
      // Each occurrence record carries a reference to the master activity for click handling.
      type Occurrence = { start: Date; end: Date; master: typeof visibleActivities[0] };
      const allOccurrences: Occurrence[] = [];
      for (const activity of visibleActivities) {
        const occ = expandOccurrences(activity, this.viewport.windowStart, this.viewport.windowEnd);
        for (const o of occ) {
          allOccurrences.push({ start: o.start, end: o.end, master: activity });
        }
      }

      // Greedy interval colouring: assign each occurrence a sub-row.
      // Milestones are excluded from the layout pass — they don't consume a row slot
      // and are instead drawn later via renderMilestonesTopPass().
      const layoutOcc = allOccurrences.filter(o => !o.master.isMilestone);
      const sortedOcc = [...layoutOcc].sort((a, b) => a.start.getTime() - b.start.getTime());
      const rowEnds: Date[] = [];
      const subRowMap = new Map<string, number>();
      sortedOcc.forEach(occ => {
        const row = rowEnds.findIndex(end => end < occ.start);
        const assigned = row === -1 ? rowEnds.length : row;
        rowEnds[assigned] = occ.end;
        // Key: activity id + occurrence start ms (stable even for expanded recurrences)
        subRowMap.set(`${occ.master.id}:${occ.start.getTime()}`, assigned);
      });
      const totalSubRows = Math.max(rowEnds.length, 1);

      allOccurrences.forEach((occ) => {
        const subRow = subRowMap.get(`${occ.master.id}:${occ.start.getTime()}`) ?? 0;
        this.renderOccurrence(laneGroup, occ.master, occ.start, occ.end, innerR, borderInner, subRow, totalSubRows, lane);
      });
    });
  }

  /** Second pass: render all milestones collected during renderLanes() into a top group.
   *  This ensures milestones always paint above regular arcs regardless of lane/activity order. */
  private renderMilestonesTopPass(g: Selection<SVGGElement, unknown, null, undefined>): void {
    if (this.pendingMilestones.length === 0) return;

    const topGroup = g.append('g').attr('class', 'cp-milestones-top');

    for (const { activity, lane, startDate, innerR, outerR } of this.pendingMilestones) {
      if (startDate > this.viewport.windowEnd || startDate < this.viewport.windowStart) continue;

      const startAngle = this.angleScale(startDate);
      const midR = (innerR + outerR) / 2;
      const halfSize = Math.min((outerR - innerR) * 0.45, 8);
      // Diamond: top, right, bottom, left points in SVG space (disc center at origin)
      const px = (r: number, a: number) => Math.sin(a) * r;
      const py = (r: number, a: number) => -Math.cos(a) * r;
      const points = [
        `${px(midR - halfSize, startAngle)},${py(midR - halfSize, startAngle)}`,
        `${px(midR, startAngle + halfSize / midR)},${py(midR, startAngle + halfSize / midR)}`,
        `${px(midR + halfSize, startAngle)},${py(midR + halfSize, startAngle)}`,
        `${px(midR, startAngle - halfSize / midR)},${py(midR, startAngle - halfSize / midR)}`,
      ].join(' ');

      const milestoneGroup = topGroup.append('g')
        .attr('class', 'activity')
        .attr('data-activity-id', activity.id)
        .style('cursor', 'pointer');

      milestoneGroup.append('polygon')
        .attr('points', points)
        .attr('fill', this.fillFor(activity, lane))
        .attr('fill-opacity', 0.92)
        .attr('stroke', 'rgba(255,255,255,0.7)')
        .attr('stroke-width', 1)
        .on('click', (event: MouseEvent) => {
          event.stopPropagation();
          this.onClickActivity(activity);
        });

      milestoneGroup.append('title')
        .text([
          `◆ ${activity.title}`,
          formatDate(startDate),
          activity.description || '',
          activity.createdBy ? `Created by ${activity.createdBy}` : '',
          activity.status && activity.status !== 'planned' ? `Status: ${activity.status}` : '',
        ].filter(Boolean).join('\n'));
    }
  }

  private fillFor(activity: Activity, lane: Lane): string {
    switch (this.colorBy) {
      case 'lane':   return withAlpha(lane.color || 'rgba(200,200,200,0.25)', 0.85);
      case 'label':  return activity.label ? colorForString(activity.label) : '#999';
      case 'status': return STATUS_COLORS[activity.status ?? 'planned'] ?? STATUS_COLORS['planned'];
      case 'owner':  return activity.createdBy ? colorForString(activity.createdBy) : '#999';
      case 'activity':
      default:       return activity.color || '#4a90e2';
    }
  }

  private renderOccurrence(
    laneGroup: Selection<SVGGElement, unknown, null, undefined>,
    activity: Activity,
    startDate: Date,
    endDate: Date,
    innerR: number,
    outerR: number,
    subRow = 0,
    totalSubRows = 1,
    lane?: Lane
  ): void {
    if (endDate < this.viewport.windowStart || startDate > this.viewport.windowEnd) return;

    let startAngle = this.angleScale(startDate);
    let endAngle   = this.angleScale(endDate);

    startAngle = Math.max(startAngle, MIN_ANGLE);
    endAngle = Math.min(endAngle, MAX_ANGLE);

    const actGroup = laneGroup.append('g')
      .attr('class', 'activity')
      .attr('data-activity-id', activity.id)
      .style('cursor', 'pointer');

    // --- Milestone rendering: deferred to top pass so diamonds always paint above arcs ---
    if (activity.isMilestone) {
      // Record for renderMilestonesTopPass(); do not draw here.
      this.pendingMilestones.push({ activity, lane: lane ?? { id: '', name: '', color: '', order: 0, activities: [] }, startDate, innerR, outerR });
      // Remove the placeholder group — nothing was appended to it.
      actGroup.remove();
      return;
    }

    // --- Normal arc rendering ---

    // Enforce minimum visible arc span (handles single-day events)
    if (endAngle - startAngle < MIN_ARC_SPAN) {
      const mid = (startAngle + endAngle) / 2;
      startAngle = mid - MIN_ARC_SPAN / 2;
      endAngle = mid + MIN_ARC_SPAN / 2;
    }

    if (endAngle <= startAngle) return;

    // Sub-band radii for stacking
    const subHeight = (outerR - innerR) / totalSubRows;
    const subInnerR = innerR + subRow * subHeight;
    const subOuterR = subInnerR + subHeight;
    const padding = Math.min(2, subHeight * 0.1);

    const status = activity.status ?? 'planned';
    const isCancelled = status === 'cancelled';
    const isDone = status === 'done';

    const pathData = (this.arcGen as any)
      .innerRadius(subInnerR + padding).outerRadius(subOuterR - padding)
      .startAngle(startAngle).endAngle(endAngle)
      .cornerRadius(3)();

    // Base fill arc
    const fillColor = this.fillFor(activity, lane ?? { id: '', name: '', color: '', order: 0, activities: [] });
    const isDraggable = !activity.isMilestone &&
      !(activity.recurrence && activity.recurrence.type !== 'none') &&
      this.onDragCommit !== null &&
      this.config.permission !== 'view';

    const fillArc = actGroup.append('path')
      .attr('d', pathData)
      .attr('fill', fillColor)
      .attr('fill-opacity', isCancelled ? 0.35 : 0.88)
      .attr('stroke', 'rgba(255,255,255,0.6)')
      .attr('stroke-width', 0.8)
      .on('mouseenter', function() {
        select(this).attr('fill-opacity', isCancelled ? 0.5 : 1).attr('stroke', 'white').attr('stroke-width', 1.2);
      })
      .on('mouseleave', function() {
        select(this).attr('fill-opacity', isCancelled ? 0.35 : 0.88).attr('stroke', 'rgba(255,255,255,0.6)').attr('stroke-width', 0.8);
      });

    if (isDraggable) {
      this.attachDrag(fillArc, activity, startAngle, endAngle, subInnerR, subOuterR, lane ?? { id: '', name: '', color: '', order: 0, activities: [] });
    } else {
      fillArc.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        this.onClickActivity(activity);
      });
    }

    // Cancelled: overlay diagonal stripe pattern
    if (isCancelled) {
      actGroup.append('path')
        .attr('d', pathData)
        .attr('fill', 'url(#cp-cancelled-stripes)')
        .attr('fill-opacity', 1)
        .attr('stroke', 'none')
        .style('pointer-events', 'none');
    }

    // Render activity title as text on a curved path so it follows the arc.
    // Top half: path goes clockwise (start→end) so text reads outward-up.
    // Bottom half: path goes counter-clockwise (end→start) so text still reads
    // right-side up to a viewer outside the disc.
    const fontSize = Math.max(7, Math.min(9, Math.floor(subHeight * 0.6)));
    if (subHeight >= fontSize + 3) {
      const midAngle = (startAngle + endAngle) / 2;
      const textR = (subInnerR + subOuterR) / 2;
      // Match the lane-label tolerance at line ~551. Without the -0.1 margin,
      // arcs centred exactly on 3 / 9 o'clock flicker between top/bottom
      // orientations on successive renders due to floating-point noise.
      const isBottom = Math.cos(midAngle) < -0.1;
      // Compensate for the dominant-baseline='central' offset so the text's
      // visual centre lands on textR. Top text extends radially outward from
      // its path; bottom-flipped text extends radially inward.
      const pathRadius = isBottom ? textR + fontSize * 0.35 : textR - fontSize * 0.35;
      const sx = (a: number) => Math.sin(a) * pathRadius;
      const sy = (a: number) => -Math.cos(a) * pathRadius;
      const d = isBottom
        ? `M ${sx(endAngle)} ${sy(endAngle)} A ${pathRadius} ${pathRadius} 0 0 0 ${sx(startAngle)} ${sy(startAngle)}`
        : `M ${sx(startAngle)} ${sy(startAngle)} A ${pathRadius} ${pathRadius} 0 0 1 ${sx(endAngle)} ${sy(endAngle)}`;

      // Measure the title's natural (straight) width so we can hide the label
      // when it doesn't fit the available arc length, instead of letting it
      // overflow or get clipped weirdly.
      const measure = actGroup.append('text')
        .attr('font-size', fontSize)
        .attr('font-family', FONT_FAMILY)
        .attr('font-weight', '500')
        .style('visibility', 'hidden')
        .text(activity.title);
      const textLen = (measure.node() as SVGTextElement).getComputedTextLength();
      measure.remove();

      const arcLen = (endAngle - startAngle) * pathRadius - 4; // 4px padding

      if (textLen <= arcLen) {
        const pathId = `cp-act-text-${this.textPathSeq++}`;
        actGroup.append('path')
          .attr('id', pathId)
          .attr('d', d)
          .attr('fill', 'none')
          .attr('stroke', 'none');

        actGroup.append('text')
          .attr('font-size', fontSize)
          .attr('font-family', FONT_FAMILY)
          .attr('font-weight', '500')
          .attr('fill', 'white')
          .attr('dominant-baseline', 'central')
          .style('pointer-events', 'none')
          .append('textPath')
            .attr('href', `#${pathId}`)
            .attr('startOffset', '50%')
            .attr('text-anchor', 'middle')
            .text(activity.title);
      }

      // Done: small checkmark near the start of the arc
      if (isDone) {
        const checkR = textR;
        const checkAngle = startAngle + 0.04;
        actGroup.append('text')
          .attr('x', Math.sin(checkAngle) * checkR)
          .attr('y', -Math.cos(checkAngle) * checkR)
          .attr('font-size', Math.min(fontSize + 1, subHeight * 0.7))
          .attr('fill', 'white')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .style('pointer-events', 'none')
          .text('✓');
      }
    }

    actGroup.append('title')
      .text([
        activity.title,
        `${formatDate(startDate)} → ${formatDate(endDate)}`,
        activity.description || '',
        activity.createdBy ? `Created by ${activity.createdBy}` : '',
        status !== 'planned' ? `Status: ${status}` : '',
      ].filter(Boolean).join('\n'));
  }

  /** Plandisc-style seam at 12 o'clock: the end-of-range "lifts" above the start,
   *  making the direction of time (CW) visually obvious. */
  private renderSeamShadow(g: Selection<SVGGElement, unknown, null, undefined>): void {
    const discBg = this.cssVar('--cp-disc-bg-outer', '#f4f5f7');
    const borderStrong = this.cssVar('--cp-border-strong', '#d0d4db');

    // Subtle highlight on the END side — the lifted edge catches light
    const highlightSpread = 0.08;
    g.append('path')
      .attr('d', (this.arcGen as any)
        .innerRadius(CORE_RADIUS).outerRadius(OUTER_RADIUS)
        .startAngle(MAX_ANGLE - highlightSpread).endAngle(MAX_ANGLE)())
      .attr('fill', 'rgba(255,255,255,0.22)')
      .attr('pointer-events', 'none');

    // Narrow, light drop shadow on the START side — cast by the lifted end edge.
    // Kept short (~3°) and soft so it reads as depth, not a dark band.
    const shadowSpread = 0.055;
    g.append('path')
      .attr('d', (this.arcGen as any)
        .innerRadius(CORE_RADIUS).outerRadius(OUTER_RADIUS)
        .startAngle(MIN_ANGLE).endAngle(MIN_ANGLE + shadowSpread)())
      .attr('fill', 'rgba(0,0,0,0.18)')
      .attr('pointer-events', 'none');

    // "Paper overhang" lip on the END side — a thin wedge extending just outside
    // OUTER_RADIUS, creating the illusion that the end of the range sits on top
    // of the start, like the outer turn of a rolled sheet.
    const lipInnerR = CORE_RADIUS;
    const lipOuterR = OUTER_RADIUS + 6;
    const lipSpread = 0.04; // ~2.3°
    g.append('path')
      .attr('d', (this.arcGen as any)
        .innerRadius(lipInnerR).outerRadius(lipOuterR)
        .startAngle(MAX_ANGLE - lipSpread).endAngle(MAX_ANGLE)())
      .attr('fill', discBg)
      .attr('stroke', borderStrong)
      .attr('stroke-width', 1)
      .attr('pointer-events', 'none');

  }

  private renderTodayIndicator(g: Selection<SVGGElement, unknown, null, undefined>): void {
    const today = now();
    if (today < this.viewport.windowStart || today > this.viewport.windowEnd) return;

    const todayColor = this.cssVar('--cp-today', '#f44336');
    const angle = this.angleScale(today);
    g.append('line')
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', Math.sin(angle) * OUTER_RADIUS)
      .attr('y2', -Math.cos(angle) * OUTER_RADIUS)
      .attr('stroke', todayColor)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4,3')
      .attr('opacity', 0.75);

    g.append('circle')
      .attr('cx', Math.sin(angle) * OUTER_RADIUS)
      .attr('cy', -Math.cos(angle) * OUTER_RADIUS)
      .attr('r', 4)
      .attr('fill', todayColor)
      .attr('opacity', 0.75);

    // At Month/Week zoom the disc shows enough detail that a date label is useful.
    const zl = this.viewport.zoomLevel;
    if (zl === ZoomLevel.Month || zl === ZoomLevel.Week) {
      const labelRadius = OUTER_RADIUS + 14;
      const lx = Math.sin(angle) * labelRadius;
      const ly = -Math.cos(angle) * labelRadius;
      // Anchor left when dot is on the right half, right when on the left half.
      const anchor = lx >= 0 ? 'start' : 'end';
      g.append('text')
        .attr('x', lx)
        .attr('y', ly)
        .attr('text-anchor', anchor)
        .attr('dominant-baseline', 'middle')
        .attr('font-size', '10')
        .attr('font-weight', '600')
        .attr('font-family', FONT_FAMILY)
        .attr('fill', todayColor)
        .attr('opacity', 0.85)
        .text(formatDate(today));
    }
  }

  private renderCenterLabel(g: Selection<SVGGElement, unknown, null, undefined>): void {
    const surface  = this.cssVar('--cp-surface', '#ffffff');
    const stroke   = this.cssVar('--cp-disc-stroke', '#d0d4db');
    const textMain = this.cssVar('--cp-text', '#1a2332');
    const textMuted = this.cssVar('--cp-text-muted', '#8896a5');

    g.append('circle')
      .attr('r', CORE_RADIUS - 2)
      .attr('fill', surface)
      .attr('filter', 'url(#cp-hub-shadow)')
      .attr('stroke', stroke)
      .attr('stroke-width', 1);

    const label = viewportLabel(this.viewport);
    const titleText = this.config.title;

    // Measure-fit the label into the hub: start at 15px, shrink until it fits
    // within the hub diameter (CORE_RADIUS - 6) * 2, floor at 8px.
    const maxLabelWidth = (CORE_RADIUS - 6) * 2;
    const labelNode = g.append('text')
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
      .attr('font-size', '15')
      .attr('font-weight', '600').attr('font-family', FONT_FAMILY)
      .attr('fill', textMain)
      .attr('y', titleText ? -8 : 0)
      .text(label);
    let labelFontSize = 15;
    const labelEl = labelNode.node() as SVGTextElement;
    while (labelEl.getComputedTextLength() > maxLabelWidth && labelFontSize > 8) {
      labelFontSize -= 1;
      labelNode.attr('font-size', String(labelFontSize));
    }

    if (titleText) {
      const truncated = titleText.length > 14 ? titleText.slice(0, 14) + '…' : titleText;
      g.append('text')
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('font-size', '8').attr('font-family', FONT_FAMILY)
        .attr('fill', textMuted).attr('y', 8)
        .text(truncated);
    }
  }

  // Convert SVG-space coordinates (relative to disc center) to an angle in [0, 2π].
  // atan2(dx, -dy): 0 = 12 o'clock, clockwise — matches d3-arc convention.
  private _svgToAngle(svgX: number, svgY: number): number {
    return xyToAngle(svgX - CX, svgY - CY);
  }

  // Convert a client-space pointer event to SVG-space coordinates.
  private _clientToSvg(clientX: number, clientY: number): { x: number; y: number } {
    const svgEl = this.svg.node() as SVGSVGElement;
    const rect = svgEl.getBoundingClientRect();
    const scaleX = VIEWBOX_SIZE / rect.width;
    const scaleY = VIEWBOX_SIZE / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  // Snap a Date to local midnight.
  private _snapToDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // Convert an angle in the current viewport to a date, snapped to day.
  private _angleToDate(angle: number): Date {
    const raw = (this.angleScale as any).invert(angle) as Date;
    return this._snapToDay(raw);
  }

  private _cancelDrag(): void {
    if (!this.dragState) return;
    if (this.dragState.ghost && this.dragState.ghostGroup) {
      this.dragState.ghostGroup.remove();
    }
    const svgEl = this.svg.node() as SVGSVGElement;
    try { svgEl.releasePointerCapture(this.dragState.pointerId); } catch { /* already released */ }
    this.dragState = null;
  }

  private _hoveredLaneAt(r: number): Lane | null {
    for (const lane of this.data.lanes) {
      if (this.filterState.hiddenLaneIds.has(lane.id)) continue;
      const slot = this.geometry.slotByLaneId.get(lane.id);
      if (slot === undefined) continue;
      const innerR = this.geometry.innerRadiusFn(slot);
      const outerR = this.geometry.outerRadiusFn(slot);
      if (r >= innerR && r <= outerR) return lane;
    }
    return null;
  }

  private _plannerStart(): Date { return parseDate(this.config.startDate); }
  private _plannerEnd(): Date { return parseDate(this.config.endDate); }

  private _onDragPointerMove(e: PointerEvent): void {
    if (!this.dragState || this.dragState.pointerId !== e.pointerId) return;

    const svgPos = this._clientToSvg(e.clientX, e.clientY);
    const rawAngle = this._svgToAngle(svgPos.x, svgPos.y);

    // Unwrap angle across the seam to prevent atan2 flip jumps
    let delta = rawAngle - this.dragState.lastPointerAngle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    this.dragState.accumulatedAngle += delta;
    this.dragState.lastPointerAngle = rawAngle;

    const angleDelta = this.dragState.accumulatedAngle - this.dragState.pointerStartAngle;

    const { mode, originalStart, originalEnd, arcStartAngle, arcEndAngle } = this.dragState;
    const msPerRad = (this.viewport.windowEnd.getTime() - this.viewport.windowStart.getTime()) / (2 * Math.PI);
    const dayMs = 86400000;
    const plannerStart = this._plannerStart();
    const plannerEnd = this._plannerEnd();

    let newStart: Date;
    let newEnd: Date;
    let newStartAngle: number;
    let newEndAngle: number;

    if (mode === 'move') {
      const shiftDays = Math.round(angleDelta * msPerRad / dayMs);
      let candidateStart = this._snapToDay(new Date(originalStart.getTime() + shiftDays * dayMs));
      let candidateEnd = this._snapToDay(new Date(originalEnd.getTime() + shiftDays * dayMs));
      const duration = originalEnd.getTime() - originalStart.getTime();
      if (candidateStart < plannerStart) { candidateStart = plannerStart; candidateEnd = new Date(plannerStart.getTime() + duration); }
      if (candidateEnd > plannerEnd) { candidateEnd = plannerEnd; candidateStart = new Date(plannerEnd.getTime() - duration); }
      newStart = candidateStart;
      newEnd = candidateEnd;
      newStartAngle = this.angleScale(newStart);
      newEndAngle = this.angleScale(newEnd);
    } else if (mode === 'resize-start') {
      newEnd = originalEnd;
      const candidateStart = this._angleToDate(this.dragState.accumulatedAngle);
      const maxStart = new Date(originalEnd.getTime() - dayMs);
      const clampedStart = candidateStart < plannerStart ? plannerStart : candidateStart;
      newStart = clampedStart > maxStart ? maxStart : clampedStart;
      newStartAngle = this.angleScale(newStart);
      newEndAngle = arcEndAngle;
    } else {
      newStart = originalStart;
      const candidateEnd = this._angleToDate(this.dragState.accumulatedAngle);
      const minEnd = new Date(originalStart.getTime() + dayMs);
      const clampedEnd = candidateEnd > plannerEnd ? plannerEnd : candidateEnd;
      newEnd = clampedEnd < minEnd ? minEnd : clampedEnd;
      newStartAngle = arcStartAngle;
      newEndAngle = this.angleScale(newEnd);
    }

    this.dragState.currentNewStart = newStart;
    this.dragState.currentNewEnd = newEnd;

    if (!this.dragState.movedMeaningfully) {
      const startChanged = formatDate(newStart) !== formatDate(originalStart);
      const endChanged = formatDate(newEnd) !== formatDate(originalEnd);
      if (Math.abs(angleDelta) > 0.5 * Math.PI / 180 || startChanged || endChanged) {
        this.dragState.movedMeaningfully = true;
      }
    }

    // Detect cross-lane drop target from pointer radius
    const dx = svgPos.x - CX;
    const dy = svgPos.y - CY;
    const r = Math.sqrt(dx * dx + dy * dy);
    const hovered = this._hoveredLaneAt(r);
    this.dragState.hoveredLane = hovered;
    const effectiveLane = hovered ?? this.dragState.lane;

    // Ghost radii: use the hovered lane's full band (no sub-row info for a fresh drop)
    let ghostInnerR = this.dragState.laneInnerR;
    let ghostOuterR = this.dragState.laneOuterR;
    if (hovered && hovered.id !== this.dragState.lane.id) {
      const slot = this.geometry.slotByLaneId.get(hovered.id);
      if (slot !== undefined) {
        const laneInner = this.geometry.innerRadiusFn(slot);
        const laneOuter = this.geometry.outerRadiusFn(slot);
        const laneW = laneOuter - laneInner;
        const borderT = Math.max(10, Math.min(18, laneW * 0.28));
        ghostInnerR = laneInner;
        ghostOuterR = laneOuter - borderT;
      }
    }

    // Update ghost arc
    const clampedStart = Math.max(newStartAngle, MIN_ANGLE);
    const clampedEnd = Math.min(newEndAngle, MAX_ANGLE);
    if (clampedEnd > clampedStart) {
      const ghostPathData = (this.arcGen as any)
        .innerRadius(ghostInnerR)
        .outerRadius(ghostOuterR)
        .startAngle(clampedStart)
        .endAngle(clampedEnd)
        .cornerRadius(3)();

      if (!this.dragState.ghostGroup) {
        const ghostGroup = this.svg.append('g')
          .attr('class', 'cp-drag-ghost')
          .attr('transform', `translate(${CX},${CY})`)
          .node() as SVGGElement;
        const ghostPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        ghostGroup.appendChild(ghostPath);
        this.dragState.ghostGroup = ghostGroup;
        this.dragState.ghost = ghostPath;
      }

      const fillColor = this.fillFor(this.dragState.activity, effectiveLane);
      const ghost = this.dragState.ghost!;
      ghost.setAttribute('d', ghostPathData);
      ghost.setAttribute('fill', fillColor);
      ghost.setAttribute('fill-opacity', '0.5');
      ghost.setAttribute('stroke', 'white');
      ghost.setAttribute('stroke-width', '1.5');
      ghost.setAttribute('stroke-dasharray', '4 3');
      ghost.style.pointerEvents = 'none';
    }
  }

  private _onDragPointerUp(e: PointerEvent): void {
    if (!this.dragState || this.dragState.pointerId !== e.pointerId) return;

    const { movedMeaningfully, currentNewStart, currentNewEnd, originalStart, originalEnd, hoveredLane, lane } = this.dragState;

    if (this.dragState.ghostGroup) this.dragState.ghostGroup.remove();
    const svgEl = this.svg.node() as SVGSVGElement;
    try { svgEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }

    const ds = this.dragState;
    this.dragState = null;

    const newLaneId = hoveredLane ? hoveredLane.id : lane.id;

    if (!movedMeaningfully ||
        (formatDate(currentNewStart) === formatDate(originalStart) &&
         formatDate(currentNewEnd) === formatDate(originalEnd) &&
         newLaneId === lane.id)) {
      this.onClickActivity(ds.activity);
    } else if (this.onDragCommit) {
      this.onDragCommit(ds.activity, currentNewStart, currentNewEnd, newLaneId);
    }
  }

  private attachDrag(
    arcSel: Selection<SVGPathElement, unknown, null, undefined>,
    activity: Activity,
    arcStartAngle: number,
    arcEndAngle: number,
    laneInnerR: number,
    laneOuterR: number,
    lane: Lane,
  ): void {
    const svgEl = this.svg.node() as SVGSVGElement;
    const arcEl = arcSel.node() as SVGPathElement;

    arcEl.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (this._pinchPointers.size >= 2) return;

      e.stopPropagation();

      const svgPos = this._clientToSvg(e.clientX, e.clientY);
      const pointerAngle = this._svgToAngle(svgPos.x, svgPos.y);

      const span = arcEndAngle - arcStartAngle;
      const minSpanForResize = 6 * Math.PI / 180; // 6°
      const hitZone = Math.min(span * 0.25, 5 * Math.PI / 180);
      let mode: DragState['mode'] = 'move';
      if (span >= minSpanForResize) {
        if (Math.abs(pointerAngle - arcStartAngle) <= hitZone) mode = 'resize-start';
        else if (Math.abs(pointerAngle - arcEndAngle) <= hitZone) mode = 'resize-end';
      }

      const originalStart = parseDate(activity.startDate);
      const originalEnd = parseDate(activity.endDate);

      this.dragState = {
        activity,
        lane,
        mode,
        originalStart,
        originalEnd,
        arcStartAngle,
        arcEndAngle,
        pointerStartAngle: pointerAngle,
        lastPointerAngle: pointerAngle,
        accumulatedAngle: pointerAngle,
        laneInnerR,
        laneOuterR,
        hoveredLane: null,
        ghost: null,
        ghostGroup: null,
        movedMeaningfully: false,
        pointerId: e.pointerId,
        currentNewStart: originalStart,
        currentNewEnd: originalEnd,
      };

      svgEl.setPointerCapture(e.pointerId);
    });
  }
}
