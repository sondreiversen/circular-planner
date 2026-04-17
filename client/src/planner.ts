import { PlannerConfig, PlannerData, Lane, Activity, Viewport, FilterState } from './types';
import { Renderer } from './renderer';
import { ListRenderer } from './list-renderer';

type ViewMode = 'disc' | 'list';

const LANE_BORDER_ALPHA = 0.78;

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
import { DataManager } from './data-manager';
import { showActivityDialog, showLaneDialog, showOutlookImportDialog } from './dialogs';
import { randomId, laneColor, parseDate, formatDate, ymdToDmy, dmyToYmd } from './utils';
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
  private listRenderer: ListRenderer | null = null;
  private dataManager: DataManager;
  private container: HTMLElement;
  private toolbar!: HTMLElement;
  private svgContainer!: HTMLElement;
  private listContainer!: HTMLElement;
  private viewMode: ViewMode = 'disc';
  private sidebarCollapsed = false;
  private showBorder = true;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private viewDiscBtn!: HTMLButtonElement;
  private viewListBtn!: HTMLButtonElement;

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
    this.filterState = { hiddenLaneIds: new Set(), searchTerm: '', activeLabels: new Set() };
    this.dataManager = new DataManager(this.config);

    // Restore sidebar collapsed state
    this.sidebarCollapsed = localStorage.getItem('cp_sidebar_collapsed') === 'true';
    const storedMode = localStorage.getItem('cp_view_mode');
    if (storedMode === 'list' || storedMode === 'disc') this.viewMode = storedMode;

    const storedBorder = localStorage.getItem('cp_lane_border_color');
    if (storedBorder) {
      document.documentElement.style.setProperty('--cp-lane-border', hexToRgba(storedBorder, LANE_BORDER_ALPHA));
    }

    if (localStorage.getItem('cp_lane_border_show') === 'false') this.showBorder = false;

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
    this.svgContainer = svgContainer;

    const listContainer = document.createElement('div');
    listContainer.className = 'cp-list-container';
    listContainer.tabIndex = 0;
    mainArea.appendChild(listContainer);
    this.listContainer = listContainer;

    this.renderer = new Renderer(svgContainer, this.config, this.data, this.viewport);
    this.renderer.setHandlers(
      (laneId, date) => this.handleClickLane(laneId, date),
      (activity) => this.handleClickActivity(activity)
    );
    this.renderer.setBorderOptions(this.showBorder);
    this.renderer.update(this.data, this.filterState);

    svgContainer.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) this.handleZoomIn();
      else if (e.deltaY > 0) this.handleZoomOut();
    }, { passive: false });

    const keyHandler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':  e.preventDefault(); this.handleNavigate(-1); break;
        case 'ArrowRight': e.preventDefault(); this.handleNavigate(1);  break;
        case 'ArrowUp':    e.preventDefault(); this.handleZoomIn();     break;
        case 'ArrowDown':  e.preventDefault(); this.handleZoomOut();    break;
      }
    };
    svgContainer.addEventListener('keydown', keyHandler);
    listContainer.addEventListener('keydown', keyHandler);

    this.applyViewMode();
  }

  private applyViewMode(): void {
    const isList = this.viewMode === 'list';
    this.svgContainer.style.display = isList ? 'none' : '';
    this.listContainer.style.display = isList ? '' : 'none';

    if (isList) {
      if (!this.listRenderer) {
        this.listRenderer = new ListRenderer(this.listContainer, this.data, this.viewport, this.filterState);
        this.listRenderer.setHandlers(
          (activity) => this.handleClickActivity(activity),
          (laneId, date) => this.handleClickLane(laneId, date)
        );
      } else {
        this.listRenderer.update(this.data, this.filterState);
        this.listRenderer.updateViewport(this.viewport);
      }
      this.listContainer.focus();
    } else {
      this.svgContainer.focus();
    }

    if (this.viewDiscBtn && this.viewListBtn) {
      this.viewDiscBtn.classList.toggle('cp-btn-active', !isList);
      this.viewListBtn.classList.toggle('cp-btn-active', isList);
    }
  }

  private setViewMode(mode: ViewMode): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    localStorage.setItem('cp_view_mode', mode);
    this.applyViewMode();
  }

  private buildSidebar(body: HTMLElement): void {
    body.innerHTML = '';

    // Section: Search
    const searchSection = document.createElement('div');
    searchSection.className = 'cp-sidebar-section';

    const searchHeading = document.createElement('div');
    searchHeading.className = 'cp-sidebar-label';
    searchHeading.textContent = 'Search';
    searchSection.appendChild(searchHeading);

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search activities…';
    searchInput.className = 'cp-filter-input cp-filter-input--full';
    searchInput.value = this.filterState.searchTerm;
    searchInput.addEventListener('input', () => {
      if (this.searchDebounce) clearTimeout(this.searchDebounce);
      this.searchDebounce = setTimeout(() => {
        this.filterState.searchTerm = searchInput.value.toLowerCase().trim();
        this.renderer.update(this.data, this.filterState); this.listRenderer?.update(this.data, this.filterState);
      }, 200);
    });
    searchSection.appendChild(searchInput);
    body.appendChild(searchSection);

    // Section: Lanes (top of list = outermost = highest order)
    const lanesSection = document.createElement('div');
    lanesSection.className = 'cp-sidebar-section';

    const lanesHeading = document.createElement('div');
    lanesHeading.className = 'cp-sidebar-label';
    lanesHeading.textContent = 'Lanes';
    lanesSection.appendChild(lanesHeading);

    // Reverse: highest order (outermost) at top
    const sidebarOrder = [...this.data.lanes].sort((a, b) => b.order - a.order);
    let dragSrcId: string | null = null;

    sidebarOrder.forEach(lane => {
      const laneRow = document.createElement('div');
      laneRow.className = 'cp-sidebar-lane-row';
      laneRow.draggable = true;
      laneRow.dataset.laneId = lane.id;

      const handle = document.createElement('span');
      handle.className = 'cp-drag-handle';
      handle.textContent = '⠿';
      handle.title = 'Drag to reorder';
      laneRow.appendChild(handle);

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
      nameSpan.style.cssText = `flex:1;opacity:${this.filterState.hiddenLaneIds.has(lane.id) ? '0.4' : '1'};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;

      toggleLabel.appendChild(cb);
      toggleLabel.appendChild(dot);
      toggleLabel.appendChild(nameSpan);
      laneRow.appendChild(toggleLabel);

      const editBtn = document.createElement('button');
      editBtn.textContent = '✎';
      editBtn.title = `Edit lane: ${lane.name}`;
      editBtn.className = 'cp-btn';
      editBtn.style.cssText = 'padding:3px 7px;font-size:11px;flex-shrink:0;';
      editBtn.addEventListener('click', () => this.handleEditLane(lane));
      laneRow.appendChild(editBtn);

      // Drag events
      laneRow.addEventListener('dragstart', (e) => {
        dragSrcId = lane.id;
        laneRow.classList.add('dragging');
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', lane.id);
      });
      laneRow.addEventListener('dragend', () => {
        dragSrcId = null;
        laneRow.classList.remove('dragging');
        lanesSection.querySelectorAll('.cp-sidebar-lane-row').forEach(r => {
          r.classList.remove('drag-over-top', 'drag-over-bottom');
        });
      });
      laneRow.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragSrcId || dragSrcId === lane.id) return;
        e.dataTransfer!.dropEffect = 'move';
        const rect = laneRow.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        laneRow.classList.toggle('drag-over-top', above);
        laneRow.classList.toggle('drag-over-bottom', !above);
      });
      laneRow.addEventListener('dragleave', () => {
        laneRow.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      laneRow.addEventListener('drop', (e) => {
        e.preventDefault();
        laneRow.classList.remove('drag-over-top', 'drag-over-bottom');
        if (!dragSrcId || dragSrcId === lane.id) return;
        const rect = laneRow.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        const rows = lanesSection.querySelectorAll<HTMLElement>('.cp-sidebar-lane-row');
        const targetIndex = [...rows].indexOf(laneRow);
        const dropIndex = above ? targetIndex : targetIndex + 1;
        this.handleReorderLane(dragSrcId, dropIndex);
      });

      lanesSection.appendChild(laneRow);
    });

    const addLaneBtn = document.createElement('button');
    addLaneBtn.textContent = '+ Add Lane';
    addLaneBtn.className = 'cp-btn cp-btn-primary';
    addLaneBtn.style.cssText = 'width:100%;margin-top:8px;';
    addLaneBtn.addEventListener('click', () => this.handleAddLane());
    lanesSection.appendChild(addLaneBtn);
    body.appendChild(lanesSection);

    // Section: Labels (if any exist)
    const allLabels = [...new Set(
      this.data.lanes.flatMap(l => l.activities.map(a => a.label)).filter(Boolean)
    )].sort();

    if (allLabels.length > 0) {
      const labelsSection = document.createElement('div');
      labelsSection.className = 'cp-sidebar-section';

      const labelsHeading = document.createElement('div');
      labelsHeading.className = 'cp-sidebar-label';
      labelsHeading.textContent = 'Labels';
      labelsSection.appendChild(labelsHeading);

      allLabels.forEach(lbl => {
        const row = document.createElement('label');
        row.className = 'cp-lane-toggle';
        row.style.cssText = 'cursor:pointer;gap:6px;';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this.filterState.activeLabels.has(lbl);
        cb.style.cssText = 'margin:0;cursor:pointer;';
        cb.addEventListener('change', () => this.handleToggleLabel(lbl));

        const nameSpan = document.createElement('span');
        nameSpan.textContent = lbl;
        nameSpan.style.cssText = `flex:1;font-size:12px;opacity:${this.filterState.activeLabels.size > 0 && !this.filterState.activeLabels.has(lbl) ? '0.4' : '1'};`;

        row.appendChild(cb);
        row.appendChild(nameSpan);
        labelsSection.appendChild(row);
      });

      body.appendChild(labelsSection);
    }

    // Section: Appearance (lane border colour)
    const apprSection = document.createElement('div');
    apprSection.className = 'cp-sidebar-section';

    const apprHeading = document.createElement('div');
    apprHeading.className = 'cp-sidebar-label';
    apprHeading.textContent = 'Appearance';
    apprSection.appendChild(apprHeading);

    const makeToggleRow = (
      labelText: string,
      checked: boolean,
      onChange: (v: boolean) => void
    ): HTMLLabelElement => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.addEventListener('change', () => onChange(cb.checked));
      row.appendChild(cb);
      const txt = document.createElement('span');
      txt.textContent = labelText;
      row.appendChild(txt);
      return row;
    };

    const borderRow = document.createElement('div');
    borderRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;';

    const borderLabel = document.createElement('span');
    borderLabel.textContent = 'Border colour';
    borderLabel.style.cssText = 'flex:1;';
    borderRow.appendChild(borderLabel);

    const storedBorder = localStorage.getItem('cp_lane_border_color');
    const borderInput = document.createElement('input');
    borderInput.type = 'color';
    borderInput.value = storedBorder || '#ffffff';
    borderInput.style.cssText = 'width:32px;height:26px;padding:0;border:1px solid #ccc;border-radius:3px;cursor:pointer;';
    borderInput.title = 'Lane border colour';
    borderInput.disabled = !this.showBorder;
    borderInput.addEventListener('input', () => {
      document.documentElement.style.setProperty('--cp-lane-border', hexToRgba(borderInput.value, LANE_BORDER_ALPHA));
      localStorage.setItem('cp_lane_border_color', borderInput.value);
      this.renderer.update(this.data, this.filterState);
    });
    borderRow.appendChild(borderInput);

    const borderReset = document.createElement('button');
    borderReset.textContent = 'Reset';
    borderReset.className = 'cp-btn';
    borderReset.style.cssText = 'padding:3px 8px;font-size:11px;';
    borderReset.title = 'Use default border colour';
    borderReset.disabled = !this.showBorder;
    borderReset.addEventListener('click', () => {
      document.documentElement.style.removeProperty('--cp-lane-border');
      localStorage.removeItem('cp_lane_border_color');
      borderInput.value = '#ffffff';
      this.renderer.update(this.data, this.filterState);
    });
    borderRow.appendChild(borderReset);

    const borderToggleRow = makeToggleRow('Show lane borders', this.showBorder, (v) => {
      this.showBorder = v;
      localStorage.setItem('cp_lane_border_show', String(v));
      borderInput.disabled = !v;
      borderReset.disabled = !v;
      this.renderer.setBorderOptions(this.showBorder);
      this.renderer.update(this.data, this.filterState);
    });
    apprSection.appendChild(borderToggleRow);

    apprSection.appendChild(borderRow);
    body.appendChild(apprSection);

    // Section: Date range
    const rangeSection = document.createElement('div');
    rangeSection.className = 'cp-sidebar-section';

    const rangeHeading = document.createElement('div');
    rangeHeading.className = 'cp-sidebar-label';
    rangeHeading.textContent = 'Date Range';
    rangeSection.appendChild(rangeHeading);

    const rangeStart = document.createElement('input');
    rangeStart.type = 'text';
    rangeStart.inputMode = 'numeric';
    rangeStart.placeholder = 'DD/MM/YYYY';
    rangeStart.value = ymdToDmy(formatDate(this.viewport.windowStart));
    rangeStart.className = 'cp-filter-input cp-filter-input--full';
    rangeSection.appendChild(rangeStart);

    const rangeTo = document.createElement('div');
    rangeTo.style.cssText = 'font-size:11px;color:#6b7280;text-align:center;margin:2px 0;';
    rangeTo.textContent = '→';
    rangeSection.appendChild(rangeTo);

    const rangeEnd = document.createElement('input');
    rangeEnd.type = 'text';
    rangeEnd.inputMode = 'numeric';
    rangeEnd.placeholder = 'DD/MM/YYYY';
    rangeEnd.value = ymdToDmy(formatDate(this.viewport.windowEnd));
    rangeEnd.className = 'cp-filter-input cp-filter-input--full';
    rangeSection.appendChild(rangeEnd);

    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.className = 'cp-btn cp-btn-primary';
    applyBtn.style.cssText = 'width:100%;margin-top:6px;';
    applyBtn.addEventListener('click', () => {
      const startYmd = dmyToYmd(rangeStart.value);
      const endYmd   = dmyToYmd(rangeEnd.value);
      if (!startYmd || !endYmd) { alert('Dates must be in DD/MM/YYYY format.'); return; }
      if (startYmd >= endYmd) { alert('Start must be before end date.'); return; }
      this.handleCustomRange(parseDate(startYmd), parseDate(endYmd));
    });
    rangeSection.appendChild(applyBtn);
    body.appendChild(rangeSection);
  }

  private handleReorderLane(sourceId: string, targetIndex: number): void {
    // Sidebar shows outermost (highest order) at top
    const sidebarOrder = [...this.data.lanes].sort((a, b) => b.order - a.order);
    const srcIndex = sidebarOrder.findIndex(l => l.id === sourceId);
    if (srcIndex === -1) return;

    // Adjust target when source is above it (removing source shifts items up)
    let adjustedTarget = targetIndex;
    if (srcIndex < targetIndex) adjustedTarget = targetIndex - 1;
    if (srcIndex === adjustedTarget) return;

    const [moved] = sidebarOrder.splice(srcIndex, 1);
    sidebarOrder.splice(adjustedTarget, 0, moved);

    // Reassign orders: sidebar index 0 = outermost = highest order
    const N = sidebarOrder.length;
    sidebarOrder.forEach((lane, i) => { lane.order = N - 1 - i; });

    this.save();
    this.refresh();
  }

  private handleToggleLabel(label: string): void {
    if (this.filterState.activeLabels.has(label)) {
      this.filterState.activeLabels.delete(label);
    } else {
      this.filterState.activeLabels.add(label);
    }
    this.renderer.update(this.data, this.filterState); this.listRenderer?.update(this.data, this.filterState);
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
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

    // View-mode toggle
    const viewGroup = document.createElement('div');
    viewGroup.className = 'cp-zoom-controls';
    viewGroup.style.marginLeft = '8px';

    const discBtn = document.createElement('button');
    discBtn.textContent = 'Disc';
    discBtn.className = 'cp-btn' + (this.viewMode === 'disc' ? ' cp-btn-active' : '');
    discBtn.title = 'Disc view';
    discBtn.addEventListener('click', () => this.setViewMode('disc'));
    viewGroup.appendChild(discBtn);
    this.viewDiscBtn = discBtn;

    const listBtn = document.createElement('button');
    listBtn.textContent = 'List';
    listBtn.className = 'cp-btn' + (this.viewMode === 'list' ? ' cp-btn-active' : '');
    listBtn.title = 'Timeline list view';
    listBtn.addEventListener('click', () => this.setViewMode('list'));
    viewGroup.appendChild(listBtn);
    this.viewListBtn = listBtn;

    this.toolbar.appendChild(viewGroup);

    // Import button (edit/owner only)
    if (this.config.permission !== 'view') {
      const importBtn = document.createElement('button');
      importBtn.textContent = 'Import';
      importBtn.title = 'Import events from Outlook';
      importBtn.className = 'cp-btn';
      importBtn.style.marginLeft = '8px';
      importBtn.addEventListener('click', () => this.handleOutlookImport());
      this.toolbar.appendChild(importBtn);
    }

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
    this.renderer.update(this.data, this.filterState); this.listRenderer?.update(this.data, this.filterState);
    this.listRenderer?.update(this.data, this.filterState);
    // Rebuild sidebar to reflect lane changes
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
  }

  private refreshViewport(): void {
    this.renderer.updateViewport(this.viewport);
    this.listRenderer?.updateViewport(this.viewport);
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
    this.renderer.update(this.data, this.filterState); this.listRenderer?.update(this.data, this.filterState);
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
  }

  // ==================== Import handler ====================

  private handleOutlookImport(): void {
    showOutlookImportDialog(
      this.config.plannerId,
      this.data.lanes,
      this.data.lanes.length,
      (activities, targetLaneId, newLane) => {
        if (newLane) {
          this.data.lanes.push(newLane);
        }
        const lane = this.data.lanes.find(l => l.id === targetLaneId);
        if (lane) {
          lane.activities.push(...activities);
          this.save();
          this.refresh();
        }
      },
    );
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

  /** Called when the global theme changes — re-renders the SVG with new CSS var values. */
  onThemeChange(): void {
    this.renderer.setTheme();
  }
}
