/**
 * `VfsRpcHost` — worker-side endpoint for the VFS read RPC protocol.
 *
 * Wave B1 of the worker-owned-OPFS migration (blueprint note d8860197):
 * exposes `readDir` / `readFile` / `stat` from the worker (which owns
 * the ZenFS/OPFS VFS) over the existing kernel RPC transport so the
 * page can observe the VFS without touching OPFS itself.
 *
 * Co-resides with `OffscreenBridge` and `TerminalSessionHost` on the
 * same kernel port: each subscriber filters by the messages it cares
 * about (this one for `vfs-*` panel envelopes). The bridge handles
 * orchestrator traffic; the terminal host handles `terminal-*`
 * envelopes; this host handles `vfs-*` envelopes. The hosts do not
 * cross-talk.
 *
 * Per-request lifecycle:
 *   `vfs-read-dir`  → `client.readDir(path)` → `vfs-read-dir-result`
 *   `vfs-read-file` → `client.readFile(path, options)` → `vfs-read-file-result`
 *                     Binary payloads are handed back as `Uint8Array`
 *                     with the underlying buffer in the transfer list,
 *                     so the `MessageChannel` adapter moves ownership
 *                     to the panel (zero-copy). The chrome.runtime
 *                     adapter copies — it doesn't honor transferables.
 *   `vfs-stat`      → `client.stat(path)` → `vfs-stat-result`
 *
 * Errors thrown by the underlying `LocalVfsClient` are serialised onto
 * the failure branch of the discriminated response. `FsError` (POSIX
 * `code` + `message` + `path`) round-trips with the `code` preserved;
 * any other error becomes `{ code: 'EIO', message }`.
 *
 * No page-side consumer wires this surface yet — Wave B2/B3 add the
 * `VfsRpcClient` and switch the panel `LocalVfsClient` implementation
 * over to it. When no client subscribes, the host's responses simply
 * fan out into nobody — existing behavior is unchanged.
 */

import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
  VfsDirEntryEnvelope,
  VfsErrorEnvelope,
  VfsReadDirRequestMsg,
  VfsReadDirResultMsg,
  VfsReadFileRequestMsg,
  VfsReadFileResultMsg,
  VfsReadRequestMsg,
  VfsStatRequestMsg,
  VfsStatResultMsg,
  VfsStatsEnvelope,
} from '../../../chrome-extension/src/messages.js';
import { FsError } from '../fs/types.js';
import type { LocalVfsClient } from './local-vfs-client.js';
import type { KernelTransport } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VfsRpcHostOptions {
  /**
   * Same kernel transport the bridge / terminal host use. Subscribing
   * via `onMessage` adds another listener on the shared wire; the
   * underlying chrome.runtime / MessageChannel adapters support
   * multiple listeners.
   */
  transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;
  /**
   * Read-only VFS facade. `VirtualFS` satisfies this for free
   * (structural subset), so the kernel-worker / offscreen wire it with
   * `host.sharedFs` directly.
   */
  client: LocalVfsClient;
  /**
   * Optional logger. Defaults to `console`. Override in tests to
   * silence expected warnings.
   */
  logger?: {
    warn(msg: string, ...rest: unknown[]): void;
    debug?(msg: string, ...rest: unknown[]): void;
  };
}

export interface VfsRpcHostHandle {
  /** Tear down. Idempotent. */
  stop: () => void;
}

/**
 * Start the VFS RPC host on a shared kernel transport. Returns a
 * `stop` handle; call it on host shutdown to drop the listener.
 */
export function startVfsRpcHost(options: VfsRpcHostOptions): VfsRpcHostHandle {
  const host = new VfsRpcHost(options);
  host.start();
  return { stop: () => host.dispose() };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class VfsRpcHost {
  private readonly transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;
  private readonly client: LocalVfsClient;
  private readonly log: NonNullable<VfsRpcHostOptions['logger']>;
  private unsubscribe: (() => void) | null = null;

  constructor(options: VfsRpcHostOptions) {
    this.transport = options.transport;
    this.client = options.client;
    this.log = options.logger ?? console;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.onMessage((envelope) => {
      if (!isExtensionEnvelope(envelope)) return;
      if (envelope.source !== 'panel') return;
      const payload = envelope.payload as PanelToOffscreenMessage;
      if (!isVfsReadRequest(payload)) return;
      void this.handleRequest(payload).catch((err) => {
        // `handleRequest` already converts all known failures into a
        // failure-branch response. An exception here is a bug — most
        // likely a transport.send() throw. Log it; we can't reply.
        this.log.warn('[vfs-rpc-host] handler unexpectedly threw', err);
      });
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -------------------------------------------------------------------------
  // Per-request handlers
  // -------------------------------------------------------------------------

  private async handleRequest(req: VfsReadRequestMsg): Promise<void> {
    switch (req.type) {
      case 'vfs-read-dir':
        return this.handleReadDir(req);
      case 'vfs-read-file':
        return this.handleReadFile(req);
      case 'vfs-stat':
        return this.handleStat(req);
    }
  }

  private async handleReadDir(req: VfsReadDirRequestMsg): Promise<void> {
    try {
      const entries = await this.client.readDir(req.path);
      // `DirEntry` from `fs/types.ts` is structurally identical to
      // `VfsDirEntryEnvelope`; cast keeps the wire decoupled from the
      // webapp fs type.
      const wireEntries = entries as VfsDirEntryEnvelope[];
      const response: VfsReadDirResultMsg = {
        type: 'vfs-read-dir-result',
        requestId: req.requestId,
        ok: true,
        entries: wireEntries,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitError('vfs-read-dir-result', req.requestId, err, req.path);
    }
  }

  private async handleReadFile(req: VfsReadFileRequestMsg): Promise<void> {
    const encoding = req.encoding ?? 'utf-8';
    try {
      const data = await this.client.readFile(req.path, { encoding });
      if (encoding === 'binary') {
        // `readFile({ encoding: 'binary' })` returns `Uint8Array`. If
        // a misbehaving client handed back a string, fall through to
        // an EIO so we don't ship a wire-shape mismatch.
        if (!(data instanceof Uint8Array)) {
          this.emitError(
            'vfs-read-file-result',
            req.requestId,
            new FsError('EIO', 'readFile(binary) did not return Uint8Array'),
            req.path
          );
          return;
        }
        const response: VfsReadFileResultMsg = {
          type: 'vfs-read-file-result',
          requestId: req.requestId,
          ok: true,
          encoding: 'binary',
          data,
        };
        // Transfer the backing buffer so the MessageChannel adapter
        // moves ownership (no copy) on standalone. The chrome.runtime
        // adapter ignores the transfer list. If the Uint8Array is a
        // view onto a SharedArrayBuffer (or another non-Transferable
        // backing), skip the transfer list — `postMessage`'s transfer
        // arg only accepts Transferable.
        const buf = data.buffer;
        const transfer =
          typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer
            ? [buf as Transferable]
            : undefined;
        this.transport.send(response, transfer);
      } else {
        if (typeof data !== 'string') {
          this.emitError(
            'vfs-read-file-result',
            req.requestId,
            new FsError('EIO', 'readFile(utf-8) did not return string'),
            req.path
          );
          return;
        }
        const response: VfsReadFileResultMsg = {
          type: 'vfs-read-file-result',
          requestId: req.requestId,
          ok: true,
          encoding: 'utf-8',
          data,
        };
        this.transport.send(response);
      }
    } catch (err) {
      this.emitError('vfs-read-file-result', req.requestId, err, req.path);
    }
  }

  private async handleStat(req: VfsStatRequestMsg): Promise<void> {
    try {
      const stats = await this.client.stat(req.path);
      // `Stats` is structurally identical to `VfsStatsEnvelope`.
      const wireStats = stats as VfsStatsEnvelope;
      const response: VfsStatResultMsg = {
        type: 'vfs-stat-result',
        requestId: req.requestId,
        ok: true,
        stats: wireStats,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitError('vfs-stat-result', req.requestId, err, req.path);
    }
  }

  // -------------------------------------------------------------------------
  // Error emission
  // -------------------------------------------------------------------------

  private emitError(
    type: VfsReadDirResultMsg['type'] | VfsReadFileResultMsg['type'] | VfsStatResultMsg['type'],
    requestId: string,
    err: unknown,
    path: string
  ): void {
    const error = toErrorEnvelope(err, path);
    // Each result type's failure branch has the same `{ ok: false, error }`
    // shape; the type literal is the only discriminator. Build via a
    // typed switch so callers get exhaustive matching.
    switch (type) {
      case 'vfs-read-dir-result': {
        const msg: VfsReadDirResultMsg = {
          type: 'vfs-read-dir-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-read-file-result': {
        const msg: VfsReadFileResultMsg = {
          type: 'vfs-read-file-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-stat-result': {
        const msg: VfsStatResultMsg = {
          type: 'vfs-stat-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExtensionEnvelope(value: unknown): value is ExtensionMessage {
  return typeof value === 'object' && value !== null && 'source' in value && 'payload' in value;
}

function isVfsReadRequest(payload: unknown): payload is VfsReadRequestMsg {
  if (typeof payload !== 'object' || payload === null) return false;
  const t = (payload as { type?: unknown }).type;
  return t === 'vfs-read-dir' || t === 'vfs-read-file' || t === 'vfs-stat';
}

function toErrorEnvelope(err: unknown, path: string): VfsErrorEnvelope {
  if (err instanceof FsError) {
    return {
      code: err.code,
      message: err.message,
      path: err.path ?? path,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'EIO', message, path };
}
