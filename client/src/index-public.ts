/**
 * Entry point for the public (unauthenticated) planner view.
 * Uses raw fetch() — NOT api-client.ts — to avoid the 401→redirect-to-login behaviour.
 * Forces permission='view' and isOwner=false regardless of server response.
 */
import { Planner } from './planner';
import { PlannerConfig, PlannerData } from './types';
import { initTheme, applyTheme, currentTheme } from './theme';
import { applyBranding } from './branding';

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

    if (loadingEl) loadingEl.style.display = 'none';
    let plannerInstance: Planner | null = null;
    if (containerEl) {
      containerEl.classList.remove('hidden');
      // Pass undefined for updatedAt so DataManager never attempts a PUT.
      plannerInstance = new Planner(containerEl, config, data, undefined);
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

document.addEventListener('DOMContentLoaded', init);
