import { api, setToken, isLoggedIn } from './api-client';

interface AuthResponse { token: string; user: { id: number; username: string; email: string } }

function showError(id: string, msg: string): void {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

function clearError(id: string): void {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  // Redirect if already logged in
  if (isLoggedIn()) { window.location.href = '/dashboard.html'; return; }

  // Show GitLab SSO button if enabled on the server
  fetch('/api/auth/gitlab/status')
    .then(r => r.json())
    .then((data: { enabled: boolean }) => {
      if (data.enabled) {
        document.getElementById('gitlab-sso-section')?.classList.remove('hidden');
      }
    })
    .catch(() => { /* SSO not available, keep button hidden */ });

  // Tab switching
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.querySelectorAll<HTMLFormElement>('.auth-form').forEach(f => f.classList.add('hidden'));
      document.getElementById(`${target}-form`)?.classList.remove('hidden');
    });
  });

  // Login form
  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('login-error');
    const email    = (document.getElementById('login-email')    as HTMLInputElement).value.trim();
    const password = (document.getElementById('login-password') as HTMLInputElement).value;
    try {
      const { token } = await api.post<AuthResponse>('/api/auth/login', { email, password });
      setToken(token);
      window.location.href = '/dashboard.html';
    } catch (err: unknown) {
      showError('login-error', (err as Error).message || 'Login failed');
    }
  });

  // Register form
  document.getElementById('register-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('register-error');
    const username = (document.getElementById('reg-username') as HTMLInputElement).value.trim();
    const email    = (document.getElementById('reg-email')    as HTMLInputElement).value.trim();
    const password = (document.getElementById('reg-password') as HTMLInputElement).value;
    if (password.length < 8) { showError('register-error', 'Password must be at least 8 characters'); return; }
    try {
      const { token } = await api.post<AuthResponse>('/api/auth/register', { username, email, password });
      setToken(token);
      window.location.href = '/dashboard.html';
    } catch (err: unknown) {
      showError('register-error', (err as Error).message || 'Registration failed');
    }
  });
});
