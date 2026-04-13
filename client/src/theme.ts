const STORAGE_KEY = 'cp_theme';

export function currentTheme(): 'light' | 'dark' {
  return (localStorage.getItem(STORAGE_KEY) as 'light' | 'dark') || 'light';
}

export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
  document.dispatchEvent(new CustomEvent('cp-theme-change', { detail: theme }));
}

export function initTheme(): void {
  applyTheme(currentTheme());
}
