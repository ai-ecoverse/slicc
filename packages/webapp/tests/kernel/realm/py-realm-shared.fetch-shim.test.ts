/**
 * Unit tests for `installPyodideAsmWasmFetchShim`. The shim is the
 * one indexURL holdout the Wave 13c VFS-bytes loader cannot bypass
 * with a loader option — pyodide's `instantiateWasm` always reads
 * `${indexURL}pyodide.asm.wasm` via `globalThis.fetch`, so the
 * shim has to (a) intercept that exact URL, (b) forward everything
 * else verbatim, and (c) restore the original `fetch` on BOTH
 * success and failure so a `loadPyodide` rejection doesn't leak
 * the shim into subsequent worker fetches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPyodideAsmWasmFetchShim } from '../../../src/kernel/realm/py-realm-shared.js';

const INDEX_URL = 'slicc-pyodide://local/abc/';
const WASM_TARGET = `${INDEX_URL}pyodide.asm.wasm`;

describe('installPyodideAsmWasmFetchShim', () => {
  let savedFetch: typeof globalThis.fetch;
  let upstream: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Stand a fake upstream `fetch` in place of the real one so the
    // shim's pass-through path is observable in isolation. `upstream`
    // is the "original" the shim should capture + restore to.
    savedFetch = globalThis.fetch;
    upstream = vi.fn(async () => new Response('upstream', { status: 200 }));
    globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it('intercepts the wasm indexURL and returns the supplied bytes as application/wasm', async () => {
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const shim = installPyodideAsmWasmFetchShim(INDEX_URL, bytes);
    try {
      const res = await globalThis.fetch(WASM_TARGET);
      expect(res.headers.get('Content-Type')).toBe('application/wasm');
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf).toEqual(bytes);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      shim.restore();
    }
  });

  it('accepts URL and Request inputs (not only string)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const shim = installPyodideAsmWasmFetchShim(INDEX_URL, bytes);
    try {
      const fromUrl = await globalThis.fetch(new URL(WASM_TARGET));
      expect(fromUrl.headers.get('Content-Type')).toBe('application/wasm');
      const fakeRequest = { url: WASM_TARGET } as unknown as Request;
      const fromRequest = await globalThis.fetch(fakeRequest);
      expect(fromRequest.headers.get('Content-Type')).toBe('application/wasm');
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      shim.restore();
    }
  });

  it('forwards every other URL to the original fetch unchanged', async () => {
    const shim = installPyodideAsmWasmFetchShim(INDEX_URL, new Uint8Array([0]));
    try {
      const res = await globalThis.fetch('https://example.com/api', { method: 'POST' });
      expect(await res.text()).toBe('upstream');
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(upstream.mock.calls[0][0]).toBe('https://example.com/api');
      const init = upstream.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('POST');
    } finally {
      shim.restore();
    }
  });

  it('restore() puts the original fetch back', () => {
    const shim = installPyodideAsmWasmFetchShim(INDEX_URL, new Uint8Array([0]));
    expect(globalThis.fetch).not.toBe(upstream);
    shim.restore();
    expect(globalThis.fetch).toBe(upstream);
  });

  it('restore() is idempotent', () => {
    const shim = installPyodideAsmWasmFetchShim(INDEX_URL, new Uint8Array([0]));
    shim.restore();
    expect(globalThis.fetch).toBe(upstream);
    shim.restore();
    expect(globalThis.fetch).toBe(upstream);
  });

  it('try/finally pattern restores the original fetch even on caller throw', async () => {
    const shim = installPyodideAsmWasmFetchShim(INDEX_URL, new Uint8Array([0]));
    await expect(
      (async () => {
        try {
          throw new Error('loadPyodide rejected');
        } finally {
          shim.restore();
        }
      })()
    ).rejects.toThrow('loadPyodide rejected');
    expect(globalThis.fetch).toBe(upstream);
  });

  it('restore() leaves a wrapping shim alone (nested install safety)', () => {
    const shim = installPyodideAsmWasmFetchShim(INDEX_URL, new Uint8Array([0]));
    // Simulate something else wrapping our fetch further (e.g. a
    // logging interceptor installed between us and the caller).
    const outerWrapper = ((input: RequestInfo | URL, init?: RequestInit) =>
      (globalThis.fetch as typeof globalThis.fetch)(
        input as RequestInfo,
        init
      )) as typeof globalThis.fetch;
    globalThis.fetch = outerWrapper;
    shim.restore();
    // Our `restore()` must NOT clobber the outer wrapper — it only
    // unwinds when our shim is still the installed fetch.
    expect(globalThis.fetch).toBe(outerWrapper);
    // Manual cleanup so afterEach sees a clean slate.
    globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
  });
});
