import { api, isLoggedIn, clearToken } from './api-client';
import { PlannerSummary } from './types';

const today = new Date();
const thisYear = today.getFullYear();

document.addEventListener('DOMContentLoaded', async () => {
  if (!isLoggedIn()) { window.location.href = '/index.html'; return; }

  // Show username
  try {
    const payload = JSON.parse(atob(localStorage.getItem('cp_token')!.split('.')[1]));
    const el = document.getElementById('header-username');
    if (el) el.textContent = payload.username;
  } catch { /* ignore */ }

  document.getElementById('logout-btn')?.addEventListener('click', () => {
    clearToken();
    window.location.href = '/index.html';
  });

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
    const start = (document.getElementById('np-start') as HTMLInputElement).value;
    const end   = (document.getElementById('np-end')   as HTMLInputElement).value;
    const errEl = document.getElementById('new-planner-error');
    if (!title || !start || !end) return;
    if (start >= end) {
      if (errEl) { errEl.textContent = 'Start date must be before end date.'; errEl.classList.remove('hidden'); }
      return;
    }
    if (errEl) errEl.classList.add('hidden');
    try {
      const planner = await api.post<{ id: number }>('/api/planners', { title, startDate: start, endDate: end });
      window.location.href = `/planner.html?id=${planner.id}`;
    } catch (err: unknown) {
      if (errEl) { errEl.textContent = (err as Error).message; errEl.classList.remove('hidden'); }
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
        <div class="planner-card-title">${esc(p.title)}</div>
        <div class="planner-card-dates">${p.startDate} → ${p.endDate}</div>
        <div class="planner-card-meta">
          <span class="badge ${badge}">${badgeText}</span>
          ${!p.isOwner ? `<span style="font-size:11px;color:#8896a5;">by ${esc(p.ownerName)}</span>` : ''}
        </div>
      `;
      card.addEventListener('click', () => { window.location.href = `/planner.html?id=${p.id}`; });
      grid.appendChild(card);
    });
  } catch (err: unknown) {
    if (grid) grid.innerHTML = `<div class="error-state">Failed to load planners: ${(err as Error).message}</div>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
