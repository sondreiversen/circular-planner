import {
  isDisplayMode,
  shouldRerender,
  POLL_INTERVAL_MS,
  STALE_AFTER_FAILURES,
} from '../display-mode';

describe('isDisplayMode', () => {
  test('off when the param is absent', () => {
    expect(isDisplayMode('?token=abc')).toBe(false);
    expect(isDisplayMode('')).toBe(false);
  });

  // This URL gets typed into a kiosk browser by hand, so accept the obvious forms.
  test.each(['?display=1', '?display=true', '?display', '?display=', '?display=YES', '?display=On'])(
    'on for %s',
    (search) => {
      expect(isDisplayMode(search)).toBe(true);
    },
  );

  test.each(['?display=0', '?display=false', '?display=no', '?display=OFF', '?display= false '])(
    'off for %s',
    (search) => {
      expect(isDisplayMode(search)).toBe(false);
    },
  );

  test('reads display alongside other params', () => {
    expect(isDisplayMode('?token=abc&display=1&now=2026-03-14')).toBe(true);
    expect(isDisplayMode('?token=abc&z=week')).toBe(false);
  });
});

describe('shouldRerender', () => {
  test('re-renders when the timestamp changed', () => {
    expect(shouldRerender('2026-03-14T09:00:00Z', '2026-03-14T10:00:00Z')).toBe(true);
  });

  test('does nothing when the timestamp is unchanged', () => {
    expect(shouldRerender('2026-03-14T09:00:00Z', '2026-03-14T09:00:00Z')).toBe(false);
  });

  test('adopts a first baseline', () => {
    expect(shouldRerender(undefined, '2026-03-14T09:00:00Z')).toBe(true);
  });

  // Better a still-correct disc than a full re-render every minute for weeks.
  test('skips when the server sent no timestamp', () => {
    expect(shouldRerender('2026-03-14T09:00:00Z', undefined)).toBe(false);
    expect(shouldRerender(undefined, undefined)).toBe(false);
    expect(shouldRerender('2026-03-14T09:00:00Z', '')).toBe(false);
  });
});

describe('constants', () => {
  test('polls once a minute', () => {
    expect(POLL_INTERVAL_MS).toBe(60_000);
  });

  // Long enough to ride out a restart, short enough that nobody trusts a frozen
  // screen for an afternoon.
  test('admits staleness after five minutes of failures', () => {
    expect(STALE_AFTER_FAILURES * POLL_INTERVAL_MS).toBe(5 * 60_000);
  });
});
