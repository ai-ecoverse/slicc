/**
 * MCP HTTP client — minimal JSON-RPC over Streamable HTTP.
 *
 * Each call is a single POST that may return either `application/json` or
 * a `text/event-stream` response containing one or more JSON-RPC frames.
 * We resolve on the first frame whose `id` matches the outgoing request id
 * and ignore unrelated notifications. No long-lived GET SSE channel.
 *
 * 401 responses surface as {@link McpAuthRequiredError} carrying the
 * `resource_metadata` URL extracted from the `WWW-Authenticate` header so
 * the caller can drive the OAuth flow in `oauth.ts`.
 */

import { createLogger } from '../../base/logger.js';
import type { McpAppDef, McpFetchLike, McpRpcError, McpToolDef } from './types.js';

const log = createLogger('mcp-client');

/** Default per-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Protocol revisions supported by this client, in preference order. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-06-18'] as const;

const MODERN_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];
const LEGACY_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[1];

/**
 * Thrown when the server returns HTTP 401. Carries the parsed
 * `resource_metadata` URL from the `WWW-Authenticate` header so callers can
 * run RFC 9728 PRM discovery without re-parsing the response.
 */
export class McpAuthRequiredError extends Error {
  readonly status: number;
  readonly resourceMetadataUrl: string | undefined;
  readonly wwwAuthenticate: string | undefined;
  constructor(opts: { status: number; resourceMetadataUrl?: string; wwwAuthenticate?: string }) {
    super(`MCP server requires authentication (HTTP ${opts.status})`);
    this.name = 'McpAuthRequiredError';
    this.status = opts.status;
    this.resourceMetadataUrl = opts.resourceMetadataUrl;
    this.wwwAuthenticate = opts.wwwAuthenticate;
  }
}

class McpRpcFailure extends Error {
  readonly rpcError: McpRpcError;

  constructor(error: McpRpcError) {
    super(`MCP RPC error ${error.code}: ${error.message}`);
    this.name = 'McpRpcFailure';
    this.rpcError = error;
  }
}

/**
 * Thrown when a JSON-RPC request exceeds its per-request timeout. The
 * `mcp` shell command maps this to exit code 124 (matching GNU
 * `timeout(1)`) so scripts can branch on timeout vs. other failures.
 */
export class McpTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  constructor(opts: { method: string; timeoutMs: number }) {
    super(`MCP request timed out after ${opts.timeoutMs}ms (${opts.method})`);
    this.name = 'McpTimeoutError';
    this.method = opts.method;
    this.timeoutMs = opts.timeoutMs;
  }
}

class McpHttpError extends Error {
  readonly status: number;
  readonly rpcError: McpRpcError | undefined;

  constructor(opts: {
    status: number;
    statusText: string;
    method: string;
    snippet: string;
    rpcError?: McpRpcError;
  }) {
    super(
      `MCP HTTP ${opts.status} ${opts.statusText} for ${opts.method}: ${opts.snippet || '(empty body)'}`
    );
    this.name = 'McpHttpError';
    this.status = opts.status;
    this.rpcError = opts.rpcError;
  }
}

/** Constructor options for {@link McpClient}. */
export interface McpClientOptions {
  /** Full server endpoint URL. */
  url: string;
  /** Static headers merged into every request (lowest precedence). */
  headers?: Record<string, string>;
  /** Pre-existing session id to echo after a legacy handshake. */
  sessionId?: string;
  /** Per-request timeout in milliseconds (default 60s). */
  timeoutMs?: number;
  /** Injected fetch — defaults to a wrapper around `createProxiedFetch()`. */
  fetchImpl?: McpFetchLike;
  /**
   * Optional async resolver for the `Authorization` header value (e.g.
   * `"Bearer <jwt>"`). Called before every request. Returning `null`
   * sends the request without an `Authorization` header.
   */
  getAuthHeader?: () => Promise<string | null>;
  /** Override the preferred protocol version used by the discovery probe. */
  protocolVersion?: string;
  /** Client identity sent on `initialize`. */
  clientInfo?: { name: string; version: string };
}

interface JsonRpcResponseFrame {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: McpRpcError;
  method?: string;
}

/**
 * Parse a `WWW-Authenticate` value and return the `resource_metadata`
 * parameter if present. Tolerates both quoted (`x="…"`) and unquoted forms.
 */
export function parseResourceMetadataUrl(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const quoted = /resource_metadata="([^"]+)"/i.exec(header);
  if (quoted) return quoted[1];
  const unquoted = /resource_metadata=([^,\s]+)/i.exec(header);
  return unquoted?.[1];
}

/**
 * Parse an SSE byte stream and return the first JSON-RPC frame whose `id`
 * matches `targetId`. Notifications and unrelated responses are ignored.
 */
export function selectSseResponseFrame(
  body: Uint8Array,
  targetId: number | string
): JsonRpcResponseFrame {
  const text = new TextDecoder('utf-8').decode(body);
  // SSE frames are separated by a blank line (\n\n or \r\n\r\n).
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n');
    let parsed: JsonRpcResponseFrame;
    try {
      parsed = JSON.parse(payload) as JsonRpcResponseFrame;
    } catch {
      continue;
    }
    if (parsed.id !== undefined && parsed.id !== null && parsed.id === targetId) {
      return parsed;
    }
  }
  throw new Error(`MCP SSE stream ended without a response for request id ${String(targetId)}`);
}

function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function rpcErrorFrom(error: unknown): McpRpcError | undefined {
  if (error instanceof McpHttpError) return error.rpcError;
  if (error instanceof McpRpcFailure) return error.rpcError;
  return undefined;
}

function rpcFailure(error: McpRpcError): Error {
  return new McpRpcFailure(error);
}

function rpcErrorFromFrame(
  frame: JsonRpcResponseFrame,
  expectedId: number
): McpRpcError | undefined {
  if (frame.jsonrpc !== '2.0' || frame.id !== expectedId || Object.hasOwn(frame, 'result')) {
    return undefined;
  }
  const error = frame.error;
  return error && typeof error.code === 'number' && typeof error.message === 'string'
    ? error
    : undefined;
}

function parseRpcError(text: string, expectedId: number): McpRpcError | undefined {
  try {
    const frame = JSON.parse(text) as JsonRpcResponseFrame;
    return rpcErrorFromFrame(frame, expectedId);
  } catch {
    return undefined;
  }
}

function advertisedVersions(error: McpRpcError): string[] {
  if (!error.data || typeof error.data !== 'object') return [];
  const supported = (error.data as { supported?: unknown }).supported;
  return Array.isArray(supported)
    ? supported.filter((version): version is string => typeof version === 'string')
    : [];
}

async function defaultFetchImpl(): Promise<McpFetchLike> {
  const { createProxiedFetch } = await import('../proxied-fetch.js');
  const fn = createProxiedFetch();
  return async (url, init) => {
    const res = await fn(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    return {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      body: res.body,
    };
  };
}

/** JSON-RPC over Streamable HTTP client for a single MCP server. */
export class McpClient {
  private readonly url: string;
  private readonly staticHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly getAuthHeader?: () => Promise<string | null>;
  private readonly preferredProtocolVersion: string;
  private readonly clientInfo: { name: string; version: string };
  private fetchImpl: McpFetchLike | null;
  private fetchImplLoader: Promise<McpFetchLike> | null = null;
  private sessionId: string | undefined;
  private negotiatedProtocolVersion: string | undefined;
  private nextId = 1;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.staticHeaders = opts.headers ?? {};
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getAuthHeader = opts.getAuthHeader;
    this.preferredProtocolVersion = opts.protocolVersion ?? MODERN_PROTOCOL_VERSION;
    this.clientInfo = opts.clientInfo ?? { name: 'SLICC', version: '0.0.0' };
    this.fetchImpl = opts.fetchImpl ?? null;
    this.sessionId = opts.sessionId;
  }

  /** The captured `Mcp-Session-Id`, if any. */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** The protocol revision selected by the discovery/initialize negotiation. */
  getNegotiatedProtocolVersion(): string | undefined {
    return this.negotiatedProtocolVersion;
  }

  /** Prefer stateless discovery, falling back to the legacy initialize handshake. */
  async initialize(): Promise<unknown> {
    if (this.preferredProtocolVersion === LEGACY_PROTOCOL_VERSION) {
      return this.initializeLegacy();
    }
    try {
      return await this.discoverModern(this.preferredProtocolVersion);
    } catch (err) {
      const rpcError = rpcErrorFrom(err);
      if (rpcError?.code === -32022) {
        const supported = advertisedVersions(rpcError);
        const retryVersion = MCP_SUPPORTED_PROTOCOL_VERSIONS.find(
          (version) => version !== LEGACY_PROTOCOL_VERSION && supported.includes(version)
        );
        if (!retryVersion) {
          throw new Error(
            `MCP server does not support a compatible modern protocol version (supported: ${supported.join(', ') || 'none'})`
          );
        }
        return this.discoverModern(retryVersion);
      }
      const isValidatedLegacySignal =
        rpcError?.code === -32601 &&
        ((err instanceof McpHttpError && err.status === 400) || err instanceof McpRpcFailure);
      if (isValidatedLegacySignal) {
        log.debug('server/discover identified a legacy server; using initialize', {
          error: err.message,
        });
        return this.initializeLegacy();
      }
      throw err;
    }
  }

  private async discoverModern(protocolVersion: string): Promise<unknown> {
    const result = (await this.request('server/discover', { protocolVersion })) as {
      supportedVersions?: unknown;
    } | null;
    const supportedVersions = Array.isArray(result?.supportedVersions)
      ? result.supportedVersions.filter((version): version is string => typeof version === 'string')
      : [];
    const selected = MCP_SUPPORTED_PROTOCOL_VERSIONS.find(
      (version) => version !== LEGACY_PROTOCOL_VERSION && supportedVersions.includes(version)
    );
    if (!selected) {
      throw new Error(
        `MCP server discovery did not advertise a compatible modern protocol version (advertised: ${supportedVersions.join(', ') || 'none'})`
      );
    }
    this.negotiatedProtocolVersion = selected;
    this.sessionId = undefined;
    return result;
  }

  /** MCP `tools/list` — returns the `tools` array (empty if absent). */
  async toolsList(): Promise<McpToolDef[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolDef[] } | null;
    return result?.tools ?? [];
  }

  /** MCP `tools/call` — returns the raw result object. */
  async toolsCall(name: string, args: unknown): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args });
  }

  /** MCP `apps/list` — best-effort; returns `[]` if the server doesn't support it. */
  async appsList(): Promise<McpAppDef[]> {
    try {
      const result = (await this.request('apps/list', {})) as { apps?: McpAppDef[] } | null;
      return result?.apps ?? [];
    } catch (err) {
      if (err instanceof McpAuthRequiredError) throw err;
      log.debug('apps/list not supported by server', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Send a JSON-RPC request and return the `result` field. */
  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const fetchImpl = await this.resolveFetchImpl();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.staticHeaders,
    };
    // Per the MCP Streamable-HTTP spec the session id is established BY the
    // server's response to `initialize`; sending one in is a protocol
    // violation. All subsequent methods echo the captured id.
    if (
      this.negotiatedProtocolVersion === LEGACY_PROTOCOL_VERSION &&
      this.sessionId &&
      method !== 'initialize'
    ) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    if (this.getAuthHeader) {
      const auth = await this.getAuthHeader();
      if (auth) headers['Authorization'] = auth;
    }

    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new McpTimeoutError({ method, timeoutMs: this.timeoutMs }));
        controller.abort();
      }, this.timeoutMs);
    });
    let res: Awaited<ReturnType<McpFetchLike>>;
    const fetchPromise = fetchImpl(this.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    try {
      res = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (err) {
      if (timedOut) {
        // Swallow the inevitable abort-induced rejection from fetchPromise so
        // it doesn't surface as an unhandled rejection after we've already
        // rethrown the timeout error.
        fetchPromise.catch(() => undefined);
        throw new McpTimeoutError({ method, timeoutMs: this.timeoutMs });
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (res.status === 401) {
      const www = headerLookup(res.headers, 'www-authenticate');
      throw new McpAuthRequiredError({
        status: 401,
        wwwAuthenticate: www,
        resourceMetadataUrl: parseResourceMetadataUrl(www),
      });
    }

    if (this.negotiatedProtocolVersion === LEGACY_PROTOCOL_VERSION) {
      const sid = headerLookup(res.headers, 'mcp-session-id');
      if (sid) this.sessionId = sid;
    }

    if (res.status >= 400) {
      const text = new TextDecoder('utf-8').decode(res.body);
      throw new McpHttpError({
        status: res.status,
        statusText: res.statusText,
        method,
        snippet: text.slice(0, 512),
        rpcError: parseRpcError(text, id),
      });
    }

    const ct = headerLookup(res.headers, 'content-type') ?? '';
    const frame: JsonRpcResponseFrame = ct.toLowerCase().includes('text/event-stream')
      ? selectSseResponseFrame(res.body, id)
      : (JSON.parse(new TextDecoder('utf-8').decode(res.body)) as JsonRpcResponseFrame);

    if (frame.error) {
      const rpcError = rpcErrorFromFrame(frame, id);
      if (!rpcError) {
        throw new Error(`MCP invalid JSON-RPC error response for request id ${String(id)}`);
      }
      throw rpcFailure(rpcError);
    }
    return frame.result;
  }

  private async resolveFetchImpl(): Promise<McpFetchLike> {
    if (this.fetchImpl) return this.fetchImpl;
    if (!this.fetchImplLoader) {
      this.fetchImplLoader = defaultFetchImpl().then((fn) => {
        this.fetchImpl = fn;
        return fn;
      });
    }
    return this.fetchImplLoader;
  }

  private async initializeLegacy(): Promise<unknown> {
    this.negotiatedProtocolVersion = LEGACY_PROTOCOL_VERSION;
    return this.request('initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
  }
}
