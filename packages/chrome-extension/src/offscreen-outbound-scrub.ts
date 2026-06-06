/**
 * Defense-in-depth outbound secret scrub for the offscreen document.
 *
 * Wraps `globalThis.fetch` so that cross-origin http(s) requests have
 * their headers and request body scrubbed (real → masked) before any
 * bytes leave the device. Matches the protection the CLI's
 * `/api/fetch-proxy` already gives: the extension's pi-ai LLM
 * providers can reach `globalThis.fetch` directly (bypassing the SW
 * Port-backed `createProxiedFetch`), and `host_permissions: <all_urls>`
 * lets those requests reach arbitrary upstream hosts.
 *
 * Direction is scrub-only (real → masked) — never unmask, no domain
 * gate. Masking is always safe; the unmask direction lives in the SW
 * fetch-proxy where it belongs.
 *
 * Response bodies pass through UNCHANGED. Streaming SSE (the common
 * shape for LLM responses) must not be buffered or broken by this
 * wrapper.
 *
 * Same-origin (`chrome-extension://<id>/...`), non-http(s) (`blob:`,
 * `data:`, `chrome-extension:`), and invalid URLs pass through
 * untouched.
 */

import { type FetchProxySecretSource, SecretsPipeline } from '@slicc/shared-ts';

export interface OutboundScrubSecretsSnapshot {
  sessionId: string;
  entries: Array<{ name: string; value: string; domains: string[] }>;
}

export type FetchLike = typeof globalThis.fetch;

export interface OutboundScrubLogger {
  warn?: (msg: string, ctx?: unknown) => void;
}

export interface OutboundScrubOptions {
  /** Underlying fetch to wrap. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Resolves to the secret snapshot used to seed the pipeline. */
  getSnapshot: () => Promise<OutboundScrubSecretsSnapshot>;
  /**
   * Same-origin filter. Cross-origin http(s) requests are scrubbed;
   * everything else passes through. Defaults to `self.location.origin`.
   */
  ownOrigin?: string;
  /** Logger for diagnostics. Defaults to no-op. */
  logger?: OutboundScrubLogger;
}

export interface OutboundScrubHandle {
  /** Restore the original fetch. Used by tests and teardown. */
  uninstall: () => void;
  /** Force a pipeline rebuild on the next scrubbed call. Used by tests. */
  reset: () => void;
}

function buildPipeline(snapshot: OutboundScrubSecretsSnapshot): SecretsPipeline {
  const entries = snapshot.entries;
  const source: FetchProxySecretSource = {
    get: async (name) => entries.find((e) => e.name === name)?.value,
    listAll: async () => entries.map((e) => ({ ...e })),
  };
  return new SecretsPipeline({ sessionId: snapshot.sessionId, source });
}

export function shouldScrubUrl(rawUrl: string, ownOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, ownOrigin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.origin === ownOrigin) return false;
  return true;
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

function scrubHeaders(headers: HeadersInit | undefined, pipeline: SecretsPipeline): Headers {
  const out = new Headers();
  const src = new Headers(headers ?? undefined);
  src.forEach((v, k) => {
    out.set(k, pipeline.scrubResponse(v));
  });
  return out;
}

/**
 * Scrub a `BodyInit` real → masked. Handles the common LLM-API shapes
 * (string, ArrayBuffer, ArrayBufferView, Blob, URLSearchParams).
 * `ReadableStream` / `FormData` are passed through unchanged —
 * buffering a streaming upload would break its semantics, and
 * defense-in-depth doesn't gain enough from FormData boundary parsing
 * to be worth the risk.
 */
/**
 * Force a `Uint8Array` produced by `scrubResponseBytes` into a body
 * accepted by `fetch`/`Request`. TS's strict `BodyInit` typing rejects
 * `Uint8Array<ArrayBufferLike>` (the result type) because the union
 * member is `Uint8Array<ArrayBuffer>` — at runtime they're identical.
 */
function bytesAsBodyInit(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

async function scrubBody(
  body: BodyInit | null,
  pipeline: SecretsPipeline
): Promise<BodyInit | null> {
  if (body == null) return body;
  if (typeof body === 'string') {
    return pipeline.scrubResponse(body);
  }
  if (body instanceof ArrayBuffer) {
    return bytesAsBodyInit(pipeline.scrubResponseBytes(new Uint8Array(body)));
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return bytesAsBodyInit(pipeline.scrubResponseBytes(bytes));
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const ab = await body.arrayBuffer();
    const scrubbed = pipeline.scrubResponseBytes(new Uint8Array(ab));
    return new Blob([scrubbed as unknown as BlobPart], { type: body.type });
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return pipeline.scrubResponse(body.toString());
  }
  return body;
}

async function scrubRequest(req: Request, pipeline: SecretsPipeline): Promise<Request> {
  const headers = scrubHeaders(req.headers, pipeline);
  let body: BodyInit | null = null;
  if (req.body != null) {
    const ab = await req.arrayBuffer();
    body =
      ab.byteLength > 0 ? bytesAsBodyInit(pipeline.scrubResponseBytes(new Uint8Array(ab))) : null;
  }
  return new Request(req.url, {
    method: req.method,
    headers,
    body,
    mode: req.mode,
    credentials: req.credentials,
    cache: req.cache,
    redirect: req.redirect,
    referrer: req.referrer,
    referrerPolicy: req.referrerPolicy,
    integrity: req.integrity,
    keepalive: req.keepalive,
    signal: req.signal,
  });
}

export function installOutboundScrubber(opts: OutboundScrubOptions): OutboundScrubHandle {
  const original = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const ownOrigin = opts.ownOrigin ?? self.location.origin;
  const logger = opts.logger ?? {};

  let pipelinePromise: Promise<SecretsPipeline> | null = null;
  const ensurePipeline = (): Promise<SecretsPipeline> => {
    if (pipelinePromise) return pipelinePromise;
    const built = (async () => {
      const snapshot = await opts.getSnapshot();
      const p = buildPipeline(snapshot);
      await p.reload();
      return p;
    })();
    pipelinePromise = built;
    built.catch(() => {
      if (pipelinePromise === built) pipelinePromise = null;
    });
    return built;
  };

  const wrapped: FetchLike = async (input, init) => {
    let url: string;
    try {
      url = extractUrl(input as RequestInfo | URL);
    } catch {
      return original(input as RequestInfo | URL, init);
    }
    if (!shouldScrubUrl(url, ownOrigin)) {
      return original(input as RequestInfo | URL, init);
    }

    let pipeline: SecretsPipeline;
    try {
      pipeline = await ensurePipeline();
    } catch (err) {
      logger.warn?.('outbound-scrub: pipeline build failed; passing through', err);
      return original(input as RequestInfo | URL, init);
    }
    if (!pipeline.hasSecrets()) {
      return original(input as RequestInfo | URL, init);
    }

    if (typeof Request !== 'undefined' && input instanceof Request) {
      const scrubbed = await scrubRequest(input.clone(), pipeline);
      return original(scrubbed, init);
    }

    const nextInit: RequestInit = init ? { ...init } : {};
    if (nextInit.headers !== undefined) {
      nextInit.headers = scrubHeaders(nextInit.headers, pipeline);
    }
    if (nextInit.body !== undefined && nextInit.body !== null) {
      nextInit.body = (await scrubBody(nextInit.body, pipeline)) as BodyInit;
    }
    return original(input as RequestInfo | URL, nextInit);
  };

  globalThis.fetch = wrapped;
  return {
    uninstall: () => {
      globalThis.fetch = original;
    },
    reset: () => {
      pipelinePromise = null;
    },
  };
}

/**
 * Default snapshot getter — RPC the SW for the current session id and
 * the full {name, value, domains} list. The SW owns `chrome.storage`;
 * the offscreen does not (MV3 quirk).
 */
export async function fetchOutboundScrubSnapshot(): Promise<OutboundScrubSecretsSnapshot> {
  const response = (await chrome.runtime.sendMessage({
    type: 'secrets.list-with-values-for-pipeline',
  })) as
    | {
        sessionId?: string;
        entries?: Array<{ name: string; value: string; domains: string[] }>;
        error?: string;
      }
    | undefined;
  if (!response || typeof response.sessionId !== 'string' || !Array.isArray(response.entries)) {
    throw new Error(response?.error ?? 'invalid snapshot response');
  }
  return { sessionId: response.sessionId, entries: response.entries };
}
