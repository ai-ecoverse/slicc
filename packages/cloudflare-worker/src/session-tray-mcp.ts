/**
 * MCP publication on the session tray.
 *
 * Metadata, registration, and token exchange stay on the DO so they still
 * answer while the leader is away. `tools/call` and the consent page
 * round-trip to the leader. This is not the file-preview pipe: a missing
 * publication answers `{ code: 'NOT_MCP' }` and the preview host falls through.
 */

import {
  buildPreviewUrl,
  type LeaderToWorkerControlMessage,
  type WorkerToLeaderControlMessage,
} from '@slicc/shared-ts';
import {
  accessGrant,
  authorizationServerMetadata,
  beginAuthorization,
  decideAuthorization,
  dropStaleGrants,
  exchangeToken,
  type McpHttpResult,
  protectedResourceMetadata,
  registerClient,
  unauthorized,
} from './mcp-serve-oauth.js';
import {
  createCapabilityToken,
  jsonResponse,
  type McpServeRecord,
  type TrayRecord,
} from './shared.js';
import { timingSafeEqual } from './timing-safe-equal.js';

const LEADER_WAIT_MS = 120_000;
const JSON_TYPE = 'application/json; charset=utf-8';

export interface McpPendingReply {
  resolve: (result: { status: number; contentType: string; body: string }) => void;
}

export interface McpDeps {
  getTray: () => TrayRecord | null;
  persistTray: () => Promise<void>;
  sendToLeader: (message: WorkerToLeaderControlMessage) => boolean;
  isoNow: () => string;
  now: () => number;
  pending: Map<string, McpPendingReply>;
}

type McpLeaderMessage = Extract<
  LeaderToWorkerControlMessage,
  { type: 'mcp.publish' | 'mcp.generation' | 'mcp.stop' | 'mcp.response' }
>;

interface EdgeRequest {
  token: string;
  method: string;
  path: string;
  search: string;
  body: string;
  contentType: string;
  authorization: string;
  origin: string;
  resourceOrigin: string;
  tooLarge: boolean;
}

export function isMcpLeaderMessage(
  message: LeaderToWorkerControlMessage
): message is McpLeaderMessage {
  return (
    message.type === 'mcp.publish' ||
    message.type === 'mcp.generation' ||
    message.type === 'mcp.stop' ||
    message.type === 'mcp.response'
  );
}

export function handleMcpLeaderMessage(message: McpLeaderMessage, deps: McpDeps): boolean {
  if (message.type === 'mcp.response') return settleMcpResponse(message, deps);
  if (message.type === 'mcp.stop') return stopPublication(message, deps);
  if (message.type === 'mcp.generation') return updateGeneration(message, deps);
  return publishMcp(message, deps);
}

export async function handleMcpInternal(
  url: URL,
  request: Request,
  deps: McpDeps
): Promise<Response> {
  if (url.pathname !== '/internal/mcp/http' || request.method !== 'POST') {
    return jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  const handled = await handleMcpHttp(request, deps);
  if (handled.persist) await deps.persistTray();
  if (handled.notMcp) return jsonResponse({ code: 'NOT_MCP' }, 404);
  const result = handled.result ?? jsonResult(500, { error: 'mcp request failed' });
  return jsonResponse({ status: result.status, headers: result.headers, body: result.body });
}

export function failAllPendingMcp(pending: Map<string, McpPendingReply>): void {
  for (const [id, waiter] of pending) {
    pending.delete(id);
    waiter.resolve({
      status: 502,
      contentType: JSON_TYPE,
      body: JSON.stringify({ error: 'leader disconnected' }),
    });
  }
}

async function handleMcpHttp(
  request: Request,
  deps: McpDeps
): Promise<{ persist: boolean; notMcp?: boolean; result?: McpHttpResult }> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { persist: false, result: jsonResult(400, { error: 'invalid body' }) };
  }
  const edge = parseEdge(payload);
  if (!edge) return { persist: false, result: jsonResult(400, { error: 'invalid body' }) };
  const serve = publicationFor(deps, edge.token);
  if (!serve) return { persist: false, notMcp: true };
  if (edge.tooLarge)
    return {
      persist: false,
      result: withCors(jsonResult(413, { error: 'body too large' }), edge.origin),
    };
  if (edge.method === 'OPTIONS')
    return {
      persist: false,
      result: withCors({ status: 204, headers: {}, body: '' }, edge.origin),
    };
  const routed = await routeMcp(edge, serve, deps);
  return { persist: routed.persist, result: withCors(routed.result, edge.origin) };
}

async function routeMcp(
  edge: EdgeRequest,
  serve: McpServeRecord,
  deps: McpDeps
): Promise<{ persist: boolean; result: McpHttpResult }> {
  if (isMetadataPath(edge)) return { persist: false, result: metadataResult(edge) };
  if (edge.path === '/oauth/register' && edge.method === 'POST') {
    return { persist: true, result: registerClient(serve, edge.body, deps.isoNow()) };
  }
  if (edge.path === '/oauth/authorize' && edge.method === 'GET')
    return authorize(edge, serve, deps);
  if (edge.path === '/oauth/decision' && edge.method === 'POST') {
    return {
      persist: true,
      result: await decideAuthorization(serve, edge.body, edge.contentType, deps.now()),
    };
  }
  if (edge.path === '/oauth/token' && edge.method === 'POST') {
    return {
      persist: true,
      result: await exchangeToken(serve, edge.body, edge.contentType, deps.now()),
    };
  }
  if (edge.path === '/mcp' && edge.method === 'GET') {
    return {
      persist: false,
      result: { status: 405, headers: { allow: 'POST', 'content-type': JSON_TYPE }, body: '' },
    };
  }
  if (edge.path === '/mcp' && edge.method === 'POST') return callTool(edge, serve, deps);
  return { persist: false, result: jsonResult(404, { code: 'NOT_FOUND' }) };
}

function metadataResult(edge: EdgeRequest): McpHttpResult {
  if (edge.path === '/.well-known/oauth-authorization-server')
    return authorizationServerMetadata(edge.resourceOrigin);
  return protectedResourceMetadata(edge.resourceOrigin);
}

function isMetadataPath(edge: EdgeRequest): boolean {
  if (edge.method !== 'GET') return false;
  return (
    edge.path === '/.well-known/oauth-protected-resource' ||
    edge.path === '/.well-known/oauth-protected-resource/mcp' ||
    edge.path === '/.well-known/oauth-authorization-server'
  );
}

async function authorize(
  edge: EdgeRequest,
  serve: McpServeRecord,
  deps: McpDeps
): Promise<{ persist: boolean; result: McpHttpResult }> {
  const begun = beginAuthorization(serve, edge.search, deps.now());
  if ('error' in begun) return { persist: false, result: begun.error };
  const html = await askLeader(deps, 'consent', JSON.stringify(begun.challenge));
  return { persist: true, result: html };
}

async function callTool(
  edge: EdgeRequest,
  serve: McpServeRecord,
  deps: McpDeps
): Promise<{ persist: boolean; result: McpHttpResult }> {
  const grant = await accessGrant(serve, edge.authorization, deps.now());
  if (grant !== 'ok') return { persist: false, result: unauthorized(edge.resourceOrigin) };
  return { persist: false, result: await askLeader(deps, 'rpc', edge.body) };
}

function askLeader(deps: McpDeps, op: 'rpc' | 'consent', body: string): Promise<McpHttpResult> {
  const reqId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      deps.pending.delete(reqId);
      resolve(jsonResult(504, { error: 'leader timeout' }));
    }, LEADER_WAIT_MS);
    deps.pending.set(reqId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve({
          status: value.status,
          headers: { 'content-type': value.contentType, 'cache-control': 'no-store' },
          body: value.body,
        });
      },
    });
    if (!deps.sendToLeader({ type: 'mcp.request', reqId, op, body })) {
      clearTimeout(timer);
      deps.pending.delete(reqId);
      resolve(jsonResult(502, { error: 'leader disconnected' }));
    }
  });
}

function publishMcp(
  message: Extract<McpLeaderMessage, { type: 'mcp.publish' }>,
  deps: McpDeps
): boolean {
  const tray = deps.getTray();
  if (!tray) return false;
  const token = tray.mcpServe?.token ?? createCapabilityToken(tray.trayId);
  const url = previewUrl(message.workerBaseUrl, token) || tray.mcpServe?.url || '';
  const existing = tray.mcpServe;
  tray.mcpServe = {
    token,
    url,
    trayId: tray.trayId,
    grantGeneration: message.grantGeneration,
    createdAt: existing?.createdAt ?? deps.isoNow(),
    clients: existing?.clients ?? [],
    pending: existing?.pending ?? [],
    codes: existing?.codes ?? [],
    tokens: existing?.tokens ?? [],
  };
  if (existing && existing.grantGeneration !== message.grantGeneration)
    dropStaleGrants(tray.mcpServe);
  deps.sendToLeader({
    type: 'mcp.published',
    requestId: message.requestId,
    url,
    token,
    grantGeneration: message.grantGeneration,
  });
  return true;
}

function updateGeneration(
  message: Extract<McpLeaderMessage, { type: 'mcp.generation' }>,
  deps: McpDeps
): boolean {
  const serve = deps.getTray()?.mcpServe;
  if (!serve) return false;
  if (serve.grantGeneration !== message.grantGeneration) {
    serve.grantGeneration = message.grantGeneration;
    dropStaleGrants(serve);
  }
  return true;
}

function stopPublication(
  message: Extract<McpLeaderMessage, { type: 'mcp.stop' }>,
  deps: McpDeps
): boolean {
  const tray = deps.getTray();
  if (!tray) return false;
  delete tray.mcpServe;
  deps.sendToLeader({ type: 'mcp.stopped', requestId: message.requestId });
  return true;
}

function settleMcpResponse(
  message: Extract<McpLeaderMessage, { type: 'mcp.response' }>,
  deps: McpDeps
): boolean {
  const waiter = deps.pending.get(message.reqId);
  if (!waiter) return false;
  deps.pending.delete(message.reqId);
  waiter.resolve({ status: message.status, contentType: message.contentType, body: message.body });
  return false;
}

function publicationFor(deps: McpDeps, token: string): McpServeRecord | null {
  const serve = deps.getTray()?.mcpServe;
  if (!serve || !timingSafeEqual(serve.token, token)) return null;
  return serve;
}

function previewUrl(workerBaseUrl: string, token: string): string {
  try {
    return buildPreviewUrl(workerBaseUrl, token, '/mcp');
  } catch {
    return '';
  }
}

function parseEdge(value: unknown): EdgeRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const token = readString(value, 'token');
  const method = readString(value, 'method');
  const path = readString(value, 'path');
  if (!token || !method || !path) return null;
  return {
    token,
    method,
    path,
    search: readString(value, 'search') ?? '',
    body: readString(value, 'body') ?? '',
    contentType: readString(value, 'contentType') ?? '',
    authorization: readString(value, 'authorization') ?? '',
    origin: readString(value, 'origin') ?? '',
    resourceOrigin: readString(value, 'resourceOrigin') ?? '',
    tooLarge: Object.getOwnPropertyDescriptor(value, 'tooLarge')?.value === true,
  };
}

function withCors(result: McpHttpResult, origin: string): McpHttpResult {
  if (!origin) return result;
  return {
    ...result,
    headers: {
      ...result.headers,
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'Authorization, Content-Type, MCP-Protocol-Version',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      vary: 'Origin',
    },
  };
}

function jsonResult(status: number, payload: unknown): McpHttpResult {
  return {
    status,
    headers: { 'content-type': JSON_TYPE, 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

function readString(value: object, key: string): string | undefined {
  const found = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof found === 'string' ? found : undefined;
}
