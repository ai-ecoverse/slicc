// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWorkerRum = vi.fn();
const mockHelixRum = vi.fn();

vi.mock('../../src/kernel/rum-worker.js', () => ({ default: mockWorkerRum }));
vi.mock('@adobe/helix-rum-js', () => ({ sampleRUM: mockHelixRum }));

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
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof localStorage).toBe('undefined');

    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await expect(initTelemetry()).resolves.toBeUndefined();
  });

  it('emits a navigate checkpoint via the worker-safe sampler with target=standalone-worker', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    expect(mockWorkerRum).toHaveBeenCalledWith(
      'navigate',
      expect.objectContaining({ target: 'standalone-worker' })
    );

    expect(mockHelixRum).not.toHaveBeenCalled();
  });

  it('writes RUM_GENERATION=slicc-standalone-worker to globalThis (no window to write to)', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    expect((globalThis as Record<string, unknown>).RUM_GENERATION).toBe('slicc-standalone-worker');
  });

  it('registers error and unhandledrejection listeners on self', async () => {
    const addSpy = vi.spyOn(workerSelf, 'addEventListener');
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    const types = addSpy.mock.calls.map((c) => c[0]);
    expect(types).toContain('error');
    expect(types).toContain('unhandledrejection');
  });

  it('error listener falls back to empty string when message is null (?? branch)', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockWorkerRum.mockClear();

    const ev = new Event('error') as ErrorEvent;

    workerSelf.dispatchEvent(ev);

    expect(mockWorkerRum).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ source: 'js', target: '' })
    );
  });

  it('error listener forwards sanitized message via trackError → sampleRUM', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
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

  it('unhandledrejection listener unwraps object reasons instead of [object Object]', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockWorkerRum.mockClear();

    const ev = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(ev, 'reason', { value: { message: 'bedrock returned 400' } });
    workerSelf.dispatchEvent(ev);

    expect(mockWorkerRum).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ source: 'js', target: 'bedrock returned 400' })
    );
  });

  it('unhandledrejection listener stringifies non-Error reasons', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
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
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
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
