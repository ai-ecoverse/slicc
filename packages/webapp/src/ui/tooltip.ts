/**
 * Global tooltip system for [data-tooltip] elements.
 * Uses a single fixed-position element appended to <body>,
 * so tooltips are never clipped by overflow:hidden ancestors.
 *
 * Placement honors `data-tooltip-pos` ('top' | 'bottom' | 'left' | 'right',
 * default 'bottom'), flips to the opposite side when the preferred side is
 * clipped, then clamps to the viewport on both axes.
 */

const DELAY = 100; // ms before showing
const GAP = 6; // px between trigger and tooltip

let el: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * Track the [data-tooltip] element currently being hovered. Used to
 * ignore pointer transitions BETWEEN descendants of the same target —
 * `pointerenter` / `pointerleave` (capture) fire for every internal
 * element boundary the cursor crosses, which would otherwise reset the
 * show-timer and hide the tooltip every time the cursor moves a pixel
 * inside a button with multi-element content (e.g. a Lucide SVG with
 * several `<path>` children).
 */
let activeTarget: HTMLElement | null = null;

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
  } else if (pos === 'left') {
    top = rect.top + rect.height / 2 - tipRect.height / 2;
    left = rect.left - tipRect.width - GAP;
  } else {
    // bottom (default)
    top = rect.bottom + GAP;
    left = rect.left + rect.width / 2 - tipRect.width / 2;
  }

  // Auto-flip to the opposite side when the preferred side is clipped.
  if (pos === 'bottom' && top + tipRect.height > window.innerHeight - 4) {
    top = rect.top - tipRect.height - GAP;
  } else if (pos === 'top' && top < 4) {
    top = rect.bottom + GAP;
  } else if (pos === 'left' && left < 4) {
    left = rect.right + GAP;
  } else if (pos === 'right' && left + tipRect.width > window.innerWidth - 4) {
    left = rect.left - tipRect.width - GAP;
  }

  // Clamp to the viewport on both axes (covers diagonal overflow and the
  // along-axis spread of left/right placements near a corner).
  if (left < 4) left = 4;
  if (left + tipRect.width > window.innerWidth - 4) {
    left = window.innerWidth - tipRect.width - 4;
  }
  if (top < 4) top = 4;
  if (top + tipRect.height > window.innerHeight - 4) {
    top = window.innerHeight - tipRect.height - 4;
  }

  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
  tip.classList.add('s2-tooltip--visible');
}

function hide(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  activeTarget = null;
  el?.classList.remove('s2-tooltip--visible');
}

/** Call once to install global tooltip listeners. */
export function initTooltips(): void {
  document.addEventListener(
    'pointerover',
    (e) => {
      const target = (e.target as HTMLElement).closest?.('[data-tooltip]') as HTMLElement | null;
      // Cursor is still over the same tooltip-bearing element — ignore
      // pointerover on internal descendants (e.g. moving from button
      // padding to its SVG, or between adjacent <path> elements inside
      // the same icon). Without this guard the timer would reset on
      // every internal boundary crossing and the tooltip would never
      // show on small buttons with multi-element content.
      if (target && target === activeTarget) return;
      // Different (or absent) target — clear any pending timer / visible
      // tooltip from the previous target before starting a new run.
      hide();
      if (!target) return;
      activeTarget = target;
      timer = setTimeout(() => show(target), DELAY);
    },
    true
  );

  document.addEventListener(
    'pointerout',
    (e) => {
      // Only hide when the cursor truly leaves the tooltip-bearing
      // element. `pointerout` fires when crossing into descendants too,
      // so we use relatedTarget to detect a real exit.
      if (!activeTarget) return;
      const related = (e as PointerEvent).relatedTarget as Node | null;
      if (related && activeTarget.contains(related)) return;
      hide();
    },
    true
  );

  document.addEventListener('pointerdown', hide, true);
}
