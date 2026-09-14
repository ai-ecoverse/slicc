export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpAppDef {
  name: string;
  title?: string;
  templateUri?: string;
  description?: string;
}

export interface McpAuthEntry {
  providerId: string;
  authorizationServer: string;
  clientId: string;

  redirectUri?: string;
  scope?: string;
  registrationClientUri?: string;
}

export interface McpServerAuthRecord {
  name: string;
  serverUrl: string;
  auth: McpAuthEntry;
}

export interface McpServerEntry {
  url: string;
  protocolVersion?: string;
  headers?: Record<string, string>;
  tools?: McpToolDef[];
  apps?: McpAppDef[];
  addedAt?: string;
  lastRefreshedAt?: string;
  auth?: McpAuthEntry;

  pluginOrigin?: string;
}

export interface McpServersFile {
  version: number;
  servers: Record<string, McpServerEntry>;
}

export interface McpRpcError {
  code: number;
  message: string;
  data?: unknown;
}

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
