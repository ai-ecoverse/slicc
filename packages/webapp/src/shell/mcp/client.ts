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

import { createLogger } from '../../core/logger.js';
import type { McpAppDef, McpFetchLike, McpRpcError, McpToolDef } from './types.js';

const log = createLogger('mcp-client');

/** Default per-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Streamable-HTTP spec version negotiated on `initialize`. */
const MCP_PROTOCOL_VERSION = '2025-06-18';

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

/** Constructor options for {@link McpClient}. */
export interface McpClientOptions {
  /** Full server endpoint URL. */
  url: string;
  /** Static headers merged into every request (lowest precedence). */
  headers?: Record<string, string>;
  /** Pre-existing session id to echo on the first request. */
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
  /** Override the protocol version sent on `initialize`. */
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
  private readonly protocolVersion: string;
  private readonly clientInfo: { name: string; version: string };
  private fetchImpl: McpFetchLike | null;
  private fetchImplLoader: Promise<McpFetchLike> | null = null;
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.staticHeaders = opts.headers ?? {};
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getAuthHeader = opts.getAuthHeader;
    this.protocolVersion = opts.protocolVersion ?? MCP_PROTOCOL_VERSION;
    this.clientInfo = opts.clientInfo ?? { name: 'SLICC', version: '0.0.0' };
    this.fetchImpl = opts.fetchImpl ?? null;
    this.sessionId = opts.sessionId;
  }

  /** The captured `Mcp-Session-Id`, if any. */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** MCP `initialize` — also captures the session id from the response. */
  async initialize(): Promise<unknown> {
    return this.request('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
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
    if (this.sessionId && method !== 'initialize') {
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
        reject(new Error(`MCP request timed out after ${this.timeoutMs}ms (${method})`));
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
        throw new Error(`MCP request timed out after ${this.timeoutMs}ms (${method})`);
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

    const sid = headerLookup(res.headers, 'mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status >= 400) {
      const snippet = new TextDecoder('utf-8').decode(res.body).slice(0, 512);
      throw new Error(
        `MCP HTTP ${res.status} ${res.statusText} for ${method}: ${snippet || '(empty body)'}`
      );
    }

    const ct = headerLookup(res.headers, 'content-type') ?? '';
    const frame: JsonRpcResponseFrame = ct.toLowerCase().includes('text/event-stream')
      ? selectSseResponseFrame(res.body, id)
      : (JSON.parse(new TextDecoder('utf-8').decode(res.body)) as JsonRpcResponseFrame);

    if (frame.error) {
      const err = frame.error;
      const e = new Error(`MCP RPC error ${err.code}: ${err.message}`) as Error & {
        rpcError: McpRpcError;
      };
      e.rpcError = err;
      throw e;
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
}
