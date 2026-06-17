import { PlannerData, Activity, Viewport, FilterState, Lane, PlannerConfig } from './types';
import { parseDate, formatDate } from './utils';
import { getGridSpec } from './viewport';
import { attachLinearDrag } from './pointer-drag';

export type ClickActivityHandler = (activity: Activity) => void;
export type ClickLaneSlotHandler = (laneId: string, date: Date) => void;
export type DragCommitHandler = (activity: Activity, newStart: Date, newEnd: Date, newLaneId: string) => void;

const LANE_COL_WIDTH = 200;
const SUB_ROW_HEIGHT = 26;
const ROW_PADDING_Y = 6;
const HEADER_ROW_HEIGHT = 32; // height of a single header row
const HEADER_HEIGHT = HEADER_ROW_HEIGHT; // kept for reference; actual height set dynamically

export class ListRenderer {
  private container: HTMLElement;
  private data: PlannerData;
  private viewport: Viewport;
  private filterState: FilterState;
  private config: PlannerConfig;
  private onClickActivity: ClickActivityHandler = () => {};
  private onClickLaneSlot: ClickLaneSlotHandler = () => {};
  private onDragCommit: DragCommitHandler | null = null;

  private root!: HTMLElement;
  private timelineEl!: HTMLElement;
  private resizeObs: ResizeObserver | null = null;

  constructor(
    container: HTMLElement,
    data: PlannerData,
    viewport: Viewport,
    filterState: FilterState,
    config: PlannerConfig
  ) {
    this.container = container;
    this.data = data;
    this.viewport = viewport;
    this.filterState = filterState;
    this.config = config;
    this.mount();
  }

  setHandlers(onClickActivity: ClickActivityHandler, onClickLaneSlot: ClickLaneSlotHandler): void {
    this.onClickActivity = onClickActivity;
    this.onClickLaneSlot = onClickLaneSlot;
  }

  setDragCommitHandler(fn: DragCommitHandler | null): void {
    this.onDragCommit = fn;
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
      const laneName = document.createElement('span');
      laneName.className = 'cp-list-lane-name';
      laneName.textContent = lane.name;
      laneCell.appendChild(laneName);
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

      // Activities — render regular bars first, milestones last so they appear on top
      const visibleActivities = lane.activities.filter(a => this.passesFilter(a));
      const sortedActs = [...visibleActivities].sort(
        (a, b) => parseDate(a.startDate).getTime() - parseDate(b.startDate).getTime()
      );
      const regular = sortedActs.filter(a => !a.isMilestone);
      const milestones = sortedActs.filter(a => a.isMilestone);

      regular.forEach((activity) => {
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

        const isDraggable =
          !activity.isMilestone &&
          !(activity.recurrence && activity.recurrence.type !== 'none') &&
          this.config.permission !== 'view' &&
          this.onDragCommit !== null;

        if (isDraggable) box.classList.add('cp-list-activity--draggable');

        const wasDragged = isDraggable
          ? attachLinearDrag({
              box, timeline, timelineWidth,
              windowStart: this.viewport.windowStart,
              windowEnd:   this.viewport.windowEnd,
              plannerStart: parseDate(this.config.startDate),
              plannerEnd:   parseDate(this.config.endDate),
              dateToX,
              getOriginalDates: () => ({
                start: parseDate(activity.startDate),
                end:   parseDate(activity.endDate),
              }),
              onCommit: (ns, ne) => this.onDragCommit!(activity, ns, ne, activity.laneId),
            })
          : () => false;

        box.addEventListener('click', (e) => {
          if (wasDragged()) return;
          e.stopPropagation();
          this.onClickActivity(activity);
        });
        timeline.appendChild(box);
      });

      milestones.forEach((activity) => {
        const start = parseDate(activity.startDate);
        if (start > this.viewport.windowEnd || start < this.viewport.windowStart) return;

        const subRow = subRows.get(activity.id) ?? 0;
        const xCenter = dateToX(start);
        const topCenter = ROW_PADDING_Y + subRow * SUB_ROW_HEIGHT + (SUB_ROW_HEIGHT - 14) / 2;
        const recurBadge = activity.recurrence ? ' ↻' : '';
        const tooltipText = `${activity.title}${recurBadge}\n${formatDate(start)}${activity.description ? '\n' + activity.description : ''}`;

        // Diamond shape
        const diamond = document.createElement('div');
        diamond.className = 'cp-list-activity cp-list-activity--milestone';
        diamond.style.left = `${xCenter - 7}px`;
        diamond.style.top = `${topCenter}px`;
        diamond.style.background = activity.color || '#4c8bf5';
        diamond.title = tooltipText;
        diamond.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onClickActivity(activity);
        });
        timeline.appendChild(diamond);

        // Label to the right of the diamond
        const label = document.createElement('span');
        label.className = 'cp-list-activity--milestone-label';
        label.style.left = `${xCenter + 10}px`;
        label.style.top = `${topCenter}px`;
        label.textContent = activity.title + recurBadge;
        label.title = tooltipText;
        label.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onClickActivity(activity);
        });
        timeline.appendChild(label);
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
      if (!tagged.some(u => u.id != null && this.filterState.activeTaggedUserIds.has(u.id))) return false;
    }
    return true;
  }

  private assignSubRows(lane: Lane): { subRows: Map<string, number>; totalSubRows: number } {
    // Milestones are excluded from layout — they don't consume a row slot and
    // are rendered on top of existing bars with z-index 3.
    const visible = lane.activities.filter(a => this.passesFilter(a) && !a.isMilestone);
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
