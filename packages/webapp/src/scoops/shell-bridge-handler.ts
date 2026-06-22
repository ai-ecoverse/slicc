// tva
/**
 * `shell-bridge-handler` — dispatches substrate steering requests
 * arriving over the lick WebSocket to their respective kernel deps.
 *
 * Consumed by `lick-ws-bridge.ts` when a `shellBridge` is injected
 * (substrate mode only — standalone, spec §11).
 *
 * Fully implemented cases (deps already provide everything):
 *   shell-exec (non-stream)  -> SubstrateSessionRegistry.runExec
 *   shell-exec (stream)      -> SubstrateSessionRegistry.streamExec
 *   shell-session-status     -> SubstrateSessionRegistry.sessionStatus
 *   targets                  -> BrowserAPI.listAllTargets
 *   vfs-read                 -> VirtualFS.readFile (utf-8 or base64)
 *   vfs-write                -> VirtualFS.writeFile (utf-8 or decoded base64)
 *   vfs-stat                 -> VirtualFS.stat
 *   vfs-list                 -> VirtualFS.readDir
 *
 * Deferred cases (canHandle=true so the bridge routes them; bodies throw):
 *   lick-emit  (Task 11)
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
  const { registry, browser, fs } = deps;

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
        throw new Error('lick-emit: not implemented until Task 11'); // Task 11
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
