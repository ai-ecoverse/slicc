/**
 * Shared transformers.js environment configuration for the speech engines.
 *
 * Wave 7 swap (no jsdelivr): both the ort-web runtime assets AND the model
 * weights are resolved from the VFS via the preview Service Worker.
 *
 * - `env.backends.onnx.wasm.wasmPaths` points at `toPreviewUrl(
 *   '/workspace/node_modules/onnxruntime-web/dist/')` — `ipk add
 *   onnxruntime-web` lands the dist there and the preview SW streams the
 *   wasm/JSEP loader directly from the live OPFS-backed `VirtualFS`. No
 *   `import.meta.url` asset emission (handled out-of-band by the vite
 *   `strip-ort-wasm-asset` plugin), no CDN fallback.
 * - `env.allowRemoteModels = false` + `env.localModelPath = toPreviewUrl(
 *   '/workspace/models/')` keeps transformers.js fetching weights from the
 *   VFS only — users place them there via the `hf download` shell command.
 *
 * Both whisper (`@huggingface/transformers` directly) and kokoro
 * (`kokoro-js`, deduped onto the same transformers copy by the Vite configs)
 * call this after import — whichever engine loads first wins; the config is
 * idempotent.
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
import { toPreviewUrl } from '../shell/supplemental-commands/shared.js';

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
}

/** Idempotency marker on a wrapped `env.fetch` — so a second engine load
 *  (whisper then kokoro, or vice versa) doesn't stack wrap-of-wrap layers. */
const FETCH_WRAPPED_MARKER = Symbol.for('slicc.transformers-env.fetch-wrapped');

const isExtensionFloat = (): boolean => typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

/** Where the user-installed `onnxruntime-web` package lives in the VFS. */
const ORT_DIST_VFS_PATH = '/workspace/node_modules/onnxruntime-web/dist/';
/** Base path under which `hf download` materializes model repos in the VFS. */
const LOCAL_MODELS_VFS_PATH = '/workspace/models/';

function urlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isRemoteHttpUrl(input: string | URL | Request): boolean {
  const s = urlString(input);
  return s.startsWith('http://') || s.startsWith('https://');
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
 * Point ort-web at the VFS-served onnxruntime-web dist (via the preview SW),
 * pin transformers to local-only model loading, and override `env.fetch` so
 * any residual HF probe still survives the Xet CORS gap.
 */
export function configureTransformersEnv(env: TransformersEnvLike): void {
  const onnxWasm = env.backends?.onnx?.wasm;
  if (onnxWasm) {
    onnxWasm.wasmPaths = toPreviewUrl(ORT_DIST_VFS_PATH);
  }
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = toPreviewUrl(LOCAL_MODELS_VFS_PATH);
  if (isExtensionFloat()) return;
  const existing = env.fetch as
    | (TransformersEnvLike['fetch'] & { [FETCH_WRAPPED_MARKER]?: boolean })
    | undefined;
  if (existing?.[FETCH_WRAPPED_MARKER]) return;
  const originalFetch = existing;
  const wrapped: NonNullable<TransformersEnvLike['fetch']> & { [FETCH_WRAPPED_MARKER]?: boolean } =
    async (input, init) => {
      if (!isRemoteHttpUrl(input)) {
        if (originalFetch) return originalFetch(input, init);
        return fetch(input as RequestInfo, init);
      }
      return proxiedTransformersFetch(input, init);
    };
  wrapped[FETCH_WRAPPED_MARKER] = true;
  env.fetch = wrapped;
}
