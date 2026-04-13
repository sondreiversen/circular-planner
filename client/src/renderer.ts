import { select, Selection } from 'd3-selection';
import 'd3-transition'; // extends Selection with .transition()
import { arc as d3Arc } from 'd3-shape';
import { createAngleScale, parseDate, formatDate, xyToAngle, FONT_FAMILY } from './utils';
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

  private onClickLane: ClickLaneHandler = () => {};
  private onClickActivity: ClickActivityHandler = () => {};
  private readonly arcGen = d3Arc<unknown>();

  constructor(container: HTMLElement, config: PlannerConfig, data: PlannerData, viewport: Viewport) {
    this.config = config;
    this.data = data;
    this.viewport = viewport;
    this.filterState = { hiddenLaneIds: new Set(), searchTerm: '' };

    this.svg = select(container)
      .append('svg')
      .attr('viewBox', `0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('class', 'circular-planner-svg');

    this.renderDefs(); // static — created once
    this.rebuildGeometry();
    this.render();
  }

  setHandlers(onClickLane: ClickLaneHandler, onClickActivity: ClickActivityHandler): void {
    this.onClickLane = onClickLane;
    this.onClickActivity = onClickActivity;
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

    // Outer labels around the perimeter
    const labelRadius = OUTER_RADIUS + 20;
    const labelsGroup = g.append('g').attr('class', 'grid-labels');

    gridSpec.labels.forEach(({ date, text }) => {
      const angle = this.angleScale(date);
      if (angle < MIN_ANGLE || angle > MAX_ANGLE) return;

      const lx = Math.sin(angle) * labelRadius;
      const ly = -Math.cos(angle) * labelRadius;
      const rotateDeg = (angle * 180 / Math.PI);

      const fontSize = this.viewport.zoomLevel === ZoomLevel.Month && text.length <= 2
        ? '8'
        : (this.viewport.zoomLevel === ZoomLevel.Year || this.viewport.zoomLevel === ZoomLevel.Quarter)
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

    // Inner day-number sub-labels (Year zoom only)
    if (gridSpec.subLabels && gridSpec.subLabels.length > 0) {
      const subLabelRadius = OUTER_RADIUS - 14;
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
    const laneStroke = this.cssVar('--cp-disc-stroke', '#c8cdd6');
    const labelColor = this.cssVar('--cp-text-muted', '#6b7280');

    sorted.forEach((lane) => {
      const isHidden = this.filterState.hiddenLaneIds.has(lane.id);
      // Hidden lanes are entirely absent from the disc — no dim placeholder
      if (isHidden) return;

      const slot = this.geometry.slotByLaneId.get(lane.id);
      if (slot === undefined) return;

      const innerR = this.geometry.innerRadiusFn(slot);
      const outerR = this.geometry.outerRadiusFn(slot);

      const laneGroup = g.append('g')
        .attr('class', 'lane')
        .attr('data-lane-id', lane.id);

      // Lane background ring
      const bgPathData = (this.arcGen as any)
        .innerRadius(innerR).outerRadius(outerR)
        .startAngle(MIN_ANGLE).endAngle(MAX_ANGLE)();
      laneGroup.append('path')
        .attr('d', bgPathData)
        .attr('fill', lane.color || 'rgba(200,200,200,0.1)')
        .attr('stroke', laneStroke)
        .attr('stroke-width', 0.5)
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

      // Lane name label
      laneGroup.append('text')
        .attr('x', 0).attr('y', -(innerR + 4) - 4)
        .attr('font-size', '9').attr('font-family', FONT_FAMILY)
        .attr('fill', labelColor).attr('text-anchor', 'middle')
        .text(lane.name);

      // Filter activities by search term and active labels
      const visibleActivities = lane.activities.filter(a => {
        if (this.filterState.searchTerm &&
            !a.title.toLowerCase().includes(this.filterState.searchTerm)) return false;
        if (this.filterState.activeLabels.size > 0 &&
            !this.filterState.activeLabels.has(a.label)) return false;
        return true;
      });

      // Greedy interval colouring: assign each activity a sub-row
      const sortedActs = [...visibleActivities].sort(
        (a, b) => parseDate(a.startDate).getTime() - parseDate(b.startDate).getTime()
      );
      const rowEnds: Date[] = [];
      const subRows: number[] = sortedActs.map(activity => {
        const start = parseDate(activity.startDate);
        const row = rowEnds.findIndex(end => end <= start);
        const assigned = row === -1 ? rowEnds.length : row;
        rowEnds[assigned] = parseDate(activity.endDate);
        return assigned;
      });
      const totalSubRows = Math.max(rowEnds.length, 1);

      sortedActs.forEach((activity, i) => {
        this.renderActivity(laneGroup, activity, innerR, outerR, subRows[i], totalSubRows);
      });
    });
  }

  private renderActivity(
    laneGroup: Selection<SVGGElement, unknown, null, undefined>,
    activity: Activity,
    innerR: number,
    outerR: number,
    subRow = 0,
    totalSubRows = 1
  ): void {
    const startDate = parseDate(activity.startDate);
    const endDate   = parseDate(activity.endDate);

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
      .text(`${activity.title}\n${formatDate(startDate)} → ${formatDate(endDate)}\n${activity.description || ''}`);
  }

  /** Plandisc-style overlap shadow at 12 o'clock seam */
  private renderSeamShadow(g: Selection<SVGGElement, unknown, null, undefined>): void {
    // Shadow arc on the START side (just CW of 12 o'clock = angle 0).
    // The END-of-range edge appears to float above, casting a shadow onto January.
    const shadowSpread = 0.18; // ~10 degrees
    g.append('path')
      .attr('d', (this.arcGen as any)
        .innerRadius(CORE_RADIUS).outerRadius(OUTER_RADIUS)
        .startAngle(MIN_ANGLE).endAngle(MIN_ANGLE + shadowSpread)())
      .attr('fill', 'url(#cp-seam-shadow)')
      .attr('pointer-events', 'none');

    // Subtle highlight on the END side (the "elevated" edge, just CCW of 12)
    const highlightSpread = 0.08; // ~4.5 degrees
    g.append('path')
      .attr('d', (this.arcGen as any)
        .innerRadius(CORE_RADIUS).outerRadius(OUTER_RADIUS)
        .startAngle(MAX_ANGLE - highlightSpread).endAngle(MAX_ANGLE)())
      .attr('fill', 'rgba(255,255,255,0.22)')
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
