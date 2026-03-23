/**
 * Global tooltip system for [data-tooltip] elements.
 * Uses a single fixed-position element appended to <body>,
 * so tooltips are never clipped by overflow:hidden ancestors.
 *
 * Placement auto-detects: prefers below, flips above if near bottom,
 * shifts horizontally to stay within viewport.
 */

const DELAY = 300; // ms before showing
const GAP = 6;     // px between trigger and tooltip

let el: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function getEl(): HTMLDivElement {
  if (!el) {
    el = document.createElement('div');
    el.className = 's2-tooltip';
    document.body.appendChild(el);
  }
  return el;
}

function show(target: HTMLElement): void {
  const text = target.getAttribute('data-tooltip');
  if (!text) return;

  const tip = getEl();
  tip.textContent = text;
  tip.classList.remove('s2-tooltip--visible');

  // Measure after setting text
  tip.style.left = '0';
  tip.style.top = '0';
  const rect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();

  // Preferred position from data-tooltip-pos, default "bottom"
  const pos = target.getAttribute('data-tooltip-pos') || 'bottom';

  let top: number;
  let left: number;

  if (pos === 'top') {
    top = rect.top - tipRect.height - GAP;
    left = rect.left + rect.width / 2 - tipRect.width / 2;
  } else if (pos === 'right') {
    top = rect.top + rect.height / 2 - tipRect.height / 2;
    left = rect.right + GAP;
  } else {
    // bottom (default)
    top = rect.bottom + GAP;
    left = rect.left + rect.width / 2 - tipRect.width / 2;
  }

  // Auto-flip vertical if clipped
  if (pos === 'bottom' && top + tipRect.height > window.innerHeight - 4) {
    top = rect.top - tipRect.height - GAP;
  } else if (pos === 'top' && top < 4) {
    top = rect.bottom + GAP;
  }

  // Clamp horizontal to viewport
  if (left < 4) left = 4;
  if (left + tipRect.width > window.innerWidth - 4) {
    left = window.innerWidth - tipRect.width - 4;
  }

  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
  tip.classList.add('s2-tooltip--visible');
}

function hide(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  el?.classList.remove('s2-tooltip--visible');
}

/** Call once to install global tooltip listeners. */
export function initTooltips(): void {
  document.addEventListener('pointerenter', (e) => {
    const target = (e.target as HTMLElement).closest?.('[data-tooltip]') as HTMLElement | null;
    if (!target) return;
    hide();
    timer = setTimeout(() => show(target), DELAY);
  }, true);

  document.addEventListener('pointerleave', (e) => {
    const target = (e.target as HTMLElement).closest?.('[data-tooltip]') as HTMLElement | null;
    if (target) hide();
  }, true);

  document.addEventListener('pointerdown', hide, true);
}
