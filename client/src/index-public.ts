/**
 * Entry point for the public (unauthenticated) planner view.
 * Uses raw fetch() — NOT api-client.ts — to avoid the 401→redirect-to-login behaviour.
 * Forces permission='view' and isOwner=false regardless of server response.
 */
import { Planner } from './planner';
import { PlannerConfig, PlannerData } from './types';
import { initTheme, applyTheme, currentTheme } from './theme';
import { applyBranding } from './branding';
import {
  isDisplayMode,
  shouldRerender,
  POLL_INTERVAL_MS,
  STALE_AFTER_FAILURES,
} from './display-mode';

interface PublicPlannerResponse {
  config: PlannerConfig;
  data: PlannerData;
  // No top-level updated_at: the server nests it inside `config`.
  // See PlannerConfig.updated_at in types.ts.
}

initTheme();

async function init(): Promise<void> {
  applyBranding();

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  const loadingEl   = document.getElementById('planner-loading');
  const errorEl     = document.getElementById('planner-error');
  const containerEl = document.getElementById('planner-container');

  function showError(msg: string): void {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) {
      errorEl.classList.remove('hidden');
      errorEl.textContent = msg;
    }
  }

  if (!token) {
    showError('No public link token provided.');
    return;
  }

  try {
    // Use raw fetch — no auth header, no redirect-on-401.
    const res = await fetch(`/api/public/planners/${encodeURIComponent(token)}`);

    if (res.status === 404) {
      showError('Planner not found. The link may have been revoked or may not exist.');
      return;
    }

    if (!res.ok) {
      showError(`Failed to load planner (${res.status}).`);
      return;
    }

    const { config, data } = await res.json() as PublicPlannerResponse;

    // Enforce read-only regardless of server response (defence-in-depth).
    config.permission = 'view';
    config.isOwner = false;

    document.title = `${config.title} — Circular Planner`;
    const titleHeader = document.getElementById('planner-title-header');
    if (titleHeader) titleHeader.textContent = config.title;

    // Set the class before mounting so the disc never paints with chrome and
    // then reflows once it is hidden — visible on a big screen as a jump.
    const display = isDisplayMode(window.location.search);
    if (display) document.body.classList.add('display-mode');

    if (loadingEl) loadingEl.style.display = 'none';
    let plannerInstance: Planner | null = null;
    if (containerEl) {
      containerEl.classList.remove('hidden');
      // undefined updatedAt so DataManager never attempts a PUT; publicView so
      // no authenticated request is made — a single 401 here would redirect the
      // whole page to the login screen.
      plannerInstance = new Planner(containerEl, config, data, undefined, { publicView: true });
    }

    if (display && plannerInstance) {
      startDisplayPolling(token, plannerInstance, config.updated_at);
    }

    const themeBtn = document.getElementById('theme-toggle') as HTMLButtonElement | null;
    if (themeBtn) {
      themeBtn.textContent = currentTheme() === 'dark' ? '☀️' : '🌙';
      themeBtn.addEventListener('click', () => {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        themeBtn.textContent = next === 'dark' ? '☀️' : '🌙';
        plannerInstance?.onThemeChange();
      });
    }

  } catch (err: unknown) {
    showError(`Failed to load planner: ${(err as Error).message}`);
  }
}

/**
 * Keep an unattended display current.
 *
 * Design constraints that are not obvious:
 *
 *  - A failed poll must never replace the disc with an error. This screen may
 *    be the only thing on a wall for weeks; one 502 during a deploy should not
 *    wipe it. Failures are counted, not surfaced, until the count says the data
 *    is genuinely old.
 *  - Re-render only on a changed `config.updated_at`. Re-rendering a disc every
 *    minute for weeks is real work for no benefit, and it would interrupt the
 *    render at exactly the moment someone glanced up.
 *  - The clock needs no help here. now() is live by default, and Renderer
 *    already re-renders at local midnight, so the today indicator advances on
 *    its own even if the planner data never changes.
 */
function startDisplayPolling(token: string, planner: Planner, initialUpdatedAt?: string): void {
  let lastUpdatedAt = initialUpdatedAt;
  let consecutiveFailures = 0;
  let staleEl: HTMLElement | null = null;

  function setStale(isStale: boolean, since?: string): void {
    if (isStale && !staleEl) {
      staleEl = document.createElement('div');
      staleEl.className = 'cp-display-stale';
      document.body.appendChild(staleEl);
    }
    if (!isStale && staleEl) {
      staleEl.remove();
      staleEl = null;
      return;
    }
    if (staleEl) {
      staleEl.textContent = since
        ? `Not updating — last change ${since}`
        : 'Not updating';
    }
  }

  async function poll(): Promise<void> {
    try {
      const res = await fetch(`/api/public/planners/${encodeURIComponent(token)}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const { config, data } = await res.json() as PublicPlannerResponse;

      consecutiveFailures = 0;
      setStale(false);

      if (shouldRerender(lastUpdatedAt, config.updated_at)) {
        lastUpdatedAt = config.updated_at;
        // undefined updatedAt keeps DataManager from ever attempting a PUT —
        // this view is read-only no matter what the server said.
        planner.setData(data, undefined);
      }
    } catch (err) {
      consecutiveFailures += 1;
      // Deliberately console-only until the failure run is long enough to mean
      // something. See STALE_AFTER_FAILURES.
      console.warn(`Display poll failed (${consecutiveFailures}):`, err);
      if (consecutiveFailures >= STALE_AFTER_FAILURES) {
        setStale(true, lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleString() : undefined); // clock-exempt: formatting a server timestamp
      }
    }
  }

  setInterval(poll, POLL_INTERVAL_MS);
}

document.addEventListener('DOMContentLoaded', init);
