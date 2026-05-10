/**
 * Tests for `releaseHostGlobals` — the dispose-time cleanup that
 * clears `globalThis.__slicc_pm` / `__slicc_lickManager` only when
 * they still point at the disposing host.
 *
 * Without this guarded delete, a second host that booted while the
 * first was running would see its own globals nuked when the first
 * disposed (the ref-equal guard prevents that).
 */

import { describe, it, expect } from 'vitest';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import { releaseHostGlobals } from '../../src/kernel/host.js';
import type { LickManager } from '../../src/scoops/lick-manager.js';

function fakeLickManager(): LickManager {
  return {} as LickManager;
}

describe('releaseHostGlobals', () => {
  it('clears __slicc_pm and __slicc_lickManager when they point at the host', () => {
    const pm = new ProcessManager();
    const lm = fakeLickManager();
    const g = globalThis as Record<string, unknown>;
    g.__slicc_pm = pm;
    g.__slicc_lickManager = lm;

    releaseHostGlobals({ processManager: pm, lickManager: lm });

    expect(g.__slicc_pm).toBeUndefined();
    expect(g.__slicc_lickManager).toBeUndefined();
  });

  it('leaves globals alone when they point at a different host', () => {
    const myPm = new ProcessManager();
    const myLm = fakeLickManager();
    const otherPm = new ProcessManager();
    const otherLm = fakeLickManager();
    const g = globalThis as Record<string, unknown>;
    // Another host owns the globals now (e.g. a successor that
    // booted while we were preparing to dispose).
    g.__slicc_pm = otherPm;
    g.__slicc_lickManager = otherLm;

    releaseHostGlobals({ processManager: myPm, lickManager: myLm });

    expect(g.__slicc_pm).toBe(otherPm);
    expect(g.__slicc_lickManager).toBe(otherLm);

    // Cleanup so this test doesn't pollute neighbors.
    delete g.__slicc_pm;
    delete g.__slicc_lickManager;
  });

  it('is a no-op when neither global is set', () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__slicc_pm;
    delete g.__slicc_lickManager;
    releaseHostGlobals({ processManager: new ProcessManager(), lickManager: fakeLickManager() });
    expect(g.__slicc_pm).toBeUndefined();
    expect(g.__slicc_lickManager).toBeUndefined();
  });
});
