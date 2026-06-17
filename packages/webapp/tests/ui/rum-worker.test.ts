/**
 * Worker-safe RUM sampler — pins the `navigator.sendBeacon` path used by the
 * standalone kernel-worker DedicatedWorker.
 *
 * Differences from `rum.js` (extension-only, page realm):
 *  - reads `self.location.href` (not `window.location.href`)
 *  - reads `globalThis.hlx` / `globalThis.RUM_GENERATION` (no `window`)
 *  - tolerates `localStorage` being absent or throwing
 */

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SampleRUM = (checkpoint: string, data?: Record<string, unknown>) => void;

describe('rum-worker.js', () => {
  let sendBeacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('self', { location: { href: 'http://worker.test/main.js' } });
    (globalThis as Record<string, unknown>).RUM_GENERATION = 'slicc-standalone-worker';
    delete (globalThis as Record<string, unknown>).hlx;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).RUM_GENERATION;
    delete (globalThis as Record<string, unknown>).hlx;
    vi.restoreAllMocks();
  });

  it('caches sampling decision on globalThis.hlx.rum on first call', async () => {
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    sampleRUM('navigate', { target: 'standalone-worker' });
    const cached = (globalThis as Record<string, unknown>).hlx as {
      rum?: { weight: number; id: string; isSelected: boolean };
    };
    expect(cached?.rum).toBeDefined();
    expect(typeof cached.rum?.id).toBe('string');
    expect(cached.rum?.weight).toBe(10);
  });

  it('emits sendBeacon when isSelected (Math.random=0 forces selection)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    sampleRUM('navigate', { target: 'standalone-worker' });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeacon.mock.calls[0];
    expect(url).toBe('https://rum.hlx.page/.rum/10');
    const parsed = JSON.parse(body as string);
    expect(parsed.checkpoint).toBe('navigate');
    expect(parsed.target).toBe('standalone-worker');
    expect(parsed.generation).toBe('slicc-standalone-worker');
    expect(parsed.referer).toBe('http://worker.test/main.js');
    expect(parsed.weight).toBe(10);
  });

  it('skips sendBeacon when not selected', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    sampleRUM('navigate', { target: 'standalone-worker' });
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it('honors slicc-rum-debug=1 in localStorage (weight=1, always selected)', async () => {
    const storage: Record<string, string> = { 'slicc-rum-debug': '1' };
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage[k] ?? null });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    sampleRUM('navigate');
    const cached = (globalThis as Record<string, unknown>).hlx as {
      rum: { weight: number };
    };
    expect(cached.rum.weight).toBe(1);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url] = sendBeacon.mock.calls[0];
    expect(url).toBe('https://rum.hlx.page/.rum/1');
  });

  it('falls back to weight=10 when localStorage is absent', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    sampleRUM('navigate');
    const cached = (globalThis as Record<string, unknown>).hlx as {
      rum: { weight: number };
    };
    expect(cached.rum.weight).toBe(10);
  });

  it('tolerates a localStorage shim that throws on getItem', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    expect(() => sampleRUM('navigate')).not.toThrow();
    const cached = (globalThis as Record<string, unknown>).hlx as {
      rum: { weight: number };
    };
    expect(cached.rum.weight).toBe(10);
  });

  it('no-ops when navigator.sendBeacon is missing', async () => {
    vi.stubGlobal('navigator', {});
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    expect(() => sampleRUM('navigate')).not.toThrow();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it('never throws when JSON.stringify rejects circular data', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sampleRUM('navigate', circular)).not.toThrow();
  });

  it('does not throw when navigator is missing entirely', async () => {
    // Stub navigator to undefined so the first guard
    // (`typeof navigator === 'undefined'`) trips. `vi.stubGlobal('navigator',
    // undefined)` actually replaces the property so the typeof check returns
    // 'undefined' even on Node >=22 (where globalThis.navigator exists).
    vi.stubGlobal('navigator', undefined);
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    expect(() => sampleRUM('navigate')).not.toThrow();
  });

  it('falls back to empty-string referer when self.location is undefined', async () => {
    vi.stubGlobal('self', {});
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    sampleRUM('navigate');
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [, body] = sendBeacon.mock.calls[0];
    expect(JSON.parse(body as string).referer).toBe('');
  });

  it('reuses cached sampling decision across multiple calls', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { default: sampleRUM } = (await import('../../src/ui/rum-worker.js')) as {
      default: SampleRUM;
    };
    sampleRUM('navigate');
    const firstId = ((globalThis as Record<string, unknown>).hlx as { rum: { id: string } }).rum.id;
    sampleRUM('fill', { source: 'ls' });
    const secondId = ((globalThis as Record<string, unknown>).hlx as { rum: { id: string } }).rum
      .id;
    expect(secondId).toBe(firstId);
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });
});
