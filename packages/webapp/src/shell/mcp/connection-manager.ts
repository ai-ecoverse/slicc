/**
 * MCP connection manager — owns one live connection per entry in
 * `/workspace/.mcp/servers.json` and is shared by the agent tools and the
 * shell `mcp` command.
 *
 * Two connection backends:
 * - `PiMcpConnection` wraps `pi-mcp`'s `McpClient` + `StreamableHttpTransport`
 *   for servers speaking <= 2025-11-25.
 * - `LegacySliccConnection` wraps SLICC's existing `McpClient` for 2026-07-28
 *   servers and `apps/list`.
 *
 * Selection: probes with SLICC's `server/discover` first (cheap, stateless).
 * On -32601 or a 4xx, uses `PiMcpConnection`. Caches the result in
 * `servers.json` as `transport: "pi" | "slicc"`.
 */

import { createLogger } from '../../base/logger.js';
import type {
  McpAppDef,
  McpExposureMode,
  McpFetchLike,
  McpServerEntry,
  McpStructuredContent,
  McpToolArgs,
  McpToolDef,
} from './types.js';

const log = createLogger('mcp-connection-manager');

// ── McpConnection interface ──────────────────────────────────────────

export interface McpConnection {
  readonly serverName: string;
  readonly serverUrl: string;
  listTools(): Promise<McpToolDef[]>;
  callTool(
    name: string,
    args: McpToolArgs,
    options?: { signal?: AbortSignal }
  ): Promise<McpCallToolResult>;
  listApps?(): Promise<McpAppDef[]>;
  close(): Promise<void>;
}

export interface McpCallToolResult {
  content: McpCallToolContent[];
  structuredContent?: McpStructuredContent;
  isError?: boolean;
}

export type McpCallToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | {
      type: 'resource';
      resource: { uri?: string; text?: string; blob?: string; mimeType?: string };
    }
  | { type: string; [key: string]: unknown };

// ── Connection Manager ───────────────────────────────────────────────

export type ToolsChangedListener = (serverName: string) => void;

export interface ConnectionManagerOptions {
  getMcpFetchLike?: () => Promise<McpFetchLike>;
  getAuthHeader?: (serverName: string) => Promise<string | null>;
}

export class McpConnectionManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly toolsChangedListeners = new Set<ToolsChangedListener>();
  private readonly options: ConnectionManagerOptions;

  constructor(options: ConnectionManagerOptions = {}) {
    this.options = options;
  }

  onToolsChanged(listener: ToolsChangedListener): () => void {
    this.toolsChangedListeners.add(listener);
    return () => this.toolsChangedListeners.delete(listener);
  }

  private emitToolsChanged(serverName: string): void {
    for (const listener of this.toolsChangedListeners) {
      try {
        listener(serverName);
      } catch (err) {
        log.warn('tools-changed listener threw', {
          serverName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  get(serverName: string): McpConnection | undefined {
    return this.connections.get(serverName);
  }

  has(serverName: string): boolean {
    return this.connections.has(serverName);
  }

  /** Connect to a server. Returns the connection and updates transport in the entry. */
  async connect(
    serverName: string,
    entry: McpServerEntry
  ): Promise<{ connection: McpConnection; transport: 'pi' | 'slicc' }> {
    const existing = this.connections.get(serverName);
    if (existing) {
      return { connection: existing, transport: entry.transport ?? 'slicc' };
    }

    const namespace = serverName.replace(/[^A-Za-z0-9_]/g, '_');
    const clash = [...this.connections.keys()].find(
      (other) => other.replace(/[^A-Za-z0-9_]/g, '_') === namespace
    );
    if (clash)
      throw new Error(
        `MCP server "${serverName}" conflicts with "${clash}" after name normalization`
      );

    const transport = entry.transport ?? (await this.probeTransport(serverName, entry));
    let connection: McpConnection;

    if (transport === 'pi') {
      connection = await this.createPiConnection(serverName, entry);
    } else {
      connection = await this.createSliccConnection(serverName, entry);
    }

    this.connections.set(serverName, connection);
    return { connection, transport };
  }

  async disconnect(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) return;
    this.connections.delete(serverName);
    try {
      await connection.close();
    } catch (err) {
      log.warn('disconnect failed', {
        serverName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.emitToolsChanged(serverName);
  }

  async reconnect(serverName: string, entry: McpServerEntry): Promise<McpConnection> {
    await this.disconnect(serverName);
    const { connection } = await this.connect(serverName, entry);
    this.emitToolsChanged(serverName);
    return connection;
  }

  notifyToolsChanged(serverName: string): void {
    this.emitToolsChanged(serverName);
  }

  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map((n) => this.disconnect(n)));
  }

  /** Probe to determine which transport a server supports. */
  private async probeTransport(serverName: string, entry: McpServerEntry): Promise<'pi' | 'slicc'> {
    const fetchImpl = this.options.getMcpFetchLike
      ? await this.options.getMcpFetchLike()
      : await defaultMcpFetchLike();
    const { McpClient: SliccClient } = await import('./client.js');

    const client = new SliccClient({
      url: entry.url,
      fetchImpl,
      headers: entry.headers,
      getAuthHeader: entry.auth
        ? () =>
            this.options.getAuthHeader
              ? this.options.getAuthHeader(serverName)
              : Promise.resolve(null)
        : undefined,
    });

    try {
      await client.initialize();
      const version = client.getNegotiatedProtocolVersion();
      if (version === '2026-07-28') {
        log.debug('transport probe: slicc modern protocol', { serverName, version });
        return 'slicc';
      }
      log.debug('transport probe: legacy protocol, using pi-mcp for GET stream + notifications', {
        serverName,
        version,
      });
      return 'pi';
    } catch (err) {
      log.debug('transport probe: slicc error, defaulting to pi-mcp', {
        serverName,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'pi';
    }
  }

  private async createPiConnection(
    serverName: string,
    entry: McpServerEntry
  ): Promise<McpConnection> {
    const { McpClient: PiClient, StreamableHttpTransport } = await import('@earendil-works/pi-mcp');

    const mcpFetch = await this.createMcpFetch(serverName, entry);

    const transport = new StreamableHttpTransport({
      url: entry.url,
      headers: entry.headers,
      fetch: mcpFetch,
      ...(entry.auth
        ? {
            authProvider: {
              token: async () => {
                const header = this.options.getAuthHeader
                  ? await this.options.getAuthHeader(serverName)
                  : null;
                return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
              },
            },
          }
        : {}),
    });

    const client = new PiClient({
      name: 'SLICC',
      version: '0.0.0',
    });

    await client.connect(transport);

    const onToolsChanged = client.onNotification('notifications/tools/list_changed', () => {
      this.emitToolsChanged(serverName);
    });

    return {
      serverName,
      serverUrl: entry.url,
      async listTools() {
        return client.listTools();
      },
      async callTool(name, args, options) {
        const result = await client.callTool(name, args, {
          signal: options?.signal,
        });
        return result as McpCallToolResult;
      },
      async close() {
        onToolsChanged();
        await client.close();
      },
    };
  }

  private async createSliccConnection(
    serverName: string,
    entry: McpServerEntry
  ): Promise<McpConnection> {
    const { McpClient: SliccClient } = await import('./client.js');
    const fetchImpl = this.options.getMcpFetchLike
      ? await this.options.getMcpFetchLike()
      : await defaultMcpFetchLike();

    const client = new SliccClient({
      url: entry.url,
      fetchImpl,
      headers: entry.headers,
      getAuthHeader: entry.auth
        ? () =>
            this.options.getAuthHeader
              ? this.options.getAuthHeader(serverName)
              : Promise.resolve(null)
        : undefined,
    });

    await client.initialize();

    return {
      serverName,
      serverUrl: entry.url,
      async listTools() {
        return client.toolsList();
      },
      async callTool(name, args, options) {
        if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const callPromise = client.toolsCall(name, args);
        const signal = options?.signal;
        const result = signal
          ? await Promise.race([
              callPromise,
              new Promise<never>((_, reject) => {
                if (signal.aborted) {
                  reject(new DOMException('Aborted', 'AbortError'));
                  return;
                }
                signal.addEventListener(
                  'abort',
                  () => reject(new DOMException('Aborted', 'AbortError')),
                  { once: true }
                );
              }),
            ])
          : await callPromise;
        return normalizeCallToolResult(result);
      },
      async listApps() {
        return client.appsList();
      },
      async close() {
        // SLICC's stateless client doesn't need explicit close.
      },
    };
  }

  private async createMcpFetch(
    serverName: string,
    entry: McpServerEntry
  ): Promise<(input: string | URL, init?: RequestInit) => Promise<Response>> {
    const fetchImpl = this.options.getMcpFetchLike
      ? await this.options.getMcpFetchLike()
      : await defaultMcpFetchLike();

    return async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const incomingHeaders: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => {
            incomingHeaders[k] = v;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) incomingHeaders[k] = v;
        } else {
          Object.assign(incomingHeaders, init.headers);
        }
      }

      const res = await fetchImpl(url, {
        method: init?.method,
        headers: incomingHeaders,
        body: typeof init?.body === 'string' ? init.body : undefined,
        signal: init?.signal ?? undefined,
      });

      return new Response(new Uint8Array(res.body).buffer, {
        status: res.status,
        statusText: res.statusText,
        headers: new Headers(res.headers),
      });
    };
  }
}

function normalizeCallToolResult(raw: unknown): McpCallToolResult {
  if (!raw || typeof raw !== 'object') {
    return { content: [{ type: 'text', text: String(raw ?? '') }] };
  }
  const obj = raw as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  return {
    content: Array.isArray(obj.content) ? obj.content : [],
    structuredContent: obj.structuredContent as McpStructuredContent | undefined,
    isError: typeof obj.isError === 'boolean' ? obj.isError : undefined,
  };
}

async function defaultMcpFetchLike(): Promise<McpFetchLike> {
  const { createProxiedFetch } = await import('../proxied-fetch.js');
  const { wrapProxiedFetchAsMcpFetch } = await import('./client.js');
  return wrapProxiedFetchAsMcpFetch(createProxiedFetch());
}

// ── Exposure resolution ──────────────────────────────────────────────

export function resolveToolExposure(
  toolName: string,
  serverExposure: McpExposureMode | undefined,
  toolExposure: Record<string, McpExposureMode> | undefined
): McpExposureMode {
  if (toolExposure) {
    let bestMatch: { specificity: number; index: number; mode: McpExposureMode } | undefined;
    const entries = Object.entries(toolExposure);
    for (let i = 0; i < entries.length; i++) {
      const [pattern, mode] = entries[i];
      const specificity = matchGlob(pattern, toolName);
      if (specificity < 0) continue;
      if (
        !bestMatch ||
        specificity > bestMatch.specificity ||
        (specificity === bestMatch.specificity && i > bestMatch.index)
      ) {
        bestMatch = { specificity, index: i, mode };
      }
    }
    if (bestMatch) return bestMatch.mode;
  }
  return serverExposure ?? 'codemode';
}

function matchGlob(pattern: string, name: string): number {
  if (pattern === name) return 2;
  if (pattern === '*') return 0;
  if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return 1;
  return -1;
}

// ── Tool name sanitization (Pi convention) ───────────────────────────

const TOOL_NAME_RE = /[^A-Za-z0-9_]/g;
const MAX_TOOL_NAME_LEN = 64;

export function mcpAgentToolName(serverName: string, toolName: string): string {
  const raw = `mcp__${serverName}__${toolName}`;
  const sanitized = raw.replace(TOOL_NAME_RE, '_');
  return sanitized.length <= MAX_TOOL_NAME_LEN
    ? sanitized
    : `${sanitized.slice(0, MAX_TOOL_NAME_LEN - 9)}_${toolNameHash(serverName, toolName)}`;
}

/** Give every colliding tool a stable suffix, independent of tools/list order. */
export function mcpAgentToolNames(serverName: string, toolNames: string[]): Map<string, string> {
  if (new Set(toolNames).size !== toolNames.length) {
    throw new Error(`MCP server "${serverName}" returned duplicate tool names`);
  }
  const bases = toolNames.map((name) => mcpAgentToolName(serverName, name));
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  const reserved = new Set(bases);
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const name of [...toolNames].sort()) {
    const base = mcpAgentToolName(serverName, name);
    let candidate = base;
    if ((counts.get(base) ?? 0) > 1) {
      let attempt = 0;
      do {
        candidate = `${base.slice(0, MAX_TOOL_NAME_LEN - 9)}_${toolNameHash(serverName, name, attempt)}`;
        attempt++;
      } while (reserved.has(candidate) || used.has(candidate));
    }
    used.add(candidate);
    result.set(name, candidate);
  }
  return result;
}

function toolNameHash(serverName: string, toolName: string, attempt = 0): string {
  // A small deterministic hash keeps the browser bundle free of node:crypto.
  let hash = 0x811c9dc5;
  const input = `${serverName}\0${toolName}${attempt ? `\0${attempt}` : ''}`;
  for (const char of input) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function deduplicateToolNames(names: string[]): Map<string, string> {
  const seen = new Map<string, number>();
  const result = new Map<string, string>();
  for (const name of names) {
    const count = seen.get(name) ?? 0;
    if (count > 0) {
      const suffix = `_${count}`;
      const deduped =
        name.length + suffix.length <= MAX_TOOL_NAME_LEN
          ? name + suffix
          : name.slice(0, MAX_TOOL_NAME_LEN - suffix.length) + suffix;
      result.set(name + `#${count}`, deduped);
      log.warn('MCP tool name collision after sanitization', { original: name, deduped });
    } else {
      result.set(name + '#0', name);
    }
    seen.set(name, count + 1);
  }
  return result;
}
