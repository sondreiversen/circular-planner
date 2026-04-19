export async function applyBranding(): Promise<void> {
  try {
    const r = await fetch('/api/branding');
    if (!r.ok) return;
    const { name, logoUrl } = await r.json() as { name: string; logoUrl: string };

    document.querySelectorAll<HTMLElement>('.app-name').forEach(el => { el.textContent = name; });

    const authH1 = document.querySelector<HTMLElement>('.auth-logo h1');
    if (authH1) authH1.textContent = name;

    document.title = document.title.replace('Circular Planner', name);

    if (logoUrl) {
      document.querySelectorAll('.app-logo-svg').forEach(el => {
        const w = el.getAttribute('width') || '28';
        const h = el.getAttribute('height') || '28';
        const img = document.createElement('img');
        img.src = logoUrl;
        img.alt = name;
        img.width = parseInt(w);
        img.height = parseInt(h);
        img.style.objectFit = 'contain';
        el.replaceWith(img);
      });
    }
  } catch { /* best-effort */ }
}
