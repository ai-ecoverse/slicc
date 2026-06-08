/**
 * One-time migration modal — blocking centered scrim shown while the
 * worker copies the legacy LightningFS IndexedDB into OPFS.
 *
 * Page-side companion to the `kernel-migration-started` /
 * `kernel-migration-progress` / `kernel-migration-finished` raw
 * kernel-port signals emitted by `kernel-worker.ts`. Behavior:
 *
 *   - `arm()`: schedule a `paint()` after `thresholdMs` (default 1000).
 *     A migration that completes inside the threshold (fast path —
 *     sentinel-present or legacy-absent no-op) fires `disarm()` first,
 *     so no modal ever paints.
 *   - `updateProgress({ copied, total })`: update the progress bar and
 *     counter. Safe to call before the timer elapses; the latest values
 *     are remembered and applied when the modal paints.
 *   - `disarm()`: cancel the pending timer and remove the modal if it
 *     has already painted.
 *
 * Once painted the modal is a full-viewport scrim with `pointer-events:
 * auto` so input is blocked until `disarm()`. The card uses the brand
 * font stack (`--s2-font-family`, "Adobe Clean") and renders a
 * determinate progress bar plus `copied / total files` label.
 *
 * Module is framework-free and DOM-only: no React, no Web Components,
 * no CSS file dependency. Inline styles keep the contract self-
 * contained and the test surface trivial.
 */

/** Default `walk > 1s` threshold before the modal paints. */
export const DEFAULT_MIGRATION_SPLASH_THRESHOLD_MS = 1000;

/** Stable id so tests + manual QA can `document.getElementById` the node. */
export const MIGRATION_SPLASH_ELEMENT_ID = 'slicc-migration-splash';

/** Adobe Clean brand stack — mirrors `--s2-font-family` in `tokens.css`. */
const BRAND_FONT_STACK =
  '"Adobe Clean", "Source Sans Pro", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export interface MigrationSplashOptions {
  /**
   * Root the modal mounts into. Required so tests can hand in a
   * detached element; production passes `document.body`.
   */
  root: HTMLElement;
  /** Threshold in ms before a pending migration paints the modal. */
  thresholdMs?: number;
  /**
   * Defaults to the bundled English copy. Tests assert on the visible
   * text to verify the threshold gate; future i18n can swap the
   * string without touching the gating code.
   */
  message?: string;
  /**
   * Timer surface — `setTimeout` / `clearTimeout` shaped. Defaults to
   * the global timers; tests inject a fake clock so the 1s wait is
   * deterministic.
   */
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  /** Optional logger for debug visibility. */
  logger?: { debug?: (msg: string) => void };
}

export interface MigrationSplashProgress {
  /** Files copied so far. */
  copied: number;
  /** Total files in the migration manifest. */
  total: number;
}

export interface MigrationSplash {
  /** Arm the threshold timer. Idempotent. */
  arm(): void;
  /** Update the progress counter + bar. Safe to call before the modal paints. */
  updateProgress(progress: MigrationSplashProgress): void;
  /** Cancel the timer + remove the modal if it has already painted. Idempotent. */
  disarm(): void;
  /** True while the timer is pending OR the modal element is mounted. */
  isActive(): boolean;
  /** Force-paint the modal (used by tests; production always goes through arm). */
  forceShow(): void;
}

interface ModalNodes {
  root: HTMLElement;
  fill: HTMLElement;
  counter: HTMLElement;
}

/**
 * Construct a splash controller. The returned object holds no
 * page-level singletons; callers manage its lifetime. The kernel
 * worker emits `kernel-migration-started` exactly once per boot, so
 * the controller is allocated lazily once on first signal and re-used
 * for the matching dismiss.
 */
export function createMigrationSplash(opts: MigrationSplashOptions): MigrationSplash {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_MIGRATION_SPLASH_THRESHOLD_MS;
  const setTimeoutImpl = opts.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutImpl = opts.clearTimeout ?? globalThis.clearTimeout;
  const message = opts.message ?? 'Upgrading workspace storage… this only happens once.';
  const log = opts.logger;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let nodes: ModalNodes | null = null;
  let lastProgress: MigrationSplashProgress = { copied: 0, total: 0 };
  // Document-level capture-phase keydown blocker. Installed when the
  // modal paints, removed on disarm. Necessary because the scrim is
  // neither focusable nor an ancestor of the focused element, so a
  // listener on the scrim itself never receives the key events.
  let keydownBlocker: ((e: Event) => void) | null = null;
  let keydownBlockerTarget: EventTarget | null = null;

  function applyProgress(): void {
    if (!nodes) return;
    const { copied, total } = lastProgress;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((copied / total) * 100))) : 0;
    nodes.fill.style.width = `${pct}%`;
    nodes.counter.textContent = total > 0 ? `${copied} / ${total} files` : 'Preparing…';
  }

  function paint(): void {
    if (nodes) return;
    const doc = opts.root.ownerDocument;
    if (!doc) return;

    // Scrim — full-viewport, blocks pointer/keyboard input. Inline
    // properties (rather than `cssText`) so the DOM reads back the
    // exact values we set in tests without going through any CSS
    // parser; jsdom's string parser is lossy for shorthand + vendor
    // prefixes.
    const scrim = doc.createElement('div');
    scrim.id = MIGRATION_SPLASH_ELEMENT_ID;
    scrim.setAttribute('role', 'status');
    scrim.setAttribute('aria-live', 'polite');
    scrim.setAttribute('aria-modal', 'true');
    scrim.style.position = 'fixed';
    scrim.style.inset = '0';
    scrim.style.zIndex = '2147483646';
    scrim.style.display = 'flex';
    scrim.style.alignItems = 'center';
    scrim.style.justifyContent = 'center';
    scrim.style.background = 'rgba(20,20,20,0.72)';
    scrim.style.backdropFilter = 'blur(4px)';
    (scrim.style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter =
      'blur(4px)';
    scrim.style.pointerEvents = 'auto';
    scrim.style.fontFamily = BRAND_FONT_STACK;
    // Swallow pointer events at the scrim so clicks can't fall
    // through to the booting UI underneath.
    scrim.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    // Keyboard blocker is installed at document scope (capture phase)
    // because the scrim is not in the focused element's ancestor
    // chain — a scrim-attached listener would never see the events.
    const target: EventTarget = doc.defaultView ?? doc;
    const blocker = (e: Event): void => {
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    target.addEventListener('keydown', blocker, true);
    keydownBlocker = blocker;
    keydownBlockerTarget = target;

    const card = doc.createElement('div');
    card.style.minWidth = '320px';
    card.style.maxWidth = '420px';
    card.style.padding = '28px 32px';
    card.style.borderRadius = '12px';
    card.style.background = '#1e1e1e';
    card.style.color = '#e8e8e8';
    card.style.boxShadow = '0 12px 32px rgba(0,0,0,0.45)';
    card.style.border = '1px solid #3a3a3a';
    card.style.textAlign = 'center';
    card.style.fontFamily = BRAND_FONT_STACK;

    const title = doc.createElement('div');
    title.textContent = message;
    title.style.fontSize = '16px';
    title.style.fontWeight = '500';
    title.style.lineHeight = '1.4';
    title.style.marginBottom = '18px';

    const track = doc.createElement('div');
    track.style.height = '6px';
    track.style.width = '100%';
    track.style.borderRadius = '3px';
    track.style.background = '#2c2c2c';
    track.style.overflow = 'hidden';
    track.style.marginBottom = '10px';

    const fill = doc.createElement('div');
    fill.setAttribute('data-slicc-migration-progress-fill', '');
    fill.style.height = '100%';
    fill.style.width = '0%';
    fill.style.background = '#3562ff';
    fill.style.transition = 'width 120ms linear';
    track.appendChild(fill);

    const counter = doc.createElement('div');
    counter.setAttribute('data-slicc-migration-progress-counter', '');
    counter.style.fontSize = '12px';
    counter.style.fontVariantNumeric = 'tabular-nums';
    counter.style.color = '#a1a1a1';

    card.appendChild(title);
    card.appendChild(track);
    card.appendChild(counter);
    scrim.appendChild(card);
    opts.root.appendChild(scrim);

    nodes = { root: scrim, fill, counter };
    applyProgress();
    log?.debug?.('[migration-splash] painted');
  }

  function remove(): void {
    if (keydownBlocker && keydownBlockerTarget) {
      keydownBlockerTarget.removeEventListener('keydown', keydownBlocker, true);
      keydownBlocker = null;
      keydownBlockerTarget = null;
    }
    if (!nodes) return;
    nodes.root.remove();
    nodes = null;
    log?.debug?.('[migration-splash] removed');
  }

  return {
    arm(): void {
      if (timerId !== null || nodes !== null) return;
      log?.debug?.(`[migration-splash] armed (threshold=${thresholdMs}ms)`);
      timerId = setTimeoutImpl(() => {
        timerId = null;
        paint();
      }, thresholdMs);
    },
    updateProgress(progress: MigrationSplashProgress): void {
      lastProgress = {
        copied: Math.max(0, progress.copied | 0),
        total: Math.max(0, progress.total | 0),
      };
      applyProgress();
    },
    disarm(): void {
      if (timerId !== null) {
        clearTimeoutImpl(timerId);
        timerId = null;
        log?.debug?.('[migration-splash] disarmed before threshold');
      }
      remove();
    },
    isActive(): boolean {
      return timerId !== null || nodes !== null;
    },
    forceShow(): void {
      if (timerId !== null) {
        clearTimeoutImpl(timerId);
        timerId = null;
      }
      paint();
    },
  };
}
