/**
 * `VfsRpcHost` — worker-side endpoint for the VFS RPC protocol.
 *
 * Exposes `readDir` / `readFile` / `stat` from the worker (which
 * owns the ZenFS/OPFS VFS) over the existing kernel RPC transport
 * so the page can observe the VFS without touching OPFS itself.
 * Also extends the surface with `writeFile` / `mkdir` / `rm` /
 * `flush` so page-side callers (e.g. the session freezer) can
 * mutate the worker-owned VFS through the same wire.
 *
 * Co-resides with `OffscreenBridge` and `TerminalSessionHost` on the
 * same kernel port: each subscriber filters by the messages it cares
 * about (this one for `vfs-*` panel envelopes). The bridge handles
 * orchestrator traffic; the terminal host handles `terminal-*`
 * envelopes; this host handles `vfs-*` envelopes. The hosts do not
 * cross-talk.
 *
 * Per-request lifecycle:
 *   `vfs-read-dir`   → `client.readDir(path)`             → `vfs-read-dir-result`
 *   `vfs-read-file`  → `client.readFile(path, options)`   → `vfs-read-file-result`
 *                      Binary payloads are handed back as `Uint8Array`
 *                      with the underlying buffer in the transfer list,
 *                      so the `MessageChannel` adapter moves ownership
 *                      to the panel (zero-copy). The chrome.runtime
 *                      adapter copies — it doesn't honor transferables.
 *   `vfs-stat`       → `client.stat(path)`                → `vfs-stat-result`
 *   `vfs-write-file` → `writableClient.writeFile(...)`    → `vfs-write-file-result`
 *   `vfs-mkdir`      → `writableClient.mkdir(...)`        → `vfs-mkdir-result`
 *   `vfs-rm`         → `writableClient.rm(...)`           → `vfs-rm-result`
 *   `vfs-flush`      → `writableClient.flush()`           → `vfs-flush-result`
 *   `vfs-list-mount-points` → `writableClient.listMountPoints()`
 *
 * Errors thrown by the underlying VFS backend are serialised onto the
 * failure branch of the discriminated response. `FsError` (POSIX
 * `code` + `message` + `path`) round-trips with the `code` preserved;
 * any other error becomes `{ code: 'EIO', message }`. Write requests
 * received without a `writableClient` configured are answered with
 * `EACCES` so a stray `WritableVfsClient` against a read-only host
 * fails fast rather than hanging.
 *
 * Write-side wiring is flag-gated by `slicc_opfs_vfs === 'opfs'` at
 * the call site (kernel-worker / offscreen boot). When the flag is
 * off, no page-side consumer subscribes and the new write request
 * types fan out into nobody — existing behavior is unchanged.
 */

import { FsError } from '../fs/types.js';
import type { LocalVfsClient } from './local-vfs-client.js';
import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
  VfsDirEntryEnvelope,
  VfsErrorEnvelope,
  VfsFlushRequestMsg,
  VfsFlushResultMsg,
  VfsListMountPointsRequestMsg,
  VfsListMountPointsResultMsg,
  VfsMkdirRequestMsg,
  VfsMkdirResultMsg,
  VfsReadDirRequestMsg,
  VfsReadDirResultMsg,
  VfsReadFileRequestMsg,
  VfsReadFileResultMsg,
  VfsReadRequestMsg,
  VfsRmRequestMsg,
  VfsRmResultMsg,
  VfsStatRequestMsg,
  VfsStatResultMsg,
  VfsStatsEnvelope,
  VfsWriteFileRequestMsg,
  VfsWriteFileResultMsg,
  VfsWriteRequestMsg,
} from './messages.js';
import type { KernelTransport } from './types.js';
import type { WritableVfsBackend } from './writable-vfs-client.js';

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
   * Optional writable VFS backend (`slicc_opfs_vfs === 'opfs'` gates
   * wiring at the caller). When wired, the host accepts
   * `vfs-write-file` / `vfs-mkdir` / `vfs-rm` / `vfs-flush` request
   * envelopes and dispatches them. When absent, write requests are
   * answered with an `EACCES` failure envelope so a stray
   * `WritableVfsClient` against a read-only host fails fast instead of
   * silently dropping. `VirtualFS` satisfies `WritableVfsBackend` for
   * free, so the kernel-worker / offscreen pass `host.sharedFs` here
   * too once the flag is on.
   */
  writableClient?: WritableVfsBackend;
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
  private readonly writableClient: WritableVfsBackend | null;
  private readonly log: NonNullable<VfsRpcHostOptions['logger']>;
  private unsubscribe: (() => void) | null = null;

  constructor(options: VfsRpcHostOptions) {
    this.transport = options.transport;
    this.client = options.client;
    this.writableClient = options.writableClient ?? null;
    this.log = options.logger ?? console;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.onMessage((envelope) => {
      if (!isExtensionEnvelope(envelope)) return;
      if (envelope.source !== 'panel') return;
      const payload = envelope.payload as PanelToOffscreenMessage;
      if (isVfsReadRequest(payload)) {
        void this.handleRequest(payload).catch((err) => {
          // `handleRequest` already converts all known failures into a
          // failure-branch response. An exception here is a bug — most
          // likely a transport.send() throw. Log it; we can't reply.
          this.log.warn('[vfs-rpc-host] handler unexpectedly threw', err);
        });
        return;
      }
      if (isVfsWriteRequest(payload)) {
        void this.handleWriteRequest(payload).catch((err) => {
          this.log.warn('[vfs-rpc-host] write handler unexpectedly threw', err);
        });
        return;
      }
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
  // Write-side handlers
  // -------------------------------------------------------------------------

  private async handleWriteRequest(req: VfsWriteRequestMsg): Promise<void> {
    if (!this.writableClient) {
      // No writable backend wired — fail fast so a stray write client
      // against a read-only host surfaces immediately instead of hanging.
      this.emitWriteError(
        writeResultTypeFor(req.type),
        req.requestId,
        new FsError('EACCES', 'vfs-rpc-host has no writable backend wired'),
        writeRequestPath(req)
      );
      return;
    }
    switch (req.type) {
      case 'vfs-write-file':
        return this.handleWriteFile(req, this.writableClient);
      case 'vfs-mkdir':
        return this.handleMkdir(req, this.writableClient);
      case 'vfs-rm':
        return this.handleRm(req, this.writableClient);
      case 'vfs-flush':
        return this.handleFlush(req, this.writableClient);
      case 'vfs-list-mount-points':
        return this.handleListMountPoints(req, this.writableClient);
    }
  }

  private async handleWriteFile(
    req: VfsWriteFileRequestMsg,
    backend: WritableVfsBackend
  ): Promise<void> {
    try {
      // The discriminated request envelope already pins `data` to the
      // right runtime shape per `encoding`. Pass it through to the
      // backend's `writeFile`, which accepts either `string` or
      // `Uint8Array` (`FileContent` in `fs/types.ts`).
      if (req.encoding === 'binary') {
        if (!(req.data instanceof Uint8Array)) {
          this.emitWriteError(
            'vfs-write-file-result',
            req.requestId,
            new FsError('EIO', 'vfs-write-file(binary) data is not Uint8Array'),
            req.path
          );
          return;
        }
      } else if (typeof req.data !== 'string') {
        this.emitWriteError(
          'vfs-write-file-result',
          req.requestId,
          new FsError('EIO', 'vfs-write-file(utf-8) data is not string'),
          req.path
        );
        return;
      }
      const opts = req.recursive === undefined ? undefined : { recursive: req.recursive };
      await backend.writeFile(req.path, req.data, opts);
      const response: VfsWriteFileResultMsg = {
        type: 'vfs-write-file-result',
        requestId: req.requestId,
        ok: true,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitWriteError('vfs-write-file-result', req.requestId, err, req.path);
    }
  }

  private async handleMkdir(req: VfsMkdirRequestMsg, backend: WritableVfsBackend): Promise<void> {
    try {
      const opts = req.recursive === undefined ? undefined : { recursive: req.recursive };
      await backend.mkdir(req.path, opts);
      const response: VfsMkdirResultMsg = {
        type: 'vfs-mkdir-result',
        requestId: req.requestId,
        ok: true,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitWriteError('vfs-mkdir-result', req.requestId, err, req.path);
    }
  }

  private async handleRm(req: VfsRmRequestMsg, backend: WritableVfsBackend): Promise<void> {
    try {
      const opts = req.recursive === undefined ? undefined : { recursive: req.recursive };
      await backend.rm(req.path, opts);
      const response: VfsRmResultMsg = {
        type: 'vfs-rm-result',
        requestId: req.requestId,
        ok: true,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitWriteError('vfs-rm-result', req.requestId, err, req.path);
    }
  }

  private async handleFlush(req: VfsFlushRequestMsg, backend: WritableVfsBackend): Promise<void> {
    try {
      await backend.flush();
      const response: VfsFlushResultMsg = {
        type: 'vfs-flush-result',
        requestId: req.requestId,
        ok: true,
      };
      this.transport.send(response);
    } catch (err) {
      // `flush()` has no associated path; pass empty string and let the
      // error envelope drop the `path` field when the source `FsError`
      // doesn't carry one.
      this.emitWriteError('vfs-flush-result', req.requestId, err, '');
    }
  }

  private async handleListMountPoints(
    req: VfsListMountPointsRequestMsg,
    backend: WritableVfsBackend
  ): Promise<void> {
    if (!backend.listMountPoints) {
      this.emitWriteError(
        'vfs-list-mount-points-result',
        req.requestId,
        new FsError('EACCES', 'vfs-rpc-host has no mount-aware backend wired'),
        ''
      );
      return;
    }
    try {
      const mountPoints = await backend.listMountPoints();
      const response: VfsListMountPointsResultMsg = {
        type: 'vfs-list-mount-points-result',
        requestId: req.requestId,
        ok: true,
        mountPoints,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitWriteError('vfs-list-mount-points-result', req.requestId, err, '');
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

  private emitWriteError(
    type:
      | VfsWriteFileResultMsg['type']
      | VfsMkdirResultMsg['type']
      | VfsRmResultMsg['type']
      | VfsFlushResultMsg['type']
      | VfsListMountPointsResultMsg['type'],
    requestId: string,
    err: unknown,
    path: string
  ): void {
    // `path === ''` is the sentinel for pathless operations (flush and
    // mount listing). Drop the `path` field from the envelope so
    // callers don't reconstruct an `FsError` with a spurious empty path.
    const error = toErrorEnvelope(err, path);
    if (path === '' && error.path === '') {
      delete (error as { path?: string }).path;
    }
    switch (type) {
      case 'vfs-write-file-result': {
        const msg: VfsWriteFileResultMsg = {
          type: 'vfs-write-file-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-mkdir-result': {
        const msg: VfsMkdirResultMsg = {
          type: 'vfs-mkdir-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-rm-result': {
        const msg: VfsRmResultMsg = {
          type: 'vfs-rm-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-flush-result': {
        const msg: VfsFlushResultMsg = {
          type: 'vfs-flush-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-list-mount-points-result': {
        const msg: VfsListMountPointsResultMsg = {
          type: 'vfs-list-mount-points-result',
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

function isVfsWriteRequest(payload: unknown): payload is VfsWriteRequestMsg {
  if (typeof payload !== 'object' || payload === null) return false;
  const t = (payload as { type?: unknown }).type;
  return (
    t === 'vfs-write-file' ||
    t === 'vfs-mkdir' ||
    t === 'vfs-rm' ||
    t === 'vfs-flush' ||
    t === 'vfs-list-mount-points'
  );
}

function writeResultTypeFor(
  reqType: VfsWriteRequestMsg['type']
):
  | VfsWriteFileResultMsg['type']
  | VfsMkdirResultMsg['type']
  | VfsRmResultMsg['type']
  | VfsFlushResultMsg['type']
  | VfsListMountPointsResultMsg['type'] {
  switch (reqType) {
    case 'vfs-write-file':
      return 'vfs-write-file-result';
    case 'vfs-mkdir':
      return 'vfs-mkdir-result';
    case 'vfs-rm':
      return 'vfs-rm-result';
    case 'vfs-flush':
      return 'vfs-flush-result';
    case 'vfs-list-mount-points':
      return 'vfs-list-mount-points-result';
  }
}

function writeRequestPath(req: VfsWriteRequestMsg): string {
  // Pathless operations use `''` to trigger path dropping in `emitWriteError`.
  return req.type === 'vfs-flush' || req.type === 'vfs-list-mount-points' ? '' : req.path;
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
