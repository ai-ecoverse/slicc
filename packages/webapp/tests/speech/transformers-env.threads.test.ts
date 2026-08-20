/**
 * ort-web thread policy (#2042). The policy is a pure function so the whole
 * isolation × concurrency × override matrix is pinned here; the wiring test
 * at the bottom proves `configureTransformersEnv` applies it and never leaves
 * `numThreads` to ort-web's auto-detect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureTransformersEnv,
  ORT_MAX_THREADS,
  ORT_THREADS_OVERRIDE_KEY,
  resolveOrtNumThreads,
  resolveOrtNumThreadsFrom,
} from '../../src/speech/transformers-env.js';

describe('resolveOrtNumThreadsFrom — policy matrix', () => {
  it('pins 1 on a non-isolated realm, whatever the cores or override say', () => {
    expect(resolveOrtNumThreadsFrom({ isolated: false, hardwareConcurrency: 16 })).toBe(1);
    expect(
      resolveOrtNumThreadsFrom({ isolated: false, hardwareConcurrency: 16, override: '4' })
    ).toBe(1);
  });

  it('uses min(ORT_MAX_THREADS, hardwareConcurrency) on an isolated leader', () => {
    expect(resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: 2 })).toBe(2);
    expect(resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: 4 })).toBe(4);
    expect(resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: 12 })).toBe(
      ORT_MAX_THREADS
    );
    expect(resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: 1 })).toBe(1);
  });

  it('treats hidden or nonsense concurrency as single-core', () => {
    expect(resolveOrtNumThreadsFrom({ isolated: true })).toBe(1);
    expect(resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: 0 })).toBe(1);
    expect(resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: Number.NaN })).toBe(1);
    expect(resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: 3.7 })).toBe(3);
  });

  it('honours a bounded override only when isolated', () => {
    expect(
      resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: 8, override: '1' })
    ).toBe(1);
    expect(
      resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: 8, override: '2' })
    ).toBe(2);
    // Clamped to the ceiling — an override cannot spawn an unbounded pool.
    expect(
      resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: 8, override: '64' })
    ).toBe(ORT_MAX_THREADS);
    // Garbage falls back to the default policy.
    for (const bad of ['0', '-3', 'lots', '', null, undefined]) {
      expect(
        resolveOrtNumThreadsFrom({ isolated: true, hardwareConcurrency: 2, override: bad })
      ).toBe(2);
    }
  });
});

describe('resolveOrtNumThreads — live-realm probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads crossOriginIsolated, hardwareConcurrency and the localStorage override', () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(resolveOrtNumThreads()).toBe(ORT_MAX_THREADS);

    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === ORT_THREADS_OVERRIDE_KEY ? '1' : null),
    });
    expect(resolveOrtNumThreads()).toBe(1);
  });

  it('survives a localStorage that throws (opaque/sandboxed realm)', () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(resolveOrtNumThreads()).toBe(2);
  });

  it('is 1 in a realm without isolation (the Node/vitest default)', () => {
    vi.stubGlobal('crossOriginIsolated', undefined);
    expect(resolveOrtNumThreads()).toBe(1);
  });
});

describe('configureTransformersEnv — applies the policy explicitly', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeEnv() {
    return { backends: { onnx: { wasm: {} as { numThreads?: number } } } };
  }

  it('sets a multi-threaded pool on an isolated leader', () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    vi.stubGlobal('localStorage', { getItem: () => null });
    const env = makeEnv();
    configureTransformersEnv(env as never);
    expect(env.backends.onnx.wasm.numThreads).toBe(4);
  });

  it('keeps the single-thread pin on a non-isolated float', () => {
    vi.stubGlobal('crossOriginIsolated', false);
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    const env = makeEnv();
    configureTransformersEnv(env as never);
    expect(env.backends.onnx.wasm.numThreads).toBe(1);
  });
});
