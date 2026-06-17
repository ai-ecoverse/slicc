/**
 * Worker-context tests for `initTelemetry()` — covers the standalone-worker
 * branch where there is no `window` / `document` / `localStorage`
 * (DedicatedWorker realm).
 *
 * Pins:
 *  - `getModeLabel()` returns 'standalone-worker' when window is undefined
 *  - `initTelemetry()` does not throw and does not early-return
 *  - `error` + `unhandledrejection` listeners are registered on `self`
 *  - `RUM_GENERATION` is written to `globalThis` (not window — there is none)
 *  - The inlined worker sampler emits a `navigate` checkpoint with
 *    target='standalone-worker'
 */

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWorkerRum = vi.fn();
const mockHelixRum = vi.fn();

// Mock both sampler modules so we can prove which branch fired and that the
// worker path never falls through to the helix path.
vi.mock('../../src/ui/rum-worker.js', () => ({ default: mockWorkerRum }));
vi.mock('@adobe/helix-rum-js', () => ({ sampleRUM: mockHelixRum }));

// EventTarget shaped `self` stub so `self.addEventListener` /
// `self.dispatchEvent` resolve to a real, isolated event bus. The Node test
// env's `globalThis` is not an EventTarget by default (`dispatchEvent` is
// missing), and a worker's `self` is a distinct EventTarget from
// `globalThis`, so we mirror that shape here.
let workerSelf: EventTarget;

describe('telemetry — standalone-worker branch', () => {
  beforeEach(() => {
    mockWorkerRum.mockClear();
    mockHelixRum.mockClear();
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).RUM_GENERATION;
    delete (globalThis as Record<string, unknown>).hlx;
    workerSelf = new EventTarget();
    vi.stubGlobal('self', workerSelf);
    // Force a DedicatedWorker-shaped realm regardless of host Node version.
    // Node 25+ exposes partial DOM-like globals (e.g. `localStorage` as an
    // empty object) which would otherwise misroute the worker branch through
    // the page branch. Stubbing here also exercises the production guard
    // against the worst-case partial-globals environment.
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('localStorage', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).RUM_GENERATION;
    delete (globalThis as Record<string, unknown>).hlx;
  });

  it('returns and does NOT throw when window/document/localStorage are undefined', async () => {
    // Sanity-check the env so the test actually exercises the worker branch.
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof localStorage).toBe('undefined');

    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await expect(initTelemetry()).resolves.toBeUndefined();
  });

  it('emits a navigate checkpoint via the worker-safe sampler with target=standalone-worker', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    expect(mockWorkerRum).toHaveBeenCalledWith(
      'navigate',
      expect.objectContaining({ target: 'standalone-worker' })
    );
    // helix-rum-js path is CLI/Electron only; the worker branch must never load it.
    expect(mockHelixRum).not.toHaveBeenCalled();
  });

  it('writes RUM_GENERATION=slicc-standalone-worker to globalThis (no window to write to)', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    expect((globalThis as Record<string, unknown>).RUM_GENERATION).toBe('slicc-standalone-worker');
  });

  it('registers error and unhandledrejection listeners on self', async () => {
    const addSpy = vi.spyOn(workerSelf, 'addEventListener');
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    const types = addSpy.mock.calls.map((c) => c[0]);
    expect(types).toContain('error');
    expect(types).toContain('unhandledrejection');
  });

  it('error listener falls back to empty string when message is null (?? branch)', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockWorkerRum.mockClear();

    const ev = new Event('error') as ErrorEvent;
    // No `message` property set — `(e as ErrorEvent).message` is `undefined`
    // so the `?? ''` fallback fires and `trackError('js', '')` runs.
    workerSelf.dispatchEvent(ev);

    expect(mockWorkerRum).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ source: 'js', target: '' })
    );
  });

  it('error listener forwards sanitized message via trackError → sampleRUM', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockWorkerRum.mockClear();

    const ev = new Event('error') as ErrorEvent;
    Object.defineProperty(ev, 'message', { value: 'boom at /workspace/skills/x/y.ts' });
    workerSelf.dispatchEvent(ev);

    expect(mockWorkerRum).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        source: 'js',
        target: expect.stringContaining('/workspace/.../'),
      })
    );
  });

  it('unhandledrejection listener stringifies non-Error reasons', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockWorkerRum.mockClear();

    const ev = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(ev, 'reason', { value: 'plain string reason' });
    workerSelf.dispatchEvent(ev);

    expect(mockWorkerRum).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ source: 'js', target: 'plain string reason' })
    );
  });

  it('unhandledrejection listener uses Error.message when reason is an Error', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockWorkerRum.mockClear();

    const ev = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(ev, 'reason', { value: new Error('typed boom') });
    workerSelf.dispatchEvent(ev);

    expect(mockWorkerRum).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ source: 'js', target: expect.stringContaining('typed boom') })
    );
  });
});
