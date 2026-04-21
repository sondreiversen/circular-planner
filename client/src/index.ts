import { api, logout } from './api-client';
import { escapeHtml } from './utils';
import { Planner } from './planner';
import { PlannerConfig, PlannerData, ShareEntry } from './types';
import { initTheme, applyTheme, currentTheme } from './theme';
import { applyBranding } from './branding';
import { installOfflineBanner, installGlobalErrorHandlers } from './toast';

installOfflineBanner();
installGlobalErrorHandlers();

interface GroupSummary {
  id: number;
  name: string;
  role: string;
}

interface GroupShareEntry {
  group_id: number;
  name: string;
  default_permission: string;
  member_count: number;
  overrides: { group_id: number; user_id: number; username: string; permission: string }[];
}

initTheme();

interface PlannerResponse {
  config: PlannerConfig;
  data: PlannerData;
  updated_at?: string;
}

async function init(): Promise<void> {
  applyBranding();
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
    const { config, data, updated_at } = await api.get<PlannerResponse>(`/api/planners/${plannerId}`);

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
      plannerInstance = new Planner(containerEl, config, data, updated_at);
    }

    // Empty-lane CTA: show overlay when planner has no lanes
    if (containerEl && data.lanes.length === 0) {
      const cta = document.createElement('div');
      cta.id = 'no-lanes-cta';
      cta.className = 'no-lanes-cta';
      cta.innerHTML = `
        <svg width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden="true" style="color:var(--cp-border-strong)">
          <circle cx="26" cy="26" r="24" stroke="currentColor" stroke-width="2.5" fill="none"/>
          <line x1="26" y1="14" x2="26" y2="38" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
          <line x1="14" y1="26" x2="38" y2="26" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
        <h3>No lanes yet</h3>
        <p>Add your first lane to start placing activities on the disc.</p>
        <button id="cta-add-lane-btn" class="btn btn-primary">+ Add lane</button>`;
      containerEl.style.position = 'relative';
      containerEl.appendChild(cta);

      document.getElementById('cta-add-lane-btn')?.addEventListener('click', () => {
        // Reuse the existing "+ Add Lane" button rendered by Planner in the sidebar
        const addLaneBtn = containerEl.querySelector<HTMLButtonElement>('.cp-btn.cp-btn-primary');
        if (addLaneBtn) {
          addLaneBtn.click();
          cta.remove();
        }
      });
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

    // Tab switching
    const tabUsers  = document.getElementById('share-tab-users');
    const tabGroups = document.getElementById('share-tab-groups');
    const panelUsers  = document.getElementById('share-panel-users');
    const panelGroups = document.getElementById('share-panel-groups');

    tabUsers?.addEventListener('click', () => {
      tabUsers.classList.add('active'); tabGroups?.classList.remove('active');
      panelUsers?.classList.remove('hidden'); panelGroups?.classList.add('hidden');
    });
    tabGroups?.addEventListener('click', async () => {
      tabGroups.classList.add('active'); tabUsers?.classList.remove('active');
      panelGroups?.classList.remove('hidden'); panelUsers?.classList.add('hidden');
      await refreshGroupShareList(plannerId);
      await populateGroupSelect(plannerId);
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

    // Add group share
    document.getElementById('share-group-add-btn')?.addEventListener('click', async () => {
      const groupId  = (document.getElementById('share-group-select') as HTMLSelectElement).value;
      const perm     = (document.getElementById('share-group-permission') as HTMLSelectElement).value;
      const errEl    = document.getElementById('share-group-error');
      if (!groupId) { if (errEl) { errEl.textContent = 'Select a group first'; errEl.classList.remove('hidden'); } return; }
      if (errEl) errEl.classList.add('hidden');
      try {
        await api.post(`/api/planners/${plannerId}/shares/group-shares`, { group_id: parseInt(groupId, 10), default_permission: perm });
        await refreshGroupShareList(plannerId);
        await populateGroupSelect(plannerId);
      } catch (err: unknown) {
        if (errEl) { errEl.textContent = (err as Error).message; errEl.classList.remove('hidden'); }
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

async function refreshGroupShareList(plannerId: number): Promise<void> {
  const list = document.getElementById('share-group-list');
  if (!list) return;
  try {
    const shares = await api.get<GroupShareEntry[]>(`/api/planners/${plannerId}/shares/group-shares`);
    list.innerHTML = '';
    if (shares.length === 0) {
      list.innerHTML = '<p style="color:#8896a5;font-size:13px;">No groups attached yet.</p>';
      return;
    }
    shares.forEach(s => {
      const row = document.createElement('div');
      row.className = 'share-row';
      row.innerHTML = `
        <div class="share-row-info">
          <span class="share-row-name">${escapeHtml(s.name)}</span>
          <span class="share-row-email">${s.member_count} member${s.member_count !== 1 ? 's' : ''}</span>
        </div>
        <div class="share-row-actions">
          <select class="gs-perm-select" data-gid="${s.group_id}" style="font-size:12px;padding:3px 6px;">
            <option value="view"${s.default_permission === 'view' ? ' selected' : ''}>View only</option>
            <option value="edit"${s.default_permission === 'edit' ? ' selected' : ''}>Can edit</option>
          </select>
          <button class="btn btn-danger gs-remove-btn" style="padding:3px 8px;font-size:11px;" data-gid="${s.group_id}">Remove</button>
        </div>
      `;
      // Per-member overrides section
      if (s.overrides.length > 0 || s.member_count > 0) {
        const details = document.createElement('details');
        details.style.cssText = 'font-size:12px;margin-top:6px;width:100%;';
        details.innerHTML = `<summary style="cursor:pointer;color:var(--cp-text-muted);">Per-member overrides (${s.overrides.length})</summary>`;
        s.overrides.forEach(o => {
          const oRow = document.createElement('div');
          oRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 8px;';
          oRow.innerHTML = `
            <span>${escapeHtml(o.username)}</span>
            <div style="display:flex;gap:6px;align-items:center;">
              <select class="gso-perm-select" data-gid="${s.group_id}" data-uid="${o.user_id}" style="font-size:12px;padding:2px 4px;">
                <option value="view"${o.permission === 'view' ? ' selected' : ''}>View</option>
                <option value="edit"${o.permission === 'edit' ? ' selected' : ''}>Edit</option>
              </select>
              <button class="btn btn-danger gso-remove-btn" style="padding:2px 6px;font-size:11px;" data-gid="${s.group_id}" data-uid="${o.user_id}">×</button>
            </div>
          `;
          details.appendChild(oRow);
        });
        row.appendChild(details);
      }
      list.appendChild(row);
    });

    // Bind group share remove
    list.querySelectorAll('.gs-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const gid = (btn as HTMLElement).dataset.gid;
        await api.delete(`/api/planners/${plannerId}/shares/group-shares/${gid}`);
        await refreshGroupShareList(plannerId);
        await populateGroupSelect(plannerId);
      });
    });

    // Bind group default permission change
    list.querySelectorAll('.gs-perm-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const gid  = (sel as HTMLSelectElement).dataset.gid;
        const perm = (sel as HTMLSelectElement).value;
        await api.post(`/api/planners/${plannerId}/shares/group-shares`, { group_id: parseInt(gid!, 10), default_permission: perm });
      });
    });

    // Bind override permission change
    list.querySelectorAll('.gso-perm-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const gid  = (sel as HTMLSelectElement).dataset.gid;
        const uid  = (sel as HTMLSelectElement).dataset.uid;
        const perm = (sel as HTMLSelectElement).value;
        await api.put(`/api/planners/${plannerId}/shares/group-shares/${gid}/overrides/${uid}`, { permission: perm });
      });
    });

    // Bind override remove
    list.querySelectorAll('.gso-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const gid = (btn as HTMLElement).dataset.gid;
        const uid = (btn as HTMLElement).dataset.uid;
        await api.delete(`/api/planners/${plannerId}/shares/group-shares/${gid}/overrides/${uid}`);
        await refreshGroupShareList(plannerId);
      });
    });
  } catch { /* ignore */ }
}

async function populateGroupSelect(plannerId: number): Promise<void> {
  const sel = document.getElementById('share-group-select') as HTMLSelectElement | null;
  if (!sel) return;
  try {
    const [myGroups, existingShares] = await Promise.all([
      api.get<GroupSummary[]>('/api/groups'),
      api.get<GroupShareEntry[]>(`/api/planners/${plannerId}/shares/group-shares`),
    ]);
    const alreadyAttached = new Set(existingShares.map(s => s.group_id));
    sel.innerHTML = '<option value="">— select a group —</option>';
    myGroups
      .filter(g => !alreadyAttached.has(g.id))
      .forEach(g => {
        const opt = document.createElement('option');
        opt.value = String(g.id);
        opt.textContent = g.name;
        sel.appendChild(opt);
      });
  } catch { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', init);
