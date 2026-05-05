import { PlannerData, Activity, Viewport, FilterState, TaggedUser } from './types';
import { parseDate, formatDate, expandOccurrences, displayName } from './utils';
import { getGridSpec } from './viewport';
import { api } from './api-client';

export type ClickActivityHandler = (activity: Activity) => void;

interface Member {
  id: number;
  username: string;
  fullName?: string;
  role: 'owner' | 'edit' | 'view';
}

type PersonRow = { id: number; username: string; fullName?: string };

const LANE_COL_WIDTH = 160;
const SUB_ROW_HEIGHT = 26;
const ROW_PADDING_Y = 6;
const HEADER_HEIGHT = 32;

export class PeopleRenderer {
  private container: HTMLElement;
  private data: PlannerData;
  private viewport: Viewport;
  private filterState: FilterState;
  private plannerId: number;
  private members: Member[] = [];
  private membersLoaded = false;
  private onClickActivity?: (a: Activity) => void;

  private root!: HTMLElement;
  private resizeObs: ResizeObserver | null = null;

  constructor(
    container: HTMLElement,
    data: PlannerData,
    viewport: Viewport,
    filterState: FilterState,
    plannerId: number
  ) {
    this.container = container;
    this.data = data;
    this.viewport = viewport;
    this.filterState = filterState;
    this.plannerId = plannerId;
    this.mount();
    this.loadMembers();
  }

  setHandlers(onClickActivity: (a: Activity) => void): void {
    this.onClickActivity = onClickActivity;
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
    const allActivities = this.data.lanes.flatMap(l => l.activities);

    // Collect all tagged users across all activities
    const seenIds = new Set<number>();
    const tagged: PersonRow[] = [];
    allActivities.forEach(a => {
      (a.taggedUsers ?? []).forEach(u => {
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

  private assignSubRows(occurrences: Array<{ start: Date; end: Date; activity: Activity; occIdx: number }>): {
    subRowMap: Map<string, number>;
    totalSubRows: number;
  } {
    const sorted = [...occurrences].sort((a, b) => a.start.getTime() - b.start.getTime());
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

    // Header row
    const header = document.createElement('div');
    header.className = 'cp-list-header';
    header.style.height = `${HEADER_HEIGHT}px`;

    const headerLaneCell = document.createElement('div');
    headerLaneCell.className = 'cp-list-lane-cell cp-list-header-cell';
    headerLaneCell.style.width = `${LANE_COL_WIDTH}px`;
    headerLaneCell.textContent = 'Person';
    header.appendChild(headerLaneCell);

    const headerTimeline = document.createElement('div');
    headerTimeline.className = 'cp-list-header-timeline';
    headerTimeline.style.width = `${timelineWidth}px`;

    const grid = getGridSpec(this.viewport);
    grid.labels.forEach(({ date, text }) => {
      if (date < this.viewport.windowStart || date > this.viewport.windowEnd) return;
      const el = document.createElement('div');
      el.className = 'cp-list-tick-label';
      el.style.left = `${dateToX(date)}px`;
      el.textContent = text;
      headerTimeline.appendChild(el);
    });
    header.appendChild(headerTimeline);
    this.root.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'cp-list-body';
    this.root.appendChild(body);

    if (persons.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cp-list-empty';
      empty.textContent = 'No people to display. Tag users in activities or share this planner.';
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
      laneCell.textContent = dn;
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

      // Activity bars (expanded occurrences)
      expandedOccs.forEach((occ) => {
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
        box.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onClickActivity?.(activity);
        });
        timeline.appendChild(box);
      });

      row.appendChild(timeline);
      body.appendChild(row);
    });
  }
}
