import { api, isLoggedIn, parseJWT, logout } from './api-client';
import { escapeHtml } from './utils';
import { Planner } from './planner';
import { PlannerConfig, PlannerData, ShareEntry } from './types';

interface PlannerResponse {
  config: PlannerConfig;
  data: PlannerData;
}

async function init(): Promise<void> {
  if (!isLoggedIn()) {
    window.location.href = '/index.html';
    return;
  }

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

    const token = localStorage.getItem('cp_token');
    if (token) {
      const payload = parseJWT(token);
      const usernameEl = document.getElementById('header-username');
      if (usernameEl && payload.username) usernameEl.textContent = payload.username as string;
    }

    const shareBtn = document.getElementById('share-btn') as HTMLButtonElement | null;
    if (shareBtn && !config.isOwner) shareBtn.style.display = 'none';

    if (loadingEl) loadingEl.style.display = 'none';
    if (containerEl) {
      containerEl.classList.remove('hidden');
      new Planner(containerEl, config, data);
    }

    if (shareBtn && config.isOwner) {
      shareBtn.addEventListener('click', () => openShareDialog(plannerId));
    }

    document.getElementById('logout-btn')?.addEventListener('click', logout);

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
