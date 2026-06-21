/**
 * `configureTransformersEnv` — points ort-web's `wasmPaths` at the VFS-served
 * `/preview/.../onnxruntime-web/dist/` (no jsdelivr) as the SYNCHRONOUS
 * fallback (extension floats consume this directly; standalone replaces it
 * with the blob-URL object form once `buildOrtWasmPathsFromVfs` resolves),
 * pins transformers to local-only model loading from `/workspace/models/`,
 * AND wraps `env.fetch` so VFS-rooted model URLs serve directly from VFS
 * bytes while residual remote http(s) probes still route through the bridge
 * `/api/fetch-proxy` (`resolveApiUrl` + `apiHeaders`), bypassing the Xet
 * redirect's CORS gap on hosted/thin-bridge leaders.
 *
 * VFS-bytes branch, blob-URL `wasmPaths`, and the direct-VFS
 * `assertLocalModelPresent` probe live in their own per-concern test files
 * (`transformers-env.vfs-load.test.ts`, `transformers-env.wasm-paths.test.ts`,
 * `transformers-env.assert-local-model-present.test.ts`) so the responder
 * polyfill + URL.createObjectURL stub stay scoped to the cases that need
 * them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeEnv {
  backends?: { onnx?: { wasm?: { wasmPaths?: unknown } } };
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
  localModelPath?: string;
}

function makeEnv(): FakeEnv {
  return { backends: { onnx: { wasm: {} } } };
}

describe('configureTransformersEnv', () => {
  const realFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    // Disable BroadcastChannel here so the background ort-wasm-paths VFS read
    // rejects synchronously; the dedicated `transformers-env.wasm-paths` and
    // `transformers-env.vfs-load` suites stand up an in-memory responder when
    // they need it.
    vi.stubGlobal('BroadcastChannel', undefined);
    const mod = await import('../../src/speech/transformers-env.js');
    mod.__resetTransformersEnvForTests();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    const { setLocalApiBaseUrl, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
    const mod = await import('../../src/speech/transformers-env.js');
    mod.__resetTransformersEnvForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sets ort-web wasmPaths to the VFS preview path for the ipk-installed onnxruntime-web', async () => {
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    const wasmPaths = env.backends?.onnx?.wasm?.wasmPaths;
    expect(typeof wasmPaths).toBe('string');
    expect(wasmPaths).toMatch(/\/preview\/workspace\/node_modules\/onnxruntime-web\/dist\/$/);
    // Defense in depth: must not point at any CDN host.
    expect(wasmPaths).not.toMatch(/jsdelivr|unpkg|huggingface/);
  });

  it('pins model loading to local /workspace/models via the preview SW', async () => {
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    expect(env.allowRemoteModels).toBe(false);
    expect(env.allowLocalModels).toBe(true);
    expect(env.localModelPath).toMatch(/\/preview\/workspace\/models\/$/);
  });

  it('wraps env.fetch and routes remote http(s) URLs through /api/fetch-proxy (same-origin)', async () => {
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    await env.fetch?.(
      'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/fetch-proxy');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Target-URL']).toBe(
      'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'
    );
    expect(headers['X-Bridge-Token']).toBeUndefined();
    expect(init.cache).toBe('no-store');
  });

  it('prepends the configured bridge base in thin-bridge mode and attaches X-Bridge-Token', async () => {
    const { setLocalApiBaseUrl, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('token-abc');
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    await env.fetch?.('https://huggingface.co/model.safetensors');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:5710/api/fetch-proxy');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBe('token-abc');
    expect(headers['X-Target-URL']).toBe('https://huggingface.co/model.safetensors');
  });

  it('passes non-http(s) URLs (blob: / data:) through unchanged', async () => {
    const original = vi.fn(async () => new Response('orig', { status: 200 }));
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env: FakeEnv = { backends: { onnx: { wasm: {} } }, fetch: original as never };
    configureTransformersEnv(env as never);
    await env.fetch?.('blob:https://example.com/abc');
    expect(original).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is idempotent — repeat calls do not stack wrappers', async () => {
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    const wrappedOnce = env.fetch;
    configureTransformersEnv(env as never);
    expect(env.fetch).toBe(wrappedOnce);
  });

  it('still proxies cross-origin URLs (HF Hub catalog probes route through /api/fetch-proxy)', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost:5710' });
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    await env.fetch?.(
      'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'
    );
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/fetch-proxy');
    expect((init.headers as Record<string, string>)['X-Target-URL']).toBe(
      'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'
    );
  });

  it('forwards caller method/body and merges init.headers into the proxy request', async () => {
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    await env.fetch?.('https://huggingface.co/model.safetensors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'payload',
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/octet-stream'
    );
    expect((init.headers as Record<string, string>)['X-Target-URL']).toBe(
      'https://huggingface.co/model.safetensors'
    );
    expect(init.body).toBe('payload');
  });
});

// `assertLocalModelPresent` is now exercised by
// `transformers-env.assert-local-model-present.test.ts`, which stands up an
// in-memory `preview-vfs` BroadcastChannel responder so the direct-VFS probe
// has something to read.
