// @vitest-environment jsdom
/**
 * `createMigrationSplash` unit tests.
 *
 * Pins both the >1s threshold gate AND the blocking-modal behavior:
 *   - modal appears as a centered scrim once the threshold elapses
 *   - modal never paints when the dismiss arrives before the threshold
 *     (fast path: sentinel-present no-op AND legacy-absent no-op both
 *     funnel through the same `disarm()` chokepoint, so this single
 *     test pins both)
 *   - scrim is a full-viewport blocker (`pointer-events: auto`,
 *     `position: fixed`, `inset: 0`) so input can't reach the booting
 *     UI underneath
 *   - card uses the brand Adobe Clean font stack rather than `system-ui`
 *   - `updateProgress` reflects the file-count ratio in both the bar
 *     fill width and the visible `copied / total files` counter
 *   - idempotent arm + disarm so noisy migration signals can't
 *     double-paint or throw on stale dismiss
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMigrationSplash,
  DEFAULT_MIGRATION_SPLASH_THRESHOLD_MS,
  MIGRATION_SPLASH_ELEMENT_ID,
} from '../../src/ui/migration-splash.js';

describe('createMigrationSplash', () => {
  let root: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    vi.useRealTimers();
    root.remove();
  });

  it('does NOT paint until the threshold elapses (slow migration)', () => {
    const splash = createMigrationSplash({ root, thresholdMs: 1000 });
    splash.arm();

    expect(root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`)).toBeNull();
    expect(splash.isActive()).toBe(true);

    vi.advanceTimersByTime(999);
    expect(root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`)).toBeNull();

    vi.advanceTimersByTime(1);
    const el = root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`) as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el?.getAttribute('role')).toBe('status');
    expect(el?.textContent).toMatch(/Upgrading|workspace|storage/i);
  });

  it('paints a centered, blocking scrim in the brand font', () => {
    const splash = createMigrationSplash({ root, thresholdMs: 0 });
    splash.forceShow();

    const el = root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`) as HTMLElement | null;
    expect(el).not.toBeNull();
    // Scrim spans the viewport and blocks input.
    expect(el?.style.position).toBe('fixed');
    expect(el?.style.inset).toBe('0px');
    expect(el?.style.pointerEvents).toBe('auto');
    expect(el?.style.display).toBe('flex');
    expect(el?.style.alignItems).toBe('center');
    expect(el?.style.justifyContent).toBe('center');
    expect(el?.getAttribute('aria-modal')).toBe('true');
    // Brand font stack — must NOT fall back to `system-ui`.
    expect(el?.style.fontFamily).toMatch(/Adobe Clean/);
    expect(el?.style.fontFamily).not.toMatch(/system-ui/);
  });

  it('renders a determinate progress bar that reflects updateProgress', () => {
    const splash = createMigrationSplash({ root, thresholdMs: 0 });
    splash.forceShow();
    splash.updateProgress({ copied: 25, total: 100 });

    const el = root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`) as HTMLElement | null;
    expect(el?.textContent).toContain('25 / 100 files');
    // The fill is the only div with a non-zero/percent `width` style;
    // grab it by walking children rather than relying on a brittle
    // descendant selector.
    const findFill = (host: HTMLElement | null): HTMLElement | null =>
      (host?.querySelector('[data-slicc-migration-progress-fill]') as HTMLElement | null) ?? null;
    const fill = findFill(el);
    expect(fill).not.toBeNull();
    expect(fill?.style.width).toBe('25%');

    splash.updateProgress({ copied: 100, total: 100 });
    expect(el?.textContent).toContain('100 / 100 files');
    expect(findFill(el)?.style.width).toBe('100%');
  });

  it('remembers progress updates issued before the modal paints', () => {
    const splash = createMigrationSplash({ root, thresholdMs: 1000 });
    splash.arm();
    splash.updateProgress({ copied: 7, total: 10 });
    expect(root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`)).toBeNull();

    vi.advanceTimersByTime(1000);
    const el = root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`) as HTMLElement | null;
    expect(el?.textContent).toContain('7 / 10 files');
  });

  it('hides when disarm fires AFTER the threshold (slow→done)', () => {
    const splash = createMigrationSplash({ root, thresholdMs: 1000 });
    splash.arm();
    vi.advanceTimersByTime(1500);
    expect(root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`)).not.toBeNull();

    splash.disarm();
    expect(root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`)).toBeNull();
    expect(splash.isActive()).toBe(false);
  });

  it('never paints when disarm fires BEFORE the threshold (fast path)', () => {
    const splash = createMigrationSplash({ root, thresholdMs: 1000 });
    splash.arm();
    vi.advanceTimersByTime(500);
    splash.disarm();
    vi.advanceTimersByTime(2000);

    expect(root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`)).toBeNull();
    expect(splash.isActive()).toBe(false);
  });

  it('arm is idempotent — a second arm while pending does not double-time', () => {
    const splash = createMigrationSplash({ root, thresholdMs: 1000 });
    splash.arm();
    vi.advanceTimersByTime(600);
    splash.arm();
    vi.advanceTimersByTime(500);

    expect(root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`)).not.toBeNull();
  });

  it('disarm is idempotent and safe before arm', () => {
    const splash = createMigrationSplash({ root, thresholdMs: 1000 });
    expect(() => splash.disarm()).not.toThrow();
    splash.arm();
    splash.disarm();
    expect(() => splash.disarm()).not.toThrow();
    expect(root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`)).toBeNull();
  });

  it('installs a capture-phase keydown blocker on paint and removes it on disarm', () => {
    // Spy the window's listener registration so we pin the exact
    // contract (event type, capture phase, paired removal) without
    // depending on jsdom's event-dispatch fidelity, which doesn't
    // reliably propagate synthesized keydowns to window listeners.
    const target = document.defaultView ?? window;
    const addSpy = vi.spyOn(target, 'addEventListener');
    const removeSpy = vi.spyOn(target, 'removeEventListener');

    const splash = createMigrationSplash({ root, thresholdMs: 0 });
    splash.forceShow();

    const addCall = addSpy.mock.calls.find(
      ([type, , options]) => type === 'keydown' && options === true
    );
    expect(addCall, 'capture-phase keydown blocker should be installed on paint').toBeDefined();
    const blocker = addCall?.[1] as (e: Event) => void;
    expect(typeof blocker).toBe('function');

    // Verify the blocker preventDefaults and stops propagation so a
    // downstream listener would never see the event.
    const ev = new Event('keydown', { cancelable: true });
    const stopSpy = vi.spyOn(ev, 'stopImmediatePropagation');
    const preventSpy = vi.spyOn(ev, 'preventDefault');
    blocker(ev);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(preventSpy).toHaveBeenCalledTimes(1);

    splash.disarm();
    const removeCall = removeSpy.mock.calls.find(
      ([type, fn, options]) => type === 'keydown' && fn === blocker && options === true
    );
    expect(removeCall, 'capture-phase keydown blocker should be removed on disarm').toBeDefined();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('defaults the threshold to the documented C3 brief value', () => {
    expect(DEFAULT_MIGRATION_SPLASH_THRESHOLD_MS).toBe(1000);
    const splash = createMigrationSplash({ root });
    splash.arm();
    vi.advanceTimersByTime(DEFAULT_MIGRATION_SPLASH_THRESHOLD_MS);
    expect(root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`)).not.toBeNull();
  });
});
