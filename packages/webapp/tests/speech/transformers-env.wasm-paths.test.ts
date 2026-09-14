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

function installPreviewVfsResponder(files: Map<string, Uint8Array>): {
  dispose: () => void;
} {
  const channel = new BroadcastChannel('preview-vfs');
  const listener = (ev: MessageEvent): void => {
    const data = ev.data as { type: string; id: string; path: string; asText: boolean } | undefined;
    if (data?.type !== 'preview-vfs-read') return;
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
  };
}

describe('configureTransformersEnv — ort wasmPaths object build (Wave 13c R6)', () => {
  let responder: ReturnType<typeof installPreviewVfsResponder> | null = null;
  let blobCounter = 0;

  let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;

  beforeEach(async () => {
    blobCounter = 0;

    originalCreateObjectUrl = URL.createObjectURL;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
      `blob:fake-${++blobCounter}`;
    const mod = await import('../../src/speech/transformers-env.js');
    mod.__resetTransformersEnvForTests();
  });

  afterEach(async () => {
    responder?.dispose();
    responder = null;
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

  it('replaces the string fallback with the object form once VFS-bytes resolve', async () => {
    responder = installPreviewVfsResponder(
      new Map<string, Uint8Array>([
        [
          '/workspace/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
          new TextEncoder().encode('//mjs'),
        ],
        [
          '/workspace/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
          new Uint8Array([0, 1, 2]),
        ],
      ])
    );
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const env = makeEnv();
    configureTransformersEnv(env as never);

    expect(typeof env.backends?.onnx?.wasm?.wasmPaths).toBe('string');

    await new Promise((r) => setTimeout(r, 20));
    const wasmPaths = env.backends?.onnx?.wasm?.wasmPaths as Record<string, string>;
    expect(typeof wasmPaths).toBe('object');
    expect(Object.keys(wasmPaths).sort()).toEqual([
      'ort-wasm-simd-threaded.jsep.mjs',
      'ort-wasm-simd-threaded.jsep.wasm',
    ]);
    expect(wasmPaths['ort-wasm-simd-threaded.jsep.mjs']).toMatch(/^blob:/);
    expect(wasmPaths['ort-wasm-simd-threaded.jsep.wasm']).toMatch(/^blob:/);
  });

  it('is referentially stable across the say⇄hear warmup race', async () => {
    responder = installPreviewVfsResponder(
      new Map<string, Uint8Array>([
        [
          '/workspace/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
          new Uint8Array([7, 7, 7]),
        ],
      ])
    );
    const { configureTransformersEnv } = await import('../../src/speech/transformers-env.js');
    const envA = makeEnv();
    const envB = makeEnv();

    configureTransformersEnv(envA as never);
    configureTransformersEnv(envB as never);
    await new Promise((r) => setTimeout(r, 20));
    const wasmA = envA.backends?.onnx?.wasm?.wasmPaths as Record<string, string>;
    const wasmB = envB.backends?.onnx?.wasm?.wasmPaths as Record<string, string>;
    expect(typeof wasmA).toBe('object');
    expect(wasmA).toBe(wasmB);

    expect(blobCounter).toBe(1);
  });

  it('surfaces `ipk add onnxruntime-web` guidance when no ort dist file is present', async () => {
    responder = installPreviewVfsResponder(new Map());
    const { configureTransformersEnv, ensureOrtWasmPaths } = await import(
      '../../src/speech/transformers-env.js'
    );
    const env = makeEnv();
    configureTransformersEnv(env as never);

    await expect(ensureOrtWasmPaths()).rejects.toThrow(/ipk add onnxruntime-web/);

    expect(typeof env.backends?.onnx?.wasm?.wasmPaths).toBe('string');
    expect(env.backends?.onnx?.wasm?.wasmPaths).toMatch(/onnxruntime-web\/dist\/$/);
  });
});
