import { encode, decode } from '../url-state';
import { FilterState, Viewport, ZoomLevel, PlannerConfig } from '../types';
import { parseDate } from '../utils';

const config: PlannerConfig = {
  plannerId: 7,
  title: 'Test',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  isOwner: true,
  permission: 'owner',
  isPublic: false,
};

function emptyFilterState(): FilterState {
  return {
    hiddenLaneIds: new Set(),
    searchTerm: '',
    activeLabels: new Set(),
    activeTaggedUserIds: new Set(),
    selectedPeopleIds: new Set(),
  };
}

function defaultViewport(): Viewport {
  return {
    windowStart: parseDate(config.startDate),
    windowEnd: parseDate(config.endDate),
    zoomLevel: ZoomLevel.Year,
  };
}

/** encode() with everything at its default, so only passthrough params survive. */
function encodeAtDefaults(search: string, overrides: Partial<{
  filterState: FilterState;
  viewport: Viewport;
}> = {}): string {
  const defaults = {
    viewport: defaultViewport(),
    viewMode: 'disc' as const,
    colorBy: 'activity' as const,
  };
  return encode(search, {
    filterState: overrides.filterState ?? emptyFilterState(),
    viewport: overrides.viewport ?? defaultViewport(),
    viewMode: 'disc',
    colorBy: 'activity',
    defaults,
  });
}

describe('encode passthrough params', () => {
  test('preserves the planner id', () => {
    expect(encodeAtDefaults('?id=7')).toBe('?id=7');
  });

  // Regression: syncUrl() runs on every zoom, navigation and filter change. When
  // encode() dropped `token`, a public share-link viewer lost it on their first
  // interaction and got "No public link token provided" after a refresh.
  test('preserves a public share token', () => {
    expect(encodeAtDefaults('?token=abc123')).toContain('token=abc123');
  });

  test('preserves the share token through a filter change', () => {
    const filterState = emptyFilterState();
    filterState.searchTerm = 'kickoff';
    const qs = encodeAtDefaults('?token=abc123', { filterState });
    expect(qs).toContain('token=abc123');
    expect(qs).toContain('q=kickoff');
  });

  test('preserves the disc-as-clock mode params', () => {
    const qs = encodeAtDefaults('?token=t&display=1&now=2026-03-14&flyover=1');
    expect(qs).toContain('token=t');
    expect(qs).toContain('display=1');
    expect(qs).toContain('now=2026-03-14');
    expect(qs).toContain('flyover=1');
  });

  test('does not invent params that were not in the incoming URL', () => {
    expect(encodeAtDefaults('?id=7')).toBe('?id=7');
  });

  // State-owned params must be re-derived, never carried through, or clearing a
  // filter would resurrect it from the previous URL.
  test('drops stale state params rather than carrying them through', () => {
    const qs = encodeAtDefaults('?id=7&q=old&hl=lane1&vm=list&cb=lane&z=week');
    expect(qs).toBe('?id=7');
  });

  test('re-derives state params from the passed state, not the URL', () => {
    const filterState = emptyFilterState();
    filterState.hiddenLaneIds = new Set(['laneA']);
    const qs = encodeAtDefaults('?id=7&hl=laneB', { filterState });
    expect(qs).toContain('hl=laneA');
    expect(qs).not.toContain('laneB');
  });

  test('handles an empty incoming search string', () => {
    expect(encodeAtDefaults('')).toBe('?');
  });
});

describe('decode', () => {
  test('ignores passthrough params and reads only state', () => {
    const st = decode('?id=7&token=abc&display=1&q=kickoff&z=week');
    expect(st.filterState?.searchTerm).toBe('kickoff');
    expect(st.viewport?.zoom).toBe(ZoomLevel.Week);
  });

  test('tolerates garbage values', () => {
    const st = decode('?z=nonsense&vm=bogus&cb=bogus&from=notadate');
    expect(st.viewport?.zoom).toBeUndefined();
    expect(st.viewMode).toBeUndefined();
    expect(st.colorBy).toBeUndefined();
  });

  test('round-trips a search term through encode and decode', () => {
    const filterState = emptyFilterState();
    filterState.searchTerm = 'quarterly review';
    const qs = encodeAtDefaults('?id=7', { filterState });
    expect(decode(qs).filterState?.searchTerm).toBe('quarterly review');
  });
});
