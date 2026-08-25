/**
 * clock.ts — the single source of "now" for date-dependent rendering.
 *
 * Everything the disc draws that depends on the current date reads now()
 * instead of calling `new Date()` directly. That makes the whole render a
 * pure function of time, which is what lets one engine serve every mode:
 *
 *     setNow(null)          ->  live      : follows the wall clock
 *     setNow(d)             ->  pinned    : frozen at d (poster export)
 *     setNow(d) in a loop   ->  swept     : flyover / scrubber
 *     ?now=2026-03-14       ->  pinned    : reproducible screenshots + bug reports
 *
 * Resolution order, highest priority first:
 *
 *     setNow(d)  ──yes──>  return d
 *         │ no
 *         v
 *     ?now=<ISO> ──yes──>  return parsed date   (parsed once, then cached)
 *         │ no
 *         v
 *     new Date()           the wall clock
 *
 * NOT everything that asks the time should come through here. Three kinds of
 * caller must keep reading the wall clock directly, because a swept or pinned
 * clock would actively break them:
 *
 *   - Scheduling      renderer.ts's midnight timer computes a delay from now.
 *                     A swept clock in the past yields a negative delay, so the
 *                     timeout fires immediately, re-renders, re-arms, and spins.
 *   - Write anchors   planner.ts's paste handler shifts a copied activity to
 *                     land on today. Paste is an edit, not a view, so its
 *                     meaning must not change because someone moved a slider.
 *   - Real timestamps toast log entries and export filenames record when a
 *                     thing actually happened in the real world.
 *
 * Those exceptions are enforced by scripts/check-clock-usage.sh, which fails
 * CI on any new `new Date()` in client/src/ outside the documented allowlist.
 */

/** Explicit override from display / flyover / scrub. null means follow the wall clock. */
let pinned: Date | null = null;

/**
 * Cached result of parsing `?now=` from the URL.
 * `undefined` means "not looked at yet"; `null` means "looked, nothing valid there".
 * Cached because now() is called on every render and URL parsing is not free.
 */
let urlOverride: Date | null | undefined;

/**
 * Parse a `now` override out of a query string.
 *
 * Pure and side-effect free so it can be tested without a DOM — the jest suite
 * runs with testEnvironment: "node", where `window` does not exist.
 *
 * Accepts anything Date can parse, so `?now=2026-03-14` and
 * `?now=2026-03-14T09:30:00Z` both work. Returns null for a missing, empty or
 * unparseable value rather than throwing: a malformed URL should degrade to the
 * real date, not break the page.
 */
export function parseNowOverride(search: string): Date | null {
  if (!search) return null;
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('now');
  } catch {
    return null;
  }
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The current date, as far as rendering is concerned.
 *
 * Returns a fresh Date each call so callers cannot mutate shared state — Date
 * is mutable, and handing out the same instance would let one caller's
 * setDate() corrupt every other reader.
 */
export function now(): Date {
  if (pinned) return new Date(pinned.getTime());

  if (urlOverride === undefined) {
    urlOverride = typeof window === 'undefined'
      ? null
      : parseNowOverride(window.location.search);
  }
  if (urlOverride) return new Date(urlOverride.getTime());

  return new Date();
}

/** Pin the clock to a fixed date, or pass null to resume following the wall clock. */
export function setNow(date: Date | null): void {
  pinned = date === null ? null : new Date(date.getTime());
}

/** True when the clock is following the wall clock — no pin and no ?now= override. */
export function isLive(): boolean {
  if (pinned) return false;
  if (urlOverride === undefined) {
    urlOverride = typeof window === 'undefined'
      ? null
      : parseNowOverride(window.location.search);
  }
  return urlOverride === null;
}

/** Drop all overrides and re-read the URL on next use. Test seam. */
export function resetClock(): void {
  pinned = null;
  urlOverride = undefined;
}
