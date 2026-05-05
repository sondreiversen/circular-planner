import { PlannerData, Activity, Viewport, FilterState, Lane } from './types';
import { parseDate, formatDate } from './utils';
import { getGridSpec } from './viewport';

export type ClickActivityHandler = (activity: Activity) => void;
export type ClickLaneSlotHandler = (laneId: string, date: Date) => void;

const LANE_COL_WIDTH = 160;
const SUB_ROW_HEIGHT = 26;
const ROW_PADDING_Y = 6;
const HEADER_ROW_HEIGHT = 32; // height of a single header row
const HEADER_HEIGHT = HEADER_ROW_HEIGHT; // kept for reference; actual height set dynamically

export class ListRenderer {
  private container: HTMLElement;
  private data: PlannerData;
  private viewport: Viewport;
  private filterState: FilterState;
  private onClickActivity: ClickActivityHandler = () => {};
  private onClickLaneSlot: ClickLaneSlotHandler = () => {};

  private root!: HTMLElement;
  private timelineEl!: HTMLElement;
  private resizeObs: ResizeObserver | null = null;

  constructor(
    container: HTMLElement,
    data: PlannerData,
    viewport: Viewport,
    filterState: FilterState
  ) {
    this.container = container;
    this.data = data;
    this.viewport = viewport;
    this.filterState = filterState;
    this.mount();
  }

  setHandlers(onClickActivity: ClickActivityHandler, onClickLaneSlot: ClickLaneSlotHandler): void {
    this.onClickActivity = onClickActivity;
    this.onClickLaneSlot = onClickLaneSlot;
  }

  update(data: PlannerData, filterState?: FilterState): void {
    this.data = data;
    if (filterState) this.filterState = filterState;
    this.render();
  }

  updateViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.render();
  }

  destroy(): void {
    this.resizeObs?.disconnect();
    this.root.remove();
  }

  private mount(): void {
    this.root = document.createElement('div');
    this.root.className = 'cp-list-view';
    this.container.appendChild(this.root);

    this.resizeObs = new ResizeObserver(() => this.render());
    this.resizeObs.observe(this.root);

    this.render();
  }

  private render(): void {
    this.root.innerHTML = '';

    const visibleLanes = this.data.lanes
      .filter(l => !this.filterState.hiddenLaneIds.has(l.id))
      .sort((a, b) => b.order - a.order); // highest order (outermost) on top, matching sidebar

    const timelineWidth = Math.max(200, this.root.clientWidth - LANE_COL_WIDTH);
    const winStart = this.viewport.windowStart.getTime();
    const winEnd = this.viewport.windowEnd.getTime();
    const winSpan = Math.max(1, winEnd - winStart);
    const dateToX = (d: Date): number => ((d.getTime() - winStart) / winSpan) * timelineWidth;

    // Header: one row for subLabels (e.g. week numbers at Month zoom) when present,
    // plus one row for primary labels (day numbers / month names).
    const grid = getGridSpec(this.viewport);
    const hasSubLabels = !!(grid.subLabels && grid.subLabels.length > 0);
    const totalHeaderHeight = hasSubLabels ? HEADER_ROW_HEIGHT * 2 : HEADER_ROW_HEIGHT;

    const header = document.createElement('div');
    header.className = 'cp-list-header';
    header.style.height = `${totalHeaderHeight}px`;

    const headerLaneCell = document.createElement('div');
    headerLaneCell.className = 'cp-list-lane-cell cp-list-header-cell';
    headerLaneCell.style.width = `${LANE_COL_WIDTH}px`;
    headerLaneCell.style.height = '100%';
    headerLaneCell.textContent = 'Lane';
    header.appendChild(headerLaneCell);

    // Timeline column: stacked rows
    const headerTimelineCol = document.createElement('div');
    headerTimelineCol.className = 'cp-list-header-timeline-col';
    headerTimelineCol.style.width = `${timelineWidth}px`;

    // Sub-label row (week numbers) — only rendered when subLabels are present
    if (hasSubLabels) {
      const subRow = document.createElement('div');
      subRow.className = 'cp-list-header-row';
      subRow.style.height = `${HEADER_ROW_HEIGHT}px`;
      grid.subLabels!.forEach(({ date, text }) => {
        if (date < this.viewport.windowStart || date > this.viewport.windowEnd) return;
        const el = document.createElement('div');
        el.className = 'cp-list-tick-sublabel';
        el.style.left = `${dateToX(date)}px`;
        el.textContent = text;
        subRow.appendChild(el);
      });
      headerTimelineCol.appendChild(subRow);
    }

    // Primary label row (day numbers / month names)
    const primaryRow = document.createElement('div');
    primaryRow.className = 'cp-list-header-row';
    primaryRow.style.height = `${HEADER_ROW_HEIGHT}px`;
    grid.labels.forEach(({ date, text }) => {
      if (date < this.viewport.windowStart || date > this.viewport.windowEnd) return;
      const el = document.createElement('div');
      el.className = 'cp-list-tick-label';
      el.style.left = `${dateToX(date)}px`;
      el.textContent = text;
      primaryRow.appendChild(el);
    });
    headerTimelineCol.appendChild(primaryRow);

    header.appendChild(headerTimelineCol);
    this.root.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'cp-list-body';
    this.root.appendChild(body);

    visibleLanes.forEach((lane, idx) => {
      const { subRows, totalSubRows } = this.assignSubRows(lane);
      const rowHeight = Math.max(1, totalSubRows) * SUB_ROW_HEIGHT + ROW_PADDING_Y * 2;

      const row = document.createElement('div');
      row.className = 'cp-list-lane-row' + (idx % 2 === 0 ? ' even' : ' odd');
      row.style.height = `${rowHeight}px`;

      const laneCell = document.createElement('div');
      laneCell.className = 'cp-list-lane-cell';
      laneCell.style.width = `${LANE_COL_WIDTH}px`;
      laneCell.style.borderLeft = `4px solid ${lane.color || '#ccc'}`;
      laneCell.title = lane.name;
      laneCell.textContent = lane.name;
      row.appendChild(laneCell);

      const timeline = document.createElement('div');
      timeline.className = 'cp-list-timeline';
      timeline.style.width = `${timelineWidth}px`;

      // Grid lines
      grid.majorTicks.forEach((d) => {
        if (d < this.viewport.windowStart || d > this.viewport.windowEnd) return;
        const g = document.createElement('div');
        g.className = 'cp-list-grid major';
        g.style.left = `${dateToX(d)}px`;
        timeline.appendChild(g);
      });
      grid.minorTicks.forEach((d) => {
        if (d < this.viewport.windowStart || d > this.viewport.windowEnd) return;
        const g = document.createElement('div');
        g.className = 'cp-list-grid minor';
        g.style.left = `${dateToX(d)}px`;
        timeline.appendChild(g);
      });

      // Today marker
      const today = new Date();
      if (today >= this.viewport.windowStart && today <= this.viewport.windowEnd) {
        const t = document.createElement('div');
        t.className = 'cp-list-today';
        t.style.left = `${dateToX(today)}px`;
        timeline.appendChild(t);
      }

      // Click empty area → add activity at that date
      timeline.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.cp-list-activity')) return;
        const rect = timeline.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const t = winStart + (x / timelineWidth) * winSpan;
        this.onClickLaneSlot(lane.id, new Date(t));
      });

      // Activities
      const visibleActivities = lane.activities.filter(a => this.passesFilter(a));
      const sortedActs = [...visibleActivities].sort(
        (a, b) => parseDate(a.startDate).getTime() - parseDate(b.startDate).getTime()
      );
      sortedActs.forEach((activity) => {
        const start = parseDate(activity.startDate);
        const end = parseDate(activity.endDate);
        if (end < this.viewport.windowStart || start > this.viewport.windowEnd) return;

        const clampedStart = start < this.viewport.windowStart ? this.viewport.windowStart : start;
        const clampedEnd = end > this.viewport.windowEnd ? this.viewport.windowEnd : end;
        const left = dateToX(clampedStart);
        const width = Math.max(4, dateToX(clampedEnd) - left);
        const subRow = subRows.get(activity.id) ?? 0;

        const box = document.createElement('div');
        box.className = 'cp-list-activity';
        box.style.left = `${left}px`;
        box.style.width = `${width}px`;
        box.style.top = `${ROW_PADDING_Y + subRow * SUB_ROW_HEIGHT}px`;
        box.style.height = `${SUB_ROW_HEIGHT - 4}px`;
        box.style.background = activity.color || '#4c8bf5';
        const recurBadge = activity.recurrence ? ' ↻' : '';
        box.title = `${activity.title}${recurBadge}\n${formatDate(start)} → ${formatDate(end)}${activity.description ? '\n' + activity.description : ''}`;
        box.textContent = activity.title + recurBadge;
        box.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onClickActivity(activity);
        });
        timeline.appendChild(box);
      });

      row.appendChild(timeline);
      body.appendChild(row);
    });

    if (visibleLanes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cp-list-empty';
      empty.textContent = 'No lanes to display.';
      body.appendChild(empty);
    }
  }

  private passesFilter(a: Activity): boolean {
    if (this.filterState.searchTerm &&
        !a.title.toLowerCase().includes(this.filterState.searchTerm)) return false;
    if (this.filterState.activeLabels.size > 0 &&
        !this.filterState.activeLabels.has(a.label)) return false;
    if (this.filterState.activeTaggedUserIds.size > 0) {
      const tagged = a.taggedUsers ?? [];
      if (!tagged.some(u => this.filterState.activeTaggedUserIds.has(u.id))) return false;
    }
    return true;
  }

  private assignSubRows(lane: Lane): { subRows: Map<string, number>; totalSubRows: number } {
    const visible = lane.activities.filter(a => this.passesFilter(a));
    const sorted = [...visible].sort(
      (a, b) => parseDate(a.startDate).getTime() - parseDate(b.startDate).getTime()
    );
    const rowEnds: Date[] = [];
    const subRows = new Map<string, number>();
    sorted.forEach((activity) => {
      const start = parseDate(activity.startDate);
      const row = rowEnds.findIndex(end => end <= start);
      const assigned = row === -1 ? rowEnds.length : row;
      rowEnds[assigned] = parseDate(activity.endDate);
      subRows.set(activity.id, assigned);
    });
    return { subRows, totalSubRows: Math.max(rowEnds.length, 1) };
  }
}
