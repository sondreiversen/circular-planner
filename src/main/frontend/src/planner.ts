import { PlannerConfig, PlannerData, Lane, Activity, Viewport, FilterState } from './types';
import { Renderer } from './renderer';
import { DataManager } from './data-manager';
import { showActivityDialog, showLaneDialog } from './dialogs';
import { randomId, laneColor, parseDate, formatDate } from './utils';
import { defaultViewport, zoomIn, zoomOut, navigate, canZoomIn, canZoomOut, viewportLabel, navigateToYear, navigateToRange } from './viewport';
import { ZoomLevel } from './types';

/**
 * Main controller for a single circular planner instance.
 * Manages state, coordinates renderer and data-manager.
 */
export class Planner {
  private config: PlannerConfig;
  private data: PlannerData;
  private viewport: Viewport;
  private filterState: FilterState;
  private renderer!: Renderer;
  private dataManager: DataManager;
  private container: HTMLElement;
  private toolbar!: HTMLElement;
  private filterRowVisible = false;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    this.config = {
      plannerId: container.dataset.plannerId || 'default',
      pageId:    container.dataset.pageId    || '0',
      title:     container.dataset.title     || 'Planner',
      startDate: container.dataset.startDate || `${new Date().getFullYear()}-01-01`,
      endDate:   container.dataset.endDate   || `${new Date().getFullYear()}-12-31`,
    };

    const bodyJson = container.dataset.plannerBody || '';
    this.data = this.parseBody(bodyJson);
    this.viewport = defaultViewport(this.config);
    this.filterState = { hiddenLaneIds: new Set(), searchTerm: '' };
    this.dataManager = new DataManager(this.config);

    this.mount();
    this.loadDraft();
  }

  private parseBody(json: string): PlannerData {
    if (!json) return { lanes: [] };
    try {
      const parsed = JSON.parse(json);
      if (parsed && Array.isArray(parsed.lanes)) return parsed;
    } catch { /* ignore */ }
    return { lanes: [] };
  }

  private mount(): void {
    this.container.style.cssText = 'position:relative;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

    this.toolbar = document.createElement('div');
    this.toolbar.className = 'cp-toolbar';
    this.buildToolbar();
    this.container.appendChild(this.toolbar);

    const svgContainer = document.createElement('div');
    svgContainer.className = 'cp-svg-container';
    svgContainer.style.cssText = 'width:100%;max-width:800px;outline:none;';
    svgContainer.tabIndex = 0;
    this.container.appendChild(svgContainer);

    this.renderer = new Renderer(svgContainer, this.config, this.data, this.viewport);
    this.renderer.setHandlers(
      (laneId, date) => this.handleClickLane(laneId, date),
      (activity) => this.handleClickActivity(activity)
    );

    svgContainer.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) this.handleZoomIn();
      else if (e.deltaY > 0) this.handleZoomOut();
    }, { passive: false });

    svgContainer.addEventListener('keydown', (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':  e.preventDefault(); this.handleNavigate(-1); break;
        case 'ArrowRight': e.preventDefault(); this.handleNavigate(1);  break;
        case 'ArrowUp':    e.preventDefault(); this.handleZoomIn();     break;
        case 'ArrowDown':  e.preventDefault(); this.handleZoomOut();    break;
      }
    });
  }

  private buildToolbar(): void {
    this.toolbar.innerHTML = '';
    this.toolbar.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-bottom:10px;';

    // ---- Primary row ----
    const primary = document.createElement('div');
    primary.className = 'cp-toolbar-primary';
    primary.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';

    // Title
    const title = document.createElement('span');
    title.style.cssText = 'font-weight:600;font-size:14px;color:#1a2332;margin-right:4px;';
    title.textContent = this.config.title;
    primary.appendChild(title);

    // Year selector
    const yearSel = document.createElement('select');
    yearSel.className = 'cp-year-select';
    yearSel.title = 'Jump to year';
    const configStartYear = new Date(this.config.startDate).getFullYear();
    const configEndYear   = new Date(this.config.endDate).getFullYear();
    const currentYear = this.viewport.windowStart.getFullYear();
    for (let y = configStartYear - 2; y <= configEndYear + 2; y++) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      if (y === currentYear) opt.selected = true;
      yearSel.appendChild(opt);
    }
    yearSel.addEventListener('change', () => this.handleYearSelect(Number(yearSel.value)));
    primary.appendChild(yearSel);

    // Spacer
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1;';
    primary.appendChild(spacer);

    // Navigation + zoom controls
    const zoomControls = document.createElement('div');
    zoomControls.className = 'cp-zoom-controls';

    const navLeft = document.createElement('button');
    navLeft.textContent = '◀';
    navLeft.title = 'Navigate backward';
    navLeft.className = 'cp-btn';
    navLeft.addEventListener('click', () => this.handleNavigate(-1));
    zoomControls.appendChild(navLeft);

    const vpLabel = document.createElement('span');
    vpLabel.className = 'cp-viewport-label';
    vpLabel.textContent = viewportLabel(this.viewport);
    vpLabel.title = 'Click to zoom out';
    vpLabel.addEventListener('click', () => this.handleZoomOut());
    zoomControls.appendChild(vpLabel);

    const navRight = document.createElement('button');
    navRight.textContent = '▶';
    navRight.title = 'Navigate forward';
    navRight.className = 'cp-btn';
    navRight.addEventListener('click', () => this.handleNavigate(1));
    zoomControls.appendChild(navRight);

    const zoomOutBtn = document.createElement('button');
    zoomOutBtn.textContent = '−';
    zoomOutBtn.title = 'Zoom out';
    zoomOutBtn.className = 'cp-btn';
    zoomOutBtn.disabled = !canZoomOut(this.viewport);
    zoomOutBtn.addEventListener('click', () => this.handleZoomOut());
    zoomControls.appendChild(zoomOutBtn);

    const zoomInBtn = document.createElement('button');
    zoomInBtn.textContent = '+';
    zoomInBtn.title = 'Zoom in';
    zoomInBtn.className = 'cp-btn';
    zoomInBtn.disabled = !canZoomIn(this.viewport);
    zoomInBtn.addEventListener('click', () => this.handleZoomIn());
    zoomControls.appendChild(zoomInBtn);

    primary.appendChild(zoomControls);

    // Filter toggle
    const filterBtn = document.createElement('button');
    filterBtn.textContent = this.filterRowVisible ? '▲ Filter' : '▼ Filter';
    filterBtn.title = 'Toggle filters';
    filterBtn.className = this.filterRowVisible ? 'cp-btn cp-btn-active' : 'cp-btn';
    filterBtn.addEventListener('click', () => {
      this.filterRowVisible = !this.filterRowVisible;
      this.buildToolbar();
    });
    primary.appendChild(filterBtn);

    // Add lane button
    const addLaneBtn = document.createElement('button');
    addLaneBtn.textContent = '+ Lane';
    addLaneBtn.className = 'cp-btn cp-btn-primary';
    addLaneBtn.addEventListener('click', () => this.handleAddLane());
    primary.appendChild(addLaneBtn);

    // Per-lane edit buttons (always visible)
    const sorted = [...this.data.lanes].sort((a, b) => a.order - b.order);
    sorted.forEach(lane => {
      const laneBtn = document.createElement('button');
      laneBtn.textContent = `✎ ${lane.name}`;
      laneBtn.title = `Edit or delete lane: ${lane.name}`;
      laneBtn.className = 'cp-btn';
      laneBtn.addEventListener('click', () => this.handleEditLane(lane));
      primary.appendChild(laneBtn);
    });

    this.toolbar.appendChild(primary);

    // ---- Secondary row (filters + lane management) ----
    if (this.filterRowVisible) {
      const secondary = document.createElement('div');
      secondary.className = 'cp-secondary-row';

      // Search input
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = 'Search activities…';
      searchInput.className = 'cp-filter-input';
      searchInput.value = this.filterState.searchTerm;
      searchInput.addEventListener('input', () => {
        if (this.searchDebounce) clearTimeout(this.searchDebounce);
        this.searchDebounce = setTimeout(() => {
          this.filterState.searchTerm = searchInput.value.toLowerCase().trim();
          this.refresh();
        }, 200);
      });
      secondary.appendChild(searchInput);

      // Separator
      const sep = document.createElement('span');
      sep.style.cssText = 'color:#c8cdd6;margin:0 2px;';
      sep.textContent = '|';
      secondary.appendChild(sep);

      // Lane visibility toggles + edit buttons
      const sorted = [...this.data.lanes].sort((a, b) => a.order - b.order);
      sorted.forEach(lane => {
        const laneRow = document.createElement('label');
        laneRow.className = 'cp-lane-toggle';
        laneRow.title = `Toggle visibility: ${lane.name}`;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !this.filterState.hiddenLaneIds.has(lane.id);
        cb.style.cssText = 'margin:0;cursor:pointer;';
        cb.addEventListener('change', () => this.handleToggleLane(lane.id));

        const dot = document.createElement('span');
        dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${lane.color || '#ccc'};display:inline-block;border:1px solid rgba(0,0,0,0.15);flex-shrink:0;`;

        const nameSpan = document.createElement('span');
        nameSpan.textContent = lane.name;
        nameSpan.style.cssText = `opacity:${this.filterState.hiddenLaneIds.has(lane.id) ? '0.4' : '1'};`;

        laneRow.appendChild(cb);
        laneRow.appendChild(dot);
        laneRow.appendChild(nameSpan);
        secondary.appendChild(laneRow);

        // Edit button for this lane
        const editBtn = document.createElement('button');
        editBtn.textContent = '✎';
        editBtn.title = `Edit lane: ${lane.name}`;
        editBtn.className = 'cp-btn';
        editBtn.style.cssText += 'padding:3px 7px;font-size:11px;';
        editBtn.addEventListener('click', () => this.handleEditLane(lane));
        secondary.appendChild(editBtn);
      });

      // Custom date range
      const rangeSep = document.createElement('span');
      rangeSep.style.cssText = 'color:#c8cdd6;margin:0 2px;';
      rangeSep.textContent = '|';
      secondary.appendChild(rangeSep);

      const rangeLabel = document.createElement('span');
      rangeLabel.style.cssText = 'font-size:11px;color:#6b7280;white-space:nowrap;';
      rangeLabel.textContent = 'Range:';
      secondary.appendChild(rangeLabel);

      const rangeStart = document.createElement('input');
      rangeStart.type = 'date';
      rangeStart.value = formatDate(this.viewport.windowStart);
      rangeStart.className = 'cp-filter-input';
      rangeStart.style.cssText += 'width:130px;';
      secondary.appendChild(rangeStart);

      const rangeTo = document.createElement('span');
      rangeTo.style.cssText = 'font-size:11px;color:#6b7280;';
      rangeTo.textContent = '→';
      secondary.appendChild(rangeTo);

      const rangeEnd = document.createElement('input');
      rangeEnd.type = 'date';
      rangeEnd.value = formatDate(this.viewport.windowEnd);
      rangeEnd.className = 'cp-filter-input';
      rangeEnd.style.cssText += 'width:130px;';
      secondary.appendChild(rangeEnd);

      const applyBtn = document.createElement('button');
      applyBtn.textContent = 'Apply';
      applyBtn.className = 'cp-btn cp-btn-primary';
      applyBtn.addEventListener('click', () => {
        if (!rangeStart.value || !rangeEnd.value) return;
        if (rangeStart.value >= rangeEnd.value) { alert('Start must be before end date.'); return; }
        this.handleCustomRange(parseDate(rangeStart.value), parseDate(rangeEnd.value));
      });
      secondary.appendChild(applyBtn);

      this.toolbar.appendChild(secondary);
    }
  }

  private async loadDraft(): Promise<void> {
    const draft = await this.dataManager.load();
    if (draft && (draft.lanes.length > 0 || this.data.lanes.length === 0)) {
      this.data = draft;
      this.refresh();
    }
  }

  private refresh(): void {
    this.renderer.update(this.data, this.filterState);
    this.buildToolbar();
  }

  private refreshViewport(): void {
    this.renderer.updateViewport(this.viewport);
    this.buildToolbar();
  }

  private save(): void {
    this.dataManager.scheduleSave(this.data);
    this.container.dataset.plannerBody = JSON.stringify(this.data);
  }

  // ==================== Zoom/Nav handlers ====================

  private handleZoomIn(): void {
    const next = zoomIn(this.viewport, this.config);
    if (next === this.viewport) return;
    this.viewport = next;
    this.refreshViewport();
  }

  private handleZoomOut(): void {
    const next = zoomOut(this.viewport, this.config);
    if (next === this.viewport) return;
    this.viewport = next;
    this.refreshViewport();
  }

  private handleNavigate(direction: -1 | 1): void {
    this.viewport = navigate(this.viewport, direction, this.config);
    this.refreshViewport();
  }

  private handleYearSelect(year: number): void {
    this.viewport = navigateToYear(year);
    this.refreshViewport();
  }

  private handleCustomRange(start: Date, end: Date): void {
    this.viewport = navigateToRange(start, end, this.viewport.zoomLevel);
    this.refreshViewport();
  }

  private handleToggleLane(laneId: string): void {
    if (this.filterState.hiddenLaneIds.has(laneId)) {
      this.filterState.hiddenLaneIds.delete(laneId);
    } else {
      this.filterState.hiddenLaneIds.add(laneId);
    }
    this.refresh();
  }

  // ==================== Activity/Lane handlers ====================

  private handleClickLane(laneId: string, date: Date): void {
    const lane = this.data.lanes.find(l => l.id === laneId);
    if (!lane) return;
    showActivityDialog(laneId, this.data.lanes, date, null,
      (activity) => this.addActivity(activity), () => {});
  }

  private handleClickActivity(activity: Activity): void {
    showActivityDialog(activity.laneId, this.data.lanes, parseDate(activity.startDate), activity,
      (updated) => this.updateActivity(updated), (id) => this.deleteActivity(id));
  }

  private handleAddLane(): void {
    showLaneDialog(null, this.data.lanes.length,
      (lane) => this.addLane(lane), () => {});
  }

  private handleEditLane(lane: Lane): void {
    showLaneDialog(lane, lane.order,
      (updated) => this.updateLane(updated), (id) => this.deleteLane(id));
  }

  // ==================== State mutations ====================

  private addActivity(activity: Activity): void {
    const lane = this.data.lanes.find(l => l.id === activity.laneId);
    if (lane) { lane.activities.push(activity); this.save(); this.refresh(); }
  }

  private updateActivity(updated: Activity): void {
    for (const lane of this.data.lanes) {
      const idx = lane.activities.findIndex(a => a.id === updated.id);
      if (idx !== -1) { lane.activities.splice(idx, 1); break; }
    }
    const targetLane = this.data.lanes.find(l => l.id === updated.laneId);
    if (targetLane) targetLane.activities.push(updated);
    this.save();
    this.refresh();
  }

  private deleteActivity(activityId: string): void {
    for (const lane of this.data.lanes) {
      const idx = lane.activities.findIndex(a => a.id === activityId);
      if (idx !== -1) { lane.activities.splice(idx, 1); break; }
    }
    this.save();
    this.refresh();
  }

  private addLane(lane: Lane): void {
    if (!lane.color) lane.color = laneColor(lane.order);
    this.data.lanes.push(lane);
    this.save();
    this.refresh();
  }

  private updateLane(updated: Lane): void {
    const idx = this.data.lanes.findIndex(l => l.id === updated.id);
    if (idx !== -1) {
      updated.activities = this.data.lanes[idx].activities;
      this.data.lanes[idx] = updated;
      this.save();
      this.refresh();
    }
  }

  private deleteLane(laneId: string): void {
    this.data.lanes = this.data.lanes.filter(l => l.id !== laneId);
    this.data.lanes.sort((a, b) => a.order - b.order).forEach((l, i) => l.order = i);
    this.save();
    this.refresh();
  }
}
