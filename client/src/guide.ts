/**
 * In-app guide: a categorized reference panel, an interactive coachmark tour,
 * and a subtle one-time first-visit prompt offering the tour.
 *
 * Reuses the overlay conventions of help-overlay.ts (dynamically-created,
 * themed via CSS custom properties, Esc / click-outside to close) and the
 * cp-guide-* styles defined in circular-planner.css.
 */

import { TOUR_STEPS, REFERENCE_SECTIONS, type TourStep } from './guide-content';

const SEEN_KEY = 'cp_guide_seen';

function markSeen(): void {
  try { localStorage.setItem(SEEN_KEY, 'true'); } catch { /* ignore */ }
}

// ============================================================
// Reference panel
// ============================================================

let panelEl: HTMLElement | null = null;
let panelEsc: ((e: KeyboardEvent) => void) | null = null;
let panelPrevFocus: HTMLElement | null = null;

export function openGuidePanel(): void {
  if (panelEl) { closeGuidePanel(); return; }
  panelPrevFocus = document.activeElement as HTMLElement | null;

  const backdrop = document.createElement('div');
  backdrop.className = 'cp-guide-panel-backdrop';

  const panel = document.createElement('div');
  panel.className = 'cp-guide-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Guide and help');

  const header = document.createElement('div');
  header.className = 'cp-guide-panel-header';
  const title = document.createElement('h2');
  title.textContent = 'Guide & help';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'cp-btn';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close (Esc)';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', closeGuidePanel);
  header.append(title, closeBtn);
  panel.appendChild(header);

  const intro = document.createElement('p');
  intro.className = 'cp-guide-panel-intro';
  intro.textContent = 'New to the circular planner? Take the guided tour, or browse the feature reference below.';
  panel.appendChild(intro);

  const tourBtn = document.createElement('button');
  tourBtn.className = 'cp-btn cp-btn-primary cp-guide-tour-btn';
  tourBtn.textContent = '▶ Take the tour';
  tourBtn.addEventListener('click', () => { closeGuidePanel(); startTour(); });
  panel.appendChild(tourBtn);

  REFERENCE_SECTIONS.forEach((section, i) => {
    const details = document.createElement('details');
    details.className = 'cp-guide-section';
    if (i === 0) details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = section.title;
    details.appendChild(summary);
    const ul = document.createElement('ul');
    section.items.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    });
    details.appendChild(ul);
    panel.appendChild(details);
  });

  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  panelEl = backdrop;

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeGuidePanel(); });
  panelEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeGuidePanel(); } };
  document.addEventListener('keydown', panelEsc, { capture: true });

  tourBtn.focus();
}

function closeGuidePanel(): void {
  panelEl?.remove();
  panelEl = null;
  if (panelEsc) { document.removeEventListener('keydown', panelEsc, { capture: true }); panelEsc = null; }
  panelPrevFocus?.focus?.();
  panelPrevFocus = null;
}

// ============================================================
// Interactive tour
// ============================================================

interface TourUI {
  backdrop: HTMLElement;
  spotlight: HTMLElement;
  tooltip: HTMLElement;
  titleEl: HTMLElement;
  bodyEl: HTMLElement;
  counterEl: HTMLElement;
  backBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
}

let tourUI: TourUI | null = null;
let tourSteps: TourStep[] = [];
let tourIdx = 0;
let tourResize: (() => void) | null = null;
let tourEsc: ((e: KeyboardEvent) => void) | null = null;

export function startTour(): void {
  if (tourUI) endTour();

  // Only keep steps whose target is present (handles view-only planners).
  tourSteps = TOUR_STEPS.filter((s) => document.querySelector(s.selector));
  if (tourSteps.length === 0) { markSeen(); return; }
  tourIdx = 0;

  const backdrop = document.createElement('div');
  backdrop.className = 'cp-guide-tour-backdrop';
  // Clicks on the dimmed area are swallowed (no accidental dismiss).
  backdrop.addEventListener('click', (e) => e.stopPropagation());

  const spotlight = document.createElement('div');
  spotlight.className = 'cp-guide-spotlight';

  const tooltip = document.createElement('div');
  tooltip.className = 'cp-guide-tooltip';
  tooltip.setAttribute('role', 'dialog');
  tooltip.setAttribute('aria-modal', 'true');

  const counterEl = document.createElement('div');
  counterEl.className = 'cp-guide-tooltip-counter';

  const titleEl = document.createElement('h3');
  titleEl.className = 'cp-guide-tooltip-title';

  const bodyEl = document.createElement('p');
  bodyEl.className = 'cp-guide-tooltip-body';

  const actions = document.createElement('div');
  actions.className = 'cp-guide-tooltip-actions';

  const skipBtn = document.createElement('button');
  skipBtn.className = 'cp-btn cp-guide-skip';
  skipBtn.textContent = 'Skip';
  skipBtn.addEventListener('click', endTour);

  const navWrap = document.createElement('div');
  navWrap.className = 'cp-guide-tooltip-nav';
  const backBtn = document.createElement('button');
  backBtn.className = 'cp-btn';
  backBtn.textContent = 'Back';
  backBtn.addEventListener('click', () => goTo(tourIdx - 1));
  const nextBtn = document.createElement('button');
  nextBtn.className = 'cp-btn cp-btn-primary';
  nextBtn.addEventListener('click', () => {
    if (tourIdx >= tourSteps.length - 1) endTour();
    else goTo(tourIdx + 1);
  });
  navWrap.append(backBtn, nextBtn);
  actions.append(skipBtn, navWrap);

  tooltip.append(counterEl, titleEl, bodyEl, actions);
  document.body.append(backdrop, spotlight, tooltip);

  tourUI = { backdrop, spotlight, tooltip, titleEl, bodyEl, counterEl, backBtn, nextBtn };

  tourResize = () => positionStep();
  window.addEventListener('resize', tourResize);
  window.addEventListener('scroll', tourResize, true);
  tourEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); endTour(); }
    else if (e.key === 'ArrowRight') { e.stopPropagation(); if (tourIdx < tourSteps.length - 1) goTo(tourIdx + 1); }
    else if (e.key === 'ArrowLeft') { e.stopPropagation(); if (tourIdx > 0) goTo(tourIdx - 1); }
  };
  document.addEventListener('keydown', tourEsc, { capture: true });

  goTo(0);
}

function goTo(i: number): void {
  if (!tourUI) return;
  tourIdx = Math.max(0, Math.min(i, tourSteps.length - 1));
  const step = tourSteps[tourIdx];
  const target = document.querySelector(step.selector);
  if (!target) { // target vanished mid-tour — skip forward, or end.
    if (tourIdx < tourSteps.length - 1) { goTo(tourIdx + 1); return; }
    endTour(); return;
  }

  tourUI.counterEl.textContent = `Step ${tourIdx + 1} of ${tourSteps.length}`;
  tourUI.titleEl.textContent = step.title;
  tourUI.bodyEl.textContent = step.body;
  tourUI.backBtn.disabled = tourIdx === 0;
  tourUI.nextBtn.textContent = tourIdx >= tourSteps.length - 1 ? 'Done' : 'Next';

  target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  // Position after the (possible) scroll settles.
  requestAnimationFrame(() => requestAnimationFrame(positionStep));
  tourUI.nextBtn.focus();
}

function positionStep(): void {
  if (!tourUI) return;
  const step = tourSteps[tourIdx];
  const target = document.querySelector(step.selector);
  if (!target) return;
  const r = target.getBoundingClientRect();
  const pad = 6;
  const sx = Math.max(4, r.left - pad);
  const sy = Math.max(4, r.top - pad);
  const sw = r.width + pad * 2;
  const sh = r.height + pad * 2;
  Object.assign(tourUI.spotlight.style, {
    left: `${sx}px`, top: `${sy}px`, width: `${sw}px`, height: `${sh}px`,
  });

  // Tooltip placement with viewport clamping.
  const tip = tourUI.tooltip;
  const tw = tip.offsetWidth || 320;
  const th = tip.offsetHeight || 160;
  const gap = 12;
  const placement = step.placement ?? 'bottom';
  let tx: number, ty: number;
  switch (placement) {
    case 'top':    tx = r.left + r.width / 2 - tw / 2; ty = r.top - th - gap; break;
    case 'left':   tx = r.left - tw - gap;             ty = r.top + r.height / 2 - th / 2; break;
    case 'right':  tx = r.right + gap;                 ty = r.top + r.height / 2 - th / 2; break;
    default:       tx = r.left + r.width / 2 - tw / 2; ty = r.bottom + gap; break;
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  // If the chosen side overflows vertically, flip bottom<->top.
  if (placement === 'bottom' && ty + th > vh - 8) ty = r.top - th - gap;
  if (placement === 'top' && ty < 8) ty = r.bottom + gap;
  tx = Math.max(8, Math.min(tx, vw - tw - 8));
  ty = Math.max(8, Math.min(ty, vh - th - 8));
  tip.style.left = `${tx}px`;
  tip.style.top = `${ty}px`;
}

function endTour(): void {
  if (tourResize) {
    window.removeEventListener('resize', tourResize);
    window.removeEventListener('scroll', tourResize, true);
    tourResize = null;
  }
  if (tourEsc) { document.removeEventListener('keydown', tourEsc, { capture: true }); tourEsc = null; }
  if (tourUI) {
    tourUI.backdrop.remove();
    tourUI.spotlight.remove();
    tourUI.tooltip.remove();
    tourUI = null;
  }
  markSeen();
}

// ============================================================
// First-visit prompt
// ============================================================

export function maybeShowFirstVisitPrompt(): void {
  let seen: string | null = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { /* ignore */ }
  if (seen) return;

  const card = document.createElement('div');
  card.className = 'cp-guide-prompt';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Welcome');

  const msg = document.createElement('p');
  msg.className = 'cp-guide-prompt-msg';
  msg.textContent = '👋 New here? Take a quick tour of the planner.';

  const actions = document.createElement('div');
  actions.className = 'cp-guide-prompt-actions';

  const dismiss = () => { markSeen(); card.remove(); };

  const startBtn = document.createElement('button');
  startBtn.className = 'cp-btn cp-btn-primary';
  startBtn.textContent = 'Start tour';
  startBtn.addEventListener('click', () => { dismiss(); startTour(); });

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'cp-btn';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', dismiss);

  actions.append(startBtn, dismissBtn);
  card.append(msg, actions);
  document.body.appendChild(card);
  requestAnimationFrame(() => card.classList.add('cp-guide-prompt-visible'));
}
