// ============================================================
// Toast notification system + offline banner + global error handlers
// ============================================================

type ToastType = 'info' | 'success' | 'error';

interface ToastOptions {
  /** Override auto-dismiss duration in ms. Pass 0 to never auto-dismiss. */
  duration?: number;
}

function getRoot(): HTMLElement {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    document.body.appendChild(root);
  }
  return root;
}

function show(type: ToastType, message: string, opts?: ToastOptions): void {
  const root = getRoot();
  const el = document.createElement('div');
  el.className = `cp-toast cp-toast-${type}`;
  el.setAttribute('role', 'alert');

  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  el.innerHTML = `<span class="cp-toast-icon">${icon}</span><span class="cp-toast-msg">${message}</span>`;

  // Close on click
  el.addEventListener('click', () => dismiss(el));

  root.appendChild(el);

  // Trigger enter animation on next frame
  requestAnimationFrame(() => el.classList.add('cp-toast-visible'));

  const duration = opts?.duration !== undefined ? opts.duration : type === 'error' ? 6000 : 4000;
  if (duration > 0) {
    setTimeout(() => dismiss(el), duration);
  }
}

function dismiss(el: HTMLElement): void {
  el.classList.remove('cp-toast-visible');
  el.addEventListener('transitionend', () => el.remove(), { once: true });
}

export const toast = {
  info(message: string, opts?: ToastOptions): void { show('info', message, opts); },
  success(message: string, opts?: ToastOptions): void { show('success', message, opts); },
  error(message: string, opts?: ToastOptions): void { show('error', message, opts); },
};

// ============================================================
// Offline banner
// ============================================================

let offlineBanner: HTMLElement | null = null;

function getOfflineBanner(): HTMLElement {
  if (!offlineBanner) {
    offlineBanner = document.createElement('div');
    offlineBanner.id = 'offline-banner';
    offlineBanner.textContent = "You're offline — changes will be saved when you reconnect.";
    offlineBanner.setAttribute('role', 'status');
    document.body.insertBefore(offlineBanner, document.body.firstChild);
  }
  return offlineBanner;
}

function updateOfflineState(online: boolean): void {
  const banner = getOfflineBanner();
  if (online) {
    banner.classList.remove('offline-banner-visible');
  } else {
    banner.classList.add('offline-banner-visible');
  }
}

export function installOfflineBanner(): void {
  // Set initial state without toast on load
  updateOfflineState(navigator.onLine);

  window.addEventListener('offline', () => {
    updateOfflineState(false);
    toast.error("You're offline — check your connection.", { duration: 5000 });
  });

  window.addEventListener('online', () => {
    updateOfflineState(true);
    toast.success('Back online!');
  });
}

// ============================================================
// Global error handlers + client-error reporting
// ============================================================

function reportError(payload: Record<string, unknown>): void {
  try {
    fetch('/api/client-errors', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => { /* fire-and-forget */ });
  } catch { /* ignore */ }
}

export function installGlobalErrorHandlers(): void {
  window.onerror = (message, source, lineno, colno, error) => {
    reportError({
      message: String(message),
      stack: error?.stack ?? null,
      url: source ?? null,
      line: lineno ?? null,
      col: colno ?? null,
      ua: navigator.userAgent,
      ts: new Date().toISOString(),
    });
    toast.error('Something went wrong — the error was reported.');
    return false; // don't suppress default handling
  };

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection');
    const stack   = reason instanceof Error ? (reason.stack ?? null) : null;
    reportError({
      message,
      stack,
      url: window.location.href,
      line: null,
      col: null,
      ua: navigator.userAgent,
      ts: new Date().toISOString(),
    });
    toast.error('Something went wrong — the error was reported.');
  });
}
