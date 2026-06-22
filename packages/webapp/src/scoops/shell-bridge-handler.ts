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
 *
 * Deferred cases (canHandle=true so the bridge routes them; bodies throw):
 *   vfs-read / vfs-write / vfs-stat / vfs-list  (Task 10)
 *   lick-emit                                    (Task 11)
 *
 * No DOM APIs — this module runs in the kernel worker context.
 */

import type { BrowserAPI } from '../cdp/browser-api.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { ExecFrame, SubstrateSessionRegistry } from '../kernel/substrate-session.js';
import type { LickManager } from './lick-manager.js';

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
  const { registry, browser } = deps;

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

  async function handleRequest(type: string, data: Record<string, unknown>): Promise<unknown> {
    switch (type) {
      case 'shell-exec': {
        const sessionId = data.sessionId as string;
        const command = data.command as string;
        return registry.runExec(sessionId, command);
      }
      case 'shell-session-status': {
        const sessionId = data.sessionId as string;
        return registry.sessionStatus(sessionId);
      }
      case 'targets': {
        return browser.listAllTargets();
      }
      // Task 10 — deferred
      case 'vfs-read':
        throw new Error('vfs-read: not implemented until Task 10'); // Task 10
      case 'vfs-write':
        throw new Error('vfs-write: not implemented until Task 10'); // Task 10
      case 'vfs-stat':
        throw new Error('vfs-stat: not implemented until Task 10'); // Task 10
      case 'vfs-list':
        throw new Error('vfs-list: not implemented until Task 10'); // Task 10
      // Task 11 — deferred
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
      const sessionId = data.sessionId as string;
      const command = data.command as string;
      return registry.streamExec(sessionId, command, onFrame);
    }
    throw new Error(`shell-bridge-handler: handleStream unsupported type ${JSON.stringify(type)}`);
  }

  return { canHandle, handleRequest, handleStream };
}
