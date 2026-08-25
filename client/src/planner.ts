import { PlannerConfig, PlannerData, Lane, Activity, Viewport, FilterState } from './types';
import { toast } from './toast';
import { Renderer } from './renderer';
import { ListRenderer } from './list-renderer';
import { PeopleRenderer } from './people-renderer';
import { History } from './history';
import { openHelpOverlay } from './help-overlay';

type ViewMode = 'disc' | 'list' | 'people';

const LANE_BORDER_ALPHA = 0.78;

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
import { DataManager } from './data-manager';
import { showActivityDialog, showLaneDialog, showOutlookImportDialog } from './dialogs';
import { randomId, laneColor, parseDate, formatDate, addDays, ColorBy, STATUS_COLORS, colorForString } from './utils';
import { defaultViewport, zoomIn, zoomOut, navigate, canZoomIn, canZoomOut, viewportLabel, navigateToYear, navigateToRange, navigateToToday } from './viewport';
import { ZoomLevel } from './types';
import { decode as decodeUrlState, encode as encodeUrlState } from './url-state';
import { listViews, createView, deleteView, SavedView } from './saved-views';
import { serializeSVGWithStyles, rasterizeSVGString } from './svg-export';
import { setClip, getClip, hasClip } from './activity-clipboard';
import { api } from './api-client';

interface Member {
  id: number;
  username: string;
  fullName?: string;
  role: 'owner' | 'edit' | 'view';
}

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
  private peopleRenderer: PeopleRenderer | null = null;
  private dataManager: DataManager;
  private container: HTMLElement;
  private toolbar!: HTMLElement;
  private svgContainer!: HTMLElement;
  private listContainer!: HTMLElement;
  private peopleContainer!: HTMLElement;
  private viewMode: ViewMode = 'disc';
  private colorBy: ColorBy = 'activity';
  private colorByLegend!: HTMLElement;
  private sidebarCollapsed = false;
  private showBorder = true;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private history: History = new History();
  private _globalKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private lastSelectedActivity: Activity | null = null;
  private viewDiscBtn!: HTMLButtonElement;
  private viewListBtn!: HTMLButtonElement;
  private viewPeopleBtn!: HTMLButtonElement;
  private searchInputEl: HTMLInputElement | null = null;
  private pngBtn: HTMLButtonElement | null = null;
  private members: Member[] = [];

  // Refs to toolbar elements that change on viewport updates
  private vpLabelEl!: HTMLSpanElement;
  private yearSelEl!: HTMLSelectElement;
  private zoomOutBtnEl!: HTMLButtonElement;
  private zoomInBtnEl!: HTMLButtonElement;
  private saveBadgeEl!: HTMLSpanElement;
  private saveFadeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement, config: PlannerConfig, initialData: PlannerData, updatedAt?: string) {
    this.container = container;
    this.config = config;
    this.data = initialData;
    this.viewport = defaultViewport(this.config);
    this.filterState = { hiddenLaneIds: new Set(), searchTerm: '', activeLabels: new Set(), activeTaggedUserIds: new Set(), selectedPeopleIds: new Set() };
    this.dataManager = new DataManager(this.config);
    if (updatedAt) this.dataManager.setUpdatedAt(updatedAt);

    this.dataManager.on('saving', () => this.setSaveBadge('saving'));
    this.dataManager.on('saved', () => this.setSaveBadge('saved'));
    this.dataManager.on('error', () => this.setSaveBadge('error'));
    this.dataManager.on('conflict', () => {
      this.setSaveBadge('error');
      toast.error('Planner was modified elsewhere — reload?', { duration: 0 });
      // Make the toast clickable to reload
      const toastEl = document.querySelector('.cp-toast-error') as HTMLElement | null;
      if (toastEl) {
        toastEl.style.cursor = 'pointer';
        toastEl.addEventListener('click', () => location.reload(), { once: true });
      }
    });

    // Apply URL-encoded state first (URL is authoritative for shared links).
    // This runs before localStorage so a shared URL always wins.
    const urlState = decodeUrlState(location.search);
    if (urlState.viewport?.from && urlState.viewport?.to && urlState.viewport?.zoom) {
      this.viewport = { windowStart: urlState.viewport.from, windowEnd: urlState.viewport.to, zoomLevel: urlState.viewport.zoom };
    } else if (urlState.viewport?.zoom) {
      // Zoom level only — keep the current windowStart year, recompute window at the new zoom
      this.viewport = navigateToYear(this.viewport.windowStart.getFullYear());
      this.viewport = { ...this.viewport, zoomLevel: urlState.viewport.zoom };
    }
    if (urlState.filterState?.searchTerm) this.filterState.searchTerm = urlState.filterState.searchTerm;
    if (urlState.filterState?.hiddenLaneIds) this.filterState.hiddenLaneIds = urlState.filterState.hiddenLaneIds;
    if (urlState.filterState?.activeLabels) this.filterState.activeLabels = urlState.filterState.activeLabels;
    if (urlState.filterState?.activeTaggedUserIds) this.filterState.activeTaggedUserIds = urlState.filterState.activeTaggedUserIds;
    if (urlState.filterState?.selectedPeopleIds) this.filterState.selectedPeopleIds = urlState.filterState.selectedPeopleIds;
    if (urlState.viewMode) this.viewMode = urlState.viewMode;
    if (urlState.colorBy) this.colorBy = urlState.colorBy;

    // Restore sidebar collapsed state
    this.sidebarCollapsed = localStorage.getItem('cp_sidebar_collapsed') === 'true';
    const storedMode = localStorage.getItem('cp_view_mode');
    // Only apply localStorage fallback when URL didn't override viewMode
    if (!urlState.viewMode && (storedMode === 'list' || storedMode === 'disc' || storedMode === 'people')) this.viewMode = storedMode;

    const storedColorBy = localStorage.getItem('cp_color_by');
    // Only apply localStorage fallback when URL didn't override colorBy
    if (!urlState.colorBy && (storedColorBy === 'activity' || storedColorBy === 'lane' || storedColorBy === 'label' || storedColorBy === 'status' || storedColorBy === 'owner')) {
      this.colorBy = storedColorBy;
    }

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

    // Color-by legend strip
    this.colorByLegend = document.createElement('div');
    this.colorByLegend.className = 'cp-color-by-legend';
    this.colorByLegend.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:4px 12px;background:var(--cp-surface);border-bottom:1px solid var(--cp-border);font-size:11px;color:var(--cp-text);';
    this.container.appendChild(this.colorByLegend);
    this.updateColorByLegend();

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

    const peopleContainer = document.createElement('div');
    peopleContainer.className = 'cp-list-container';
    peopleContainer.tabIndex = 0;
    mainArea.appendChild(peopleContainer);
    this.peopleContainer = peopleContainer;

    this.renderer = new Renderer(svgContainer, this.config, this.data, this.viewport);
    // Only wire mutation handlers when the user has edit rights; view-only users
    // get no-op handlers so clicking the disc does nothing.
    if (this.config.permission !== 'view') {
      this.renderer.setHandlers(
        (laneId, date) => this.handleClickLane(laneId, date),
        (activity) => this.handleClickActivity(activity)
      );
      this.renderer.setDragCommitHandler((act, newStart, newEnd, newLaneId) =>
        this.handleDragCommit(act, newStart, newEnd, newLaneId)
      );
    }
    this.renderer.setPinchZoomHandlers(
      () => this.handleZoomIn(),
      () => this.handleZoomOut()
    );
    this.renderer.setBorderOptions(this.showBorder);
    this.renderer.setColorBy(this.colorBy);
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
    this.installGlobalKeyHandler();
    this.loadMembers();
  }

  private loadMembers(): void {
    api.get<Member[]>(`/api/planners/${this.config.plannerId}/members`).then(members => {
      this.members = members;
      // Re-render sidebar so the "Visible people" section shows member names immediately.
      const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
      if (sidebarBody) this.buildSidebar(sidebarBody);
    }).catch(() => { /* non-fatal; people picker may be empty */ });
  }

  /** Returns true when focus is inside an editable element (input/textarea/contenteditable). */
  private static isEditingText(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  private installGlobalKeyHandler(): void {
    const handler = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const ctrl = isMac ? e.metaKey : e.ctrlKey;

      // Ctrl/Cmd+Z — undo (always intercepted, even in inputs)
      if (ctrl && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        const cmd = this.history.undo();
        if (cmd) { toast.info(`Undone: ${cmd.label}`); this.save(); }
        return;
      }
      // Ctrl/Cmd+Shift+Z — redo (Ctrl+Y dropped — Firefox uses it for Show Downloads)
      if (ctrl && e.shiftKey && e.key === 'z') {
        e.preventDefault();
        const cmd = this.history.redo();
        if (cmd) { toast.info(`Redone: ${cmd.label}`); this.save(); }
        return;
      }
      // Ctrl/Cmd+S — force save
      if (ctrl && e.key === 's') {
        e.preventDefault();
        this.dataManager.save(this.data);
        return;
      }

      // Esc — only act when the search input has focus; otherwise let other handlers work
      if (e.key === 'Escape' && this.searchInputEl && document.activeElement === this.searchInputEl) {
        if (this.searchInputEl.value) {
          this.searchInputEl.value = '';
          this.searchInputEl.dispatchEvent(new Event('input'));
        } else {
          this.searchInputEl.blur();
        }
        e.preventDefault();
        return;
      }

      // Guard: don't fire shortcut keys when typing in inputs
      if (Planner.isEditingText()) return;

      // Ctrl/Cmd+C — copy selected activity (only when no text is selected on the page)
      if (ctrl && !e.shiftKey && e.key === 'c') {
        if (!this.lastSelectedActivity) return;
        if ((window.getSelection()?.toString() ?? '') !== '') return;
        setClip(this.lastSelectedActivity);
        toast.info('Activity copied — Ctrl+V to paste');
        e.preventDefault();
        return;
      }

      // Ctrl/Cmd+V — paste clipboard activity (pre-filled dialog, date-shifted to today)
      if (ctrl && !e.shiftKey && e.key === 'v') {
        if (!hasClip()) return;
        if (this.config.permission === 'view') {
          e.preventDefault();
          toast.error('Cannot paste — view-only access');
          return;
        }
        e.preventDefault();
        const src = getClip()!;
        const today = new Date();
        const origStart = parseDate(src.startDate);
        const origEnd = parseDate(src.endDate);
        const offsetDays = Math.round((today.getTime() - origStart.getTime()) / 86400000);
        const newStart = formatDate(addDays(origStart, offsetDays));
        const newEnd = formatDate(addDays(origEnd, offsetDays));
        const laneExists = this.data.lanes.some(l => l.id === src.laneId);
        const targetLaneId = laneExists ? src.laneId : (this.data.lanes[0]?.id ?? src.laneId);
        const prefilled: Activity = {
          ...src,
          id: randomId(),
          laneId: targetLaneId,
          title: src.title + ' (copy)',
          startDate: newStart,
          endDate: newEnd,
        };
        delete (prefilled as any).createdBy;
        delete (prefilled as any).createdAt;
        showActivityDialog(targetLaneId, this.data.lanes, parseDate(newStart), prefilled,
          (activity) => this.addActivity(activity), () => {}, this.config.endDate, undefined, true);
        return;
      }

      // n — new activity (Ctrl+N can't be intercepted; browsers claim it for new window)
      if (e.key === 'n') {
        e.preventDefault();
        if (this.config.permission !== 'view') this.handleAddEvent();
        return;
      }

      // ? — help overlay
      if (e.key === '?') {
        e.preventDefault();
        openHelpOverlay();
        return;
      }

      // / — focus search (expand sidebar first if collapsed)
      if (e.key === '/') {
        e.preventDefault();
        if (this.sidebarCollapsed) {
          const sidebar = document.getElementById('cp-sidebar');
          const toggle = sidebar?.querySelector('.cp-sidebar-toggle') as HTMLButtonElement | null;
          toggle?.click();
        }
        this.searchInputEl?.focus();
        return;
      }

      // t — jump to today
      if (e.key === 't') {
        e.preventDefault();
        this.handleNavigateToday();
        return;
      }

      // 1 / 2 / 3 — switch view mode
      if (e.key === '1') { e.preventDefault(); this.setViewMode('disc');   return; }
      if (e.key === '2') { e.preventDefault(); this.setViewMode('list');   return; }
      if (e.key === '3') { e.preventDefault(); this.setViewMode('people'); return; }

      // + / = — zoom in (= is the unshifted key on most keyboards that produces +)
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.handleZoomIn();
        return;
      }

      // - — zoom out
      if (e.key === '-') {
        e.preventDefault();
        this.handleZoomOut();
        return;
      }

      // Home — jump to planner start date (slide window to begin at config.startDate)
      if (e.key === 'Home') {
        e.preventDefault();
        const span = this.viewport.windowEnd.getTime() - this.viewport.windowStart.getTime();
        const homeStart = new Date(this.config.startDate);
        this.viewport = navigateToRange(homeStart, new Date(homeStart.getTime() + span), this.viewport.zoomLevel);
        this.refreshViewport();
        return;
      }

      // End — jump to planner end date (slide window to end at config.endDate)
      if (e.key === 'End') {
        e.preventDefault();
        const span = this.viewport.windowEnd.getTime() - this.viewport.windowStart.getTime();
        const homeEnd = new Date(this.config.endDate);
        this.viewport = navigateToRange(new Date(homeEnd.getTime() - span), homeEnd, this.viewport.zoomLevel);
        this.refreshViewport();
        return;
      }
    };

    this._globalKeyHandler = handler;
    document.addEventListener('keydown', handler);
  }

  private applyViewMode(): void {
    const isList = this.viewMode === 'list';
    const isPeople = this.viewMode === 'people';
    const isDisc = this.viewMode === 'disc';

    this.svgContainer.style.display = isDisc ? '' : 'none';
    this.listContainer.style.display = isList ? '' : 'none';
    this.peopleContainer.style.display = isPeople ? '' : 'none';

    if (isList) {
      if (!this.listRenderer) {
        this.listRenderer = new ListRenderer(this.listContainer, this.data, this.viewport, this.filterState, this.config);
        this.listRenderer.setHandlers(
          (activity) => this.handleClickActivity(activity),
          (laneId, date) => this.handleClickLane(laneId, date)
        );
        this.listRenderer.setDragCommitHandler((act, newStart, newEnd, newLaneId) =>
          this.handleDragCommit(act, newStart, newEnd, newLaneId)
        );
      } else {
        this.listRenderer.update(this.data, this.filterState);
        this.listRenderer.updateViewport(this.viewport);
      }
      this.listContainer.focus();
    } else if (isPeople) {
      if (!this.peopleRenderer) {
        this.peopleRenderer = new PeopleRenderer(
          this.peopleContainer,
          this.data,
          this.viewport,
          this.filterState,
          this.config.plannerId,
          this.config
        );
        this.peopleRenderer.setHandlers(
          (activity) => this.handleClickActivity(activity)
        );
        this.peopleRenderer.setDragCommitHandler((act, newStart, newEnd, newLaneId) =>
          this.handleDragCommit(act, newStart, newEnd, newLaneId)
        );
      } else {
        this.peopleRenderer.update(this.data, this.filterState);
        this.peopleRenderer.updateViewport(this.viewport);
      }
      this.peopleContainer.focus();
    } else {
      this.svgContainer.focus();
    }

    if (this.viewDiscBtn && this.viewListBtn && this.viewPeopleBtn) {
      this.viewDiscBtn.classList.toggle('cp-btn-active', isDisc);
      this.viewListBtn.classList.toggle('cp-btn-active', isList);
      this.viewPeopleBtn.classList.toggle('cp-btn-active', isPeople);
    }

    this.updatePngBtnState();
  }

  private updatePngBtnState(): void {
    if (!this.pngBtn) return;
    const canvasSupported = typeof document.createElement('canvas').toDataURL === 'function';
    if (this.viewMode === 'disc' && canvasSupported) {
      this.pngBtn.disabled = false;
      this.pngBtn.title = 'Download disc as PNG';
    } else {
      this.pngBtn.disabled = true;
      this.pngBtn.title = 'PNG export is only available for the disc view. Use Print to save list/people as PDF.';
    }
  }

  private setViewMode(mode: ViewMode): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    localStorage.setItem('cp_view_mode', mode);
    this.applyViewMode();
    // Rebuild sidebar so "Visible people" section shows/hides with view mode change.
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
    this.syncUrl();
  }

  /**
   * Build a section whose header is a clickable button with a chevron.
   * Collapsed state persists in localStorage under `cp_sidebar_collapsed_<key>`.
   * Returns the outer section element and the inner content container — append
   * rows to `content`, the section to `body`.
   */
  private makeCollapsibleSection(title: string, key: string): { section: HTMLElement; content: HTMLElement } {
    const section = document.createElement('div');
    section.className = 'cp-sidebar-section';
    const storageKey = `cp_sidebar_collapsed_${key}`;
    if (localStorage.getItem(storageKey) === '1') {
      section.classList.add('cp-sidebar-section--collapsed');
    }

    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = 'cp-sidebar-collapsible';

    const chevron = document.createElement('span');
    chevron.className = 'cp-sidebar-chevron';
    chevron.textContent = '▾';
    chevron.setAttribute('aria-hidden', 'true');

    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;

    heading.appendChild(chevron);
    heading.appendChild(titleSpan);
    heading.addEventListener('click', () => {
      section.classList.toggle('cp-sidebar-section--collapsed');
      const collapsed = section.classList.contains('cp-sidebar-section--collapsed');
      localStorage.setItem(storageKey, collapsed ? '1' : '0');
      heading.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    heading.setAttribute('aria-expanded', section.classList.contains('cp-sidebar-section--collapsed') ? 'false' : 'true');

    section.appendChild(heading);

    const content = document.createElement('div');
    content.className = 'cp-sidebar-section-body';
    section.appendChild(content);

    return { section, content };
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
        this.renderer.update(this.data, this.filterState); this.listRenderer?.update(this.data, this.filterState); this.peopleRenderer?.update(this.data, this.filterState);
        this.syncUrl();
      }, 200);
    });
    searchSection.appendChild(searchInput);
    this.searchInputEl = searchInput;
    body.appendChild(searchSection);

    // Section: Lanes (top of list = outermost = highest order)
    const { section: lanesSection, content: lanesContent } = this.makeCollapsibleSection('Lanes', 'lanes');

    // Reverse: highest order (outermost) at top
    const sidebarOrder = [...this.data.lanes].sort((a, b) => b.order - a.order);
    let dragSrcId: string | null = null;

    sidebarOrder.forEach(lane => {
      const laneRow = document.createElement('div');
      laneRow.className = 'cp-sidebar-lane-row';
      laneRow.draggable = this.config.permission !== 'view';
      laneRow.dataset.laneId = lane.id;

      if (this.config.permission !== 'view') {
        const handle = document.createElement('span');
        handle.className = 'cp-drag-handle';
        handle.textContent = '⠿';
        handle.title = 'Drag to reorder';
        laneRow.appendChild(handle);
      }

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

      toggleLabel.appendChild(dot);
      toggleLabel.appendChild(nameSpan);
      toggleLabel.appendChild(cb);
      laneRow.appendChild(toggleLabel);

      if (this.config.permission !== 'view') {
        const editBtn = document.createElement('button');
        editBtn.textContent = '✎';
        editBtn.title = `Edit lane: ${lane.name}`;
        editBtn.className = 'cp-btn';
        editBtn.style.cssText = 'padding:3px 7px;font-size:11px;flex-shrink:0;';
        editBtn.addEventListener('click', () => this.handleEditLane(lane));
        laneRow.appendChild(editBtn);
      }

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
        lanesContent.querySelectorAll('.cp-sidebar-lane-row').forEach(r => {
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
        const rows = lanesContent.querySelectorAll<HTMLElement>('.cp-sidebar-lane-row');
        const targetIndex = [...rows].indexOf(laneRow);
        const dropIndex = above ? targetIndex : targetIndex + 1;
        this.handleReorderLane(dragSrcId, dropIndex);
      });

      lanesContent.appendChild(laneRow);
    });

    if (this.config.permission !== 'view') {
      const addLaneBtn = document.createElement('button');
      addLaneBtn.textContent = '+ Add Lane';
      addLaneBtn.className = 'cp-btn cp-btn-primary';
      addLaneBtn.style.cssText = 'width:100%;margin-top:8px;';
      addLaneBtn.addEventListener('click', () => this.handleAddLane());
      lanesContent.appendChild(addLaneBtn);
    }
    body.appendChild(lanesSection);

    // Section: Labels (if any exist)
    const allActivities = this.data.lanes.flatMap(l => l.activities);
    const allLabels = [...new Set(allActivities.map(a => a.label).filter(Boolean))].sort();
    const hasUntagged = allActivities.some(a => !a.label);

    if (allLabels.length > 0 || hasUntagged) {
      const { section: labelsSection, content: labelsContent } = this.makeCollapsibleSection('Labels', 'labels');

      const makeChip = (lbl: string, displayText: string) => {
        const row = document.createElement('label');
        row.className = 'cp-lane-toggle';
        row.style.cssText = 'cursor:pointer;gap:6px;';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this.filterState.activeLabels.has(lbl);
        cb.style.cssText = 'margin:0;cursor:pointer;flex-shrink:0;';
        cb.addEventListener('change', () => this.handleToggleLabel(lbl));

        const nameSpan = document.createElement('span');
        nameSpan.textContent = displayText;
        nameSpan.style.cssText = `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:${this.filterState.activeLabels.size > 0 && !this.filterState.activeLabels.has(lbl) ? '0.4' : '1'};`;

        row.appendChild(nameSpan);
        row.appendChild(cb);
        labelsContent.appendChild(row);
      };

      allLabels.forEach(lbl => makeChip(lbl, lbl));
      if (hasUntagged) makeChip('', 'Untagged');

      body.appendChild(labelsSection);
    }

    // Section: Tagged users (if any exist across activities); pending tags have no id and are excluded.
    const seenTaggedUserIds = new Set<number>();
    const allTaggedUsers = allActivities
      .flatMap(a => a.taggedUsers ?? [])
      .filter(u => u.id != null)
      .filter(u => {
        if (seenTaggedUserIds.has(u.id as number)) return false;
        seenTaggedUserIds.add(u.id as number);
        return true;
      })
      .sort((a, b) => {
        const na = a.fullName?.trim() || a.username;
        const nb = b.fullName?.trim() || b.username;
        return na.localeCompare(nb);
      });

    if (allTaggedUsers.length > 0) {
      const { section: taggedUsersSection, content: taggedUsersContent } =
        this.makeCollapsibleSection('Tagged users', 'tagged_users');

      allTaggedUsers.forEach(u => {
        const uid = u.id as number;
        const dn = u.fullName?.trim() || u.username;
        const isActive = this.filterState.activeTaggedUserIds.has(uid);

        const row = document.createElement('label');
        row.className = 'cp-lane-toggle';
        row.style.cssText = 'cursor:pointer;gap:6px;';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isActive;
        cb.style.cssText = 'margin:0;cursor:pointer;flex-shrink:0;';
        cb.addEventListener('change', () => this.handleToggleTaggedUser(uid));

        const nameSpan = document.createElement('span');
        nameSpan.textContent = dn;
        nameSpan.style.cssText = `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:${this.filterState.activeTaggedUserIds.size > 0 && !isActive ? '0.4' : '1'};`;

        row.appendChild(nameSpan);
        row.appendChild(cb);
        taggedUsersContent.appendChild(row);
      });

      body.appendChild(taggedUsersSection);
    }

    // Section: Visible people — only shown when in people view
    if (this.viewMode === 'people' && this.members.length > 0) {
      const { section: peopleSection, content: peopleContent } =
        this.makeCollapsibleSection('Visible people', 'selected_people');

      // Header controls: Select all / Clear
      const pickerControls = document.createElement('div');
      pickerControls.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;';

      const selectAllBtn = document.createElement('button');
      selectAllBtn.textContent = 'Select all';
      selectAllBtn.className = 'cp-btn';
      selectAllBtn.style.cssText = 'padding:2px 8px;font-size:11px;';
      selectAllBtn.addEventListener('click', () => this.handleSelectAllPeople());
      pickerControls.appendChild(selectAllBtn);

      const clearBtn = document.createElement('button');
      clearBtn.textContent = 'Clear';
      clearBtn.className = 'cp-btn';
      clearBtn.style.cssText = 'padding:2px 8px;font-size:11px;';
      clearBtn.addEventListener('click', () => this.handleClearSelectedPeople());
      pickerControls.appendChild(clearBtn);

      peopleContent.appendChild(pickerControls);

      // Search input — only worth showing once the list is long enough to scroll.
      const rows: Array<{ row: HTMLElement; name: string }> = [];
      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.placeholder = 'Search people…';
      searchInput.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:6px;padding:4px 8px;font-size:12px;border:1px solid var(--cp-border);border-radius:4px;background:var(--cp-surface);color:var(--cp-text);';
      if (this.members.length > 8) peopleContent.appendChild(searchInput);

      // Sort members by display name
      const sortedMembers = [...this.members].sort((a, b) => {
        const na = a.fullName?.trim() || a.username;
        const nb = b.fullName?.trim() || b.username;
        return na.localeCompare(nb);
      });

      sortedMembers.forEach(m => {
        const isSelected = this.filterState.selectedPeopleIds.has(m.id);
        const dn = m.fullName?.trim() || m.username;

        const row = document.createElement('label');
        row.className = 'cp-lane-toggle';
        row.style.cssText = 'cursor:pointer;gap:6px;';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isSelected;
        cb.style.cssText = 'margin:0;cursor:pointer;flex-shrink:0;';
        cb.addEventListener('change', () => this.handleToggleSelectedPerson(m.id));

        const nameSpan = document.createElement('span');
        nameSpan.textContent = dn;
        nameSpan.style.cssText = `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:${this.filterState.selectedPeopleIds.size > 0 && !isSelected ? '0.4' : '1'};`;

        row.appendChild(nameSpan);
        row.appendChild(cb);
        peopleContent.appendChild(row);
        rows.push({ row, name: dn.toLowerCase() });
      });

      // Live-filter rows as the user types. Debounced lightly to avoid layout
      // thrash when typing fast; the rows toggle display:none so the scroll
      // height shrinks with the filter result.
      let searchDebounce: ReturnType<typeof setTimeout> | null = null;
      searchInput.addEventListener('input', () => {
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          const q = searchInput.value.trim().toLowerCase();
          for (const { row, name } of rows) {
            row.style.display = !q || name.includes(q) ? '' : 'none';
          }
        }, 100);
      });

      body.appendChild(peopleSection);
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
      row.style.cssText = 'display:flex;flex-direction:row;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none;';
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
    borderInput.style.cssText = 'width:32px;height:26px;padding:0;border:1px solid var(--cp-border-strong);border-radius:3px;cursor:pointer;';
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
    rangeStart.type = 'date';
    rangeStart.value = formatDate(this.viewport.windowStart);
    rangeStart.className = 'cp-filter-input cp-filter-input--full';
    rangeSection.appendChild(rangeStart);

    const rangeTo = document.createElement('div');
    rangeTo.style.cssText = 'font-size:11px;color:var(--cp-text-muted);text-align:center;margin:2px 0;';
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
      const startYmd = rangeStart.value;
      const endYmd   = rangeEnd.value;
      if (!startYmd || !endYmd) { alert('Please select start and end dates.'); return; }
      if (startYmd >= endYmd) { alert('Start must be before end date.'); return; }
      this.handleCustomRange(parseDate(startYmd), parseDate(endYmd));
    });
    rangeSection.appendChild(applyBtn);
    body.appendChild(rangeSection);
  }

  private handleReorderLane(sourceId: string, targetIndex: number): void {
    // Snapshot orders before the move
    const before = this.data.lanes.map(l => ({ id: l.id, order: l.order }));

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

    const after = this.data.lanes.map(l => ({ id: l.id, order: l.order }));
    this.history.push({
      label: 'Reorder lane',
      do: () => {
        after.forEach(({ id, order }) => { const l = this.data.lanes.find(x => x.id === id); if (l) l.order = order; });
        this.refresh();
      },
      undo: () => {
        before.forEach(({ id, order }) => { const l = this.data.lanes.find(x => x.id === id); if (l) l.order = order; });
        this.refresh();
      },
    });

    this.save();
    this.refresh();
  }

  private handleToggleLabel(label: string): void {
    if (this.filterState.activeLabels.has(label)) {
      this.filterState.activeLabels.delete(label);
    } else {
      this.filterState.activeLabels.add(label);
    }
    this.renderer.update(this.data, this.filterState); this.listRenderer?.update(this.data, this.filterState); this.peopleRenderer?.update(this.data, this.filterState);
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
    this.syncUrl();
  }

  private handleToggleTaggedUser(userId: number): void {
    if (this.filterState.activeTaggedUserIds.has(userId)) {
      this.filterState.activeTaggedUserIds.delete(userId);
    } else {
      this.filterState.activeTaggedUserIds.add(userId);
    }
    this.renderer.update(this.data, this.filterState); this.listRenderer?.update(this.data, this.filterState); this.peopleRenderer?.update(this.data, this.filterState);
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
    this.syncUrl();
  }

  private handleToggleSelectedPerson(userId: number): void {
    if (this.filterState.selectedPeopleIds.has(userId)) {
      this.filterState.selectedPeopleIds.delete(userId);
    } else {
      this.filterState.selectedPeopleIds.add(userId);
    }
    this.peopleRenderer?.update(this.data, this.filterState);
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
    this.syncUrl();
  }

  private handleSelectAllPeople(): void {
    this.members.forEach(m => this.filterState.selectedPeopleIds.add(m.id));
    this.peopleRenderer?.update(this.data, this.filterState);
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
    this.syncUrl();
  }

  private handleClearSelectedPeople(): void {
    this.filterState.selectedPeopleIds.clear();
    this.peopleRenderer?.update(this.data, this.filterState);
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
    this.syncUrl();
  }

  private buildToolbar(): void {
    this.toolbar.innerHTML = '';
    this.toolbar.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;background:var(--cp-surface);border-bottom:1px solid var(--cp-border);';

    // Title
    const title = document.createElement('span');
    title.className = 'cp-toolbar-title';
    title.style.cssText = 'font-weight:600;font-size:14px;color:var(--cp-text);margin-right:4px;';
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
    viewGroup.dataset.tour = 'views';

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

    const peopleBtn = document.createElement('button');
    peopleBtn.textContent = 'People';
    peopleBtn.className = 'cp-btn' + (this.viewMode === 'people' ? ' cp-btn-active' : '');
    peopleBtn.title = 'People view';
    peopleBtn.addEventListener('click', () => this.setViewMode('people'));
    viewGroup.appendChild(peopleBtn);
    this.viewPeopleBtn = peopleBtn;

    this.toolbar.appendChild(viewGroup);

    // Color-by select
    const colorByWrap = document.createElement('div');
    colorByWrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-left:8px;';
    colorByWrap.dataset.tour = 'colorby';

    const colorByLabel = document.createElement('label');
    colorByLabel.textContent = 'Color by';
    colorByLabel.style.cssText = 'font-size:11px;color:var(--cp-text-muted);white-space:nowrap;';

    const colorBySel = document.createElement('select');
    colorBySel.style.cssText = 'font-size:11px;padding:2px 4px;border:1px solid var(--cp-border);border-radius:4px;background:var(--cp-surface);color:var(--cp-text);cursor:pointer;';
    const colorByOptions: Array<[ColorBy, string]> = [
      ['activity', 'Activity'],
      ['lane',     'Lane'],
      ['label',    'Label'],
      ['status',   'Status'],
      ['owner',    'Owner'],
    ];
    colorByOptions.forEach(([val, text]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      if (val === this.colorBy) opt.selected = true;
      colorBySel.appendChild(opt);
    });
    colorBySel.addEventListener('change', () => {
      this.colorBy = colorBySel.value as ColorBy;
      localStorage.setItem('cp_color_by', this.colorBy);
      this.renderer.setColorBy(this.colorBy);
      this.renderer.update(this.data, this.filterState);
      this.updateColorByLegend();
      this.syncUrl();
    });
    colorByWrap.appendChild(colorByLabel);
    colorByWrap.appendChild(colorBySel);
    this.toolbar.appendChild(colorByWrap);

    // Views dropdown
    this.toolbar.appendChild(this.buildViewsControl());

    // Add-event + Import buttons (edit/owner only)
    if (this.config.permission !== 'view') {
      const addEventBtn = document.createElement('button');
      addEventBtn.textContent = '+ Add event';
      addEventBtn.title = 'Add a new event (n)';
      addEventBtn.className = 'cp-btn cp-btn-primary';
      addEventBtn.style.marginLeft = '8px';
      addEventBtn.dataset.tour = 'add-event';
      addEventBtn.addEventListener('click', () => this.handleAddEvent());
      this.toolbar.appendChild(addEventBtn);

      const importBtn = document.createElement('button');
      importBtn.textContent = 'Import';
      importBtn.title = 'Import events from Outlook';
      importBtn.className = 'cp-btn';
      importBtn.addEventListener('click', () => this.handleOutlookImport());
      this.toolbar.appendChild(importBtn);
    }

    // Export group
    {
      const exportGroup = document.createElement('div');
      exportGroup.className = 'cp-zoom-controls';
      exportGroup.style.marginLeft = '8px';
      exportGroup.dataset.tour = 'export';

      // Print button
      const printBtn = document.createElement('button');
      printBtn.textContent = 'Print';
      printBtn.title = 'Print or save as PDF';
      printBtn.className = 'cp-btn';
      printBtn.addEventListener('click', () => {
        const title = this.config.title;
        const start = this.config.startDate;
        const end   = this.config.endDate;
        document.body.setAttribute('data-print-title', `${title} — ${start} to ${end}`);
        document.body.dataset.printView = this.viewMode;

        // Force the light palette for the duration of the print. The @media
        // print block in circular-planner.css cannot do this on its own — the
        // disc's colours are baked into SVG attributes at render time, so they
        // must be re-rendered before the print dialog reads the document.
        const root = document.documentElement;
        const previousTheme = root.dataset.theme;
        const needsRestore = previousTheme === 'dark';
        if (needsRestore) {
          root.dataset.theme = 'light';
          this.renderer.setTheme();
        }

        const cleanup = () => {
          document.body.removeAttribute('data-print-title');
          delete document.body.dataset.printView;
          if (needsRestore) {
            root.dataset.theme = previousTheme as string;
            this.renderer.setTheme();
          }
          window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        window.print();
      });
      exportGroup.appendChild(printBtn);

      // PNG button
      const canvasSupported = typeof document.createElement('canvas').toDataURL === 'function';
      const pngBtn = document.createElement('button');
      pngBtn.textContent = 'PNG';
      pngBtn.className = 'cp-btn';
      if (canvasSupported) {
        pngBtn.addEventListener('click', () => {
          const slug = (s: string) =>
            s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'planner';
          const filename = `${slug(this.config.title)}-${formatDate(new Date())}.png`;
          const node = this.renderer.getSVGNode();
          const vb = node.viewBox.baseVal;
          const vbW = vb && vb.width  > 0 ? vb.width  : 800;
          const vbH = vb && vb.height > 0 ? vb.height : 800;
          // Serialize inside the light-palette window — colours are baked into
          // SVG attributes at render time and cannot be corrected afterwards.
          const svgStr = this.withLightPalette(() => serializeSVGWithStyles(node));
          rasterizeSVGString(svgStr, vbW, vbH, filename).catch((err) => {
            console.error('PNG export failed:', err);
            const msg = err instanceof Error && err.message ? err.message : String(err);
            toast.error(`PNG export failed: ${msg}`);
          });
        });
      }
      this.pngBtn = pngBtn;
      this.updatePngBtnState();
      exportGroup.appendChild(pngBtn);

      this.toolbar.appendChild(exportGroup);
    }

    // Spacer
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1;';
    this.toolbar.appendChild(spacer);

    // Save-state badge
    const saveBadge = document.createElement('span');
    saveBadge.id = 'cp-save-badge';
    saveBadge.className = 'cp-save-badge cp-save-badge--idle';
    this.toolbar.appendChild(saveBadge);
    this.saveBadgeEl = saveBadge;

    // Navigation + zoom controls
    const zoomControls = document.createElement('div');
    zoomControls.className = 'cp-zoom-controls';
    zoomControls.dataset.tour = 'nav';

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

    const todayBtn = document.createElement('button');
    todayBtn.textContent = 'Today';
    todayBtn.title = 'Jump to today (preserves zoom level)';
    todayBtn.className = 'cp-btn';
    todayBtn.addEventListener('click', () => this.handleNavigateToday());
    zoomControls.appendChild(todayBtn);

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
    this.listRenderer?.update(this.data, this.filterState);
    this.peopleRenderer?.update(this.data, this.filterState);
    // Rebuild sidebar to reflect lane changes
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
    this.updateColorByLegend();
  }

  private updateColorByLegend(): void {
    if (!this.colorByLegend) return;
    if (this.colorBy === 'activity') {
      this.colorByLegend.style.display = 'none';
      return;
    }
    this.colorByLegend.style.display = 'flex';
    this.colorByLegend.innerHTML = '';

    // Header label
    const hdr = document.createElement('span');
    hdr.style.cssText = 'font-weight:600;color:var(--cp-text-muted);font-size:11px;margin-right:4px;';
    const modeLabels: Record<ColorBy, string> = { activity: 'Activity', lane: 'Lane', label: 'Label', status: 'Status', owner: 'Owner' };
    hdr.textContent = `${modeLabels[this.colorBy]}:`;
    this.colorByLegend.appendChild(hdr);

    const entries: Array<{ label: string; color: string }> = [];

    if (this.colorBy === 'status') {
      const statuses: Array<[string, string]> = [
        ['planned', 'Planned'],
        ['in_progress', 'In progress'],
        ['done', 'Done'],
        ['cancelled', 'Cancelled'],
      ];
      statuses.forEach(([key, label]) => {
        entries.push({ label, color: STATUS_COLORS[key] });
      });
    } else if (this.colorBy === 'lane') {
      this.data.lanes.forEach(lane => {
        if (!this.filterState.hiddenLaneIds.has(lane.id)) {
          const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(lane.color || '');
          const color = m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, 0.85)` : (lane.color || '#999');
          entries.push({ label: lane.name, color });
        }
      });
    } else if (this.colorBy === 'label') {
      const seen = new Set<string>();
      this.data.lanes.forEach(lane => {
        lane.activities.forEach(act => {
          if (act.label && !seen.has(act.label)) {
            seen.add(act.label);
            entries.push({ label: act.label, color: colorForString(act.label) });
          }
        });
      });
      if (entries.length === 0) {
        entries.push({ label: '(no label)', color: '#999' });
      }
    } else if (this.colorBy === 'owner') {
      const seen = new Set<string>();
      this.data.lanes.forEach(lane => {
        lane.activities.forEach(act => {
          const owner = act.createdBy || '';
          if (!seen.has(owner)) {
            seen.add(owner);
            entries.push({ label: owner || '(unknown)', color: owner ? colorForString(owner) : '#999' });
          }
        });
      });
    }

    entries.forEach(({ label, color }) => {
      const item = document.createElement('span');
      item.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';

      const swatch = document.createElement('span');
      swatch.style.cssText = `display:inline-block;width:12px;height:12px;border-radius:50%;background:${color};flex-shrink:0;`;

      const txt = document.createElement('span');
      txt.textContent = label;
      txt.style.cssText = 'font-size:11px;color:var(--cp-text);';

      item.appendChild(swatch);
      item.appendChild(txt);
      this.colorByLegend.appendChild(item);
    });
  }

  /** Build the "Views" dropdown control for the toolbar. */
  private buildViewsControl(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-block;margin-left:8px;';

    const btn = document.createElement('button');
    btn.className = 'cp-btn';
    btn.textContent = 'Views';
    btn.title = 'Saved views';
    wrap.appendChild(btn);

    const dropdown = document.createElement('div');
    dropdown.style.cssText = [
      'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:200;',
      'background:var(--cp-surface);border:1px solid var(--cp-border);border-radius:6px;',
      'box-shadow:0 4px 16px rgba(0,0,0,0.15);min-width:220px;max-width:320px;',
      'overflow:hidden;',
    ].join('');
    wrap.appendChild(dropdown);

    let isOpen = false;

    const openDropdown = async () => {
      isOpen = true;
      btn.classList.add('cp-btn-active');
      dropdown.style.display = 'block';
      await this.renderViewsDropdown(dropdown, () => closeDropdown());
    };

    const closeDropdown = () => {
      isOpen = false;
      btn.classList.remove('cp-btn-active');
      dropdown.style.display = 'none';
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isOpen) closeDropdown();
      else openDropdown();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (isOpen && !wrap.contains(e.target as Node)) closeDropdown();
    });

    return wrap;
  }

  /** Render (or re-render) the saved views dropdown content. */
  private async renderViewsDropdown(dropdown: HTMLElement, close: () => void): Promise<void> {
    dropdown.innerHTML = '';

    // Loading indicator
    const loading = document.createElement('div');
    loading.textContent = 'Loading…';
    loading.style.cssText = 'padding:10px 14px;font-size:12px;color:var(--cp-text-muted);';
    dropdown.appendChild(loading);

    let views: SavedView[] = [];
    try {
      views = await listViews(this.config.plannerId);
    } catch {
      dropdown.innerHTML = '';
      const err = document.createElement('div');
      err.textContent = 'Could not load views.';
      err.style.cssText = 'padding:10px 14px;font-size:12px;color:var(--cp-text-muted);';
      dropdown.appendChild(err);
      return;
    }

    dropdown.innerHTML = '';

    const listSection = document.createElement('div');
    listSection.style.cssText = 'max-height:240px;overflow-y:auto;';

    if (views.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No saved views yet.';
      empty.style.cssText = 'padding:10px 14px;font-size:12px;color:var(--cp-text-muted);';
      listSection.appendChild(empty);
    } else {
      views.forEach((v) => {
        const row = document.createElement('div');
        row.style.cssText = [
          'display:flex;align-items:center;gap:6px;padding:7px 14px;cursor:pointer;',
          'font-size:12px;color:var(--cp-text);',
          'border-bottom:1px solid var(--cp-border);',
        ].join('');
        row.style.transition = 'background 0.1s';
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--cp-surface-alt, rgba(0,0,0,0.04))'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });

        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        nameSpan.textContent = v.name;
        row.appendChild(nameSpan);

        // Show "by Username" attribution
        {
          const bySpan = document.createElement('span');
          bySpan.textContent = `by ${v.createdBy.username}`;
          bySpan.style.cssText = 'font-size:10px;color:var(--cp-text-muted);white-space:nowrap;flex-shrink:0;';
          row.appendChild(bySpan);
        }

        // Shared indicator
        if (v.isShared) {
          const sharedTag = document.createElement('span');
          sharedTag.textContent = 'shared';
          sharedTag.style.cssText = [
            'font-size:9px;padding:1px 4px;border-radius:3px;flex-shrink:0;',
            'background:rgba(59,130,246,0.15);color:var(--cp-primary,#3b82f6);',
          ].join('');
          row.appendChild(sharedTag);
        }

        // Delete button (shown on hover via CSS approach using JS)
        const delBtn = document.createElement('button');
        delBtn.textContent = '×';
        delBtn.title = 'Delete view';
        delBtn.style.cssText = [
          'flex-shrink:0;border:none;background:none;cursor:pointer;',
          'font-size:14px;line-height:1;padding:0 2px;color:var(--cp-text-muted);',
          'opacity:0;transition:opacity 0.1s;',
        ].join('');
        row.addEventListener('mouseenter', () => { delBtn.style.opacity = '1'; });
        row.addEventListener('mouseleave', () => { delBtn.style.opacity = '0'; });
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete view "${v.name}"?`)) return;
          try {
            await deleteView(this.config.plannerId, v.id);
            await this.renderViewsDropdown(dropdown, close);
          } catch {
            // toast already shown by api-client
          }
        });
        row.appendChild(delBtn);

        row.addEventListener('click', () => {
          this.applyViewState(v.state);
          close();
        });

        listSection.appendChild(row);
      });
    }

    dropdown.appendChild(listSection);

    // Separator
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid var(--cp-border);';
    dropdown.appendChild(sep);

    // "Save current view…" item
    const saveRow = document.createElement('div');
    saveRow.style.cssText = 'padding:8px 14px;';

    const saveLabel = document.createElement('div');
    saveLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--cp-text);margin-bottom:6px;';
    saveLabel.textContent = 'Save current view…';
    saveRow.appendChild(saveLabel);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'View name';
    nameInput.maxLength = 120;
    nameInput.style.cssText = [
      'width:100%;box-sizing:border-box;padding:4px 6px;font-size:12px;',
      'border:1px solid var(--cp-border);border-radius:4px;',
      'background:var(--cp-surface);color:var(--cp-text);',
    ].join('');
    saveRow.appendChild(nameInput);

    // Shared checkbox — only for planner owner
    let isSharedCheckbox: HTMLInputElement | null = null;
    if (this.config.isOwner) {
      const sharedWrap = document.createElement('label');
      sharedWrap.style.cssText = 'display:flex;flex-direction:row;align-items:center;gap:5px;font-size:11px;color:var(--cp-text);margin-top:5px;cursor:pointer;';

      isSharedCheckbox = document.createElement('input');
      isSharedCheckbox.type = 'checkbox';
      isSharedCheckbox.style.cursor = 'pointer';

      const sharedText = document.createElement('span');
      sharedText.textContent = 'Share with all planner viewers';
      sharedWrap.appendChild(isSharedCheckbox);
      sharedWrap.appendChild(sharedText);
      saveRow.appendChild(sharedWrap);
    }

    const saveBtn = document.createElement('button');
    saveBtn.className = 'cp-btn cp-btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'width:100%;margin-top:6px;font-size:12px;';
    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }

      // Encode current state as a query string (without the planner `id` param).
      // We strip the leading `?id=N&` portion — decode() ignores `id` anyway,
      // but storing only the state params keeps things clean.
      const fullQs = encodeUrlState(location.search, {
        filterState: this.filterState,
        viewport: this.viewport,
        viewMode: this.viewMode,
        colorBy: this.colorBy,
        defaults: {
          viewport: { windowStart: new Date(this.config.startDate), windowEnd: new Date(this.config.endDate), zoomLevel: this.viewport.zoomLevel },
          viewMode: 'disc',
          colorBy: 'activity',
        },
      });
      // Strip leading `?` and remove the `id` param to store only state.
      const stateParams = new URLSearchParams(fullQs.replace(/^\?/, ''));
      stateParams.delete('id');
      const stateStr = stateParams.toString();

      const isShared = isSharedCheckbox ? isSharedCheckbox.checked : false;
      saveBtn.disabled = true;
      try {
        await createView(this.config.plannerId, name, stateStr, isShared);
        await this.renderViewsDropdown(dropdown, close);
        toast.success('View saved');
      } catch {
        saveBtn.disabled = false;
      }
    });
    saveRow.appendChild(saveBtn);

    dropdown.appendChild(saveRow);
  }

  /** Apply a saved view state string (query-string format) to the current planner. */
  private applyViewState(stateStr: string): void {
    const urlState = decodeUrlState(stateStr);

    if (urlState.viewport?.from && urlState.viewport?.to && urlState.viewport?.zoom) {
      this.viewport = { windowStart: urlState.viewport.from, windowEnd: urlState.viewport.to, zoomLevel: urlState.viewport.zoom };
    } else if (urlState.viewport?.zoom) {
      this.viewport = { ...this.viewport, zoomLevel: urlState.viewport.zoom };
    }

    if (urlState.filterState) {
      if (urlState.filterState.searchTerm !== undefined) this.filterState.searchTerm = urlState.filterState.searchTerm;
      if (urlState.filterState.hiddenLaneIds) this.filterState.hiddenLaneIds = urlState.filterState.hiddenLaneIds;
      if (urlState.filterState.activeLabels) this.filterState.activeLabels = urlState.filterState.activeLabels;
      if (urlState.filterState.activeTaggedUserIds) this.filterState.activeTaggedUserIds = urlState.filterState.activeTaggedUserIds;
      if (urlState.filterState.selectedPeopleIds) this.filterState.selectedPeopleIds = urlState.filterState.selectedPeopleIds;
    } else {
      // If no filter state in the saved view, reset to defaults.
      this.filterState = { hiddenLaneIds: new Set(), searchTerm: '', activeLabels: new Set(), activeTaggedUserIds: new Set(), selectedPeopleIds: new Set() };
    }

    if (urlState.viewMode) {
      this.viewMode = urlState.viewMode;
      localStorage.setItem('cp_view_mode', this.viewMode);
      this.applyViewMode();
    }

    if (urlState.colorBy) {
      this.colorBy = urlState.colorBy;
      localStorage.setItem('cp_color_by', this.colorBy);
      this.renderer.setColorBy(this.colorBy);
    }

    this.refresh();
    this.refreshViewport();
    // Rebuild toolbar so view-mode buttons and color-by select reflect new state.
    this.buildToolbar();
  }

  /** Mirror the current filter/viewport/viewMode/colorBy state into the URL (replaceState). */
  private syncUrl(): void {
    const qs = encodeUrlState(location.search, {
      filterState: this.filterState,
      viewport: this.viewport,
      viewMode: this.viewMode,
      colorBy: this.colorBy,
      defaults: {
        viewport: defaultViewport(this.config),
        viewMode: 'disc',
        colorBy: 'activity',
      },
    });
    history.replaceState(null, '', qs);
  }

  private refreshViewport(): void {
    this.renderer.updateViewport(this.viewport);
    this.listRenderer?.updateViewport(this.viewport);
    this.peopleRenderer?.updateViewport(this.viewport);
    this.updateViewportState();
    this.syncUrl();
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

  private handleNavigateToday(): void {
    this.viewport = navigateToToday(this.viewport.zoomLevel, this.config);
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
    this.renderer.update(this.data, this.filterState); this.listRenderer?.update(this.data, this.filterState); this.peopleRenderer?.update(this.data, this.filterState);
    const sidebarBody = document.querySelector('#cp-sidebar .cp-sidebar-body') as HTMLElement | null;
    if (sidebarBody) this.buildSidebar(sidebarBody);
    this.syncUrl();
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
      (activity) => this.addActivity(activity), () => {}, this.config.endDate);
  }

  private handleAddEvent(): void {
    const firstLane = this.data.lanes.find(l => !this.filterState.hiddenLaneIds.has(l.id)) ?? this.data.lanes[0];
    if (!firstLane) { this.handleAddLane(); return; }
    const today = new Date();
    const inViewport = today >= this.viewport.windowStart && today <= this.viewport.windowEnd;
    const seedDate = inViewport
      ? today
      : new Date((this.viewport.windowStart.getTime() + this.viewport.windowEnd.getTime()) / 2);
    this.handleClickLane(firstLane.id, seedDate);
  }

  private handleClickActivity(activity: Activity): void {
    this.lastSelectedActivity = activity;
    // Find the base activity (occurrences share the base's id).
    const base = this.data.lanes.flatMap(l => l.activities).find(a => a.id === activity.id) ?? activity;
    const isRecurring = !!base.recurrence && base.recurrence.type !== 'none';
    const occurrenceDate = isRecurring ? activity.startDate : undefined;
    showActivityDialog(base.laneId, this.data.lanes, parseDate(base.startDate), base,
      (updated) => this.updateActivity(updated), (id) => this.deleteActivity(id),
      this.config.endDate, occurrenceDate);
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

  private handleDragCommit(activity: Activity, newStart: Date, newEnd: Date, newLaneId: string): void {
    let origLane: Lane | null = null;
    let base: Activity | null = null;
    for (const lane of this.data.lanes) {
      const found = lane.activities.find(a => a.id === activity.id);
      if (found) { base = found; origLane = lane; break; }
    }
    if (!base || !origLane) return;

    const origStartStr = base.startDate;
    const origEndStr = base.endDate;
    const origLaneId = origLane.id;
    const newStartStr = formatDate(newStart);
    const newEndStr = formatDate(newEnd);

    if (newStartStr === origStartStr && newEndStr === origEndStr && newLaneId === origLaneId) return;

    const moveActivity = (act: Activity, fromLaneId: string, toLaneId: string, startStr: string, endStr: string) => {
      for (const lane of this.data.lanes) {
        const i = lane.activities.findIndex(a => a.id === act.id);
        if (i !== -1) { lane.activities.splice(i, 1); break; }
      }
      const targetLane = this.data.lanes.find(l => l.id === toLaneId);
      if (targetLane) {
        act.startDate = startStr;
        act.endDate = endStr;
        act.laneId = toLaneId;
        targetLane.activities.push(act);
      }
    };

    moveActivity(base, origLaneId, newLaneId, newStartStr, newEndStr);

    this.history.push({
      label: `Move activity "${base.title}"`,
      do: () => {
        const b = this.data.lanes.flatMap(l => l.activities).find(a => a.id === activity.id);
        if (b) moveActivity(b, b.laneId, newLaneId, newStartStr, newEndStr);
        this.refreshActiveView();
      },
      undo: () => {
        const b = this.data.lanes.flatMap(l => l.activities).find(a => a.id === activity.id);
        if (b) moveActivity(b, b.laneId, origLaneId, origStartStr, origEndStr);
        this.refreshActiveView();
      },
    });

    this.save();
    this.refreshActiveView();
  }

  // Update only the currently visible renderer. The other two are re-rendered
  // lazily when the user switches to them via applyViewMode(), which already
  // calls .update() on the renderer it's switching into.
  private refreshActiveView(): void {
    if (this.viewMode === 'list')        this.listRenderer?.update(this.data, this.filterState);
    else if (this.viewMode === 'people') this.peopleRenderer?.update(this.data, this.filterState);
    else                                  this.renderer.update(this.data, this.filterState);
  }

  private addActivity(activity: Activity): void {
    const lane = this.data.lanes.find(l => l.id === activity.laneId);
    if (!lane) return;
    lane.activities.push(activity);
    this.history.push({
      label: `Add activity "${activity.title}"`,
      do: () => {
        const l = this.data.lanes.find(x => x.id === activity.laneId);
        if (l && !l.activities.find(a => a.id === activity.id)) l.activities.push(JSON.parse(JSON.stringify(activity)));
        this.refresh();
      },
      undo: () => {
        for (const l of this.data.lanes) {
          const i = l.activities.findIndex(a => a.id === activity.id);
          if (i !== -1) { l.activities.splice(i, 1); break; }
        }
        this.refresh();
      },
    });
    this.save();
    this.refresh();
  }

  private updateActivity(updated: Activity): void {
    // Find and capture the previous version before mutating
    let prevActivity: Activity | null = null;
    let prevLaneId: string | null = null;
    for (const lane of this.data.lanes) {
      const idx = lane.activities.findIndex(a => a.id === updated.id);
      if (idx !== -1) {
        prevActivity = JSON.parse(JSON.stringify(lane.activities[idx]));
        prevLaneId = lane.id;
        lane.activities.splice(idx, 1);
        break;
      }
    }
    const targetLane = this.data.lanes.find(l => l.id === updated.laneId);
    if (targetLane) targetLane.activities.push(updated);
    const snapshot = JSON.parse(JSON.stringify(updated));
    if (prevActivity && prevLaneId) {
      const prev = prevActivity;
      const prevLane = prevLaneId;
      this.history.push({
        label: `Edit activity "${updated.title}"`,
        do: () => {
          for (const l of this.data.lanes) { const i = l.activities.findIndex(a => a.id === snapshot.id); if (i !== -1) { l.activities.splice(i, 1); break; } }
          const tl = this.data.lanes.find(l => l.id === snapshot.laneId);
          if (tl) tl.activities.push(JSON.parse(JSON.stringify(snapshot)));
          this.refresh();
        },
        undo: () => {
          for (const l of this.data.lanes) { const i = l.activities.findIndex(a => a.id === prev.id); if (i !== -1) { l.activities.splice(i, 1); break; } }
          const ol = this.data.lanes.find(l => l.id === prevLane);
          if (ol) ol.activities.push(JSON.parse(JSON.stringify(prev)));
          this.refresh();
        },
      });
    }
    this.save();
    this.refresh();
  }

  private deleteActivity(activityId: string): void {
    let deletedActivity: Activity | null = null;
    let deletedLaneId: string | null = null;
    for (const lane of this.data.lanes) {
      const idx = lane.activities.findIndex(a => a.id === activityId);
      if (idx !== -1) {
        deletedActivity = JSON.parse(JSON.stringify(lane.activities[idx]));
        deletedLaneId = lane.id;
        lane.activities.splice(idx, 1);
        break;
      }
    }
    if (deletedActivity && deletedLaneId) {
      const act = deletedActivity;
      const laneId = deletedLaneId;
      this.history.push({
        label: `Delete activity "${act.title}"`,
        do: () => {
          for (const l of this.data.lanes) { const i = l.activities.findIndex(a => a.id === act.id); if (i !== -1) { l.activities.splice(i, 1); break; } }
          this.refresh();
        },
        undo: () => {
          const l = this.data.lanes.find(x => x.id === laneId);
          if (l) l.activities.push(JSON.parse(JSON.stringify(act)));
          this.refresh();
        },
      });
    }
    this.save();
    this.refresh();
  }

  private addLane(lane: Lane): void {
    if (!lane.color) lane.color = laneColor(lane.order);
    this.data.lanes.push(lane);
    const snapshot: Lane = JSON.parse(JSON.stringify(lane));
    this.history.push({
      label: `Add lane "${lane.name}"`,
      do: () => {
        if (!this.data.lanes.find(l => l.id === snapshot.id)) this.data.lanes.push(JSON.parse(JSON.stringify(snapshot)));
        this.refresh();
      },
      undo: () => {
        this.data.lanes = this.data.lanes.filter(l => l.id !== snapshot.id);
        this.refresh();
      },
    });
    this.save();
    this.refresh();
  }

  private updateLane(updated: Lane): void {
    const idx = this.data.lanes.findIndex(l => l.id === updated.id);
    if (idx !== -1) {
      const prev: Lane = JSON.parse(JSON.stringify(this.data.lanes[idx]));
      updated.activities = this.data.lanes[idx].activities;
      this.data.lanes[idx] = updated;
      const snap: Lane = JSON.parse(JSON.stringify(updated));
      this.history.push({
        label: `Edit lane "${updated.name}"`,
        do: () => {
          const i = this.data.lanes.findIndex(l => l.id === snap.id);
          if (i !== -1) { const acts = this.data.lanes[i].activities; this.data.lanes[i] = JSON.parse(JSON.stringify(snap)); this.data.lanes[i].activities = acts; }
          this.refresh();
        },
        undo: () => {
          const i = this.data.lanes.findIndex(l => l.id === prev.id);
          if (i !== -1) { const acts = this.data.lanes[i].activities; this.data.lanes[i] = JSON.parse(JSON.stringify(prev)); this.data.lanes[i].activities = acts; }
          this.refresh();
        },
      });
      this.save();
      this.refresh();
    }
  }

  private deleteLane(laneId: string): void {
    const laneSnap = this.data.lanes.find(l => l.id === laneId);
    if (!laneSnap) return;
    const snapshot: Lane = JSON.parse(JSON.stringify(laneSnap));
    this.data.lanes = this.data.lanes.filter(l => l.id !== laneId);
    this.data.lanes.sort((a, b) => a.order - b.order).forEach((l, i) => l.order = i);
    const ordersAfter = this.data.lanes.map(l => ({ id: l.id, order: l.order }));
    this.history.push({
      label: `Delete lane "${snapshot.name}"`,
      do: () => {
        this.data.lanes = this.data.lanes.filter(l => l.id !== snapshot.id);
        ordersAfter.forEach(({ id, order }) => { const l = this.data.lanes.find(x => x.id === id); if (l) l.order = order; });
        this.refresh();
      },
      undo: () => {
        if (!this.data.lanes.find(l => l.id === snapshot.id)) this.data.lanes.push(JSON.parse(JSON.stringify(snapshot)));
        this.data.lanes.sort((a, b) => a.order - b.order).forEach((l, i) => l.order = i);
        this.refresh();
      },
    });
    this.save();
    this.refresh();
  }

  private setSaveBadge(state: 'saving' | 'saved' | 'error'): void {
    if (!this.saveBadgeEl) return;
    if (this.saveFadeTimer) { clearTimeout(this.saveFadeTimer); this.saveFadeTimer = null; }

    this.saveBadgeEl.className = 'cp-save-badge cp-save-badge--' + state;

    if (state === 'saving') {
      this.saveBadgeEl.textContent = 'Saving\u2026';
    } else if (state === 'saved') {
      this.saveBadgeEl.textContent = 'Saved \u2713';
      this.saveFadeTimer = setTimeout(() => {
        if (this.saveBadgeEl) this.saveBadgeEl.className = 'cp-save-badge cp-save-badge--idle';
        this.saveFadeTimer = null;
      }, 2000);
    } else {
      this.saveBadgeEl.textContent = 'Save failed \u2014 retry';
      this.saveBadgeEl.onclick = () => this.dataManager.save(this.data);
    }
  }

  /** Called when the global theme changes — re-renders the SVG with new CSS var values. */
  onThemeChange(): void {
    this.renderer.setTheme();
  }

  /**
   * Run `fn` with the disc re-rendered against the light palette, then restore.
   *
   * Why this exists: renderDefs() reads the CSS custom properties through
   * getComputedStyle at render time and bakes the results into `stop-color`
   * and `fill` *attributes* (18 cssVar reads in renderer.ts). A CSS override —
   * including the `@media print` block in circular-planner.css — cannot
   * retroactively change an attribute that was already serialized. So a dark
   * session produced dark PNGs, dark SVGs and dark printouts, and the print
   * CSS never had any effect on the disc at all.
   *
   * Everything here is synchronous, so the browser never paints the
   * intermediate light state and the user sees no flash. It deliberately sets
   * the dataset attribute directly rather than calling applyTheme(), which
   * would persist the change to localStorage and fire a theme-change event.
   */
  withLightPalette<T>(fn: () => T): T {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    if (previous === 'light' || previous === undefined) return fn();

    root.dataset.theme = 'light';
    this.renderer.setTheme();
    try {
      return fn();
    } finally {
      root.dataset.theme = previous;
      this.renderer.setTheme();
    }
  }

  /** Open the activity dialog for the given activity (used by hash-based deep links). */
  openActivity(activity: Activity): void {
    this.handleClickActivity(activity);
  }
}
