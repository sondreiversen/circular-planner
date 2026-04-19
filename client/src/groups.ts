import { api, logout } from './api-client';
import { escapeHtml } from './utils';
import { initTheme, applyTheme, currentTheme } from './theme';
import { applyBranding } from './branding';

initTheme();

interface GroupSummary {
  id: number;
  name: string;
  description: string | null;
  role: 'admin' | 'member';
  member_count: number;
}

interface GroupMember {
  user_id: number;
  username: string;
  email: string;
  role: 'admin' | 'member';
}

interface GroupDetail {
  id: number;
  name: string;
  description: string | null;
  role: 'admin' | 'member';
  members: GroupMember[];
}

interface UserSearchResult {
  id: number;
  username: string;
  email: string;
}

let currentGroup: GroupDetail | null = null;
let selectedUser: UserSearchResult | null = null;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

document.addEventListener('DOMContentLoaded', async () => {
  applyBranding();
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

  const params = new URLSearchParams(window.location.search);
  const idStr = params.get('id');
  if (idStr) {
    await showDetail(parseInt(idStr, 10));
  } else {
    await loadGroups();
    bindNewGroupDialog();
  }
});

async function loadGroups(): Promise<void> {
  const grid = document.getElementById('groups-grid');
  if (!grid) return;
  try {
    const groups = await api.get<GroupSummary[]>('/api/groups');
    grid.innerHTML = '';
    if (groups.length === 0) {
      grid.innerHTML = '<div class="loading-state">No groups yet. Create your first one!</div>';
      return;
    }
    groups.forEach(g => {
      const card = document.createElement('div');
      card.className = 'group-card';
      const roleBadge = g.role === 'admin' ? 'badge-admin' : 'badge-member';
      card.innerHTML = `
        <div class="group-card-name">${escapeHtml(g.name)}</div>
        ${g.description ? `<div class="group-card-desc">${escapeHtml(g.description)}</div>` : ''}
        <div class="group-card-meta">
          <span class="badge ${roleBadge}">${escapeHtml(g.role)}</span>
          <span style="font-size:11px;color:var(--cp-text-muted);">${g.member_count} member${g.member_count !== 1 ? 's' : ''}</span>
        </div>
      `;
      card.addEventListener('click', () => { window.location.href = `/groups.html?id=${g.id}`; });
      grid.appendChild(card);
    });
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="error-state">Failed to load groups: ${escapeHtml((err as Error).message)}</div>`;
  }
}

async function showDetail(groupId: number): Promise<void> {
  document.getElementById('list-view')?.classList.add('hidden');
  const detailView = document.getElementById('detail-view');
  detailView?.classList.remove('hidden');

  try {
    currentGroup = await api.get<GroupDetail>(`/api/groups/${groupId}`);
    renderDetail();
  } catch (err) {
    if (detailView) detailView.innerHTML = `<div class="error-state">Failed to load group: ${escapeHtml((err as Error).message)}</div>`;
  }
}

function renderDetail(): void {
  if (!currentGroup) return;
  const g = currentGroup;
  const isAdmin = g.role === 'admin';

  const nameEl = document.getElementById('detail-name');
  const descEl = document.getElementById('detail-desc');
  if (nameEl) nameEl.textContent = g.name;
  if (descEl) {
    descEl.textContent = g.description || (isAdmin ? 'Add a description…' : '');
    descEl.style.display = g.description || isAdmin ? '' : 'none';
  }

  const editBtn = document.getElementById('edit-group-btn');
  const deleteBtn = document.getElementById('delete-group-btn');
  const addMemberForm = document.getElementById('add-member-form');
  if (editBtn) editBtn.classList.toggle('hidden', !isAdmin);
  if (deleteBtn) deleteBtn.classList.toggle('hidden', !isAdmin);
  if (addMemberForm) addMemberForm.classList.toggle('hidden', !isAdmin);

  renderMembers(g.members, isAdmin);
  bindDetailEvents(g.id, isAdmin);
}

function renderMembers(members: GroupMember[], isAdmin: boolean): void {
  const list = document.getElementById('members-list');
  if (!list) return;
  list.innerHTML = '';
  members.forEach(m => {
    const row = document.createElement('div');
    row.className = 'member-row';
    const roleBadge = m.role === 'admin' ? 'badge-admin' : 'badge-member';
    row.innerHTML = `
      <div class="member-info">
        <span class="member-name">${escapeHtml(m.username)}</span>
        <span class="member-email">${escapeHtml(m.email)}</span>
      </div>
      <div class="member-actions">
        <span class="badge ${roleBadge}">${m.role}</span>
        ${isAdmin ? `
          <select class="role-select" data-uid="${m.user_id}" style="font-size:12px;padding:3px 6px;">
            <option value="member"${m.role === 'member' ? ' selected' : ''}>Member</option>
            <option value="admin"${m.role === 'admin' ? ' selected' : ''}>Admin</option>
          </select>
          <button class="btn btn-danger remove-btn" style="padding:3px 8px;font-size:11px;" data-uid="${m.user_id}">Remove</button>
        ` : ''}
      </div>
    `;
    list.appendChild(row);
  });
}

function bindDetailEvents(groupId: number, isAdmin: boolean): void {
  // Edit group name/desc
  const editBtn = document.getElementById('edit-group-btn');
  const editFormWrap = document.getElementById('edit-form-wrap');
  const editNameInput = document.getElementById('edit-name-input') as HTMLInputElement;
  const editDescInput = document.getElementById('edit-desc-input') as HTMLInputElement;
  const editSaveBtn = document.getElementById('edit-save-btn');
  const editCancelBtn = document.getElementById('edit-cancel-btn');
  const editError = document.getElementById('edit-error');

  editBtn?.addEventListener('click', () => {
    if (!currentGroup) return;
    editNameInput.value = currentGroup.name;
    editDescInput.value = currentGroup.description || '';
    editFormWrap?.classList.remove('hidden');
    editNameInput.focus();
  });
  editCancelBtn?.addEventListener('click', () => { editFormWrap?.classList.add('hidden'); });
  editSaveBtn?.addEventListener('click', async () => {
    const name = editNameInput.value.trim();
    if (!name) { if (editError) { editError.textContent = 'Name cannot be empty'; editError.classList.remove('hidden'); } return; }
    if (editError) editError.classList.add('hidden');
    try {
      await api.patch(`/api/groups/${groupId}`, { name, description: editDescInput.value.trim() || null });
      currentGroup = await api.get<GroupDetail>(`/api/groups/${groupId}`);
      editFormWrap?.classList.add('hidden');
      renderDetail();
    } catch (err) {
      if (editError) { editError.textContent = (err as Error).message; editError.classList.remove('hidden'); }
    }
  });

  // Delete group
  document.getElementById('delete-group-btn')?.addEventListener('click', async () => {
    if (!confirm(`Delete group "${currentGroup?.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/groups/${groupId}`);
      window.location.href = '/groups.html';
    } catch (err) {
      alert((err as Error).message);
    }
  });

  // Role change
  document.getElementById('members-list')?.addEventListener('change', async (e) => {
    const select = e.target as HTMLSelectElement;
    if (!select.classList.contains('role-select')) return;
    const uid = parseInt(select.dataset.uid || '', 10);
    const role = select.value;
    try {
      await api.patch(`/api/groups/${groupId}/members/${uid}`, { role });
      currentGroup = await api.get<GroupDetail>(`/api/groups/${groupId}`);
      renderMembers(currentGroup.members, isAdmin);
    } catch (err) {
      alert((err as Error).message);
      // revert
      currentGroup = await api.get<GroupDetail>(`/api/groups/${groupId}`);
      renderMembers(currentGroup.members, isAdmin);
    }
  });

  // Remove member
  document.getElementById('members-list')?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('.remove-btn') as HTMLElement | null;
    if (!btn) return;
    const uid = parseInt(btn.dataset.uid || '', 10);
    const member = currentGroup?.members.find(m => m.user_id === uid);
    if (!confirm(`Remove ${member?.username ?? 'this user'} from the group?`)) return;
    try {
      await api.delete(`/api/groups/${groupId}/members/${uid}`);
      currentGroup = await api.get<GroupDetail>(`/api/groups/${groupId}`);
      renderMembers(currentGroup.members, isAdmin);
    } catch (err) {
      alert((err as Error).message);
    }
  });

  if (!isAdmin) return;

  // Member search
  const searchInput = document.getElementById('member-search') as HTMLInputElement;
  const searchResults = document.getElementById('member-search-results');
  const addBtn = document.getElementById('add-member-btn') as HTMLButtonElement;
  const addError = document.getElementById('add-member-error');

  searchInput?.addEventListener('input', () => {
    const q = searchInput.value.trim();
    selectedUser = null;
    addBtn.disabled = true;
    if (searchDebounce) clearTimeout(searchDebounce);
    if (q.length < 2) { searchResults?.classList.add('hidden'); return; }
    searchDebounce = setTimeout(async () => {
      try {
        const users = await api.get<UserSearchResult[]>(`/api/users?q=${encodeURIComponent(q)}`);
        if (!searchResults) return;
        if (users.length === 0) {
          searchResults.innerHTML = '<div class="search-result-item">No users found</div>';
          searchResults.classList.remove('hidden');
          return;
        }
        searchResults.innerHTML = '';
        users.forEach(u => {
          const item = document.createElement('div');
          item.className = 'search-result-item';
          item.innerHTML = `<div class="search-result-name">${escapeHtml(u.username)}</div><div class="search-result-email">${escapeHtml(u.email)}</div>`;
          item.addEventListener('click', () => {
            selectedUser = u;
            searchInput.value = `${u.username} (${u.email})`;
            searchResults.classList.add('hidden');
            addBtn.disabled = false;
          });
          searchResults.appendChild(item);
        });
        searchResults.classList.remove('hidden');
      } catch { /* ignore */ }
    }, 200);
  });

  addBtn?.addEventListener('click', async () => {
    if (!selectedUser) return;
    const role = (document.getElementById('member-role') as HTMLSelectElement).value;
    if (addError) addError.classList.add('hidden');
    try {
      await api.post(`/api/groups/${groupId}/members`, { user_id: selectedUser.id, role });
      selectedUser = null;
      searchInput.value = '';
      addBtn.disabled = true;
      currentGroup = await api.get<GroupDetail>(`/api/groups/${groupId}`);
      renderMembers(currentGroup.members, isAdmin);
    } catch (err) {
      if (addError) { addError.textContent = (err as Error).message; addError.classList.remove('hidden'); }
    }
  });
}

function bindNewGroupDialog(): void {
  const overlay = document.getElementById('new-group-overlay');
  document.getElementById('new-group-btn')?.addEventListener('click', () => {
    overlay?.classList.remove('hidden');
    (document.getElementById('ng-name') as HTMLInputElement)?.focus();
  });
  document.getElementById('ng-cancel')?.addEventListener('click', () => overlay?.classList.add('hidden'));
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });

  document.getElementById('new-group-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (document.getElementById('ng-name') as HTMLInputElement).value.trim();
    const description = (document.getElementById('ng-desc') as HTMLInputElement).value.trim();
    const errEl = document.getElementById('ng-error');
    if (!name) return;
    if (errEl) errEl.classList.add('hidden');
    try {
      const g = await api.post<{ id: number }>('/api/groups', { name, description: description || null });
      window.location.href = `/groups.html?id=${g.id}`;
    } catch (err) {
      if (errEl) { errEl.textContent = (err as Error).message; errEl.classList.remove('hidden'); }
    }
  });
}
