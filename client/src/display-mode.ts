/**
 * display-mode.ts — pure helpers for the unattended wall-display view.
 *
 * Display mode turns the public planner page into something you point a screen
 * at: no header, no toolbar, no sidebar, just the disc, refreshing itself.
 *
 * The logic lives here rather than in index-public.ts so it can be tested
 * without a DOM — the jest suite runs with testEnvironment: "node".
 *
 *   ?display=1  ──>  body.display-mode  ──>  chrome hidden, disc fills viewport
 *                          │
 *                          └──>  poll every 60s
 *                                    │
 *                                    ├── config.updated_at changed ──> setData()
 *                                    ├── unchanged ─────────────────> do nothing
 *                                    └── request failed ────────────> keep last
 *                                                                     good render,
 *                                                                     count failures
 */

/** How often the display re-checks the server. */
export const POLL_INTERVAL_MS = 60_000;

/**
 * Consecutive poll failures tolerated before the display admits it is stale.
 *
 * Five minutes of silence at a 60s interval. Short enough that nobody trusts a
 * frozen screen for long, long enough that one flaky request or a server
 * restart does not put a warning on the wall.
 */
export const STALE_AFTER_FAILURES = 5;

/**
 * Is display mode requested by this query string?
 *
 * Liberal about the value because this URL gets typed by hand into a kiosk
 * browser and copied between machines: `?display`, `?display=1` and
 * `?display=true` all count. `0` and `false` explicitly do not, so the mode can
 * be turned off without editing the URL down.
 */
export function isDisplayMode(search: string): boolean {
  if (!search) return false;
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('display');
  } catch {
    return false;
  }
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/**
 * Should a poll result trigger a re-render?
 *
 * Re-rendering the disc is not free, and an unattended screen may run for
 * weeks, so the default is to do nothing. Only a genuinely changed timestamp
 * causes work.
 *
 * A missing `next` means the server told us nothing useful, so we cannot detect
 * change and deliberately skip rather than re-render blindly every minute
 * forever. A missing `prev` means we have no baseline yet, so adopt it.
 */
export function shouldRerender(prev: string | undefined, next: string | undefined): boolean {
  if (!next) return false;
  if (!prev) return true;
  return prev !== next;
}
