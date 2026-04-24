import { api, logout } from './api-client';
import { escapeHtml } from './utils';
import { PlannerSummary } from './types';
import { initTheme, applyTheme, currentTheme } from './theme';
import { applyBranding } from './branding';
import { installOfflineBanner, installGlobalErrorHandlers } from './toast';
installOfflineBanner();
installGlobalErrorHandlers();

interface GroupSummary {
  id: number;
  name: string;
  description: string | null;
  role: 'admin' | 'member';
  member_count: number;
}

initTheme();

const today = new Date();
const thisYear = today.getFullYear();

document.addEventListener('DOMContentLoaded', async () => {
  applyBranding();
  // Verify session via cookie; populate username from /api/auth/me.
  try {
    const meRes = await fetch('/api/auth/me', { credentials: 'include' });
    if (!meRes.ok) { window.location.href = '/index.html'; return; }
    const me = await meRes.json() as { user?: { username?: string } };
    const el = document.getElementById('header-username');
    if (el && me.user?.username) el.textContent = me.user.username;
  } catch {
    window.location.href = '/index.html';
    return;
  }

  document.getElementById('logout-btn')?.addEventListener('click', logout);

  const themeBtn = document.getElementById('theme-toggle') as HTMLButtonElement | null;
  if (themeBtn) {
    themeBtn.textContent = currentTheme() === 'dark' ? '☀️' : '🌙';
    themeBtn.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      themeBtn.textContent = next === 'dark' ? '☀️' : '🌙';
    });
  }

  document.getElementById('new-planner-btn')?.addEventListener('click', () => {
    // Set sensible defaults in the dialog
    const start = document.getElementById('np-start') as HTMLInputElement;
    const end   = document.getElementById('np-end')   as HTMLInputElement;
    if (start && !start.value) start.value = `${thisYear}-01-01`;
    if (end   && !end.value)   end.value   = `${thisYear}-12-31`;
    document.getElementById('new-planner-overlay')?.classList.remove('hidden');
    (document.getElementById('np-title') as HTMLInputElement)?.focus();
  });

  document.getElementById('np-cancel')?.addEventListener('click', closeDialog);
  document.getElementById('new-planner-overlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('new-planner-overlay')) closeDialog();
  });

  document.getElementById('new-planner-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = (document.getElementById('np-title') as HTMLInputElement).value.trim();
    const startRaw = (document.getElementById('np-start') as HTMLInputElement).value;
    const endRaw   = (document.getElementById('np-end')   as HTMLInputElement).value;
    const errEl = document.getElementById('new-planner-error');
    const showErr = (msg: string) => {
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
    };
    if (!title || !startRaw || !endRaw) return;
    const start = startRaw;
    const end   = endRaw;
    if (start >= end) { showErr('Start date must be before end date.'); return; }
    if (errEl) errEl.classList.add('hidden');
    try {
      const planner = await api.post<{ id: number }>('/api/planners', { title, startDate: start, endDate: end });
      window.location.href = `/planner.html?id=${planner.id}`;
    } catch (err: unknown) {
      showErr((err as Error).message);
    }
  });

  await loadPlanners();
  await loadGroups();
});

function closeDialog(): void {
  document.getElementById('new-planner-overlay')?.classList.add('hidden');
}

async function loadPlanners(): Promise<void> {
  const grid = document.getElementById('planners-grid');
  if (!grid) return;
  try {
    const planners = await api.get<PlannerSummary[]>('/api/planners');
    grid.innerHTML = '';

    if (planners.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <svg class="empty-state-icon" width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
            <circle cx="28" cy="28" r="26" stroke="currentColor" stroke-width="2.5" fill="none"/>
            <circle cx="28" cy="28" r="14" stroke="currentColor" stroke-width="2" fill="none" opacity="0.5"/>
            <circle cx="28" cy="28" r="4" fill="currentColor" opacity="0.4"/>
          </svg>
          <h3>No planners yet</h3>
          <p>Create your first planner to start organising your year.</p>
          <button id="empty-new-planner-btn" class="btn btn-primary">+ New planner</button>
        </div>`;
      document.getElementById('empty-new-planner-btn')?.addEventListener('click', () => {
        document.getElementById('new-planner-btn')?.click();
      });
      return;
    }

    planners.forEach(p => {
      const card = document.createElement('div');
      card.className = 'planner-card';
      const badge = p.isOwner ? 'badge-owner' : (p.permission === 'edit' ? 'badge-edit' : 'badge-view');
      const badgeText = p.isOwner ? 'Owner' : p.permission;
      card.innerHTML = `
        <div class="planner-card-title">${escapeHtml(p.title)}</div>
        <div class="planner-card-dates">${escapeHtml(p.startDate)} → ${escapeHtml(p.endDate)}</div>
        <div class="planner-card-meta">
          <span class="badge ${badge}">${escapeHtml(badgeText)}</span>
          ${!p.isOwner ? `<span style="font-size:11px;color:#8896a5;">by ${escapeHtml(p.ownerName)}</span>` : ''}
        </div>
      `;
      card.addEventListener('click', () => { window.location.href = `/planner.html?id=${p.id}`; });
      grid.appendChild(card);
    });
  } catch (err: unknown) {
    if (grid) grid.innerHTML = `<div class="error-state">Failed to load planners: ${escapeHtml((err as Error).message)}</div>`;
  }
}

async function loadGroups(): Promise<void> {
  const grid = document.getElementById('groups-grid');
  if (!grid) return;
  try {
    const groups = await api.get<GroupSummary[]>('/api/groups');
    grid.innerHTML = '';
    if (groups.length === 0) {
      grid.innerHTML = '<div class="loading-state">No groups yet. <a href="/groups.html">Create one!</a></div>';
      return;
    }
    groups.forEach(g => {
      const card = document.createElement('div');
      card.className = 'planner-card';
      const roleBadge = g.role === 'admin' ? 'badge-owner' : 'badge-view';
      card.innerHTML = `
        <div class="planner-card-title">${escapeHtml(g.name)}</div>
        ${g.description ? `<div class="planner-card-dates">${escapeHtml(g.description)}</div>` : ''}
        <div class="planner-card-meta">
          <span class="badge ${roleBadge}">${escapeHtml(g.role)}</span>
          <span style="font-size:11px;color:#8896a5;">${g.member_count} member${g.member_count !== 1 ? 's' : ''}</span>
        </div>
      `;
      card.addEventListener('click', () => { window.location.href = `/groups.html?id=${g.id}`; });
      grid.appendChild(card);
    });
  } catch (err: unknown) {
    if (grid) grid.innerHTML = `<div class="error-state">Failed to load groups: ${escapeHtml((err as Error).message)}</div>`;
  }
}

