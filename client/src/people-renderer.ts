import { PlannerData, Activity, Viewport, FilterState, TaggedUser, PlannerConfig } from './types';
import { parseDate, formatDate, expandOccurrences, displayName } from './utils';
import { getGridSpec } from './viewport';
import { api } from './api-client';
import { attachLinearDrag } from './pointer-drag';

export type DragCommitHandler = (activity: Activity, newStart: Date, newEnd: Date, newLaneId: string) => void;

export type ClickActivityHandler = (activity: Activity) => void;

interface Member {
  id: number;
  username: string;
  fullName?: string;
  role: 'owner' | 'edit' | 'view';
}

type PersonRow = { id: number; username: string; fullName?: string };

const LANE_COL_WIDTH = 200;
const SUB_ROW_HEIGHT = 26;
const ROW_PADDING_Y = 6;
const HEADER_ROW_HEIGHT = 32; // height of a single header row

export class PeopleRenderer {
  private container: HTMLElement;
  private data: PlannerData;
  private viewport: Viewport;
  private filterState: FilterState;
  private config: PlannerConfig;
  private plannerId: number;
  private members: Member[] = [];
  private membersLoaded = false;
  private onClickActivity?: (a: Activity) => void;
  private onDragCommit: DragCommitHandler | null = null;

  private root!: HTMLElement;
  private resizeObs: ResizeObserver | null = null;

  constructor(
    container: HTMLElement,
    data: PlannerData,
    viewport: Viewport,
    filterState: FilterState,
    plannerId: number,
    config: PlannerConfig
  ) {
    this.container = container;
    this.data = data;
    this.viewport = viewport;
    this.filterState = filterState;
    this.config = config;
    this.plannerId = plannerId;
    this.mount();
    this.loadMembers();
  }

  setHandlers(onClickActivity: (a: Activity) => void): void {
    this.onClickActivity = onClickActivity;
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

  private async loadMembers(): Promise<void> {
    try {
      this.members = await api.get<Member[]>(`/api/planners/${this.plannerId}/members`);
      this.membersLoaded = true;
      this.render();
    } catch (e) {
      console.error('Failed to load planner members', e);
      this.membersLoaded = true;
      this.render();
    }
  }

  private buildPersonRows(): PersonRow[] {
    // If a manual selection is active, show exactly those people.
    if (this.filterState.selectedPeopleIds.size > 0) {
      const allActivities = this.data.lanes.flatMap(l => l.activities);

      // Build a fallback lookup from tagged users scraped from activities.
      const taggedById = new Map<number, PersonRow>();
      allActivities.forEach(a => {
        (a.taggedUsers ?? []).forEach(u => {
          if (u.id != null && !taggedById.has(u.id)) {
            taggedById.set(u.id, { id: u.id, username: u.username, fullName: u.fullName });
          }
        });
      });

      const rows: PersonRow[] = [];
      this.filterState.selectedPeopleIds.forEach(id => {
        // Prefer the member record (has the authoritative display name); fall back to tagged.
        const member = this.members.find(m => m.id === id);
        if (member) {
          rows.push({ id: member.id, username: member.username, fullName: member.fullName });
        } else {
          const tagged = taggedById.get(id);
          if (tagged) rows.push(tagged);
        }
      });

      rows.sort((a, b) => displayName(a).localeCompare(displayName(b)));
      return rows;
    }

    // Default behaviour: union of tagged users across activities + members.
    const allActivities = this.data.lanes.flatMap(l => l.activities);

    const seenIds = new Set<number>();
    const tagged: PersonRow[] = [];
    allActivities.forEach(a => {
      (a.taggedUsers ?? []).forEach(u => {
        if (u.id == null) return; // pending tags have no id; skip from people view
        if (!seenIds.has(u.id)) {
          seenIds.add(u.id);
          tagged.push({ id: u.id, username: u.username, fullName: u.fullName });
        }
      });
    });

    // Union with members (members may already be in tagged)
    this.members.forEach(m => {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        tagged.push({ id: m.id, username: m.username, fullName: m.fullName });
      }
    });

    // Sort by display name
    tagged.sort((a, b) => {
      const na = displayName(a);
      const nb = displayName(b);
      return na.localeCompare(nb);
    });

    return tagged;
  }

  private passesFilter(a: Activity): boolean {
    if (this.filterState.hiddenLaneIds.has(a.laneId)) return false;
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

  private assignSubRows(occurrences: Array<{ start: Date; end: Date; activity: Activity; occIdx: number }>): {
    subRowMap: Map<string, number>;
    totalSubRows: number;
  } {
    // Milestones are excluded from layout — they don't consume a row slot and
    // are rendered on top (z-index 3) with their own pass.
    const sorted = [...occurrences]
      .filter(occ => !occ.activity.isMilestone)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const rowEnds: Date[] = [];
    const subRowMap = new Map<string, number>();
    sorted.forEach(occ => {
      const row = rowEnds.findIndex(end => end <= occ.start);
      const assigned = row === -1 ? rowEnds.length : row;
      rowEnds[assigned] = occ.end;
      subRowMap.set(`${occ.activity.id}:${occ.occIdx}`, assigned);
    });
    return { subRowMap, totalSubRows: Math.max(rowEnds.length, 1) };
  }

  private render(): void {
    this.root.innerHTML = '';

    const persons = this.buildPersonRows();
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
    headerLaneCell.textContent = 'Person';
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

    if (persons.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cp-list-empty';
      // Different copy depending on whether the picker is in use. If the user
      // has explicitly cleared the picker, the right hint is "you're in manual
      // mode, pick someone" — not "tag users."
      empty.textContent = this.filterState.selectedPeopleIds.size > 0
        ? 'No selected people to display. Open "Visible people" in the sidebar to add some, or Clear to fall back to auto mode.'
        : 'No people to display. Use the "Visible people" picker in the sidebar to choose who appears here, or tag users in activities.';
      body.appendChild(empty);
      return;
    }

    const allActivities = this.data.lanes.flatMap(l => l.activities);

    persons.forEach((person, idx) => {
      // Collect activities tagged to this person, passing global filter
      const personActivities = allActivities.filter(a => {
        if (!this.passesFilter(a)) return false;
        return (a.taggedUsers ?? []).some(u => u.id === person.id);
      });

      // Expand occurrences for each activity
      const expandedOccs: Array<{ start: Date; end: Date; activity: Activity; occIdx: number }> = [];
      personActivities.forEach(activity => {
        const occs = expandOccurrences(activity, this.viewport.windowStart, this.viewport.windowEnd);
        occs.forEach((occ, occIdx) => {
          expandedOccs.push({ start: occ.start, end: occ.end, activity, occIdx });
        });
      });

      const { subRowMap, totalSubRows } = this.assignSubRows(expandedOccs);
      const rowHeight = Math.max(1, totalSubRows) * SUB_ROW_HEIGHT + ROW_PADDING_Y * 2;

      const row = document.createElement('div');
      row.className = 'cp-list-lane-row' + (idx % 2 === 0 ? ' even' : ' odd');
      row.style.height = `${rowHeight}px`;

      const laneCell = document.createElement('div');
      laneCell.className = 'cp-list-lane-cell';
      laneCell.style.width = `${LANE_COL_WIDTH}px`;
      const dn = displayName(person);
      laneCell.title = dn;
      const nameSpan = document.createElement('span');
      nameSpan.className = 'cp-list-lane-name';
      nameSpan.textContent = dn;
      laneCell.appendChild(nameSpan);
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

      // Activity bars (expanded occurrences) — regular bars first, milestones last so they appear on top
      const regularOccs = expandedOccs.filter(occ => !occ.activity.isMilestone);
      const milestoneOccs = expandedOccs.filter(occ => occ.activity.isMilestone);

      regularOccs.forEach((occ) => {
        const { start, end, activity, occIdx } = occ;
        const clampedStart = start < this.viewport.windowStart ? this.viewport.windowStart : start;
        const clampedEnd = end > this.viewport.windowEnd ? this.viewport.windowEnd : end;
        const left = dateToX(clampedStart);
        const width = Math.max(4, dateToX(clampedEnd) - left);
        const subRow = subRowMap.get(`${activity.id}:${occIdx}`) ?? 0;

        const lane = this.data.lanes.find(l => l.id === activity.laneId);
        const laneColor = lane?.color || '#ccc';

        const box = document.createElement('div');
        box.className = 'cp-list-activity';
        box.style.left = `${left}px`;
        box.style.width = `${width}px`;
        box.style.top = `${ROW_PADDING_Y + subRow * SUB_ROW_HEIGHT}px`;
        box.style.height = `${SUB_ROW_HEIGHT - 4}px`;
        box.style.background = activity.color || '#4c8bf5';
        box.style.borderLeft = `4px solid ${laneColor}`;
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
          this.onClickActivity?.(activity);
        });
        timeline.appendChild(box);
      });

      milestoneOccs.forEach((occ) => {
        const { start, activity, occIdx } = occ;
        if (start > this.viewport.windowEnd || start < this.viewport.windowStart) return;

        const subRow = subRowMap.get(`${activity.id}:${occIdx}`) ?? 0;
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
          this.onClickActivity?.(activity);
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
          this.onClickActivity?.(activity);
        });
        timeline.appendChild(label);
      });

      row.appendChild(timeline);
      body.appendChild(row);
    });
  }
}
