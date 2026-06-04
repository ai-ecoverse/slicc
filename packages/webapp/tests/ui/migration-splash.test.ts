// @vitest-environment jsdom
/**
 * Wave C3 — `createMigrationSplash` unit tests.
 *
 * Pins the >1s walk threshold gate end-to-end:
 *   - splash appears when the migration exceeds the threshold (slow path)
 *   - splash never paints when the dismiss arrives before the threshold
 *     (fast path: sentinel-present no-op AND legacy-absent no-op both
 *     funnel through the same `disarm()` chokepoint, so this single
 *     test pins both)
 *   - the controller is allocated lazily by `mainStandaloneWorker`, so
 *     flag-off boots never instantiate one — the `arm()` / `disarm()`
 *     surface is what we test (the flag gate lives in `host.ts`).
 *   - idempotent arm + disarm so a noisy `kernel-migration-started`
 *     can't double-paint and a stale `kernel-migration-finished` can't
 *     throw.
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
    const el = root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`);
    expect(el).not.toBeNull();
    expect(el?.getAttribute('role')).toBe('status');
    expect(el?.textContent).toMatch(/Upgrading|workspace|storage/i);
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

  it('defaults the threshold to the documented C3 brief value', () => {
    expect(DEFAULT_MIGRATION_SPLASH_THRESHOLD_MS).toBe(1000);
    const splash = createMigrationSplash({ root });
    splash.arm();
    vi.advanceTimersByTime(DEFAULT_MIGRATION_SPLASH_THRESHOLD_MS);
    expect(root.querySelector(`#${MIGRATION_SPLASH_ELEMENT_ID}`)).not.toBeNull();
  });
});
