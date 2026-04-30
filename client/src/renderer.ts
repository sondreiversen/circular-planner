import { select, Selection } from 'd3-selection';
import 'd3-transition'; // extends Selection with .transition()
import { arc as d3Arc } from 'd3-shape';
import { createAngleScale, parseDate, formatDate, xyToAngle, FONT_FAMILY, expandOccurrences } from './utils';
import { PlannerConfig, PlannerData, Lane, Activity, DiscGeometry, Viewport, ZoomLevel, GridSpec, FilterState } from './types';
import { getGridSpec, viewportLabel } from './viewport';

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

export class Renderer {
  private svg: Selection<SVGSVGElement, unknown, null, undefined>;
  private config: PlannerConfig;
  private data: PlannerData;
  private viewport: Viewport;
  private filterState: FilterState;
  private angleScale!: ReturnType<typeof createAngleScale>;
  private geometry!: DiscGeometry;
  private showBorder = true;

  private onClickLane: ClickLaneHandler = () => {};
  private onClickActivity: ClickActivityHandler = () => {};
  private onZoomIn: (() => void) | null = null;
  private onZoomOut: (() => void) | null = null;
  private readonly arcGen = d3Arc<unknown>();

  // Pinch-to-zoom state
  private _pinchPointers = new Map<number, { x: number; y: number }>();
  private _pinchStartDist = 0;

  constructor(container: HTMLElement, config: PlannerConfig, data: PlannerData, viewport: Viewport) {
    this.config = config;
    this.data = data;
    this.viewport = viewport;
    this.filterState = { hiddenLaneIds: new Set(), searchTerm: '', activeLabels: new Set(), activeTaggedUserIds: new Set() };

    this.svg = select(container)
      .append('svg')
      .attr('viewBox', `0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('class', 'circular-planner-svg')
      .attr('role', 'img')
      .attr('aria-label', 'Circular planner');

    this.renderDefs(); // static — created once
    this.rebuildGeometry();
    this.render();
  }

  setHandlers(onClickLane: ClickLaneHandler, onClickActivity: ClickActivityHandler): void {
    this.onClickLane = onClickLane;
    this.onClickActivity = onClickActivity;
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
  }

  private render(): void {
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
    this.renderSeamShadow(g);
    this.renderTodayIndicator(g);
    this.renderCenterLabel(g);
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

    // Minor ticks
    gridSpec.minorTicks.forEach(d => {
      const angle = this.angleScale(d);
      if (angle <= MIN_ANGLE || angle >= MAX_ANGLE) return;
      gridGroup.append('line')
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', Math.sin(angle) * OUTER_RADIUS)
        .attr('y2', -Math.cos(angle) * OUTER_RADIUS)
        .attr('stroke', gridMinor)
        .attr('stroke-width', 0.5);
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
          if (!tagged.some(u => this.filterState.activeTaggedUserIds.has(u.id))) return false;
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

      // Greedy interval colouring: assign each occurrence a sub-row
      const sortedOcc = [...allOccurrences].sort((a, b) => a.start.getTime() - b.start.getTime());
      const rowEnds: Date[] = [];
      const subRows: number[] = sortedOcc.map(occ => {
        const row = rowEnds.findIndex(end => end <= occ.start);
        const assigned = row === -1 ? rowEnds.length : row;
        rowEnds[assigned] = occ.end;
        return assigned;
      });
      const totalSubRows = Math.max(rowEnds.length, 1);

      sortedOcc.forEach((occ, i) => {
        this.renderOccurrence(laneGroup, occ.master, occ.start, occ.end, innerR, borderInner, subRows[i], totalSubRows);
      });
    });
  }

  private renderOccurrence(
    laneGroup: Selection<SVGGElement, unknown, null, undefined>,
    activity: Activity,
    startDate: Date,
    endDate: Date,
    innerR: number,
    outerR: number,
    subRow = 0,
    totalSubRows = 1
  ): void {
    if (endDate < this.viewport.windowStart || startDate > this.viewport.windowEnd) return;

    let startAngle = this.angleScale(startDate);
    let endAngle   = this.angleScale(endDate);

    startAngle = Math.max(startAngle, MIN_ANGLE);
    endAngle = Math.min(endAngle, MAX_ANGLE);

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

    const actGroup = laneGroup.append('g')
      .attr('class', 'activity')
      .attr('data-activity-id', activity.id)
      .style('cursor', 'pointer');

    const pathData = (this.arcGen as any)
      .innerRadius(subInnerR + padding).outerRadius(subOuterR - padding)
      .startAngle(startAngle).endAngle(endAngle)
      .cornerRadius(3)();
    actGroup.append('path')
      .attr('d', pathData)
      .attr('fill', activity.color || '#4a90e2')
      .attr('fill-opacity', 0.88)
      .attr('stroke', 'rgba(255,255,255,0.6)')
      .attr('stroke-width', 0.8)
      .on('click', (event: MouseEvent) => {
        event.stopPropagation();
        this.onClickActivity(activity);
      })
      .on('mouseenter', function() {
        select(this).attr('fill-opacity', 1).attr('stroke', 'white').attr('stroke-width', 1.2);
      })
      .on('mouseleave', function() {
        select(this).attr('fill-opacity', 0.88).attr('stroke', 'rgba(255,255,255,0.6)').attr('stroke-width', 0.8);
      });

    const midAngle = (startAngle + endAngle) / 2;
    const textR = (subInnerR + subOuterR) / 2;
    const tx = Math.sin(midAngle) * textR;
    const ty = -Math.cos(midAngle) * textR;
    const rotateDeg = (midAngle * 180 / Math.PI);

    const arcSpanDeg = (endAngle - startAngle) * 180 / Math.PI;
    if (arcSpanDeg > 10 && subHeight >= 10) {
      actGroup.append('text')
        .attr('x', tx)
        .attr('y', ty)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('transform', `rotate(${rotateDeg},${tx},${ty})`)
        .attr('font-size', '9')
        .attr('font-family', FONT_FAMILY)
        .attr('font-weight', '500')
        .attr('fill', 'white')
        .attr('pointer-events', 'none')
        .text(activity.title);
    }

    actGroup.append('title')
      .text([
        activity.title,
        `${formatDate(startDate)} → ${formatDate(endDate)}`,
        activity.description || '',
        activity.createdBy ? `Created by ${activity.createdBy}` : '',
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
    const today = new Date();
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

    g.append('text')
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
      .attr('font-size', label.length > 10 ? '11' : '15')
      .attr('font-weight', '600').attr('font-family', FONT_FAMILY)
      .attr('fill', textMain)
      .attr('y', titleText ? -8 : 0)
      .text(label);

    if (titleText) {
      const truncated = titleText.length > 14 ? titleText.slice(0, 14) + '…' : titleText;
      g.append('text')
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('font-size', '8').attr('font-family', FONT_FAMILY)
        .attr('fill', textMuted).attr('y', 8)
        .text(truncated);
    }
  }
}
