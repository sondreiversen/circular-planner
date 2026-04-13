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
  private sidebarCollapsed = false;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;

  // Refs to toolbar elements that change on viewport updates
  private vpLabelEl!: HTMLSpanElement;
  private yearSelEl!: HTMLSelectElement;
  private zoomOutBtnEl!: HTMLButtonElement;
  private zoomInBtnEl!: HTMLButtonElement;

  constructor(container: HTMLElement, config: PlannerConfig, initialData: PlannerData) {
    this.container = container;
    this.config = config;
    this.data = initialData;
    this.viewport = defaultViewport(this.config);
    this.filterState = { hiddenLaneIds: new Set(), searchTerm: '' };
    this.dataManager = new DataManager(this.config);

    // Restore sidebar collapsed state
    this.sidebarCollapsed = localStorage.getItem('cp_sidebar_collapsed') === 'true';

    this.mount();
  }

  private mount(): void {
    this.container.style.cssText = 'position:relative;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;height:100%;';

    this.toolbar = document.createElement('div');
    this.toolbar.className = 'cp-toolbar';
    this.buildToolbar();
    this.container.appendChild(this.toolbar);

    // Page body: sidebar + disc
    const pageBody = document.createElement('div');
    pageBody.className = 'cp-page-body';
    this.container.appendChild(pageBody);

    // Sidebar
    const sidebar = document.createElement('aside');
    sidebar.className = 'cp-sidebar' + (this.sidebarCollapsed ? ' collapsed' : '');
    sidebar.id = 'cp-sidebar';
    pageBody.appendChild(sidebar);

    const sidebarToggle = document.createElement('button');
    sidebarToggle.className = 'cp-sidebar-toggle';
    sidebarToggle.title = this.sidebarCollapsed ? 'Expand filters' : 'Collapse filters';
    sidebarToggle.textContent = this.sidebarCollapsed ? '›' : '‹';
    sidebarToggle.addEventListener('click', () => {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      sidebar.classList.toggle('collapsed', this.sidebarCollapsed);
      sidebarToggle.textContent = this.sidebarCollapsed ? '›' : '‹';
      sidebarToggle.title = this.sidebarCollapsed ? 'Expand filters' : 'Collapse filters';
      localStorage.setItem('cp_sidebar_collapsed', String(this.sidebarCollapsed));
    });
    sidebar.appendChild(sidebarToggle);

    const sidebarBody = document.createElement('div');
    sidebarBody.className = 'cp-sidebar-body';
    sidebar.appendChild(sidebarBody);
    this.buildSidebar(sidebarBody);

    // Main disc area
    const mainArea = document.createElement('div');
    mainArea.className = 'cp-disc-area';
    pageBody.appendChild(mainArea);

    const svgContainer = document.createElement('div');
    svgContainer.className = 'cp-svg-container';
    svgContainer.tabIndex = 0;
    mainArea.appendChild(svgContainer);

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

  private buildSidebar(body: HTMLElement): void {
    body.innerHTML = '';

    // Section: Search
    const searchSection = document.createElement('div');
    searchSection.className = 'cp-sidebar-section';

    const searchLabel = document.createElement('div');
    searchLabel.className = 'cp-sidebar-label';
    searchLabel.textContent = 'Search';
    searchSection.appendChild(searchLabel);

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search activities…';
    searchInput.className = 'cp-filter-input cp-filter-input--full';
    searchInput.value = this.filterState.searchTerm;
    searchInput.addEventListener('input', () => {
      if (this.searchDebounce) clearTimeout(this.searchDebounce);
      this.searchDebounce = setTimeout(() => {
        this.filterState.searchTerm = searchInput.value.toLowerCase().trim();
        this.renderer.update(this.data, this.filterState);
      }, 200);
    });
    searchSection.appendChild(searchInput);
    body.appendChild(searchSection);

    // Section: Lanes
    const lanesSection = document.createElement('div');
    lanesSection.className = 'cp-sidebar-section';

    const lanesLabel = document.createElement('div');
    lanesLabel.className = 'cp-sidebar-label';
    lanesLabel.textContent = 'Lanes';
    lanesSection.appendChild(lanesLabel);

    const sorted = [...this.data.lanes].sort((a, b) => a.order - b.order);
    sorted.forEach(lane => {
      const laneRow = document.createElement('div');
      laneRow.className = 'cp-sidebar-lane-row';

      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'cp-lane-toggle';
      toggleLabel.title = `Toggle visibility: ${lane.name}`;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !this.filterState.hiddenLaneIds.has(lane.id);
      cb.style.cssText = 'margin:0;cursor:pointer;';
      cb.addEventListener('change', () => this.handleToggleLane(lane.id));

      const dot = document.createElement('span');
      dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${lane.color || '#ccc'};display:inline-block;border:1px solid rgba(0,0,0,0.15);flex-shrink:0;`;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = lane.name;
      nameSpan.style.cssText = `flex:1;opacity:${this.filterState.hiddenLaneIds.has(lane.id) ? '0.4' : '1'};`;

      toggleLabel.appendChild(cb);
      toggleLabel.appendChild(dot);
      toggleLabel.appendChild(nameSpan);
      laneRow.appendChild(toggleLabel);

      const editBtn = document.createElement('button');
      editBtn.textContent = '✎';
      editBtn.title = `Edit lane: ${lane.name}`;
      editBtn.className = 'cp-btn';
      editBtn.style.cssText = 'padding:3px 7px;font-size:11px;';
      editBtn.addEventListener('click', () => this.handleEditLane(lane));
      laneRow.appendChild(editBtn);

      lanesSection.appendChild(laneRow);
    });

    const addLaneBtn = document.createElement('button');
    addLaneBtn.textContent = '+ Add Lane';
    addLaneBtn.className = 'cp-btn cp-btn-primary';
    addLaneBtn.style.cssText = 'width:100%;margin-top:8px;';
    addLaneBtn.addEventListener('click', () => this.handleAddLane());
    lanesSection.appendChild(addLaneBtn);
    body.appendChild(lanesSection);

    // Section: Date range
    const rangeSection = document.createElement('div');
    rangeSection.className = 'cp-sidebar-section';

    const rangeLabel = document.createElement('div');
    rangeLabel.className = 'cp-sidebar-label';
    rangeLabel.textContent = 'Date Range';
    rangeSection.appendChild(rangeLabel);

    const rangeStart = document.createElement('input');
    rangeStart.type = 'date';
    rangeStart.value = formatDate(this.viewport.windowStart);
    rangeStart.className = 'cp-filter-input cp-filter-input--full';
    rangeSection.appendChild(rangeStart);

    const rangeTo = document.createElement('div');
    rangeTo.style.cssText = 'font-size:11px;color:#6b7280;text-align:center;margin:2px 0;';
    rangeTo.textContent = '→';
    rangeSection.appendChild(rangeTo);

    const rangeEnd = document.createElement('input');
    rangeEnd.type = 'date';
    rangeEnd.value = formatDate(this.viewport.windowEnd);
    rangeEnd.className = 'cp-filter-input cp-filter-input--full';
    rangeSection.appendChild(rangeEnd);

    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.className = 'cp-btn cp-btn-primary';
    applyBtn.style.cssText = 'width:100%;margin-top:6px;';
    applyBtn.addEventListener('click', () => {
      if (!rangeStart.value || !rangeEnd.value) return;
      if (rangeStart.value >= rangeEnd.value) { alert('Start must be before end date.'); return; }
      this.handleCustomRange(parseDate(rangeStart.value), parseDate(rangeEnd.value));
    });
    rangeSection.appendChild(applyBtn);
    body.appendChild(rangeSection);
  }

  private buildToolbar(): void {
    this.toolbar.innerHTML = '';
    this.toolbar.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;background:white;border-bottom:1px solid #e4e7ed;';

    // Title
    const title = document.createElement('span');
    title.style.cssText = 'font-weight:600;font-size:14px;color:#1a2332;margin-right:4px;';
    title.textContent = this.config.title;
    this.toolbar.appendChild(title);

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
    this.toolbar.appendChild(yearSel);
    this.yearSelEl = yearSel;

    // Spacer
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1;';
    this.toolbar.appendChild(spacer);

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
    this.vpLabelEl = vpLabel;

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
    this.zoomOutBtnEl = zoomOutBtn;

    const zoomInBtn = document.createElement('button');
    zoomInBtn.textContent = '+';
    zoomInBtn.title = 'Zoom in';
    zoomInBtn.className = 'cp-btn';
    zoomInBtn.disabled = !canZoomIn(this.viewport);
    zoomInBtn.addEventListener('click', () => this.handleZoomIn());
    zoomControls.appendChild(zoomInBtn);
    this.zoomInBtnEl = zoomInBtn;

    this.toolbar.appendChild(zoomControls);
  }

  private refresh(): void {
    this.renderer.update(this.data, this.filterState);
    // Rebuild sidebar to reflect lane changes
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
  }

  private refreshViewport(): void {
    this.renderer.updateViewport(this.viewport);
    this.updateViewportState();
  }

  /** Update only the viewport-dependent toolbar elements — no DOM rebuild */
  private updateViewportState(): void {
    this.vpLabelEl.textContent = viewportLabel(this.viewport);
    this.yearSelEl.value = String(this.viewport.windowStart.getFullYear());
    this.zoomOutBtnEl.disabled = !canZoomOut(this.viewport);
    this.zoomInBtnEl.disabled  = !canZoomIn(this.viewport);
  }

  private save(): void {
    this.dataManager.scheduleSave(this.data);
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
    this.renderer.update(this.data, this.filterState);
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
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
