import { api, logout } from './api-client';
import { escapeHtml, displayName } from './utils';
import { PlannerSummary } from './types';
import { initTheme, applyTheme, currentTheme } from './theme';
import { applyBranding } from './branding';
import { installOfflineBanner, installGlobalErrorHandlers } from './toast';
import { now } from './clock';
installOfflineBanner();
installGlobalErrorHandlers();

interface SearchResult {
  kind: 'activity' | 'planner';
  activityId?: string;
  activityTitle?: string;
  startDate?: string;
  endDate?: string;
  laneId?: string;
  laneName?: string;
  plannerId: number;
  plannerTitle: string;
}

interface GroupSummary {
  id: number;
  name: string;
  description: string | null;
  role: 'admin' | 'member';
  member_count: number;
}

interface AuthMe {
  user?: { username?: string; fullName?: string; is_admin?: boolean };
}

initTheme();

const today = now();
const thisYear = today.getFullYear();

// Tracks whether the current user is an admin (populated on DOMContentLoaded)
let currentUserIsAdmin = false;

document.addEventListener('DOMContentLoaded', async () => {
  applyBranding();

  // Fire all four fetches in parallel
  let me: AuthMe;
  let owned: PlannerSummary[];
  let pub: PlannerSummary[];
  let groups: GroupSummary[];

  try {
    [me, owned, pub, groups] = await Promise.all([
      api.get<AuthMe>('/api/auth/me'),
      api.get<PlannerSummary[]>('/api/planners'),
      api.get<PlannerSummary[]>('/api/planners/public'),
      api.get<GroupSummary[]>('/api/groups'),
    ]);
  } catch (err: unknown) {
    // api.get already redirects to /index.html on 401; other errors fall through here
    const msg = (err as Error).message;
    if (msg === 'Unauthorized') return;
    // For non-auth errors show error states and bail
    const grid = document.getElementById('planners-grid');
    if (grid) grid.innerHTML = `<div class="error-state">Failed to load: ${escapeHtml(msg)}</div>`;
    return;
  }

  // ── Render user info ────────────────────────────────────────────────────────
  const el = document.getElementById('header-username');
  if (el && me.user?.username) el.textContent = displayName({ username: me.user.username, fullName: me.user.fullName });
  if (me.user?.is_admin) {
    currentUserIsAdmin = true;
    const headerRight = document.querySelector('.header-right');
    if (headerRight) {
      const adminLink = document.createElement('a');
      adminLink.href = '/admin.html';
      adminLink.className = 'btn btn-ghost';
      adminLink.textContent = 'Admin';
      headerRight.insertBefore(adminLink, headerRight.firstChild);
    }
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

  // ── Render all sections with already-resolved data ──────────────────────────
  renderOwnedPlanners(owned);
  renderGroups(groups);
  renderDiscover(pub);

  bindGlobalSearch();
});

function closeDialog(): void {
  document.getElementById('new-planner-overlay')?.classList.add('hidden');
}

// ── Duplicate modal ──────────────────────────────────────────────────────────

function openDuplicateModal(plannerId: number, plannerTitle: string, triggerBtn: HTMLElement): void {
  const previouslyFocused = triggerBtn;

  const backdrop = document.createElement('section');
  backdrop.className = 'cp-dialog-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  backdrop.innerHTML = `
    <div class="cp-dialog-box cp-dialog-box--narrow">
      <h2 class="cp-dialog-title">Duplicate &ldquo;${escapeHtml(plannerTitle)}&rdquo;</h2>
      <label class="cp-dialog-label">
        Shift dates by
        <select id="cp-dup-preset" class="cp-dialog-input">
          <option value="1year">1 year forward (default)</option>
          <option value="6months">6 months forward</option>
          <option value="custom">Custom&hellip;</option>
        </select>
      </label>
      <div id="cp-dup-custom" style="display:none;">
        <div style="display:flex;gap:8px;margin-top:6px;">
          <label class="cp-dialog-label" style="flex:1;">
            Years
            <input id="cp-dup-years" type="number" class="cp-dialog-input" value="0" min="0" step="1">
          </label>
          <label class="cp-dialog-label" style="flex:1;">
            Months
            <input id="cp-dup-months" type="number" class="cp-dialog-input" value="0" min="0" step="1">
          </label>
          <label class="cp-dialog-label" style="flex:1;">
            Days
            <input id="cp-dup-days" type="number" class="cp-dialog-input" value="0" min="0" step="1">
          </label>
        </div>
      </div>
      <label class="cp-dialog-label cp-dialog-label--last">
        Title suffix
        <input id="cp-dup-suffix" class="cp-dialog-input" value=" (copy)">
      </label>
      <div id="cp-dup-error" class="cp-dialog-error" style="display:none;"></div>
      <div class="cp-dialog-actions">
        <div class="cp-dialog-actions-right">
          <button id="cp-dup-cancel" class="cp-dialog-btn">Cancel</button>
          <button id="cp-dup-confirm" class="cp-dialog-btn cp-dialog-btn--primary">Duplicate</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);

  const presetEl   = backdrop.querySelector<HTMLSelectElement>('#cp-dup-preset')!;
  const customEl   = backdrop.querySelector<HTMLElement>('#cp-dup-custom')!;
  const yearsEl    = backdrop.querySelector<HTMLInputElement>('#cp-dup-years')!;
  const monthsEl   = backdrop.querySelector<HTMLInputElement>('#cp-dup-months')!;
  const daysEl     = backdrop.querySelector<HTMLInputElement>('#cp-dup-days')!;
  const suffixEl   = backdrop.querySelector<HTMLInputElement>('#cp-dup-suffix')!;
  const confirmBtn = backdrop.querySelector<HTMLButtonElement>('#cp-dup-confirm')!;
  const cancelBtn  = backdrop.querySelector<HTMLButtonElement>('#cp-dup-cancel')!;
  const errorEl    = backdrop.querySelector<HTMLElement>('#cp-dup-error')!;

  presetEl.addEventListener('change', () => {
    customEl.style.display = presetEl.value === 'custom' ? '' : 'none';
  });

  // Focus trap
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  backdrop.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(backdrop.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(el => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  });

  function closeModal() {
    backdrop.remove();
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  }

  cancelBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    errorEl.style.display = 'none';

    let offsetYears = 0, offsetMonths = 0, offsetDays = 0;
    if (presetEl.value === '1year') {
      offsetYears = 1;
    } else if (presetEl.value === '6months') {
      offsetMonths = 6;
    } else {
      offsetYears  = parseInt(yearsEl.value,  10) || 0;
      offsetMonths = parseInt(monthsEl.value, 10) || 0;
      offsetDays   = parseInt(daysEl.value,   10) || 0;
    }

    const titleSuffix = suffixEl.value;

    try {
      const result = await api.post<{ id: number }>(`/api/planners/${plannerId}/duplicate`, {
        titleSuffix,
        offsetYears,
        offsetMonths,
        offsetDays,
      });
      window.location.href = `/planner.html?id=${result.id}`;
    } catch (err: unknown) {
      errorEl.textContent = (err as Error).message || 'Failed to duplicate planner.';
      errorEl.style.display = 'block';
      confirmBtn.disabled = false;
    }
  });

  requestAnimationFrame(() => presetEl.focus());
}

// ── Delete confirmation modal ────────────────────────────────────────────────

function openDeleteModal(plannerId: number, plannerTitle: string, cardEl: HTMLElement, triggerBtn: HTMLElement): void {
  const previouslyFocused = triggerBtn;

  const backdrop = document.createElement('section');
  backdrop.className = 'cp-dialog-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  backdrop.innerHTML = `
    <div class="cp-dialog-box cp-dialog-box--narrow">
      <h2 class="cp-dialog-title">Delete planner &ldquo;${escapeHtml(plannerTitle)}&rdquo;?</h2>
      <p style="font-size:13px;color:var(--cp-text-muted);margin-bottom:16px;line-height:1.5;">
        This permanently deletes the planner and all its lanes, activities, and shares.
        <strong>This cannot be undone.</strong>
      </p>
      <label class="cp-dialog-label cp-dialog-label--last">
        Type the planner title to confirm:
        <input id="cp-delete-confirm-input" class="cp-dialog-input" autocomplete="off" spellcheck="false">
      </label>
      <div id="cp-delete-error" class="cp-dialog-error" style="display:none;"></div>
      <div class="cp-dialog-actions">
        <div class="cp-dialog-actions-right">
          <button id="cp-delete-cancel" class="cp-dialog-btn">Cancel</button>
          <button id="cp-delete-confirm" class="cp-dialog-btn cp-dialog-btn--danger" disabled>Delete</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);

  const input   = backdrop.querySelector<HTMLInputElement>('#cp-delete-confirm-input')!;
  const confirmBtn = backdrop.querySelector<HTMLButtonElement>('#cp-delete-confirm')!;
  const cancelBtn  = backdrop.querySelector<HTMLButtonElement>('#cp-delete-cancel')!;
  const errorEl    = backdrop.querySelector<HTMLElement>('#cp-delete-error')!;

  // Focus trap
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const trapHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(backdrop.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(el => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  };
  backdrop.addEventListener('keydown', trapHandler);

  function closeModal() {
    backdrop.remove();
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  }

  // Enable Delete button only when input matches title exactly
  input.addEventListener('input', () => {
    confirmBtn.disabled = input.value !== plannerTitle;
  });

  cancelBtn.addEventListener('click', closeModal);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    errorEl.style.display = 'none';
    try {
      await api.delete(`/api/planners/${plannerId}`);
      // Remove card from the DOM
      cardEl.remove();
      closeModal();
    } catch (err: unknown) {
      errorEl.textContent = (err as Error).message || 'Failed to delete planner.';
      errorEl.style.display = 'block';
      confirmBtn.disabled = false;
    }
  });

  // Focus the input on open
  requestAnimationFrame(() => input.focus());
}

// ── Card builder ─────────────────────────────────────────────────────────────

function buildPlannerCard(p: PlannerSummary, showDelete: boolean): HTMLElement {
  const card = document.createElement('div');
  card.className = 'planner-card';
  const badge = p.isOwner ? 'badge-owner' : (p.permission === 'edit' ? 'badge-edit' : 'badge-view');
  const badgeText = p.isOwner ? 'Owner' : p.permission;
  const publicBadge = p.isPublic ? '<span class="badge badge-public">Public</span>' : '';
  const dupBtn = `<button class="card-action card-duplicate" data-planner-id="${p.id}" title="Duplicate planner">Duplicate</button>`;
  const deleteBtn = showDelete
    ? `<button class="card-action card-delete" data-planner-id="${p.id}" data-planner-title="${escapeHtml(p.title)}" title="Delete planner">Delete</button>`
    : '';
  card.innerHTML = `
    <div class="planner-card-title">${escapeHtml(p.title)}</div>
    <div class="planner-card-dates">${escapeHtml(p.startDate)} → ${escapeHtml(p.endDate)}</div>
    <div class="planner-card-meta">
      <span class="badge ${badge}">${escapeHtml(badgeText)}</span>
      ${publicBadge}
      ${!p.isOwner ? `<span style="font-size:11px;color:#8896a5;">by ${escapeHtml(p.ownerName)}</span>` : ''}
    </div>
    <div class="planner-card-actions">${dupBtn}${deleteBtn}</div>
  `;
  card.addEventListener('click', () => { window.location.href = `/planner.html?id=${p.id}`; });

  const dupBtnEl = card.querySelector<HTMLButtonElement>('.card-duplicate');
  dupBtnEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    openDuplicateModal(p.id, p.title, dupBtnEl);
  });

  if (showDelete) {
    const btn = card.querySelector<HTMLButtonElement>('.card-delete');
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteModal(p.id, p.title, card, btn);
    });
  }

  return card;
}

// ── Render helpers (accept already-fetched data) ─────────────────────────────

function renderOwnedPlanners(planners: PlannerSummary[]): void {
  const grid = document.getElementById('planners-grid');
  if (!grid) return;
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
    const showDelete = p.isOwner || currentUserIsAdmin;
    grid.appendChild(buildPlannerCard(p, showDelete));
  });
}

function renderDiscover(planners: PlannerSummary[]): void {
  let section = document.getElementById('discover-section');

  if (planners.length === 0) {
    if (section) section.style.display = 'none';
    return;
  }

  // Create the section if it doesn't already exist in HTML
  if (!section) {
    section = document.createElement('section');
    section.id = 'discover-section';
    section.className = 'dashboard-section';
    section.innerHTML = `
      <div class="dashboard-title-row" style="margin-top:36px;">
        <h2>Discover</h2>
      </div>
      <div class="planner-grid planners-grid" id="discover-grid"></div>
    `;
    const main = document.querySelector('.dashboard-main');
    if (main) main.appendChild(section);
  } else {
    section.style.display = '';
  }

  const grid = document.getElementById('discover-grid');
  if (!grid) return;
  grid.innerHTML = '';

  planners.forEach(p => {
    // No Delete button in Discover — browse-only
    grid.appendChild(buildPlannerCard(p, false));
  });
}

function renderGroups(groups: GroupSummary[]): void {
  const grid = document.getElementById('groups-grid');
  if (!grid) return;
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
}

// ── Global search ─────────────────────────────────────────────────────────────

function bindGlobalSearch(): void {
  const input = document.getElementById('global-search-input') as HTMLInputElement | null;
  const resultsEl = document.getElementById('global-search-results') as HTMLElement | null;
  if (!input || !resultsEl) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function hideResults(): void {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
  }

  function showResults(results: SearchResult[]): void {
    resultsEl.innerHTML = '';
    if (results.length === 0) {
      resultsEl.innerHTML = '<div style="padding:12px 16px;color:var(--cp-text-muted);font-size:13px;">No results found.</div>';
      resultsEl.classList.remove('hidden');
      return;
    }

    results.forEach(r => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--cp-border);font-size:13px;display:flex;flex-direction:column;gap:2px;';

      let label: string;
      let url: string;
      if (r.kind === 'activity') {
        label = `Activity: ${escapeHtml(r.activityTitle ?? '')} — ${escapeHtml(r.plannerTitle)} · ${escapeHtml(r.laneName ?? '')}`;
        if (r.startDate) label += ` · ${escapeHtml(r.startDate)}`;
        url = `/planner.html?id=${r.plannerId}#activity=${encodeURIComponent(r.activityId ?? '')}`;
      } else {
        label = `Planner: ${escapeHtml(r.plannerTitle)}`;
        url = `/planner.html?id=${r.plannerId}`;
      }

      row.innerHTML = `<span>${label}</span>`;

      row.addEventListener('mousedown', (e) => {
        // Use mousedown so it fires before the blur event hides the dropdown.
        e.preventDefault();
        window.location.href = url;
      });

      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--cp-surface)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = '';
      });

      resultsEl.appendChild(row);
    });

    resultsEl.classList.remove('hidden');
  }

  async function runSearch(q: string): Promise<void> {
    if (q.length < 2) {
      hideResults();
      return;
    }
    try {
      const { results } = await api.get<{ results: SearchResult[] }>(
        '/api/search?q=' + encodeURIComponent(q)
      );
      showResults(results);
    } catch {
      hideResults();
    }
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(q), 200);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2 && resultsEl.children.length > 0) {
      resultsEl.classList.remove('hidden');
    }
  });

  input.addEventListener('blur', () => {
    // Delay so a mousedown on a result row registers before the dropdown hides.
    setTimeout(() => hideResults(), 150);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideResults();
      input.blur();
    }
  });
}

// ── Loader helpers (for post-mutation refresh paths) ─────────────────────────

export async function loadPlanners(): Promise<void> {
  const grid = document.getElementById('planners-grid');
  if (!grid) return;
  try {
    const planners = await api.get<PlannerSummary[]>('/api/planners');
    renderOwnedPlanners(planners);
  } catch (err: unknown) {
    if (grid) grid.innerHTML = `<div class="error-state">Failed to load planners: ${escapeHtml((err as Error).message)}</div>`;
  }
}

export async function loadPublicPlanners(): Promise<void> {
  try {
    const planners = await api.get<PlannerSummary[]>('/api/planners/public');
    renderDiscover(planners);
  } catch {
    // If the endpoint isn't available yet or fails, silently hide section
    const section = document.getElementById('discover-section');
    if (section) section.style.display = 'none';
  }
}

export async function loadGroups(): Promise<void> {
  const grid = document.getElementById('groups-grid');
  if (!grid) return;
  try {
    const groups = await api.get<GroupSummary[]>('/api/groups');
    renderGroups(groups);
  } catch (err: unknown) {
    if (grid) grid.innerHTML = `<div class="error-state">Failed to load groups: ${escapeHtml((err as Error).message)}</div>`;
  }
}
