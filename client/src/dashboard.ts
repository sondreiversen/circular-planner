import { api, logout } from './api-client';
import { escapeHtml, ymdToDmy, dmyToYmd } from './utils';
import { PlannerSummary } from './types';
import { initTheme, applyTheme, currentTheme } from './theme';

initTheme();

const today = new Date();
const thisYear = today.getFullYear();

document.addEventListener('DOMContentLoaded', async () => {
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
    if (start && !start.value) start.value = ymdToDmy(`${thisYear}-01-01`);
    if (end   && !end.value)   end.value   = ymdToDmy(`${thisYear}-12-31`);
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
    const start = dmyToYmd(startRaw);
    const end   = dmyToYmd(endRaw);
    if (!start || !end) { showErr('Dates must be in DD/MM/YYYY format.'); return; }
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
      grid.innerHTML = '<div class="loading-state">No planners yet. Create your first one!</div>';
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

