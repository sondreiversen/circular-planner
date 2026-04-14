import { api, logout } from './api-client';
import { escapeHtml } from './utils';
import { Planner } from './planner';
import { PlannerConfig, PlannerData, ShareEntry } from './types';
import { initTheme, applyTheme, currentTheme } from './theme';

initTheme();

interface PlannerResponse {
  config: PlannerConfig;
  data: PlannerData;
}

async function init(): Promise<void> {
  // Session presence is validated by the API call below — a 401 from the
  // server triggers a redirect to /index.html via api-client.
  const params = new URLSearchParams(window.location.search);
  const idStr = params.get('id');
  if (!idStr) {
    window.location.href = '/dashboard.html';
    return;
  }
  const plannerId = parseInt(idStr, 10);

  const loadingEl   = document.getElementById('planner-loading');
  const errorEl     = document.getElementById('planner-error');
  const containerEl = document.getElementById('planner-container');

  try {
    const { config, data } = await api.get<PlannerResponse>(`/api/planners/${plannerId}`);

    document.title = `${config.title} — Circular Planner`;
    const titleHeader = document.getElementById('planner-title-header');
    if (titleHeader) titleHeader.textContent = config.title;

    // Populate username from /api/auth/me (cookie-based session).
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((me: { user?: { username?: string } } | null) => {
        const usernameEl = document.getElementById('header-username');
        if (usernameEl && me?.user?.username) usernameEl.textContent = me.user.username;
      })
      .catch(() => { /* ignore */ });

    const shareBtn = document.getElementById('share-btn') as HTMLButtonElement | null;
    if (shareBtn && !config.isOwner) shareBtn.style.display = 'none';

    if (loadingEl) loadingEl.style.display = 'none';
    let plannerInstance: Planner | null = null;
    if (containerEl) {
      containerEl.classList.remove('hidden');
      plannerInstance = new Planner(containerEl, config, data);
    }

    if (shareBtn && config.isOwner) {
      shareBtn.addEventListener('click', () => openShareDialog(plannerId));
    }

    document.getElementById('logout-btn')?.addEventListener('click', logout);

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
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) {
      errorEl.classList.remove('hidden');
      errorEl.textContent = `Failed to load planner: ${(err as Error).message}`;
    }
  }
}

async function openShareDialog(plannerId: number): Promise<void> {
  const overlay = document.getElementById('share-overlay');
  if (!overlay) return;

  // Bind listeners once; subsequent calls just show the dialog
  if (!overlay.dataset.initialized) {
    overlay.dataset.initialized = 'true';

    document.getElementById('share-close')?.addEventListener('click', () => overlay.classList.add('hidden'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) overlay.classList.add('hidden');
    });

    const form    = document.getElementById('share-form') as HTMLFormElement;
    const errorEl = document.getElementById('share-error');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email      = (document.getElementById('share-email') as HTMLInputElement).value.trim();
      const permission = (document.getElementById('share-permission') as HTMLSelectElement).value;
      if (!email) return;
      if (errorEl) errorEl.classList.add('hidden');
      try {
        await api.post(`/api/planners/${plannerId}/shares`, { email, permission });
        (document.getElementById('share-email') as HTMLInputElement).value = '';
        await refreshShareList(plannerId);
      } catch (err: unknown) {
        if (errorEl) { errorEl.textContent = (err as Error).message; errorEl.classList.remove('hidden'); }
      }
    });
  }

  overlay.classList.remove('hidden');
  await refreshShareList(plannerId);
}

async function refreshShareList(plannerId: number): Promise<void> {
  const list = document.getElementById('share-list');
  if (!list) return;
  try {
    const shares = await api.get<ShareEntry[]>(`/api/planners/${plannerId}/shares`);
    list.innerHTML = '';
    if (shares.length === 0) {
      list.innerHTML = '<p style="color:#8896a5;font-size:13px;">Not shared with anyone yet.</p>';
      return;
    }
    shares.forEach(s => {
      const row = document.createElement('div');
      row.className = 'share-row';
      row.innerHTML = `
        <div class="share-row-info">
          <span class="share-row-name">${escapeHtml(s.username)}</span>
          <span class="share-row-email">${escapeHtml(s.email)}</span>
        </div>
        <div class="share-row-actions">
          <span class="badge ${s.permission === 'edit' ? 'badge-edit' : 'badge-view'}">${s.permission}</span>
          <button class="btn btn-danger" style="padding:3px 8px;font-size:11px;" data-uid="${s.user_id}">Remove</button>
        </div>
      `;
      row.querySelector('button')?.addEventListener('click', async () => {
        await api.delete(`/api/planners/${plannerId}/shares/${s.user_id}`);
        await refreshShareList(plannerId);
      });
      list.appendChild(row);
    });
  } catch { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', init);
