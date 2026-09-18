import { isExtensionRealm } from '../core/runtime-env.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { detectMimeType, toPreviewUrl } from '../shell/supplemental-commands/shared.js';

export interface TransformersEnvLike {
  backends?: { onnx?: { wasm?: { wasmPaths?: unknown; numThreads?: number } } };
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  allowRemoteModels?: boolean;

  allowLocalModels?: boolean;

  localModelPath?: string;

  remoteHost?: string;

  remotePathTemplate?: string;

  useBrowserCache?: boolean;
}

const FETCH_WRAPPED_MARKER = Symbol.for('slicc.transformers-env.fetch-wrapped');

const isExtensionFloat = isExtensionRealm;

export const ORT_DIST_VFS_PATH = '/workspace/node_modules/onnxruntime-web/dist/';

export const LOCAL_MODELS_VFS_PATH = '/workspace/models/';

function urlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isRemoteHttpUrl(input: string | URL | Request): boolean {
  const s = urlString(input);
  return s.startsWith('http://') || s.startsWith('https://');
}

function realmOrigin(): string | null {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return loc?.origin ?? null;
}

function isSameOriginUrl(input: string | URL | Request): boolean {
  const here = realmOrigin();
  if (!here) return false;
  try {
    return new URL(urlString(input)).origin === here;
  } catch {
    return false;
  }
}

async function proxiedTransformersFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const targetUrl = urlString(input);
  const callerHeaders: Record<string, string> = {};
  if (init?.headers) {
    new Headers(init.headers).forEach((v, k) => {
      callerHeaders[k] = v;
    });
  }
  const headers = apiHeaders({
    ...callerHeaders,
    'X-Target-URL': targetUrl,
  });
  const method = (init?.method ?? 'GET').toUpperCase();
  const proxyInit: RequestInit = { method, headers, cache: 'no-store' };
  if (init?.body && method !== 'GET' && method !== 'HEAD') {
    proxyInit.body = init.body;
  }
  return fetch(resolveApiUrl('/api/fetch-proxy'), proxyInit);
}

const VFS_READ_TIMEOUT_MS = 30000;

export const ORT_WASM_DIST_FILES: ReadonlyArray<string> = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
];

const VFS_ENOENT_MARKER = Symbol.for('slicc.transformers-env.vfs-enoent');

function readVfsBytes(path: string): Promise<Uint8Array> {
  if (typeof BroadcastChannel === 'undefined') {
    return Promise.reject(
      new Error(`Cannot read VFS path ${path}: BroadcastChannel unavailable in this realm`)
    );
  }
  const channel = new BroadcastChannel('preview-vfs');
  const id = `tfx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<Uint8Array>((resolve, reject) => {
    const finish = (cb: () => void): void => {
      channel.removeEventListener('message', listener);
      channel.close();
      cb();
    };
    let timer: ReturnType<typeof setTimeout>;
    const armTimeout = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const err = new Error(`ENOENT: ${path} (preview-vfs responder timed out)`) as Error & {
          [VFS_ENOENT_MARKER]?: true;
        };
        err[VFS_ENOENT_MARKER] = true;
        finish(() => reject(err));
      }, VFS_READ_TIMEOUT_MS);
    };
    armTimeout();
    const listener = (ev: MessageEvent): void => {
      const data = ev.data as
        | { type?: string; id?: string; content?: string | Uint8Array; error?: string }
        | undefined;
      if (!data || data.id !== id) return;

      if (data.type === 'preview-vfs-start') {
        armTimeout();
        return;
      }
      if (data.type !== 'preview-vfs-response') return;
      clearTimeout(timer);
      if (typeof data.error === 'string') {
        const err = new Error(data.error) as Error & { [VFS_ENOENT_MARKER]?: true };
        if (data.error.includes('ENOENT')) err[VFS_ENOENT_MARKER] = true;
        finish(() => reject(err));
        return;
      }
      const content = data.content;
      if (content instanceof Uint8Array) {
        finish(() => resolve(content));
        return;
      }
      if (typeof content === 'string') {
        finish(() => resolve(new TextEncoder().encode(content)));
        return;
      }
      finish(() => reject(new Error(`Unexpected empty preview-vfs response for ${path}`)));
    };
    channel.addEventListener('message', listener);
    channel.postMessage({ type: 'preview-vfs-read', id, path, asText: false });
  });
}

function isVfsEnoent(err: unknown): boolean {
  return !!(err as { [VFS_ENOENT_MARKER]?: boolean })?.[VFS_ENOENT_MARKER];
}

function toFreshBuffer(sourceBytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(sourceBytes.byteLength);
  const safe = new Uint8Array(buf);
  safe.set(sourceBytes);
  return safe;
}

export function extractVfsPathFromPreviewUrl(
  url: string,
  localModelPath: string | undefined
): string | null {
  if (!localModelPath) return null;
  if (!url.startsWith(localModelPath)) return null;
  const remainder = url.slice(localModelPath.length).split('?')[0].split('#')[0];
  return `${LOCAL_MODELS_VFS_PATH}${remainder}`;
}

async function readVfsAsResponse(path: string, init?: RequestInit): Promise<Response> {
  let bytes: Uint8Array;
  try {
    bytes = await readVfsBytes(path);
  } catch (err) {
    if (isVfsEnoent(err)) {
      return new Response(`Not found: ${path}`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    throw err;
  }
  const mime = detectMimeType(path);
  const rangeHeader = init?.headers ? new Headers(init.headers).get('range') : null;
  if (rangeHeader === 'bytes=0-0') {
    return new Response(null, {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.byteLength),
        'Content-Range': `bytes 0-0/${bytes.byteLength}`,
      },
    });
  }
  return new Response(toFreshBuffer(bytes), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(bytes.byteLength),
    },
  });
}

let wasmPathsPromise: Promise<Record<string, string>> | null = null;

async function buildOrtWasmPathsFromVfs(): Promise<Record<string, string>> {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('onnxruntime-web blob URLs require URL.createObjectURL (browser realm only)');
  }
  const results: Record<string, string> = {};
  await Promise.all(
    ORT_WASM_DIST_FILES.map(async (filename) => {
      try {
        const bytes = await readVfsBytes(`${ORT_DIST_VFS_PATH}${filename}`);
        const blob = new Blob([toFreshBuffer(bytes)], { type: detectMimeType(filename) });
        results[filename] = URL.createObjectURL(blob);
      } catch (err) {
        if (!isVfsEnoent(err)) throw err;
      }
    })
  );
  if (Object.keys(results).length === 0) {
    throw new Error(
      'onnxruntime-web is not installed — run `ipk add onnxruntime-web` to stage the wasm runtime in /workspace/node_modules/.'
    );
  }
  return results;
}

export function ensureOrtWasmPaths(): Promise<Record<string, string>> {
  if (!wasmPathsPromise) wasmPathsPromise = buildOrtWasmPathsFromVfs();
  return wasmPathsPromise;
}

export function __resetTransformersEnvForTests(): void {
  wasmPathsPromise = null;
}

export const ORT_MAX_THREADS = 4;

export const ORT_THREADS_OVERRIDE_KEY = 'slicc_ort_num_threads';

export interface OrtThreadPolicyInput {
  isolated: boolean;

  hardwareConcurrency?: number;

  override?: string | null;
}

export function resolveOrtNumThreadsFrom(input: OrtThreadPolicyInput): number {
  if (!input.isolated) return 1;
  const cores = input.hardwareConcurrency;
  const coresKnown = typeof cores === 'number' && Number.isFinite(cores) && cores >= 1;
  const ceiling = coresKnown ? Math.min(ORT_MAX_THREADS, Math.floor(cores)) : ORT_MAX_THREADS;
  const override = input.override == null ? Number.NaN : Number.parseInt(input.override, 10);
  if (Number.isFinite(override) && override >= 1) {
    return Math.max(1, Math.min(ceiling, override));
  }
  return coresKnown ? Math.max(1, ceiling) : 1;
}

export function resolveOrtNumThreads(): number {
  let override: string | null = null;
  try {
    override = globalThis.localStorage?.getItem(ORT_THREADS_OVERRIDE_KEY) ?? null;
  } catch {}
  const input: OrtThreadPolicyInput = {
    isolated: globalThis.crossOriginIsolated === true,
    hardwareConcurrency: globalThis.navigator?.hardwareConcurrency,
    override,
  };
  const threads = resolveOrtNumThreadsFrom(input);
  if (override != null && input.isolated) {
    console.warn(
      `[speech] ort-web numThreads=${threads} forced by localStorage.${ORT_THREADS_OVERRIDE_KEY}=${JSON.stringify(override)} — this persists until removed`
    );
  }
  return threads;
}

export function configureTransformersEnv(env: TransformersEnvLike): void {
  const onnxWasm = env.backends?.onnx?.wasm;
  if (onnxWasm) {
    onnxWasm.wasmPaths = toPreviewUrl(ORT_DIST_VFS_PATH);

    onnxWasm.numThreads = resolveOrtNumThreads();
  }
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = toPreviewUrl(LOCAL_MODELS_VFS_PATH);

  env.useBrowserCache = false;
  if (isExtensionFloat()) return;

  env.allowRemoteModels = true;
  env.remoteHost = env.localModelPath;
  env.remotePathTemplate = '{model}/';

  if (onnxWasm) {
    void ensureOrtWasmPaths().then(
      (paths) => {
        onnxWasm.wasmPaths = paths;
      },
      () => {}
    );
  }
  const existing = env.fetch as
    | (TransformersEnvLike['fetch'] & { [FETCH_WRAPPED_MARKER]?: boolean })
    | undefined;
  if (existing?.[FETCH_WRAPPED_MARKER]) return;
  const originalFetch = existing;

  const localBase = env.localModelPath;
  const wrapped: NonNullable<TransformersEnvLike['fetch']> & { [FETCH_WRAPPED_MARKER]?: boolean } =
    async (input, init) => {
      const vfsPath = extractVfsPathFromPreviewUrl(urlString(input), localBase);
      if (vfsPath !== null) {
        return readVfsAsResponse(vfsPath, init);
      }
      if (!isRemoteHttpUrl(input) || isSameOriginUrl(input)) {
        if (originalFetch) return originalFetch(input, init);
        return fetch(input as RequestInfo, init);
      }
      return proxiedTransformersFetch(input, init);
    };
  wrapped[FETCH_WRAPPED_MARKER] = true;
  env.fetch = wrapped;
}

export async function assertLocalModelPresent(modelId: string): Promise<void> {
  const guidance = `weights for ${modelId} are missing — run \`hf download ${modelId}\` to fetch them into /workspace/models/.`;
  try {
    await readVfsBytes(`${LOCAL_MODELS_VFS_PATH}${modelId}/config.json`);
  } catch (err) {
    if (isVfsEnoent(err)) throw new Error(guidance);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${guidance} (probe failed: ${detail})`);
  }
}
