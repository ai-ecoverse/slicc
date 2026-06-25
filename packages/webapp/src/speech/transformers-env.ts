/**
 * Shared transformers.js environment configuration for the speech engines.
 *
 * Wave 13c swap (no preview SW round-trip): both the ort-web runtime assets
 * AND the model weights are loaded directly from VFS bytes via the page-side
 * `preview-vfs` BroadcastChannel responder — the same wire the preview SW
 * uses, but bypassed locally so each file resolves without an HTTP request,
 * service worker boot-race, or per-file 30 s SW timeout. The legacy preview-
 * URL string forms are kept ONLY for the extension float (which still wraps
 * `chrome.runtime.getURL('/preview/...')` against host_permissions) and as
 * the matcher transformers.js URLs are produced against.
 *
 * - For standalone / hosted-leader / cherry / Wrangler: `env.backends.onnx.
 *   wasm.wasmPaths` becomes the OBJECT form `{filename: blobUrl}` resolved
 *   from VFS bytes (`/workspace/node_modules/onnxruntime-web/dist/...`).
 *   The blob URLs persist for the runtime lifetime — ort instantiates lazily
 *   at `pipeline()` time.
 * - `env.localModelPath = toPreviewUrl('/workspace/models/')` keeps
 *   transformers.js asking only for VFS-rooted paths; the wrapped `env.fetch`
 *   recognizes the `localModelPath` prefix and answers from VFS bytes BEFORE
 *   any same-origin/SW fall-through. The extension float keeps
 *   `allowRemoteModels = false` (its non-URL `localPath` satisfies the local
 *   existence probe); standalone re-enables the remote branch but pins
 *   `remoteHost`/`remotePathTemplate` to the same VFS base so the probe still
 *   resolves offline (Wave 13g — see `configureTransformersEnv`).
 *
 * Both whisper (`@huggingface/transformers` directly) and kokoro
 * (`kokoro-js`, deduped onto the same transformers copy by the Vite configs)
 * call this after import — whichever engine loads first wins; the config is
 * idempotent. The wasmPaths-build promise is cached at module scope so the
 * say⇄hear warmup race resolves to the same referential object.
 *
 * `env.fetch` override: even though weights now live locally, transformers.js
 * still emits HTTP requests against `huggingface.co` for catalog probes (model
 * card, config.json) when traversing fallbacks. Routing those through
 * `/api/fetch-proxy` keeps CORS sane on the leader origin (Xet redirect, no
 * leader-origin grant) — same wiring as every other agent-initiated HTTP
 * site. Extension float has host_permissions covering both origins, so the
 * library's default `fetch` is left alone there.
 */

import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { detectMimeType, toPreviewUrl } from '../shell/supplemental-commands/shared.js';

/** Structural slice of transformers.js' `env` that we touch. */
export interface TransformersEnvLike {
  backends?: { onnx?: { wasm?: { wasmPaths?: unknown } } };
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Disable HF-Hub fetches; weights load only from `localModelPath`. */
  allowRemoteModels?: boolean;
  /** Allow loading from `localModelPath` (default true; pinned to true here). */
  allowLocalModels?: boolean;
  /**
   * Base URL transformers.js prepends to model ids when reading locally.
   * `<localModelPath>/<modelId>/<file>` — must end with `/`.
   */
  localModelPath?: string;
  /**
   * Host URL transformers.js prepends to model ids for "remote" reads. We
   * point this at `localModelPath` so the existence-probe `remoteURL` stays
   * under the VFS prefix and resolves through the wrapped `env.fetch`.
   */
  remoteHost?: string;
  /**
   * Template appended to `remoteHost` per model. `'{model}/'` yields
   * `<remoteHost>/<modelId>/<file>`, matching the local VFS layout so
   * `extractVfsPathFromPreviewUrl` recognizes the probe URL.
   */
  remotePathTemplate?: string;
}

/** Idempotency marker on a wrapped `env.fetch` — so a second engine load
 *  (whisper then kokoro, or vice versa) doesn't stack wrap-of-wrap layers. */
const FETCH_WRAPPED_MARKER = Symbol.for('slicc.transformers-env.fetch-wrapped');

const isExtensionFloat = (): boolean => typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

/** Where the user-installed `onnxruntime-web` package lives in the VFS. */
export const ORT_DIST_VFS_PATH = '/workspace/node_modules/onnxruntime-web/dist/';
/** Base path under which `hf download` materializes model repos in the VFS. */
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

/** The current realm's origin, or null if no `location.origin` is exposed. */
function realmOrigin(): string | null {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return loc?.origin ?? null;
}

/**
 * Same-origin URLs (the preview SW serving `/workspace/models/` + the
 * onnxruntime-web `dist/`) must NOT route through `/api/fetch-proxy` — the
 * proxy fetches externally with node-server, bypassing the in-browser SW that
 * actually serves the VFS-backed bytes. Skipping same-origin lets the wrapped
 * `env.fetch` fall through to the native page-realm `fetch`, which the SW
 * intercepts and answers from OPFS.
 */
function isSameOriginUrl(input: string | URL | Request): boolean {
  const here = realmOrigin();
  if (!here) return false;
  try {
    return new URL(urlString(input)).origin === here;
  } catch {
    return false;
  }
}

/** Route one transformers.js remote fetch through `/api/fetch-proxy`. */
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

/**
 * VFS-bytes read budget. The `preview-vfs` responder is page-side and the
 * underlying read is a RemoteVfsClient RPC to the kernel worker — fast for
 * normal model files (configs, tokenizers, individual onnx files) but the
 * kokoro `model.onnx_data` (~330 MB) can take real wall-clock to stream over
 * the worker RPC. Match the preview-sw-handler 30 s budget so heavy reads
 * don't surface here as a misleading ENOENT.
 */
const VFS_READ_TIMEOUT_MS = 30000;

/** The set of `onnxruntime-web` dist files speech needs at runtime. The JSEP
 *  build (WebGPU), the plain SIMD build (CPU fallback), and the asyncify
 *  single-threaded build (the variant ort-web picks when `SharedArrayBuffer`
 *  is unavailable, e.g. when the page lacks `crossOriginIsolated`) are each
 *  read when present; absent variants are skipped. At least one must exist —
 *  otherwise the user hasn't run `ipk add onnxruntime-web` and we surface the
 *  canonical guidance error. */
export const ORT_WASM_DIST_FILES: ReadonlyArray<string> = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];

/** One-shot ENOENT marker carried on errors raised by `readVfsBytes` so the
 *  fetch wrap can distinguish a missing file (→ 404 response) from a
 *  transport-level failure (→ rethrow). */
const VFS_ENOENT_MARKER = Symbol.for('slicc.transformers-env.vfs-enoent');

/**
 * Read raw VFS bytes via the same `preview-vfs` BroadcastChannel responder
 * the preview SW talks to — but bypass the SW entirely. The responder is
 * always page-resident and reaches OPFS via the kernel worker's VfsRpcHost,
 * so this is the page realm's direct VFS access path (no HTTP, no SW boot-
 * race, no per-file 30 s SW window).
 */
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
    const timer = setTimeout(() => {
      const err = new Error(`ENOENT: ${path} (preview-vfs responder timed out)`) as Error & {
        [VFS_ENOENT_MARKER]?: true;
      };
      err[VFS_ENOENT_MARKER] = true;
      finish(() => reject(err));
    }, VFS_READ_TIMEOUT_MS);
    const listener = (ev: MessageEvent): void => {
      const data = ev.data as
        | { type?: string; id?: string; content?: string | Uint8Array; error?: string }
        | undefined;
      if (data?.type !== 'preview-vfs-response' || data.id !== id) return;
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

/** True for errors `readVfsBytes` raised because the file is genuinely missing
 *  (ENOENT) — i.e. the fetch wrap should answer with a 404 Response so the
 *  transformers.js file-fallback chain can route to its next candidate. */
function isVfsEnoent(err: unknown): boolean {
  return !!(err as { [VFS_ENOENT_MARKER]?: boolean })?.[VFS_ENOENT_MARKER];
}

/** Copy `Uint8Array` bytes onto a fresh `ArrayBuffer` so the resulting buffer
 *  is plain (not `SharedArrayBuffer`) and the caller's source can be reused
 *  or freed without affecting the new view. Required for both `new Response(
 *  bytes)` and `new Blob([bytes])` under strict TS lib types. */
function toFreshBuffer(sourceBytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(sourceBytes.byteLength);
  const safe = new Uint8Array(buf);
  safe.set(sourceBytes);
  return safe;
}

/**
 * Map a transformers.js-emitted `localModelPath` URL back to the absolute
 * VFS path the responder reads from. Returns `null` for any URL that is NOT
 * under the model-path prefix — the fetch wrap then routes it to the next
 * branch (same-origin pass-through or HF-proxy). Pure function for testing.
 */
export function extractVfsPathFromPreviewUrl(
  url: string,
  localModelPath: string | undefined
): string | null {
  if (!localModelPath) return null;
  if (!url.startsWith(localModelPath)) return null;
  const remainder = url.slice(localModelPath.length).split('?')[0].split('#')[0];
  return `${LOCAL_MODELS_VFS_PATH}${remainder}`;
}

/**
 * Synthesize a `Response` from VFS bytes mirroring the preview-SW contract
 * transformers.js' loader expects: 200 with `Content-Type` + `Content-Length`
 * for normal reads; 206 with `Content-Range` + correct `Content-Length` and
 * an empty body for the cache-aware metadata `Range: bytes=0-0` probe (`rA()`
 * in the transformers bundle) so we don't ship the body for size-only
 * lookups; 404 for ENOENT so the fallback chain still routes.
 */
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

/** Module-level promise so concurrent first loads (the say⇄hear warmup race)
 *  resolve to the same referential wasmPaths object. The blob URLs are NOT
 *  revoked — ort-web instantiates lazily at `pipeline()` time, often well
 *  after `configureTransformersEnv` returns. */
let wasmPathsPromise: Promise<Record<string, string>> | null = null;

/**
 * Read the small set of `onnxruntime-web` dist files from VFS and wrap each
 * in a blob URL so ort-web's object-form `wasmPaths` can resolve filenames
 * to local data without a network request. Throws the canonical
 * `ipk add onnxruntime-web` guidance if NO dist file is present.
 */
async function buildOrtWasmPathsFromVfs(): Promise<Record<string, string>> {
  // `URL.createObjectURL` requires a browser realm. The fetch wrap and the
  // assertion both short-circuit on the extension float (no wasmPaths build
  // there at all) — this guard covers Node / vitest where the global is
  // absent: tests stub it explicitly when exercising this path.
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
        // Skip optional variants that aren't installed; surface only if
        // EVERY known filename is missing.
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

/**
 * Resolve the ort `wasmPaths` object form, building it from VFS bytes on the
 * first call and reusing the same promise across concurrent invocations so
 * the say⇄hear warmup race converges on one referential object. Rejects with
 * the canonical `ipk add onnxruntime-web` guidance when no dist file is
 * present. Exported for tests + any future caller that wants to surface the
 * missing-install error explicitly (the engines themselves rely on the
 * `configureTransformersEnv`-installed fallback string preserving the prior
 * Wave 7 failure mode when ort isn't staged).
 */
export function ensureOrtWasmPaths(): Promise<Record<string, string>> {
  if (!wasmPathsPromise) wasmPathsPromise = buildOrtWasmPathsFromVfs();
  return wasmPathsPromise;
}

/**
 * Test-only reset for the module-level wasmPaths promise. Vitest exercises
 * `buildOrtWasmPathsFromVfs` once per case; production never calls this.
 */
export function __resetTransformersEnvForTests(): void {
  wasmPathsPromise = null;
}

/**
 * Point ort-web at VFS-resolved blob URLs (no preview-SW HTTP round-trip),
 * pin transformers to local-only model loading, and override `env.fetch` so
 * model files load from VFS bytes and any residual HF probe still survives
 * the Xet CORS gap.
 */
export function configureTransformersEnv(env: TransformersEnvLike): void {
  const onnxWasm = env.backends?.onnx?.wasm;
  if (onnxWasm) {
    // Initial value: the preview-URL string the extension uses (chrome.runtime.
    // getURL-rewritten under host_permissions). Standalone/etc. replace this
    // with the resolved blob-URL object below; until the async resolution
    // completes, this string serves as a safe fallback for any synchronous
    // reader. ort-web reads wasmPaths at pipeline() time, which happens
    // strictly after `assertLocalModelPresent` (which awaits the same
    // resolution) — so by the time it matters, the object form is in place.
    onnxWasm.wasmPaths = toPreviewUrl(ORT_DIST_VFS_PATH);
  }
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = toPreviewUrl(LOCAL_MODELS_VFS_PATH);
  if (isExtensionFloat()) return;
  // Standalone fix (Wave 13g): transformers@4.2.0's `get_file_metadata`
  // existence probe only confirms a LOCAL file when `localPath` is a non-URL
  // fs path — but `localModelPath` here is an http preview URL, so the local
  // branch is skipped and the only other branch (a `Range: bytes=0-0` probe
  // via `env.fetch`) is gated behind `allowRemoteModels`. Re-enable the remote
  // branch but point its host at the SAME preview base so `remoteURL` falls
  // under the `localModelPath` prefix — the wrapped `env.fetch` below answers
  // it from VFS bytes (206 for the metadata probe). No CDN/network is
  // introduced; `remotePathTemplate = '{model}/'` mirrors the local layout so
  // `extractVfsPathFromPreviewUrl` matches.
  env.allowRemoteModels = true;
  env.remoteHost = env.localModelPath;
  env.remotePathTemplate = '{model}/';
  // Standalone: build the wasmPaths object from VFS bytes and replace the
  // string fallback as soon as resolution completes. The promise is cached
  // (`wasmPathsPromise`) so a second `configureTransformersEnv` call from
  // the other engine reuses the same resolved object.
  if (onnxWasm) {
    void ensureOrtWasmPaths().then(
      (paths) => {
        onnxWasm.wasmPaths = paths;
      },
      () => {
        /* swallow — `assertLocalModelPresent` surfaces the actionable error */
      }
    );
  }
  const existing = env.fetch as
    | (TransformersEnvLike['fetch'] & { [FETCH_WRAPPED_MARKER]?: boolean })
    | undefined;
  if (existing?.[FETCH_WRAPPED_MARKER]) return;
  const originalFetch = existing;
  // Snapshot `localModelPath` at wrap time so a later mutation can't break
  // the prefix match — risk D.6 in the research report.
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

/**
 * Verify that the local weights for `modelId` are reachable before invoking
 * transformers.js — otherwise the library surfaces an opaque "Could not load
 * model …" error and the user has no idea they need to stage the weights.
 *
 * Probes `<LOCAL_MODELS_VFS_PATH>/<modelId>/config.json` (the entry every
 * transformers / kokoro-js model declares) directly via the VFS-bytes path,
 * with NO dependency on the preview SW being installed / claimed. ENOENT →
 * the same canonical "run `hf download …`" guidance the previous fetch-probe
 * path surfaced; transport-level failures are wrapped with the same line.
 *
 * The ort wasmPaths build is a separate concern — if `onnxruntime-web` is
 * missing, the wasmPaths fallback string surfaces the same SW 404 the
 * pre-Wave-13c path did, so the failure mode stays consistent.
 */
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
