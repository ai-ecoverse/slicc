/**
 * Tests for `makeKernelWorkerInitGuard` — the re-entrancy guard that
 * sits in front of the kernel-worker boot listener.
 *
 * Pins:
 *   - first init runs boot
 *   - duplicate init while boot is in flight is dropped (warned)
 *   - duplicate init after boot resolves is dropped (latched)
 *   - boot rejection resets the guard so a retry init succeeds
 *   - custom `onError` / `onDuplicate` hooks fire instead of console
 */

import { describe, it, expect, vi } from 'vitest';
import { makeKernelWorkerInitGuard } from '../../src/kernel/kernel-worker-init-guard.js';
import type { KernelWorkerInitMsg } from '../../src/kernel/kernel-worker.js';

function makeInit(): KernelWorkerInitMsg {
  // The guard never inspects the payload — only routes it to bootFn.
  return {
    type: 'kernel-worker-init',
    kernelPort: {} as MessagePort,
    cdpPort: {} as MessagePort,
  };
}

describe('makeKernelWorkerInitGuard', () => {
  it('runs bootFn on the first init message', () => {
    const bootFn = vi.fn(async () => undefined);
    const guard = makeKernelWorkerInitGuard(bootFn);
    expect(guard.isInitialized()).toBe(false);
    guard.handle(makeInit());
    expect(bootFn).toHaveBeenCalledTimes(1);
    expect(guard.isInitialized()).toBe(true);
  });

  it('drops a duplicate init while boot is in flight (no second bootFn call)', async () => {
    let resolveBoot: () => void = () => undefined;
    const bootFn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveBoot = resolve;
        })
    );
    const onDuplicate = vi.fn();
    const guard = makeKernelWorkerInitGuard(bootFn, { onDuplicate });
    guard.handle(makeInit());
    guard.handle(makeInit()); // dropped
    expect(bootFn).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    resolveBoot();
    await Promise.resolve();
  });

  it('drops a duplicate init after boot resolves (latched)', async () => {
    const bootFn = vi.fn(async () => undefined);
    const onDuplicate = vi.fn();
    const guard = makeKernelWorkerInitGuard(bootFn, { onDuplicate });
    guard.handle(makeInit());
    await Promise.resolve(); // let bootFn settle
    guard.handle(makeInit()); // dropped — guard stays latched on success
    expect(bootFn).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('resets the guard when bootFn rejects so a retry init succeeds', async () => {
    let attempt = 0;
    const bootFn = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error('first boot failed');
    });
    const onError = vi.fn();
    const guard = makeKernelWorkerInitGuard(bootFn, { onError });
    guard.handle(makeInit());
    // Wait for the rejected boot to flow through the .catch.
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(guard.isInitialized()).toBe(false);
    // Retry should now succeed.
    guard.handle(makeInit());
    expect(bootFn).toHaveBeenCalledTimes(2);
    expect(guard.isInitialized()).toBe(true);
  });

  it('uses default console hooks when none provided', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bootFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const guard = makeKernelWorkerInitGuard(bootFn);
    guard.handle(makeInit());
    guard.handle(makeInit()); // duplicate while in flight → console.warn
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
