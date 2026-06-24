// tva
/**
 * `shell-bridge-handler` — dispatches substrate steering requests
 * arriving over the lick WebSocket to their respective kernel deps.
 *
 * Consumed by `lick-ws-bridge.ts` when a `shellBridge` is injected
 * (substrate mode only — standalone, spec §11).
 *
 * Implemented cases:
 *   shell-exec (non-stream)  -> SubstrateSessionRegistry.runExec
 *   shell-exec (stream)      -> SubstrateSessionRegistry.streamExec
 *   shell-session-status     -> SubstrateSessionRegistry.sessionStatus
 *   targets                  -> BrowserAPI.listAllTargets
 *   vfs-read                 -> VirtualFS.readFile (utf-8 or base64)
 *   vfs-write                -> VirtualFS.writeFile (utf-8 or decoded base64)
 *   vfs-stat                 -> VirtualFS.stat
 *   vfs-list                 -> VirtualFS.readDir
 *   lick-emit                -> LickManager.emitEvent / handleWebhookEvent
 *
 * No DOM APIs — this module runs in the kernel worker context.
 * Base64 helpers use chunked btoa/atob (no Buffer) — worker-safe.
 */

import type { BrowserAPI } from '../cdp/browser-api.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { ExecFrame, SubstrateSessionRegistry } from '../kernel/substrate-session.js';
import type { LickManager } from './lick-manager.js';

// ---------------------------------------------------------------------------
// Base64 helpers — no Buffer; safe in DedicatedWorker context
// ---------------------------------------------------------------------------

/** Encode a Uint8Array to a base64 string using chunked btoa (avoids stack overflow on large inputs). */
function toBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Decode a base64 string to a Uint8Array. */
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ShellBridgeDeps {
  registry: SubstrateSessionRegistry;
  lickManager: LickManager;
  browser: BrowserAPI;
  fs: VirtualFS;
}

export function createShellBridgeHandler(deps: ShellBridgeDeps): {
  canHandle(type: string): boolean;
  handleRequest(type: string, data: Record<string, unknown>): Promise<unknown>;
  handleStream(
    type: string,
    data: Record<string, unknown>,
    onFrame: (f: ExecFrame) => void
  ): Promise<void>;
} {
  const { registry, lickManager, browser, fs } = deps;

  // Set of message types this handler owns.
  const HANDLED = new Set([
    'shell-exec',
    'shell-session-status',
    'targets',
    'vfs-read',
    'vfs-write',
    'vfs-stat',
    'vfs-list',
    'lick-emit',
  ]);

  function canHandle(type: string): boolean {
    return HANDLED.has(type);
  }

  function requirePath(op: string, data: Record<string, unknown>): string {
    if (typeof data.path !== 'string' || data.path === '') {
      throw new Error(`${op}: path is required`);
    }
    return data.path;
  }

  async function handleVfsRequest(type: string, data: Record<string, unknown>): Promise<unknown> {
    switch (type) {
      case 'vfs-read': {
        const path = requirePath('vfs-read', data);
        if (data.encoding !== 'base64') {
          const content = (await fs.readFile(path, { encoding: 'utf-8' })) as string;
          return { content, encoding: 'utf-8' };
        }
        const bytes = (await fs.readFile(path, { encoding: 'binary' })) as Uint8Array;
        return { content: toBase64(bytes), encoding: 'base64' };
      }
      case 'vfs-write': {
        const path = requirePath('vfs-write', data);
        const body =
          data.encoding === 'base64' ? fromBase64(String(data.content)) : String(data.content);
        await fs.writeFile(path, body);
        return { ok: true };
      }
      case 'vfs-stat': {
        const s = await fs.stat(requirePath('vfs-stat', data));
        return {
          type: s.type === 'directory' ? 'directory' : 'file',
          size: s.size,
          mtime: s.mtime,
        };
      }
      case 'vfs-list':
        return fs.readDir(requirePath('vfs-list', data));
      default:
        throw new Error(`shell-bridge-handler: unknown type ${JSON.stringify(type)}`);
    }
  }

  function emitNavigateLick(payload: Record<string, unknown>): { ok: true } {
    const verb = typeof payload.verb === 'string' ? payload.verb : null;
    const target = typeof payload.target === 'string' ? payload.target : null;
    const url = typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : null;
    if ((verb !== 'handoff' && verb !== 'upskill') || !target || !url)
      throw new Error("lick-emit navigate requires verb ('handoff'|'upskill'), target, and url");
    const body: Record<string, unknown> = { url, verb, target };
    for (const k of ['instruction', 'branch', 'path', 'title'] as const)
      if (typeof payload[k] === 'string') body[k] = payload[k];
    lickManager.emitEvent({
      type: 'navigate',
      navigateUrl: url,
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body,
    });
    return { ok: true };
  }

  function emitWebhookLick(payload: Record<string, unknown>): { ok: true } {
    const webhookId = typeof payload.webhookId === 'string' ? payload.webhookId : null;
    if (!webhookId) throw new Error('lick-emit webhook requires webhookId');
    const headers =
      payload.headers && typeof payload.headers === 'object'
        ? (payload.headers as Record<string, string>)
        : {};
    lickManager.handleWebhookEvent(webhookId, headers, payload.body);
    return { ok: true };
  }

  function handleLickEmit(data: Record<string, unknown>): { ok: true } {
    // NOTE: the lick's type travels as `lickType`, NOT `type`. The node-server
    // lick bridge serializes requests as `{ type, requestId, ...payload }`
    // (lick-bridge.ts), so a payload `type` would clobber the request type
    // ('lick-emit') and the webapp dispatcher would route on the lick type
    // ('navigate') instead — returning "Unknown request type". Keep this key
    // free of the reserved envelope fields (`type`, `requestId`).
    const lickType = typeof data.lickType === 'string' ? data.lickType : '';
    const payload = (data.data ?? {}) as Record<string, unknown>;
    if (lickType === 'navigate') return emitNavigateLick(payload);
    if (lickType === 'webhook') return emitWebhookLick(payload);
    throw new Error(`lick-emit: unsupported type '${lickType}' (supported: navigate, webhook)`);
  }

  async function handleRequest(type: string, data: Record<string, unknown>): Promise<unknown> {
    switch (type) {
      case 'shell-exec': {
        // The routes already validate, but the handler must not trust its input.
        if (
          typeof data.sessionId !== 'string' ||
          data.sessionId === '' ||
          typeof data.command !== 'string' ||
          data.command === ''
        ) {
          throw new Error('shell-exec: sessionId and command are required');
        }
        return registry.runExec(data.sessionId, data.command);
      }
      case 'shell-session-status':
        return registry.sessionStatus(data.sessionId as string);
      case 'targets':
        return browser.listAllTargets();
      case 'vfs-read':
      case 'vfs-write':
      case 'vfs-stat':
      case 'vfs-list':
        return handleVfsRequest(type, data);
      case 'lick-emit':
        return handleLickEmit(data);
      default:
        throw new Error(`shell-bridge-handler: unknown type ${JSON.stringify(type)}`);
    }
  }

  async function handleStream(
    type: string,
    data: Record<string, unknown>,
    onFrame: (f: ExecFrame) => void
  ): Promise<void> {
    if (type === 'shell-exec') {
      if (
        typeof data.sessionId !== 'string' ||
        data.sessionId === '' ||
        typeof data.command !== 'string' ||
        data.command === ''
      ) {
        throw new Error('shell-exec: sessionId and command are required');
      }
      const sessionId = data.sessionId;
      const command = data.command;
      return registry.streamExec(sessionId, command, onFrame);
    }
    throw new Error(`shell-bridge-handler: handleStream unsupported type ${JSON.stringify(type)}`);
  }

  return { canHandle, handleRequest, handleStream };
}
