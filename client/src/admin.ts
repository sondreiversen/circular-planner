import { api, logout } from './api-client';
import { escapeHtml, displayName } from './utils';
import { initTheme, applyTheme, currentTheme } from './theme';
import { applyBranding } from './branding';
import { installOfflineBanner, installGlobalErrorHandlers } from './toast';

initTheme();
installOfflineBanner();
installGlobalErrorHandlers();

interface AdminUser {
  id: number;
  username: string;
  email: string;
  full_name: string | null;
  auth_provider: string | null;
  is_admin: boolean;
  created_at: string;
}

interface AdminGroup {
  id: number;
  name: string;
  description: string | null;
  member_count: number;
}

interface GroupMember {
  user_id: number;
  username: string;
  email: string;
  fullName?: string | null;
  role: 'admin' | 'member';
}

interface UserSearchResult {
  id: number;
  username: string;
  email: string;
  fullName?: string | null;
}

let currentMeID = 0;
let selectedAddMemberUser: UserSearchResult | null = null;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

document.addEventListener('DOMContentLoaded', async () => {
  applyBranding();
  try {
    const meRes = await fetch('/api/auth/me', { credentials: 'include' });
    if (!meRes.ok) { window.location.href = '/index.html'; return; }
    const me = await meRes.json() as { user?: { username?: string; fullName?: string; id?: number; is_admin?: boolean } };
    if (!me.user?.is_admin) { window.location.href = '/dashboard.html'; return; }
    currentMeID = me.user.id ?? 0;
    const el = document.getElementById('header-username');
    if (el && me.user?.username) el.textContent = displayName({ username: me.user.username, fullName: me.user.fullName });
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

  document.getElementById('tab-users')?.addEventListener('click', () => switchTab('users'));
  document.getElementById('tab-groups')?.addEventListener('click', () => switchTab('groups'));
  document.getElementById('tab-settings')?.addEventListener('click', () => switchTab('settings'));

  await loadUsers();
});

function switchTab(tab: 'users' | 'groups' | 'settings'): void {
  const usersSection = document.getElementById('section-users');
  const groupsSection = document.getElementById('section-groups');
  const settingsSection = document.getElementById('section-settings');
  const tabUsers = document.getElementById('tab-users');
  const tabGroups = document.getElementById('tab-groups');
  const tabSettings = document.getElementById('tab-settings');

  // Hide all, deactivate all
  usersSection?.classList.add('hidden');
  groupsSection?.classList.add('hidden');
  settingsSection?.classList.add('hidden');
  tabUsers?.classList.remove('active');
  tabGroups?.classList.remove('active');
  tabSettings?.classList.remove('active');

  if (tab === 'users') {
    usersSection?.classList.remove('hidden');
    tabUsers?.classList.add('active');
    loadUsers();
  } else if (tab === 'groups') {
    groupsSection?.classList.remove('hidden');
    tabGroups?.classList.add('active');
    loadGroups();
  } else {
    settingsSection?.classList.remove('hidden');
    tabSettings?.classList.add('active');
    loadSettings();
  }
}

async function loadSettings(): Promise<void> {
  const cb = document.getElementById('setting-allow-registration') as HTMLInputElement | null;
  const feedback = document.getElementById('settings-feedback');
  if (!cb) return;

  try {
    const result = await api.get<{ allowRegistration: boolean }>('/api/admin/settings');
    cb.checked = result.allowRegistration;
  } catch { /* toast already shown */ }

  // Remove previous listener by cloning
  const newCb = cb.cloneNode(true) as HTMLInputElement;
  cb.parentNode?.replaceChild(newCb, cb);

  newCb.addEventListener('change', async () => {
    try {
      await api.patch<{ allowRegistration: boolean }>('/api/admin/settings', { allowRegistration: newCb.checked });
      if (feedback) {
        feedback.textContent = 'Settings saved.';
        feedback.style.background = 'var(--cp-surface-2, #f0f4ff)';
        feedback.style.color = 'var(--cp-accent, #0052cc)';
        feedback.classList.remove('hidden');
        setTimeout(() => feedback.classList.add('hidden'), 2000);
      }
    } catch {
      if (feedback) {
        feedback.textContent = 'Failed to save settings.';
        feedback.style.background = 'var(--cp-feedback-err-bg)';
        feedback.style.color = 'var(--cp-feedback-err-fg)';
        feedback.classList.remove('hidden');
        setTimeout(() => feedback.classList.add('hidden'), 2000);
      }
    }
  });
}

async function loadUsers(): Promise<void> {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  try {
    const users = await api.get<AdminUser[]>('/api/admin/users');
    tbody.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      const adminBadge = u.is_admin
        ? `<span class="badge badge-admin">admin</span>`
        : `<span class="badge badge-member">user</span>`;
      const isSelf = u.id === currentMeID;
      const nameDisplay = u.full_name ? escapeHtml(u.full_name) : '<span style="color:var(--cp-text-muted)">—</span>';
      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${nameDisplay}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.auth_provider ?? 'local')}</td>
        <td>${adminBadge}</td>
        <td>${escapeHtml(u.created_at.slice(0, 10))}</td>
        <td>
          <div class="action-cell">
            <button class="btn btn-ghost btn-sm toggle-admin-btn"
              data-id="${u.id}" data-is-admin="${u.is_admin ? '1' : '0'}"
              ${isSelf ? 'disabled title="Cannot change your own role"' : ''}>
              ${u.is_admin ? 'Revoke admin' : 'Make admin'}
            </button>
            <button class="btn btn-danger btn-sm delete-user-btn"
              data-id="${u.id}" data-username="${escapeHtml(u.username)}" data-fullname="${escapeHtml(u.full_name ?? '')}"
              ${isSelf ? 'disabled title="Cannot delete your own account"' : ''}>
              Delete
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll<HTMLButtonElement>('.toggle-admin-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id ?? '0', 10);
        const isAdmin = btn.dataset.isAdmin === '1';
        try {
          await api.patch('/api/admin/users/' + id, { is_admin: !isAdmin });
          await loadUsers();
        } catch { /* toast already shown */ }
      });
    });

    tbody.querySelectorAll<HTMLButtonElement>('.delete-user-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id ?? '0', 10);
        const username = btn.dataset.username ?? '';
        const fullName = btn.dataset.fullname ?? '';
        const label = fullName ? `${fullName} (${username})` : username;
        if (!confirm(`Delete user "${label}"? This cannot be undone.`)) return;
        try {
          await api.delete('/api/admin/users/' + id);
          await loadUsers();
        } catch { /* toast already shown */ }
      });
    });
  } catch { /* toast already shown */ }
}

async function loadGroups(): Promise<void> {
  const list = document.getElementById('groups-list');
  if (!list) return;
  list.innerHTML = '<div class="loading-state">Loading…</div>';
  try {
    const groups = await api.get<AdminGroup[]>('/api/admin/groups');
    list.innerHTML = '';
    if (groups.length === 0) {
      list.innerHTML = '<div class="loading-state">No groups.</div>';
      return;
    }
    groups.forEach(g => {
      const wrap = document.createElement('div');
      wrap.dataset.groupId = String(g.id);

      const header = document.createElement('div');
      header.className = 'group-row-header';
      header.innerHTML = `
        <div>
          <div class="group-row-name">${escapeHtml(g.name)}</div>
          ${g.description ? `<div class="group-row-meta">${escapeHtml(g.description)}</div>` : ''}
        </div>
        <span class="group-row-meta">${g.member_count} member${g.member_count !== 1 ? 's' : ''}</span>
      `;

      const panel = document.createElement('div');
      panel.className = 'group-members-panel hidden';

      header.addEventListener('click', async () => {
        if (panel.classList.contains('hidden')) {
          panel.classList.remove('hidden');
          await loadGroupPanel(panel, g.id);
        } else {
          panel.classList.add('hidden');
        }
      });

      wrap.appendChild(header);
      wrap.appendChild(panel);
      list.appendChild(wrap);
    });
  } catch { /* toast already shown */ }
}

async function loadGroupPanel(panel: HTMLElement, groupID: number): Promise<void> {
  panel.innerHTML = '<div class="loading-state" style="padding:12px">Loading…</div>';
  try {
    const members = await api.get<GroupMember[]>(`/api/admin/groups/${groupID}/members`);
    panel.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'admin-table';
    table.innerHTML = `<thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>`;
    const tbody = document.createElement('tbody');

    members.forEach(m => {
      const tr = document.createElement('tr');
      const roleBadge = m.role === 'admin'
        ? `<span class="badge badge-admin">admin</span>`
        : `<span class="badge badge-member">member</span>`;
      const dn = displayName({ username: m.username, fullName: m.fullName });
      tr.innerHTML = `
        <td><span class="member-display-name">${escapeHtml(dn)}</span><br><span class="member-sub">@${escapeHtml(m.username)}</span></td>
        <td>${escapeHtml(m.email)}</td>
        <td>${roleBadge}</td>
        <td>
          <div class="action-cell">
            <button class="btn btn-ghost btn-sm toggle-role-btn"
              data-user-id="${m.user_id}" data-role="${m.role}">
              ${m.role === 'admin' ? 'Make member' : 'Make admin'}
            </button>
            <button class="btn btn-danger btn-sm remove-member-btn"
              data-user-id="${m.user_id}">
              Remove
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    panel.appendChild(table);

    panel.querySelectorAll<HTMLButtonElement>('.toggle-role-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = parseInt(btn.dataset.userId ?? '0', 10);
        const newRole = btn.dataset.role === 'admin' ? 'member' : 'admin';
        try {
          await api.patch(`/api/admin/groups/${groupID}/members/${uid}`, { role: newRole });
          await loadGroupPanel(panel, groupID);
        } catch { /* toast already shown */ }
      });
    });

    panel.querySelectorAll<HTMLButtonElement>('.remove-member-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = parseInt(btn.dataset.userId ?? '0', 10);
        if (!confirm('Remove this member from the group?')) return;
        try {
          await api.delete(`/api/admin/groups/${groupID}/members/${uid}`);
          await loadGroupPanel(panel, groupID);
        } catch { /* toast already shown */ }
      });
    });

    // Add member form
    const addForm = document.createElement('div');
    addForm.className = 'add-member-form';
    addForm.innerHTML = `
      <h4>Add Member</h4>
      <div class="add-member-fields">
        <label>
          Search user
          <input type="text" class="member-search" placeholder="Username or email…" autocomplete="off">
        </label>
        <label>
          Role
          <select class="member-role">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button class="btn btn-primary add-member-btn" disabled>Add</button>
      </div>
      <div class="search-results hidden"></div>
    `;
    panel.appendChild(addForm);

    const searchInput = addForm.querySelector<HTMLInputElement>('.member-search')!;
    const roleSelect = addForm.querySelector<HTMLSelectElement>('.member-role')!;
    const addBtn = addForm.querySelector<HTMLButtonElement>('.add-member-btn')!;
    const resultsDiv = addForm.querySelector<HTMLDivElement>('.search-results')!;
    let selected: UserSearchResult | null = null;

    searchInput.addEventListener('input', () => {
      selected = null;
      addBtn.disabled = true;
      if (searchDebounce) clearTimeout(searchDebounce);
      const q = searchInput.value.trim();
      if (!q) { resultsDiv.classList.add('hidden'); return; }
      searchDebounce = setTimeout(async () => {
        try {
          const results = await api.get<UserSearchResult[]>(`/api/users?q=${encodeURIComponent(q)}`);
          resultsDiv.innerHTML = '';
          if (results.length === 0) {
            resultsDiv.innerHTML = '<div class="search-result-item">No users found</div>';
          } else {
            results.forEach(u => {
              const item = document.createElement('div');
              item.className = 'search-result-item';
              const dn = displayName({ username: u.username, fullName: u.fullName });
              item.innerHTML = `<div class="search-result-name">${escapeHtml(dn)} &lt;${escapeHtml(u.email)}&gt;</div>`;
              item.addEventListener('click', () => {
                selected = u;
                searchInput.value = `${displayName({ username: u.username, fullName: u.fullName })} (${u.username})`;
                addBtn.disabled = false;
                resultsDiv.classList.add('hidden');
              });
              resultsDiv.appendChild(item);
            });
          }
          resultsDiv.classList.remove('hidden');
        } catch { /* toast already shown */ }
      }, 200);
    });

    addBtn.addEventListener('click', async () => {
      if (!selected) return;
      try {
        await api.post(`/api/admin/groups/${groupID}/members`, { user_ids: [selected.id], role: roleSelect.value });
        searchInput.value = '';
        selected = null;
        addBtn.disabled = true;
        resultsDiv.classList.add('hidden');
        await loadGroupPanel(panel, groupID);
      } catch { /* toast already shown */ }
    });
  } catch { /* toast already shown */ }
}
