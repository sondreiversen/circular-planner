import { api, logout } from './api-client';
import { escapeHtml, displayName } from './utils';
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

// Tracks whether the current user is an admin (populated on DOMContentLoaded)
let currentUserIsAdmin = false;

document.addEventListener('DOMContentLoaded', async () => {
  applyBranding();
  // Verify session via cookie; populate username from /api/auth/me.
  try {
    const meRes = await fetch('/api/auth/me', { credentials: 'include' });
    if (!meRes.ok) { window.location.href = '/index.html'; return; }
    const me = await meRes.json() as { user?: { username?: string; fullName?: string; is_admin?: boolean } };
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
  await loadPublicPlanners();
});

function closeDialog(): void {
  document.getElementById('new-planner-overlay')?.classList.add('hidden');
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
    ${deleteBtn ? `<div class="planner-card-actions">${deleteBtn}</div>` : ''}
  `;
  card.addEventListener('click', () => { window.location.href = `/planner.html?id=${p.id}`; });

  if (showDelete) {
    const btn = card.querySelector<HTMLButtonElement>('.card-delete');
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteModal(p.id, p.title, card, btn);
    });
  }

  return card;
}

// ── Loaders ──────────────────────────────────────────────────────────────────

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
      const showDelete = p.isOwner || currentUserIsAdmin;
      grid.appendChild(buildPlannerCard(p, showDelete));
    });
  } catch (err: unknown) {
    if (grid) grid.innerHTML = `<div class="error-state">Failed to load planners: ${escapeHtml((err as Error).message)}</div>`;
  }
}

async function loadPublicPlanners(): Promise<void> {
  let section = document.getElementById('discover-section');
  try {
    const planners = await api.get<PlannerSummary[]>('/api/planners/public');
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
  } catch {
    // If the endpoint isn't available yet or fails, silently hide section
    if (section) section.style.display = 'none';
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
