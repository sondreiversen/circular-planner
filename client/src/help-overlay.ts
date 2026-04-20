/**
 * Keyboard-shortcut help overlay.
 * Call openHelpOverlay() to show; dismiss with Esc or click-outside.
 */

const SHORTCUTS: { key: string; action: string }[] = [
  { key: '?',              action: 'Open this help overlay' },
  { key: 'Ctrl/Cmd + Z',  action: 'Undo last action' },
  { key: 'Ctrl/Cmd + Shift + Z', action: 'Redo' },
  { key: 'Ctrl + Y',      action: 'Redo (alternate)' },
  { key: 'Ctrl/Cmd + S',  action: 'Force save now' },
  { key: 'Ctrl + N',      action: 'New activity' },
  { key: '← / →',         action: 'Navigate backward / forward' },
  { key: '↑ / ↓',         action: 'Zoom in / out' },
  { key: 'Scroll wheel',  action: 'Zoom in / out on disc' },
  { key: 'Esc',           action: 'Close dialog / overlay' },
];

let overlayEl: HTMLElement | null = null;
let escListener: ((e: KeyboardEvent) => void) | null = null;

export function openHelpOverlay(): void {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
    if (escListener) {
      document.removeEventListener('keydown', escListener);
      escListener = null;
    }
    return;
  }

  const backdrop = document.createElement('div');
  backdrop.style.cssText = [
    'position:fixed;inset:0;z-index:9000;',
    'background:rgba(0,0,0,0.45);',
    'display:flex;align-items:center;justify-content:center;',
  ].join('');

  const panel = document.createElement('div');
  panel.role = 'dialog';
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Keyboard shortcuts');
  panel.style.cssText = [
    'background:var(--cp-bg,#fff);color:var(--cp-text,#1a2332);',
    'border-radius:10px;padding:28px 32px;max-width:560px;width:90%;',
    'box-shadow:0 12px 48px rgba(0,0,0,0.22);',
    'max-height:85vh;overflow-y:auto;',
  ].join('');

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;';

  const title = document.createElement('h2');
  title.textContent = 'Keyboard Shortcuts';
  title.style.cssText = 'margin:0;font-size:17px;font-weight:700;';
  header.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '\u00d7';
  closeBtn.className = 'cp-btn';
  closeBtn.style.cssText = 'font-size:18px;padding:2px 10px;line-height:1;';
  closeBtn.title = 'Close (Esc)';
  closeBtn.addEventListener('click', closeOverlay);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const grid = document.createElement('div');
  grid.style.cssText = [
    'display:grid;',
    'grid-template-columns:minmax(160px,auto) 1fr;',
    'gap:8px 20px;',
    'font-size:13px;',
  ].join('');

  SHORTCUTS.forEach(({ key, action }) => {
    const keyEl = document.createElement('span');
    keyEl.style.cssText = [
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
      'background:var(--cp-border-subtle,#e4e7ed);',
      'color:var(--cp-text,#1a2332);',
      'border-radius:5px;padding:3px 8px;',
      'font-size:12px;white-space:nowrap;align-self:start;',
    ].join('');
    keyEl.textContent = key;

    const actionEl = document.createElement('span');
    actionEl.style.cssText = 'align-self:center;color:var(--cp-text-muted,#4b5563);';
    actionEl.textContent = action;

    grid.appendChild(keyEl);
    grid.appendChild(actionEl);
  });

  panel.appendChild(grid);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  overlayEl = backdrop;

  // Close on click-outside (backdrop itself, not the panel)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeOverlay();
  });

  escListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeOverlay(); }
  };
  document.addEventListener('keydown', escListener, { capture: true });
}

function closeOverlay(): void {
  overlayEl?.remove();
  overlayEl = null;
  if (escListener) {
    document.removeEventListener('keydown', escListener, { capture: true });
    escListener = null;
  }
}
