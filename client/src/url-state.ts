import { FilterState, Viewport, ZoomLevel } from './types';
import { parseDate, formatDate, ColorBy } from './utils';

type ViewMode = 'disc' | 'list' | 'people';

export interface UrlState {
  filterState?: Partial<FilterState>;
  viewport?: { from?: Date; to?: Date; zoom?: ZoomLevel };
  viewMode?: ViewMode;
  colorBy?: ColorBy;
}

const VALID_ZOOM_LEVELS = new Set<string>([
  ZoomLevel.Year, ZoomLevel.Quarter, ZoomLevel.Month, ZoomLevel.Week,
]);

const VALID_VIEW_MODES = new Set<string>(['disc', 'list', 'people']);

const VALID_COLOR_BY = new Set<string>(['activity', 'lane', 'label', 'status', 'owner']);

/** Parse a YYYY-MM-DD string, returning undefined on invalid input. */
function safeParseDate(s: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = parseDate(s);
  if (isNaN(d.getTime())) return undefined;
  return d;
}

/**
 * Decode URL-encoded filter/viewport state from a query string.
 * Ignores the `id` param. Tolerates missing or garbage values.
 */
export function decode(search: string): UrlState {
  const params = new URLSearchParams(search);
  const result: UrlState = {};

  // Zoom level
  const z = params.get('z');
  const zoom = z && VALID_ZOOM_LEVELS.has(z) ? (z as ZoomLevel) : undefined;

  // Viewport dates
  const fromStr = params.get('from');
  const toStr = params.get('to');
  const from = fromStr ? safeParseDate(fromStr) : undefined;
  const to = toStr ? safeParseDate(toStr) : undefined;

  if (zoom || from || to) {
    result.viewport = { zoom, from, to };
  }

  // Filter state
  const filterState: Partial<FilterState> = {};

  const q = params.get('q');
  if (q) filterState.searchTerm = q;

  const hl = params.get('hl');
  if (hl) {
    const ids = hl.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length > 0) filterState.hiddenLaneIds = new Set(ids);
  }

  const lb = params.get('lb');
  if (lb) {
    // Each label is URL-decoded individually
    const labels = lb.split(',').map(s => decodeURIComponent(s.trim())).filter(Boolean);
    if (labels.length > 0) filterState.activeLabels = new Set(labels);
  }

  const tu = params.get('tu');
  if (tu) {
    const ids = tu.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (ids.length > 0) filterState.activeTaggedUserIds = new Set(ids);
  }

  const sp = params.get('sp');
  if (sp) {
    const ids = sp.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (ids.length > 0) filterState.selectedPeopleIds = new Set(ids);
  }

  if (Object.keys(filterState).length > 0) {
    result.filterState = filterState;
  }

  // View mode
  const vm = params.get('vm');
  if (vm && VALID_VIEW_MODES.has(vm)) {
    result.viewMode = vm as ViewMode;
  }

  // Color by
  const cb = params.get('cb');
  if (cb && VALID_COLOR_BY.has(cb)) {
    result.colorBy = cb as ColorBy;
  }

  return result;
}

/**
 * Build a full query string preserving the `id` param and encoding the current state.
 * Omits params that match their defaults to keep URLs short.
 */
export function encode(
  currentSearch: string,
  state: {
    filterState: FilterState;
    viewport: Viewport;
    viewMode: ViewMode;
    colorBy: ColorBy;
    defaults: {
      viewport: Viewport;
      viewMode: ViewMode;
      colorBy: ColorBy;
    };
  },
): string {
  const params = new URLSearchParams();

  // Always preserve the planner id
  const existing = new URLSearchParams(currentSearch);
  const id = existing.get('id');
  if (id) params.set('id', id);

  const { filterState, viewport, viewMode, colorBy, defaults } = state;

  // Zoom level — omit if it matches the default
  if (viewport.zoomLevel !== defaults.viewport.zoomLevel) {
    params.set('z', viewport.zoomLevel);
  }

  // Viewport dates — only encode if both differ from defaults
  const fromDiffers = formatDate(viewport.windowStart) !== formatDate(defaults.viewport.windowStart);
  const toDiffers = formatDate(viewport.windowEnd) !== formatDate(defaults.viewport.windowEnd);
  if (fromDiffers) params.set('from', formatDate(viewport.windowStart));
  if (toDiffers) params.set('to', formatDate(viewport.windowEnd));

  // Search term
  if (filterState.searchTerm) params.set('q', filterState.searchTerm);

  // Hidden lane IDs
  if (filterState.hiddenLaneIds.size > 0) {
    params.set('hl', [...filterState.hiddenLaneIds].join(','));
  }

  // Active labels — URL-encode each label value
  if (filterState.activeLabels.size > 0) {
    params.set('lb', [...filterState.activeLabels].map(encodeURIComponent).join(','));
  }

  // Active tagged user IDs
  if (filterState.activeTaggedUserIds.size > 0) {
    params.set('tu', [...filterState.activeTaggedUserIds].join(','));
  }

  // Selected people IDs (people-view picker)
  if (filterState.selectedPeopleIds.size > 0) {
    params.set('sp', [...filterState.selectedPeopleIds].join(','));
  }

  // View mode — omit if disc (default)
  if (viewMode !== 'disc') {
    params.set('vm', viewMode);
  }

  // Color by — omit if activity (default)
  if (colorBy !== 'activity') {
    params.set('cb', colorBy);
  }

  const qs = params.toString();
  return qs ? `?${qs}` : '?';
}
