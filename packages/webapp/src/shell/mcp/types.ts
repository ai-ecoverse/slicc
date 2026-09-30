/**
 * Shared types for the MCP shell layer.
 *
 * The MCP HTTP client (`client.ts`), the on-disk store (`store.ts`), and the
 * provider/OAuth helpers (`provider.ts`) all import from here so the wire-
 * and on-disk shapes stay in one place.
 */

/** A tool entry as returned by `tools/list`. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** A best-effort App entry (server-defined; treated as opaque metadata). */
export interface McpAppDef {
  name: string;
  title?: string;
  templateUri?: string;
  description?: string;
}

/**
 * Persisted OAuth metadata for an MCP server. Tokens themselves live in the
 * shared OAuth account store (`slicc_accounts`) — this block only records
 * the DCR result + AS coordinates so silent renewal works after reload.
 */
export interface McpAuthEntry {
  providerId: string;
  authorizationServer: string;
  clientId: string;
  /** Exact redirect URI registered with the authorization server. */
  redirectUri?: string;
  scope?: string;
  registrationClientUri?: string;
}

/** Joined view used by lazy provider registration. */
export interface McpServerAuthRecord {
  name: string;
  serverUrl: string;
  auth: McpAuthEntry;
}

/**
 * How an MCP server's tools are surfaced to the model. Matches Pi's
 * vocabulary (`pi-coding-agent/docs/mcp.md`).
 */
export type McpExposureMode = 'codemode' | 'codemode-deferred' | 'deferred' | 'direct' | 'hidden';

/** Full persisted entry for one server in `servers.json`. */
export interface McpServerEntry {
  url: string;
  protocolVersion?: string;
  headers?: Record<string, string>;
  tools?: McpToolDef[];
  apps?: McpAppDef[];
  addedAt?: string;
  lastRefreshedAt?: string;
  auth?: McpAuthEntry;
  /**
   * Name of the agent plugin that bridged this entry (`plugin install`).
   * Absent for user-added servers; plugin install/remove never touches an
   * entry whose `pluginOrigin` doesn't match, so a user-added server that
   * happens to share the `<plugin>:<server>` name shape is safe.
   */
  pluginOrigin?: string;
  /**
   * How the server's tools are exposed to the model. Defaults to
   * `'codemode'`. `'direct'` declares them as native agent tools.
   */
  exposure?: McpExposureMode;
  /**
   * Per-tool exposure overrides, keyed by glob patterns matched against
   * the tool name. More specific patterns win; ties break by last entry.
   */
  toolExposure?: Record<string, McpExposureMode>;
  /**
   * Transport backend selected after the first successful probe.
   * `'pi'` = `pi-mcp` StreamableHttpTransport; `'slicc'` = legacy SLICC
   * client (2026-07-28 + `apps/list`). Additive; `version: 1` stays.
   */
  transport?: 'pi' | 'slicc';
}

/** Bag type for MCP tool arguments (JSON object). */
export type McpToolArgs = { [key: string]: unknown };

/** Bag type for MCP structured content (JSON object). */
export type McpStructuredContent = { [key: string]: unknown };

/** On-disk shape for `/workspace/.mcp/servers.json`. */
export interface McpServersFile {
  version: number;
  servers: Record<string, McpServerEntry>;
}

/** JSON-RPC error payload. */
export interface McpRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Minimal fetch shape that `McpClient` depends on. */
export type McpFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}>;
