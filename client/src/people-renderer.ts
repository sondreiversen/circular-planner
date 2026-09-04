import { PlannerData, Activity, Viewport, FilterState, TaggedUser, PlannerConfig } from './types';
import { parseDate, formatDate, expandOccurrences, displayName, addDays } from './utils';
import { getGridSpec } from './viewport';
import { api } from './api-client';
import { attachLinearDrag } from './pointer-drag';
import { now } from './clock';
import { availabilityFor, hiddenBlockingActivities, freeWindows, partitionBySpan } from './availability';

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
const BAND_HEIGHT = 34;       // the availability summary row under the people

export class PeopleRenderer {
  private container: HTMLElement;
  private data: PlannerData;
  private viewport: Viewport;
  private filterState: FilterState;
  private config: PlannerConfig;
  private plannerId: number;
  private members: Member[] = [];
  private membersLoaded = false;
  private publicView = false;
  /**
   * Selected person ids that matched neither a planner member nor a tagged
   * user, so no row could be drawn for them. Recomputed on every render.
   */
  private unresolvedPersonIds: number[] = [];
  private onClickActivity?: (a: Activity) => void;
  private onDragCommit: DragCommitHandler | null = null;
  private onCreateFromBand:
    ((start: Date, end: Date, freeIds: number[], busyIds: number[]) => void) | null = null;

  private root!: HTMLElement;
  private resizeObs: ResizeObserver | null = null;

  constructor(
    container: HTMLElement,
    data: PlannerData,
    viewport: Viewport,
    filterState: FilterState,
    plannerId: number,
    config: PlannerConfig,
    publicView = false,
  ) {
    this.container = container;
    this.data = data;
    this.viewport = viewport;
    this.filterState = filterState;
    this.config = config;
    this.plannerId = plannerId;
    this.publicView = publicView;
    this.mount();
    // /members is authenticated. On the public view it 401s, and api-client
    // turns a 401 into a full-page redirect to login. See Planner.publicView.
    if (!publicView) this.loadMembers();
  }

  setHandlers(onClickActivity: (a: Activity) => void): void {
    this.onClickActivity = onClickActivity;
  }

  /** Create from a stretch of the availability band: (start, end, freeIds, busyIds). */
  setCreateFromBandHandler(
    fn: ((start: Date, end: Date, freeIds: number[], busyIds: number[]) => void) | null,
  ): void {
    this.onCreateFromBand = fn;
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
      const unresolved: number[] = [];
      this.filterState.selectedPeopleIds.forEach(id => {
        // Prefer the member record (has the authoritative display name); fall back to tagged.
        const member = this.members.find(m => m.id === id);
        if (member) {
          rows.push({ id: member.id, username: member.username, fullName: member.fullName });
          return;
        }
        const tagged = taggedById.get(id);
        if (tagged) { rows.push(tagged); return; }
        // Neither a member nor tagged anywhere: there is no name to draw. Record
        // it so the view can say so instead of quietly shrinking the selection.
        unresolved.push(id);
      });
      this.unresolvedPersonIds = unresolved;

      rows.sort((a, b) => displayName(a).localeCompare(displayName(b)));
      return rows;
    }

    // Default behaviour: union of tagged users across activities + members.
    // Nothing can be unresolved here — the rows ARE the union.
    this.unresolvedPersonIds = [];
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
      this.renderUnresolvedNote(body);
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
        const { occurrences: occs } = expandOccurrences(activity, this.viewport.windowStart, this.viewport.windowEnd);
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
      const today = now();
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
        // Cancelled work does not block a window (see availability.ts), so it
        // must not LOOK like it does. Without this a cancelled box sits at full
        // strength inside a stretch the availability band calls free.
        if (activity.status === 'cancelled') box.classList.add('cp-list-activity--cancelled');
        box.style.left = `${left}px`;
        box.style.width = `${width}px`;
        box.style.top = `${ROW_PADDING_Y + subRow * SUB_ROW_HEIGHT}px`;
        box.style.height = `${SUB_ROW_HEIGHT - 4}px`;
        box.style.background = activity.color || '#4c8bf5';
        box.style.borderLeft = `4px solid ${laneColor}`;
        const recurBadge = activity.recurrence ? ' ↻' : '';
        // Status only when it is not the default, matching the disc's tooltip.
        // Without this a cancelled activity carries no textual sign that it is
        // cancelled — the styling alone is not readable on a four-pixel box.
        const statusNote = activity.status && activity.status !== 'planned'
          ? `\nStatus: ${activity.status}` : '';
        box.title = `${activity.title}${recurBadge}\n${formatDate(start)} → ${formatDate(end)}${statusNote}${activity.description ? '\n' + activity.description : ''}`;
        box.textContent = activity.title + recurBadge;

        const isDraggable =
          !activity.isMilestone &&
          !activity.recurrence &&
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

    this.renderAvailabilityBand(body, persons, allActivities, timelineWidth, dateToX);
    this.renderUnresolvedNote(body);
  }

  /**
   * Say when a selected person could not be shown, instead of quietly dropping them.
   *
   * selectedPeopleIds round-trips through the URL as `sp=` (url-state.ts), so a
   * shared link carries a selection made against a different set of people. Any
   * id that matches neither a planner member nor a tagged user used to be
   * discarded with no signal at all: the recipient saw "Free of 3" for a link
   * that selected five, with nothing to suggest the answer was about a smaller
   * group than the sender meant. That is the availability band's denominator
   * being silently wrong on the feature's primary sharing path.
   *
   * The message waits for the member list. Before it arrives, an id that will
   * resolve perfectly well looks unresolvable, and saying so would be a
   * transient lie on every single load. On the public view the list never
   * arrives at all — /members is authenticated — so there the shortfall is
   * reported without claiming to know why.
   */
  private renderUnresolvedNote(body: HTMLElement): void {
    const n = this.unresolvedPersonIds.length;
    if (n === 0) return;
    if (!this.publicView && !this.membersLoaded) return; // still loading; not yet a fact

    const note = document.createElement('div');
    note.className = 'cp-availability-note cp-unresolved-note';
    const people = `${n} selected ${n === 1 ? 'person' : 'people'}`;
    note.textContent = this.publicView
      ? `${people} from this link could not be shown here, so any availability below covers the rest.`
      : `${people} from this link ${n === 1 ? 'is' : 'are'} not in this planner and ${n === 1 ? 'is' : 'are'} not shown. Availability covers the rest.`;
    note.title = `Unresolved ids: ${this.unresolvedPersonIds.join(', ')}`;
    body.appendChild(note);
  }

  /**
   * Hand a clicked stretch up to the planner, split into who is free and who is not.
   *
   * The split is the whole point. Tagging everyone would knowingly double-book
   * the busy ones and make the planner assert something false; tagging only the
   * free ones would silently drop people the user deliberately selected. The
   * caller prefills the free ones and offers the rest with their clashes named.
   */
  private createFromBand(
    start: Date,
    end: Date,
    personIds: number[],
    allActivities: Activity[],
  ): void {
    if (!this.onCreateFromBand) return;
    const split = partitionBySpan(allActivities, personIds, { start, end });
    this.onCreateFromBand(
      start,
      end,
      split.filter(p => p.free).map(p => p.personId),
      split.filter(p => !p.free).map(p => p.personId),
    );
  }

  /**
   * The availability summary row: how many of the people above are free each day.
   *
   * A COUNT rather than a boolean. Simulated on block-structured schedules over a
   * 92-day window, "everyone free for three days" succeeds 2% of the time for
   * four people at 60% occupancy and 0% for six, so a strict band would be empty
   * almost always for the group sizes this exists for. It also throws away what
   * the real conversation runs on: "can we do it when five of the six are free
   * and catch Bo up after?"
   *
   * The denominator is exactly the rows drawn above, so the viewer can always
   * see what the count is out of.
   */
  private renderAvailabilityBand(
    body: HTMLElement,
    persons: PersonRow[],
    allActivities: Activity[],
    timelineWidth: number,
    dateToX: (d: Date) => number,
  ): void {
    if (persons.length === 0) return;

    const window = { start: this.viewport.windowStart, end: this.viewport.windowEnd };
    const personIds = persons.map(p => p.id);

    // UNFILTERED on purpose. passesFilter drops activities by search term, label,
    // hidden lane and tagged user, so honouring it here would mean typing
    // "workshop" into the search box marks everyone free. A filter is a viewing
    // preference, not a statement about what exists.
    const free = availabilityFor(allActivities, personIds, window);

    // Same gate the drag affordance uses: reading the band is useful in a
    // view-only planner, creating from it is not.
    const canCreate = this.config.permission !== 'view' && this.onCreateFromBand !== null;

    const row = document.createElement('div');
    // cp-list-lane-row carries the flex layout the timeline needs a height from.
    row.className = 'cp-list-lane-row cp-availability-row';
    row.style.height = `${BAND_HEIGHT}px`;

    const labelCell = document.createElement('div');
    labelCell.className = 'cp-list-lane-cell cp-availability-label';
    labelCell.style.width = `${LANE_COL_WIDTH}px`;
    labelCell.textContent = free.truncated ? 'Availability —' : `Free of ${persons.length}`;
    row.appendChild(labelCell);

    const timeline = document.createElement('div');
    timeline.className = 'cp-list-timeline cp-availability-timeline';
    timeline.style.width = `${timelineWidth}px`;

    if (free.truncated) {
      // Refusing to answer is the whole point. The occurrences the expansion
      // never emitted do not read as "unknown" downstream, they read as
      // "nothing scheduled", so a band drawn from truncated counts would show a
      // confidently wrong stretch of green.
      const warn = document.createElement('div');
      warn.className = 'cp-availability-warning';
      warn.textContent = 'Range too large to compute availability — narrow the date range.';
      timeline.appendChild(warn);
      row.appendChild(timeline);
      body.appendChild(row);
      return;
    }

    // All-free stretches, highlighted behind the per-day cells.
    freeWindows(free, window, persons.length, 1).forEach(w => {
      const seg = document.createElement('div');
      seg.className = 'cp-availability-allfree';
      const left = dateToX(w.start);
      seg.style.left = `${left}px`;
      seg.style.width = `${Math.max(2, dateToX(addDays(w.end, 1)) - left)}px`;
      seg.title = `Everyone free: ${formatDate(w.start)} → ${formatDate(w.end)}`;
      if (canCreate) {
        // pointer-events is off by default so the segment does not swallow the
        // per-day cells underneath; turn it on only when it is actionable.
        seg.style.pointerEvents = 'auto';
        seg.classList.add('cp-availability-clickable');
        seg.addEventListener('click', () => this.createFromBand(w.start, w.end, personIds, allActivities));
      }
      timeline.appendChild(seg);
    });

    // One cell per day, shaded by how many people are free.
    free.counts.forEach((count, i) => {
      const dayStart = addDays(this.viewport.windowStart, i);
      const left = dateToX(dayStart);
      const width = dateToX(addDays(dayStart, 1)) - left;
      if (width <= 0) return;

      const cell = document.createElement('div');
      cell.className = 'cp-availability-cell';
      cell.style.left = `${left}px`;
      cell.style.width = `${Math.max(1, width)}px`;
      // Opacity carries the count so the eye reads density rather than digits;
      // the number is drawn too whenever the cell is wide enough for it.
      const ratio = persons.length > 0 ? count / persons.length : 0;
      cell.style.setProperty('--cp-free-ratio', String(ratio));
      if (count === persons.length) cell.classList.add('cp-availability-cell--all');
      if (count === 0) cell.classList.add('cp-availability-cell--none');
      if (width >= 14) cell.textContent = String(count);
      cell.title = canCreate
        ? `${formatDate(dayStart)}: ${count} of ${persons.length} free — click to create here`
        : `${formatDate(dayStart)}: ${count} of ${persons.length} free`;
      if (canCreate) {
        cell.classList.add('cp-availability-clickable');
        cell.addEventListener('click', () => this.createFromBand(dayStart, dayStart, personIds, allActivities));
      }
      timeline.appendChild(cell);
    });

    row.appendChild(timeline);
    body.appendChild(row);

    // The band is computed over everything, so it disagrees with the rows
    // whenever a filter is active. Say so rather than leaving the viewer to
    // notice a contradiction and distrust both.
    const hidden = hiddenBlockingActivities(
      allActivities, a => this.passesFilter(a), personIds, window,
    );
    if (hidden.length > 0) {
      const note = document.createElement('div');
      note.className = 'cp-availability-note';
      note.textContent = `Availability includes ${hidden.length} activit${hidden.length === 1 ? 'y' : 'ies'} hidden by the current filter.`;
      note.title = hidden.map(a => a.title).join('\n');
      body.appendChild(note);
    }
  }
}
