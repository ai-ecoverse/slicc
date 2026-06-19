/**
 * `configureTransformersEnv` — points ort-web's `wasmPaths` at the VFS-served
 * `/preview/.../onnxruntime-web/dist/` (no jsdelivr), pins transformers to
 * local-only model loading from `/workspace/models/`, AND wraps `env.fetch`
 * so any residual remote http(s) probes route through the bridge
 * `/api/fetch-proxy` (`resolveApiUrl` + `apiHeaders`), bypassing the Xet
 * redirect's CORS gap on hosted/thin-bridge leaders.
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

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    const { setLocalApiBaseUrl, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
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

  it('passes same-origin preview URLs through unwrapped so the SW intercepts them', async () => {
    // Page realm: location.origin is the UI origin. The preview SW serves
    // `/preview/workspace/models/<modelId>/<file>` from OPFS — routing those
    // through `/api/fetch-proxy` would bypass the SW entirely and bounce off
    // the node-server (which has no /preview handler).
    vi.stubGlobal('location', { origin: 'http://localhost:5710' });
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    await env.fetch?.(
      'http://localhost:5710/preview/workspace/models/onnx-community/whisper-tiny/config.json'
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(
      'http://localhost:5710/preview/workspace/models/onnx-community/whisper-tiny/config.json'
    );
    // No proxy headers, no rewritten target URL.
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    expect(headers['X-Target-URL']).toBeUndefined();
  });

  it('still proxies cross-origin URLs even when same-origin pass-through is active', async () => {
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

describe('assertLocalModelPresent', () => {
  const realFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns silently when the local config.json is reachable', async () => {
    const { assertLocalModelPresent } = await import('../../src/speech/transformers-env.js');
    await expect(assertLocalModelPresent('onnx-community/whisper-tiny')).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // The probe must hit the preview SW path under /workspace/models/, so the
    // user's `hf download` lands exactly where this check looks.
    expect(url).toMatch(
      /\/preview\/workspace\/models\/onnx-community\/whisper-tiny\/config\.json$/
    );
  });

  it('throws clean `hf download` guidance when the preview SW returns 404', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 404, statusText: 'Not Found' }));
    const { assertLocalModelPresent } = await import('../../src/speech/transformers-env.js');
    await expect(assertLocalModelPresent('onnx-community/whisper-tiny')).rejects.toThrow(
      /hf download onnx-community\/whisper-tiny/
    );
  });

  it('wraps a probe network failure with the same actionable guidance', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'));
    const { assertLocalModelPresent } = await import('../../src/speech/transformers-env.js');
    await expect(assertLocalModelPresent('onnx-community/Kokoro-82M-v1.0-ONNX')).rejects.toThrow(
      /hf download onnx-community\/Kokoro-82M-v1\.0-ONNX/
    );
  });
});
