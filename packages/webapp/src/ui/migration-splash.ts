/**
 * Wave C3 — one-time migration splash (`walk > 1s`).
 *
 * Page-side companion to the `kernel-migration-started` /
 * `kernel-migration-finished` raw kernel-port signals emitted by
 * `kernel-worker.ts`. Behavior:
 *
 *   - `arm()`: schedule a `show()` after `thresholdMs` (default 1000).
 *     A migration that completes inside the threshold (fast path,
 *     including the sentinel-present and legacy-absent fast no-ops)
 *     fires `disarm()` before the timer elapses → no splash ever
 *     paints.
 *   - `disarm()`: cancel the pending timer and, if the splash is
 *     already painted, remove it.
 *
 * The splash is a minimal absolutely-positioned overlay over the
 * page-supplied root element. It does NOT block any DOM events — the
 * UI keeps booting underneath, the splash just communicates "first-run
 * migration is taking a moment". Pointer-events are intentionally
 * `none` so a slow migration can't trap the user.
 *
 * Module is framework-free and DOM-only: no React, no Web Components,
 * no CSS file dependency. Inline styles keep the contract self-
 * contained and the test surface trivial. The flag-off code path never
 * imports this module (the kernel-worker never posts the start signal
 * unless `sharedFs.backend === 'opfs'`), so the legacy boot remains
 * byte-identical.
 */

/** Default `walk > 1s` threshold per the C3 brief. */
export const DEFAULT_MIGRATION_SPLASH_THRESHOLD_MS = 1000;

/** Stable id so tests + manual QA can `document.getElementById` the node. */
export const MIGRATION_SPLASH_ELEMENT_ID = 'slicc-migration-splash';

export interface MigrationSplashOptions {
  /**
   * Root the splash mounts into. Required so tests can hand in a
   * detached element; production passes `document.body`.
   */
  root: HTMLElement;
  /** Threshold in ms before a pending migration paints the splash. */
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

export interface MigrationSplash {
  /** Arm the threshold timer. Idempotent (a second `arm` while armed is a no-op). */
  arm(): void;
  /** Cancel the timer + remove the splash if it has already painted. Idempotent. */
  disarm(): void;
  /** True while the timer is pending OR the splash element is mounted. */
  isActive(): boolean;
  /** Force-paint the splash (used by tests; production always goes through arm). */
  forceShow(): void;
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
  const message =
    opts.message ??
    'Upgrading workspace storage… this only happens once and runs in the background.';
  const log = opts.logger;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let element: HTMLElement | null = null;

  function paint(): void {
    if (element) return;
    const el = opts.root.ownerDocument?.createElement('div');
    if (!el) return;
    el.id = MIGRATION_SPLASH_ELEMENT_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    // Inline styles keep the module self-contained; the splash is a
    // single non-interactive overlay strip pinned at the top of the
    // root so the booting UI underneath remains fully usable.
    el.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483646',
      'padding:8px 16px',
      'font:13px/1.4 system-ui, -apple-system, sans-serif',
      'background:#1f2937',
      'color:#f9fafb',
      'text-align:center',
      'pointer-events:none',
      'box-shadow:0 1px 4px rgba(0,0,0,0.25)',
    ].join(';');
    el.textContent = message;
    opts.root.appendChild(el);
    element = el;
    log?.debug?.('[migration-splash] painted');
  }

  function remove(): void {
    if (!element) return;
    element.remove();
    element = null;
    log?.debug?.('[migration-splash] removed');
  }

  return {
    arm(): void {
      if (timerId !== null || element !== null) return;
      log?.debug?.(`[migration-splash] armed (threshold=${thresholdMs}ms)`);
      timerId = setTimeoutImpl(() => {
        timerId = null;
        paint();
      }, thresholdMs);
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
      return timerId !== null || element !== null;
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
