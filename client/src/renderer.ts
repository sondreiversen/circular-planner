import { select, Selection } from 'd3-selection';
import 'd3-transition'; // extends Selection with .transition()
import { arc as d3Arc } from 'd3-shape';
import { createAngleScale, parseDate, formatDate, xyToAngle } from './utils';
import { PlannerConfig, PlannerData, Lane, Activity, DiscGeometry, Viewport, ZoomLevel, GridSpec, FilterState } from './types';
import { getGridSpec, viewportLabel } from './viewport';

const VIEWBOX_SIZE = 800;
const CX = 400;
const CY = 400;
const OUTER_RADIUS = 350;
const CORE_RADIUS = 55;
const MIN_ANGLE = -(Math.PI / 2);
const MAX_ANGLE = (3 * Math.PI) / 2;

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

    const numLanes = Math.max(this.data.lanes.length, 1);
    const laneWidth = (OUTER_RADIUS - CORE_RADIUS) / numLanes;

    this.geometry = {
      cx: CX,
      cy: CY,
      coreRadius: CORE_RADIUS,
      outerRadius: OUTER_RADIUS,
      laneWidth,
      innerRadiusFn: (order: number) => CORE_RADIUS + order * laneWidth,
      outerRadiusFn: (order: number) => CORE_RADIUS + (order + 1) * laneWidth,
    };
  }

  private fullRender(): void {
    this.svg.selectAll('*').remove();
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

  private renderDefs(): void {
    this.svg.selectAll('defs').remove();
    const defs = this.svg.insert('defs', ':first-child');

    // Disc background: subtle radial gradient
    const bgGrad = defs.append('radialGradient')
      .attr('id', 'cp-bg-grad')
      .attr('cx', '50%').attr('cy', '50%').attr('r', '50%');
    bgGrad.append('stop').attr('offset', '0%').attr('stop-color', '#ffffff');
    bgGrad.append('stop').attr('offset', '100%').attr('stop-color', '#f4f5f7');

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

    // Seam shadow gradient: fades right from 12 o'clock (cast by end-of-range onto start-of-range)
    // The gradient runs in SVG space: from (CX, top) leftward across the seam
    const seamGrad = defs.append('linearGradient')
      .attr('id', 'cp-seam-shadow')
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', CX).attr('y1', CY - OUTER_RADIUS)
      .attr('x2', CX + 40).attr('y2', CY - OUTER_RADIUS);
    seamGrad.append('stop').attr('offset', '0%')
      .attr('stop-color', 'rgba(0,0,0,0.22)');
    seamGrad.append('stop').attr('offset', '100%')
      .attr('stop-color', 'rgba(0,0,0,0)');
  }

  private render(): void {
    this.renderDefs();

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
    g.append('circle')
      .attr('r', OUTER_RADIUS)
      .attr('fill', 'url(#cp-bg-grad)')
      .attr('filter', 'url(#cp-disc-shadow)')
      .attr('stroke', '#d0d4db')
      .attr('stroke-width', 1);
  }

  private renderGrid(g: Selection<SVGGElement, unknown, null, undefined>): void {
    const gridSpec = getGridSpec(this.viewport);
    const gridGroup = g.append('g').attr('class', 'gridlines');

    // Start-of-window line
    const startAngle = MIN_ANGLE;
    gridGroup.append('line')
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', Math.cos(startAngle) * OUTER_RADIUS)
      .attr('y2', Math.sin(startAngle) * OUTER_RADIUS)
      .attr('stroke', '#b0b7c3')
      .attr('stroke-width', 1.5);

    // Minor ticks
    gridSpec.minorTicks.forEach(d => {
      const angle = this.angleScale(d);
      if (angle <= MIN_ANGLE || angle >= MAX_ANGLE) return;
      gridGroup.append('line')
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', Math.cos(angle) * OUTER_RADIUS)
        .attr('y2', Math.sin(angle) * OUTER_RADIUS)
        .attr('stroke', '#e8eaed')
        .attr('stroke-width', 0.5);
    });

    // Major ticks
    gridSpec.majorTicks.forEach(d => {
      const angle = this.angleScale(d);
      if (angle <= MIN_ANGLE || angle >= MAX_ANGLE) return;
      gridGroup.append('line')
        .attr('x1', 0).attr('y1', 0)
        .attr('x2', Math.cos(angle) * OUTER_RADIUS)
        .attr('y2', Math.sin(angle) * OUTER_RADIUS)
        .attr('stroke', '#d5d9e0')
        .attr('stroke-width', 1);
    });

    // Labels around the perimeter
    const labelRadius = OUTER_RADIUS + 20;
    const labelsGroup = g.append('g').attr('class', 'grid-labels');

    gridSpec.labels.forEach(({ date, text }) => {
      const angle = this.angleScale(date);
      if (angle < MIN_ANGLE || angle > MAX_ANGLE) return;

      const lx = Math.cos(angle) * labelRadius;
      const ly = Math.sin(angle) * labelRadius;
      const rotateDeg = (angle * 180 / Math.PI) + 90;

      const fontSize = this.viewport.zoomLevel === ZoomLevel.Month && text.length <= 2 ? '8' : '11';

      labelsGroup.append('text')
        .attr('x', lx)
        .attr('y', ly)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('transform', `rotate(${rotateDeg},${lx},${ly})`)
        .attr('font-size', fontSize)
        .attr('font-family', '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif')
        .attr('fill', '#5f6b7a')
        .text(text);
    });
  }

  private renderLanes(g: Selection<SVGGElement, unknown, null, undefined>): void {
    const sorted = [...this.data.lanes].sort((a, b) => a.order - b.order);
    const arcFull = d3Arc<unknown>()
      .startAngle(MIN_ANGLE)
      .endAngle(MAX_ANGLE);

    sorted.forEach((lane, idx) => {
      const innerR = this.geometry.innerRadiusFn(idx);
      const outerR = this.geometry.outerRadiusFn(idx);
      const isHidden = this.filterState.hiddenLaneIds.has(lane.id);

      const laneGroup = g.append('g')
        .attr('class', 'lane')
        .attr('data-lane-id', lane.id)
        .style('opacity', isHidden ? '0.08' : '1');

      // Lane background ring
      const bgPath = (arcFull as any).innerRadius(innerR).outerRadius(outerR);
      laneGroup.append('path')
        .attr('d', bgPath())
        .attr('fill', lane.color || 'rgba(200,200,200,0.1)')
        .attr('stroke', '#c8cdd6')
        .attr('stroke-width', 0.5)
        .style('cursor', isHidden ? 'default' : 'pointer')
        .on('click', (event: MouseEvent) => {
          if (isHidden) return;
          const rect = (event.target as Element).closest('svg')?.getBoundingClientRect();
          if (!rect) return;
          const svgX = (event.clientX - rect.left) / rect.width * VIEWBOX_SIZE;
          const svgY = (event.clientY - rect.top) / rect.height * VIEWBOX_SIZE;
          const dx = svgX - CX;
          const dy = svgY - CY;
          const angle = xyToAngle(dx, dy);
          const clickedDate = (this.angleScale as any).invert(angle) as Date;
          this.onClickLane(lane.id, clickedDate);
        });

      // Lane name label
      laneGroup.append('text')
        .attr('x', 0)
        .attr('y', -(innerR + 4) - 4)
        .attr('font-size', '9')
        .attr('font-family', '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif')
        .attr('fill', '#6b7280')
        .attr('text-anchor', 'middle')
        .text(lane.name);

      if (!isHidden) {
        // Filter activities by search term
        const visibleActivities = this.filterState.searchTerm
          ? lane.activities.filter(a =>
              a.title.toLowerCase().includes(this.filterState.searchTerm))
          : lane.activities;

        visibleActivities.forEach(activity => {
          this.renderActivity(laneGroup, activity, innerR, outerR);
        });
      }
    });
  }

  private renderActivity(
    laneGroup: Selection<SVGGElement, unknown, null, undefined>,
    activity: Activity,
    innerR: number,
    outerR: number
  ): void {
    const startDate = parseDate(activity.startDate);
    const endDate   = parseDate(activity.endDate);

    if (endDate <= this.viewport.windowStart || startDate >= this.viewport.windowEnd) return;

    let startAngle = this.angleScale(startDate);
    let endAngle   = this.angleScale(endDate);

    startAngle = Math.max(startAngle, MIN_ANGLE);
    endAngle = Math.min(endAngle, MAX_ANGLE);

    if (endAngle <= startAngle) return;

    const arcGen = d3Arc<unknown>()
      .innerRadius(innerR + 2)
      .outerRadius(outerR - 2)
      .startAngle(startAngle)
      .endAngle(endAngle)
      .cornerRadius(3);

    const actGroup = laneGroup.append('g')
      .attr('class', 'activity')
      .attr('data-activity-id', activity.id)
      .style('cursor', 'pointer');

    const pathData = (arcGen as any)();
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
    const textR = (innerR + outerR) / 2;
    const tx = Math.cos(midAngle) * textR;
    const ty = Math.sin(midAngle) * textR;
    const rotateDeg = (midAngle * 180 / Math.PI) + 90;

    const arcSpanDeg = (endAngle - startAngle) * 180 / Math.PI;
    if (arcSpanDeg > 10) {
      actGroup.append('text')
        .attr('x', tx)
        .attr('y', ty)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('transform', `rotate(${rotateDeg},${tx},${ty})`)
        .attr('font-size', '9')
        .attr('font-family', '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif')
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
    // Shadow arc on the START side (just clockwise from 12 o'clock)
    // making the END side appear to float above
    const shadowSpread = 0.13; // ~7.5 degrees
    const shadowArc = d3Arc<unknown>()
      .innerRadius(CORE_RADIUS)
      .outerRadius(OUTER_RADIUS)
      .startAngle(MIN_ANGLE)
      .endAngle(MIN_ANGLE + shadowSpread);

    g.append('path')
      .attr('d', (shadowArc as any)())
      .attr('fill', 'url(#cp-seam-shadow)')
      .attr('pointer-events', 'none');

    // Subtle highlight on the END side (the "elevated" edge)
    const highlightSpread = 0.06; // ~3.5 degrees
    const highlightArc = d3Arc<unknown>()
      .innerRadius(CORE_RADIUS)
      .outerRadius(OUTER_RADIUS)
      .startAngle(MAX_ANGLE - highlightSpread)
      .endAngle(MAX_ANGLE);

    g.append('path')
      .attr('d', (highlightArc as any)())
      .attr('fill', 'rgba(255,255,255,0.18)')
      .attr('pointer-events', 'none');
  }

  private renderTodayIndicator(g: Selection<SVGGElement, unknown, null, undefined>): void {
    const today = new Date();
    if (today < this.viewport.windowStart || today > this.viewport.windowEnd) return;

    const angle = this.angleScale(today);
    g.append('line')
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', Math.cos(angle) * OUTER_RADIUS)
      .attr('y2', Math.sin(angle) * OUTER_RADIUS)
      .attr('stroke', '#f44336')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4,3')
      .attr('opacity', 0.75);

    g.append('circle')
      .attr('cx', Math.cos(angle) * OUTER_RADIUS)
      .attr('cy', Math.sin(angle) * OUTER_RADIUS)
      .attr('r', 4)
      .attr('fill', '#f44336')
      .attr('opacity', 0.75);
  }

  private renderCenterLabel(g: Selection<SVGGElement, unknown, null, undefined>): void {
    g.append('circle')
      .attr('r', CORE_RADIUS - 2)
      .attr('fill', 'white')
      .attr('filter', 'url(#cp-hub-shadow)')
      .attr('stroke', '#d0d4db')
      .attr('stroke-width', 1);

    const label = viewportLabel(this.viewport);
    const titleText = this.config.title;

    g.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', label.length > 10 ? '11' : '15')
      .attr('font-weight', '600')
      .attr('font-family', '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif')
      .attr('fill', '#1a2332')
      .attr('y', titleText ? -8 : 0)
      .text(label);

    if (titleText) {
      const truncated = titleText.length > 14 ? titleText.slice(0, 14) + '…' : titleText;
      g.append('text')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('font-size', '8')
        .attr('font-family', '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif')
        .attr('fill', '#8896a5')
        .attr('y', 8)
        .text(truncated);
    }
  }
}
