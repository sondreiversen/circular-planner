import { api, logout } from './api-client';
import { escapeHtml } from './utils';
import { Planner } from './planner';
import { PlannerConfig, PlannerData, ShareEntry } from './types';
import { initTheme, applyTheme, currentTheme } from './theme';
import { applyBranding } from './branding';
import { installOfflineBanner, installGlobalErrorHandlers } from './toast';
import { openHelpOverlay } from './help-overlay';
import { openGuidePanel, maybeShowFirstVisitPrompt } from './guide';

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
    const { config, data } = await api.get<PlannerResponse>(`/api/planners/${plannerId}`);
    // The server nests updated_at inside `config`, not at the top level.
    // Reading it top-level yields undefined, which leaves DataManager without a
    // baseline and silently disables the 409 concurrent-edit check on first save.
    const updated_at = config.updated_at;

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

    // If navigated here from global search with #activity=ID, open that activity.
    const hashMatch = window.location.hash.match(/^#activity=(.+)$/);
    if (hashMatch && plannerInstance) {
      const targetId = decodeURIComponent(hashMatch[1]);
      // Wait one tick for the first render to complete before opening the dialog.
      setTimeout(() => {
        const activity = data.lanes.flatMap(l => l.activities).find(a => a.id === targetId);
        if (activity) plannerInstance!.openActivity(activity);
      }, 0);
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
      shareBtn.addEventListener('click', () => openShareDialog(plannerId, config));
    }

    document.getElementById('logout-btn')?.addEventListener('click', logout);
    document.getElementById('help-btn')?.addEventListener('click', openHelpOverlay);
    document.getElementById('guide-btn')?.addEventListener('click', openGuidePanel);

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

    // First-visit nudge offering the guided tour (shown once, never blocks).
    maybeShowFirstVisitPrompt();

  } catch (err: unknown) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) {
      errorEl.classList.remove('hidden');
      errorEl.textContent = `Failed to load planner: ${(err as Error).message}`;
    }
  }
}

async function openShareDialog(plannerId: number, config: PlannerConfig): Promise<void> {
  const overlay = document.getElementById('share-overlay');
  if (!overlay) return;

  // Initialise the public toggle from current config state on every open
  const publicCb = document.getElementById('share-make-public') as HTMLInputElement | null;
  if (publicCb) publicCb.checked = config.isPublic;

  // Bind listeners once; subsequent calls just show the dialog
  if (!overlay.dataset.initialized) {
    overlay.dataset.initialized = 'true';

    // Wire "Make public" toggle
    const cb = document.getElementById('share-make-public') as HTMLInputElement | null;
    const feedbackEl = document.getElementById('share-public-feedback');
    cb?.addEventListener('change', async () => {
      const newValue = cb.checked;
      try {
        await api.put(`/api/planners/${plannerId}`, { isPublic: newValue });
        config.isPublic = newValue;
        if (feedbackEl) {
          feedbackEl.textContent = newValue ? 'Planner is now public.' : 'Planner is now private.';
          feedbackEl.classList.remove('hidden', 'share-public-feedback--error');
          feedbackEl.classList.add('share-public-feedback--ok');
          setTimeout(() => feedbackEl.classList.add('hidden'), 3000);
        }
      } catch (err: unknown) {
        // Revert checkbox on error
        cb.checked = !newValue;
        if (feedbackEl) {
          feedbackEl.textContent = (err as Error).message || 'Failed to update visibility.';
          feedbackEl.classList.remove('hidden', 'share-public-feedback--ok');
          feedbackEl.classList.add('share-public-feedback--error');
        }
      }
    });

    document.getElementById('share-close')?.addEventListener('click', () => overlay.classList.add('hidden'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) overlay.classList.add('hidden');
    });

    // Tab switching
    const tabUsers  = document.getElementById('share-tab-users');
    const tabGroups = document.getElementById('share-tab-groups');
    const tabPublic = document.getElementById('share-tab-public');
    const panelUsers  = document.getElementById('share-panel-users');
    const panelGroups = document.getElementById('share-panel-groups');
    const panelPublic = document.getElementById('share-panel-public');

    const showTab = (active: 'users' | 'groups' | 'public') => {
      tabUsers?.classList.toggle('active', active === 'users');
      tabGroups?.classList.toggle('active', active === 'groups');
      tabPublic?.classList.toggle('active', active === 'public');
      panelUsers?.classList.toggle('hidden', active !== 'users');
      panelGroups?.classList.toggle('hidden', active !== 'groups');
      panelPublic?.classList.toggle('hidden', active !== 'public');
    };

    tabUsers?.addEventListener('click', () => showTab('users'));
    tabGroups?.addEventListener('click', async () => {
      showTab('groups');
      await refreshGroupShareList(plannerId);
      await populateGroupSelect(plannerId);
    });
    tabPublic?.addEventListener('click', async () => {
      showTab('public');
      await refreshTokenPanel(plannerId);
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

interface ShareToken {
  token: string;
  created_at: string;
  revoked_at: string | null;
}

function buildPublicUrl(plannerId: number, token: string): string {
  // Use the API response URL if available; otherwise build from current origin.
  return window.location.origin + '/planner-public.html?token=' + encodeURIComponent(token);
}

function setTokenPanelActive(token: string, url: string): void {
  const noToken = document.getElementById('share-token-no-token');
  const active  = document.getElementById('share-token-active');
  if (noToken) noToken.classList.add('hidden');
  if (active)  active.classList.remove('hidden');

  const urlInput = document.getElementById('share-token-url-input') as HTMLInputElement | null;
  if (urlInput) urlInput.value = url;

  const embedCode = document.getElementById('share-token-embed-code') as HTMLTextAreaElement | null;
  if (embedCode) {
    embedCode.value = `<iframe src="${url}" width="800" height="800" style="border:0"></iframe>`;
  }
}

function setTokenPanelNone(): void {
  const noToken = document.getElementById('share-token-no-token');
  const active  = document.getElementById('share-token-active');
  if (noToken) noToken.classList.remove('hidden');
  if (active)  active.classList.add('hidden');
}

async function refreshTokenPanel(plannerId: number): Promise<void> {
  const errEl = document.getElementById('share-token-error');
  if (errEl) errEl.classList.add('hidden');
  try {
    const tokens = await api.get<ShareToken[]>(`/api/planners/${plannerId}/share-tokens`);
    const active = tokens.find(t => !t.revoked_at);
    if (active) {
      const url = buildPublicUrl(plannerId, active.token);
      setTokenPanelActive(active.token, url);
    } else {
      setTokenPanelNone();
    }
  } catch {
    setTokenPanelNone();
  }

  // Wire buttons once
  const enableBtn = document.getElementById('share-token-enable-btn');
  if (enableBtn && !enableBtn.dataset.bound) {
    enableBtn.dataset.bound = '1';
    enableBtn.addEventListener('click', async () => {
      const errEl2 = document.getElementById('share-token-error');
      try {
        const { token, url } = await api.post<{ token: string; url: string }>(`/api/planners/${plannerId}/share-tokens`, {});
        setTokenPanelActive(token, url);
      } catch (err) {
        if (errEl2) { errEl2.textContent = (err as Error).message; errEl2.classList.remove('hidden'); }
      }
    });
  }

  const copyBtn = document.getElementById('share-token-copy-btn');
  if (copyBtn && !copyBtn.dataset.bound) {
    copyBtn.dataset.bound = '1';
    copyBtn.addEventListener('click', () => {
      const urlInput = document.getElementById('share-token-url-input') as HTMLInputElement | null;
      if (!urlInput) return;
      navigator.clipboard?.writeText(urlInput.value).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
      }).catch(() => {
        urlInput.select();
        document.execCommand('copy');
      });
    });
  }

  const revokeBtn = document.getElementById('share-token-revoke-btn');
  if (revokeBtn && !revokeBtn.dataset.bound) {
    revokeBtn.dataset.bound = '1';
    revokeBtn.addEventListener('click', async () => {
      const urlInput = document.getElementById('share-token-url-input') as HTMLInputElement | null;
      const currentUrl = urlInput?.value ?? '';
      const tokenMatch = currentUrl.match(/[?&]token=([^&]+)/);
      if (!tokenMatch) return;
      const tokenVal = decodeURIComponent(tokenMatch[1]);
      const errEl3 = document.getElementById('share-token-error');
      try {
        await api.post(`/api/planners/${plannerId}/share-tokens/${encodeURIComponent(tokenVal)}/revoke`, {});
        setTokenPanelNone();
      } catch (err) {
        if (errEl3) { errEl3.textContent = (err as Error).message; errEl3.classList.remove('hidden'); }
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
