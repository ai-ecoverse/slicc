/**
 * Shared transformers.js environment configuration for the speech engines.
 *
 * The ort-web wasm/JSEP runtime is resolved at run time, not bundle time —
 * point it at the version-matched CDN directory instead of letting the
 * bundler-mangled `import.meta.url` resolution guess (and instead of Vite
 * emitting ~22 MB assets into dist; see `vite-plugins/strip-ort-wasm-asset.ts`).
 *
 * Both whisper (`@huggingface/transformers` directly) and kokoro
 * (`kokoro-js`, deduped onto the same transformers copy by the Vite configs)
 * call this after import — whichever engine loads first wins; the config is
 * idempotent.
 *
 * `env.fetch` override: Hugging Face model requests 302-redirect to a Xet
 * storage backend (`cas-bridge.xethub.hf.co`) that does NOT grant CORS to
 * the leader origin (e.g. `sliccy.ai`, `localhost:8787`). In CLI /
 * standalone / thin-bridge floats we route remote http(s) requests through
 * the bridge's `/api/fetch-proxy` so the redirect is followed server-side,
 * reusing the shared `resolveApiUrl` / `apiHeaders` helpers (same wiring
 * as every other agent-initiated HTTP site). Extension float has
 * host_permissions covering both origins, so the library's default
 * `fetch` is left alone.
 */

import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { jsdelivrNpmUrl } from '../shell/supplemental-commands/cdn-url-builder.js';
import { ORT_WEB_VERSION } from './ort-version.js';

/** Structural slice of transformers.js' `env` that we touch. */
export interface TransformersEnvLike {
  backends?: { onnx?: { wasm?: { wasmPaths?: unknown } } };
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Idempotency marker on a wrapped `env.fetch` — so a second engine load
 *  (whisper then kokoro, or vice versa) doesn't stack wrap-of-wrap layers. */
const FETCH_WRAPPED_MARKER = Symbol.for('slicc.transformers-env.fetch-wrapped');

const isExtensionFloat = (): boolean => typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

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

/** Point ort-web's runtime asset resolution at the version-pinned CDN dir,
 *  and override `env.fetch` so HF model downloads survive the Xet CORS gap. */
export function configureTransformersEnv(env: TransformersEnvLike): void {
  const onnxWasm = env.backends?.onnx?.wasm;
  if (onnxWasm) {
    onnxWasm.wasmPaths = jsdelivrNpmUrl('onnxruntime-web', ORT_WEB_VERSION, 'dist/').toString();
  }
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
