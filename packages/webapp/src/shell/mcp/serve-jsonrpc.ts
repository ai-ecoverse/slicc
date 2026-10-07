/**
 * Stateless MCP JSON-RPC for a published CLI set.
 *
 * Speaks `initialize`, `notifications/initialized`, `server/discover`,
 * `tools/list`, `tools/call`, and `ping`. No SSE, resources, or prompts.
 * A notification (no `id`) is answered with HTTP 202 and an empty body.
 */

import type { JsonObjectSchema } from './serve-catalog.js';

export interface RpcTool {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}

export interface ToolRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RpcOutcome {
  status: number;
  contentType: string;
  body: string;
}

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-06-18'] as const;
const OUTPUT_CAP = 100_000;
const JSON_HEADERS = 'application/json; charset=utf-8';

type RpcId = string | number | null;

export async function handleJsonRpc(
  raw: string,
  tools: RpcTool[],
  call: (name: string, args: unknown) => Promise<ToolRunResult>
): Promise<RpcOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (Array.isArray(parsed)) return rpcError(null, -32600, 'Batch requests are not supported');
  if (!parsed || typeof parsed !== 'object') return rpcError(null, -32600, 'Invalid request');
  const method = readString(parsed, 'method');
  if (!method) return rpcError(readId(parsed), -32600, 'Invalid request');
  if (!hasOwn(parsed, 'id')) return { status: 202, contentType: 'text/plain', body: '' };
  const id = readId(parsed);
  const params = Object.getOwnPropertyDescriptor(parsed, 'params')?.value;
  if (method === 'initialize') return rpcOk(id, initializeResult(params));
  if (method === 'server/discover') return rpcOk(id, discoverResult());
  if (method === 'tools/list') return rpcOk(id, { tools });
  if (method === 'ping') return rpcOk(id, {});
  if (method === 'tools/call') return toolCall(id, params, tools, call);
  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function toolCall(
  id: RpcId,
  params: unknown,
  tools: RpcTool[],
  call: (name: string, args: unknown) => Promise<ToolRunResult>
): Promise<RpcOutcome> {
  const name = params && typeof params === 'object' ? readString(params, 'name') : undefined;
  if (!name) return rpcError(id, -32602, 'tools/call requires a name');
  if (!tools.some((tool) => tool.name === name))
    return rpcError(id, -32602, `Unknown tool: ${name}`);
  const args =
    params && typeof params === 'object'
      ? Object.getOwnPropertyDescriptor(params, 'arguments')?.value
      : undefined;
  try {
    const result = await call(name, args);
    return rpcOk(id, toolResult(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'tool call failed';
    return rpcError(id, -32000, message);
  }
}

function toolResult(result: ToolRunResult): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
  structuredContent: { stdout: string; stderr: string; exitCode: number };
} {
  const stdout = cap(result.stdout);
  const stderr = cap(result.stderr);
  const text = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout;
  return {
    content: [{ type: 'text', text }],
    isError: result.exitCode !== 0,
    structuredContent: { stdout, stderr, exitCode: result.exitCode },
  };
}

function initializeResult(params: unknown): {
  protocolVersion: string;
  capabilities: { tools: { listChanged: false } };
  serverInfo: { name: string; version: string };
} {
  const requested =
    params && typeof params === 'object' ? readString(params, 'protocolVersion') : undefined;
  const protocolVersion =
    PROTOCOL_VERSIONS.find((version) => version === requested) ?? PROTOCOL_VERSIONS[0];
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'slicc-mcp-serve', version: '1' },
  };
}

function discoverResult(): {
  protocolVersion: string;
  supportedVersions: readonly string[];
  capabilities: { tools: { listChanged: false } };
  serverInfo: { name: string; version: string };
} {
  return {
    protocolVersion: PROTOCOL_VERSIONS[0],
    supportedVersions: PROTOCOL_VERSIONS,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'slicc-mcp-serve', version: '1' },
  };
}

function cap(value: string): string {
  if (value.length <= OUTPUT_CAP) return value;
  return `${value.slice(0, OUTPUT_CAP)}\n… truncated ${value.length - OUTPUT_CAP} chars`;
}

function rpcOk(id: RpcId, result: unknown): RpcOutcome {
  return {
    status: 200,
    contentType: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  };
}

function rpcError(id: RpcId, code: number, message: string): RpcOutcome {
  return {
    status: 200,
    contentType: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  };
}

function readId(value: object): RpcId {
  const id = Object.getOwnPropertyDescriptor(value, 'id')?.value;
  if (typeof id === 'string' || typeof id === 'number' || id === null) return id;
  return null;
}

function readString(value: object, key: string): string | undefined {
  const found = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof found === 'string' ? found : undefined;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
