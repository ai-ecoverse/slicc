/**
 * Wave 13c · R6 — the wrapped `env.fetch` recognizes `localModelPath`-prefixed
 * URLs and answers from VFS bytes directly (via the `preview-vfs`
 * BroadcastChannel responder) instead of going through the preview SW + HTTP
 * round-trip. Non-preview URLs still fall through to the existing
 * same-origin pass-through / HF-proxy chain.
 *
 * Each test stands up an in-process `preview-vfs` responder (same wire as
 * `installPreviewVfsResponder` in production) so the BroadcastChannel
 * branch has something to read.
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

/** Install a `preview-vfs` responder backed by a path → bytes map. */
function installPreviewVfsResponder(files: Map<string, Uint8Array>): {
  dispose: () => void;
  reads: string[];
} {
  const reads: string[] = [];
  const channel = new BroadcastChannel('preview-vfs');
  const listener = (ev: MessageEvent): void => {
    const data = ev.data as { type: string; id: string; path: string; asText: boolean } | undefined;
    if (data?.type !== 'preview-vfs-read') return;
    reads.push(data.path);
    const content = files.get(data.path);
    if (content === undefined) {
      channel.postMessage({
        type: 'preview-vfs-response',
        id: data.id,
        error: `ENOENT: ${data.path}`,
      });
      return;
    }
    channel.postMessage({ type: 'preview-vfs-response', id: data.id, content });
  };
  channel.addEventListener('message', listener);
  return {
    dispose: () => {
      channel.removeEventListener('message', listener);
      channel.close();
    },
    reads,
  };
}

describe('configureTransformersEnv — VFS-bytes branch (Wave 13c R6)', () => {
  let responder: ReturnType<typeof installPreviewVfsResponder> | null = null;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;

  beforeEach(async () => {
    // Patch URL.createObjectURL for the background ort-wasm-paths build that
    // configureTransformersEnv kicks off (the wasm-paths suite verifies its
    // semantics; here we only care about env.fetch dispatch). Patch by direct
    // property assignment so `new URL(...)` still works for same-origin
    // checks (vi.stubGlobal('URL', {...}) would shadow the constructor).
    originalCreateObjectUrl = URL.createObjectURL;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:fake';
    fetchSpy = vi.fn(async () => new Response('cross-origin', { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const mod = await import('../../src/speech/transformers-env.js');
    mod.__resetTransformersEnvForTests();
  });

  afterEach(async () => {
    responder?.dispose();
    responder = null;
    globalThis.fetch = realFetch;
    if (originalCreateObjectUrl) {
      (URL as { createObjectURL: typeof URL.createObjectURL }).createObjectURL =
        originalCreateObjectUrl;
    } else {
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
    }
    const mod = await import('../../src/speech/transformers-env.js');
    mod.__resetTransformersEnvForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('serves a localModelPath-prefixed URL from VFS bytes (200 + Content-Length)', async () => {
    const body = new TextEncoder().encode('{"model_type":"whisper"}');
    responder = installPreviewVfsResponder(
      new Map([['/workspace/models/onnx-community/whisper-tiny/config.json', body]])
    );
    vi.stubGlobal('location', { origin: 'http://localhost:5710' });
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    const resp = await env.fetch?.(
      'http://localhost:5710/preview/workspace/models/onnx-community/whisper-tiny/config.json'
    );
    expect(resp?.status).toBe(200);
    expect(resp?.headers.get('Content-Length')).toBe(String(body.byteLength));
    expect(resp?.headers.get('Content-Type')).toBe('application/json');
    expect(await resp?.text()).toBe('{"model_type":"whisper"}');
    // Crucial: the preview SW HTTP path was never touched (no network fetch).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a 206 with correct Content-Length and empty body for the bytes=0-0 metadata probe', async () => {
    const body = new Uint8Array(4096);
    responder = installPreviewVfsResponder(
      new Map([['/workspace/models/onnx-community/whisper-tiny/onnx/encoder.onnx', body]])
    );
    vi.stubGlobal('location', { origin: 'http://localhost:5710' });
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    const resp = await env.fetch?.(
      'http://localhost:5710/preview/workspace/models/onnx-community/whisper-tiny/onnx/encoder.onnx',
      { headers: { Range: 'bytes=0-0' } }
    );
    expect(resp?.status).toBe(206);
    expect(resp?.headers.get('Content-Length')).toBe(String(body.byteLength));
    expect(resp?.headers.get('Content-Range')).toBe(`bytes 0-0/${body.byteLength}`);
    expect(await resp?.text()).toBe('');
  });

  it('answers with a 404 Response on ENOENT so transformers.js fallback chain still routes', async () => {
    responder = installPreviewVfsResponder(new Map());
    vi.stubGlobal('location', { origin: 'http://localhost:5710' });
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    const resp = await env.fetch?.(
      'http://localhost:5710/preview/workspace/models/onnx-community/whisper-tiny/missing.json'
    );
    expect(resp?.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still passes through non-preview same-origin URLs to native fetch', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost:5710' });
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    await env.fetch?.('http://localhost:5710/some/other/asset.css');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:5710/some/other/asset.css');
  });

  it('still routes HF Hub catalog probes through /api/fetch-proxy', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost:5710' });
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);
    await env.fetch?.(
      'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/fetch-proxy');
    expect((init.headers as Record<string, string>)['X-Target-URL']).toBe(
      'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'
    );
  });
});
