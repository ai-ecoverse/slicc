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
  scope?: string;
  registrationClientUri?: string;
}

/** Joined view used by lazy provider registration. */
export interface McpServerAuthRecord {
  name: string;
  serverUrl: string;
  auth: McpAuthEntry;
}

/** Full persisted entry for one server in `servers.json`. */
export interface McpServerEntry {
  url: string;
  headers?: Record<string, string>;
  sessionId?: string;
  tools?: McpToolDef[];
  apps?: McpAppDef[];
  addedAt?: string;
  lastRefreshedAt?: string;
  auth?: McpAuthEntry;
}

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
